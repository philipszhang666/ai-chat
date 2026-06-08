// ============ 💾 IndexedDB 存储层 ============
// 【模块定位】用 IndexedDB 替代 localStorage，解决：
//   ① localStorage 容量天花板低（~5-10MB），大附件/多对话动辄撑爆
//   ② JSON.stringify 大对象阻塞主线程
//   ③ 二进制只能 base64 化，占空间
//
// 【设计要点】保留同步 API（storage.get/set/remove）
//   - 现有 30+ 处 localStorage 调用全部是同步的，全改异步代价过大
//   - 启动时一次性把所有 KV 灌入内存缓存（kvCache）
//   - 运行时 get/set 走内存（同步），set 时调度异步落盘（debounced 200ms）
//   - 关闭/刷新页面前 flush 一次保证不丢
//
// 【数据布局】单 Object Store：'kv'，{key: string, value: any}
//   - 与 localStorage 1:1 映射，迁移和读写都最直观
//
// 加载顺序：必须在 config.js 之后、所有业务模块之前（HTML 中第 2 个 script）

(function () {
  'use strict';

  const DB_NAME = 'aichat_db';
  const DB_VERSION = 1;
  const STORE_NAME = 'kv';

  // ---------- 内存缓存（运行时所有同步访问的真相源） ----------
  // 值统一存"字符串"，与 localStorage 行为完全一致（业务层负责 JSON.parse / stringify）
  const kvCache = new Map();
  let _ready = false;          // 是否已完成首次加载
  let _readyPromise = null;    // 首次加载的 Promise
  let _db = null;              // IDBDatabase 实例

  // ---------- 待写入队列（key -> value 或 DELETE） ----------
  const DELETE_MARK = Symbol('delete');
  const dirty = new Map();
  let flushTimer = null;
  const FLUSH_DELAY = 200;     // ms：聚合多次写入

  // ---------- 配额错误回调（业务层注册，触发清理逻辑） ----------
  // 由于现在 storage.set 是异步落盘，QuotaExceededError 不会在 set 现场抛出，
  // 必须靠这个钩子反向通知业务层（如 state.js 的 handleStorageQuotaExceeded）。
  let _onQuotaError = null;
  let _quotaErrorPending = false;   // 防止短时间内重复触发清理
  let _flushInFlight = null;        // 当前正在执行的 flush Promise（避免并发写入）

  // ============ 底层 IDB 操作 ============
  function openDB() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        return reject(new Error('当前环境不支持 IndexedDB'));
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IDB open failed'));
      req.onblocked = () => console.warn('[idb-store] open blocked');
    });
  }

  function idbGetAll(db) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  function idbBatchWrite(db, entries) {
    // entries: [{ key, value }] 或 { key, _delete: true }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const e of entries) {
        if (e._delete) {
          store.delete(e.key);
        } else {
          store.put({ key: e.key, value: e.value });
        }
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('tx aborted'));
    });
  }

  // ============ 一次性从 localStorage 迁移旧数据 ============
  // 仅在 IndexedDB 首次为空 + localStorage 有内容时执行
  async function migrateFromLocalStorage(db) {
    try {
      if (!('localStorage' in window) || localStorage.length === 0) return 0;
      const entries = [];
      // 收集所有 localStorage 中的键（不预设白名单，全部带走最安全）
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k == null) continue;
        const v = localStorage.getItem(k);
        if (v == null) continue;
        entries.push({ key: k, value: v });
      }
      if (entries.length === 0) return 0;

      await idbBatchWrite(db, entries);
      for (const e of entries) kvCache.set(e.key, e.value);

      // 写迁移完成标记
      await idbBatchWrite(db, [{ key: '__migrated_v1__', value: '1' }]);
      kvCache.set('__migrated_v1__', '1');

      console.log(`[idb-store] ✅ 已从 localStorage 迁移 ${entries.length} 项数据到 IndexedDB`);
      console.log('[idb-store] ℹ️ localStorage 原数据已保留作为兜底，确认无误后可手动清理：localStorage.clear()');
      return entries.length;
    } catch (e) {
      console.error('[idb-store] 迁移失败：', e);
      return 0;
    }
  }

  // ============ 初始化（启动时调用一次） ============
  async function idbInit() {
    if (_readyPromise) return _readyPromise;
    _readyPromise = (async () => {
      try {
        _db = await openDB();
        // 先全量灌入缓存
        const all = await idbGetAll(_db);
        for (const row of all) {
          if (row && typeof row.key === 'string') {
            kvCache.set(row.key, row.value);
          }
        }
        // 若尚未迁移，则尝试从 localStorage 拉一次
        if (!kvCache.has('__migrated_v1__')) {
          await migrateFromLocalStorage(_db);
        }
        _ready = true;
        // 页面关闭前强制刷盘
        window.addEventListener('beforeunload', () => {
          // 注意：beforeunload 里只能发同步操作，IDB 是异步的，无法保证落盘
          // 但 200ms debounce 期间用户多半已经停止操作，绝大多数情况都能落
          flushNow();
        });
        // 切到后台时主动 flush，避免移动端被 kill
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'hidden') flushNow();
        });
        console.log(`[idb-store] 🚀 IndexedDB 就绪，缓存 ${kvCache.size} 项`);
      } catch (e) {
        console.error('[idb-store] 初始化失败，回退到 localStorage:', e);
        _ready = false;  // 失败时保持 false，storage 走 localStorage 兜底
      }
    })();
    return _readyPromise;
  }

  // ============ Debounced Flush ============
  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flushNow, FLUSH_DELAY);
  }

  // 判断是否是"配额超限"类错误
  function _isQuotaError(err) {
    if (!err) return false;
    const name = err.name || '';
    const msg  = (err.message || '').toLowerCase();
    return name === 'QuotaExceededError'
        || name === 'NS_ERROR_DOM_QUOTA_REACHED'
        || msg.includes('quota')
        || msg.includes('disk')
        || (err.code === 22)
        || (err.code === 1014);
  }

  // 触发外部清理回调（仅 quota 错误）+ 重试一次
  // 返回：true=清理后重试成功；false=放弃
  async function _handleQuotaAndRetry(entries) {
    if (typeof _onQuotaError !== 'function') {
      console.warn('[idb-store] 配额超限但未注册 onQuotaError 回调，数据可能丢失');
      return false;
    }
    if (_quotaErrorPending) {
      // 已经在清理中，本批先回塞 dirty 等下一轮 flush
      for (const e of entries) {
        if (e._delete) dirty.set(e.key, DELETE_MARK);
        else if (!dirty.has(e.key)) dirty.set(e.key, e.value);
      }
      return false;
    }
    _quotaErrorPending = true;
    try {
      console.warn('[idb-store] ⚠️ IndexedDB 配额超限，触发紧急清理…');
      // 让业务层做清理（可能会同步调用 storage.set 进一步堆 dirty）
      await Promise.resolve(_onQuotaError());
      // 清理逻辑跑完后，再尝试写一次本批
      try {
        await idbBatchWrite(_db, entries);
        console.log('[idb-store] ✅ 清理后重试写入成功');
        return true;
      } catch (retryErr) {
        if (_isQuotaError(retryErr)) {
          console.error('[idb-store] ❌ 清理后仍然超限，本批丢弃');
        } else {
          console.error('[idb-store] ❌ 清理后写入仍失败：', retryErr);
        }
        return false;
      }
    } finally {
      _quotaErrorPending = false;
    }
  }

  function flushNow() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!_db || dirty.size === 0) return _flushInFlight || Promise.resolve();
    // 串行化：若上一次 flush 还在进行，等它完成
    if (_flushInFlight) {
      return _flushInFlight.then(() => flushNow());
    }
    const entries = [];
    for (const [k, v] of dirty) {
      if (v === DELETE_MARK) entries.push({ key: k, _delete: true });
      else entries.push({ key: k, value: v });
    }
    dirty.clear();

    _flushInFlight = idbBatchWrite(_db, entries).catch(async err => {
      if (_isQuotaError(err)) {
        // 配额错误：触发外部清理，并尝试重试一次；失败则放弃这批，不死循环
        const ok = await _handleQuotaAndRetry(entries);
        if (!ok) {
          // 清理失败，提示用户
          try {
            if (typeof window.toast === 'function') {
              window.toast('⚠️ 存储空间已满，部分数据未能保存', 6000);
            }
          } catch (e) {}
        }
      } else {
        // 非配额错误（如临时 IO 失败）：保守重试一次，放回 dirty
        console.error('[idb-store] 写入失败（非配额）：', err);
        for (const e of entries) {
          if (e._delete) dirty.set(e.key, DELETE_MARK);
          else if (!dirty.has(e.key)) dirty.set(e.key, e.value);
        }
        // 不立刻重试，留给下一次 scheduleFlush 触发（避免快错快重试打爆）
      }
    }).finally(() => {
      _flushInFlight = null;
    });
    return _flushInFlight;
  }

  // ============ 对外的 storage 同步 API ============
  // 与 localStorage 行为对齐：get 返回 string 或 null；set/remove 同步反映到内存，异步落盘
  const storage = {
    get(key) {
      if (kvCache.has(key)) {
        const v = kvCache.get(key);
        return v == null ? null : v;
      }
      // 兜底：IDB 初始化失败 / 未就绪 → 走 localStorage
      if (!_ready) {
        try { return localStorage.getItem(key); } catch (e) { return null; }
      }
      return null;
    },
    set(key, value) {
      if (value == null) return this.remove(key);
      const str = typeof value === 'string' ? value : String(value);
      kvCache.set(key, str);
      // IDB 尚未就绪时同步写 localStorage 作为兜底
      if (!_ready) {
        try { localStorage.setItem(key, str); } catch (e) { /* 满了再说 */ }
        return;
      }
      dirty.set(key, str);
      scheduleFlush();
    },
    remove(key) {
      kvCache.delete(key);
      if (!_ready) {
        try { localStorage.removeItem(key); } catch (e) {}
        return;
      }
      dirty.set(key, DELETE_MARK);
      scheduleFlush();
    },
    // 全清（用于"重置所有数据"）：清内存 + 调度删 IDB + 同步删 localStorage
    clearAll() {
      const keys = Array.from(kvCache.keys());
      kvCache.clear();
      if (_db) {
        const tx = _db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).clear();
      }
      try { localStorage.clear(); } catch (e) {}
      dirty.clear();
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      return keys.length;
    },
    // 立即落盘（重要操作后可主动调用）
    flush: flushNow,
    // ⭐ 注册配额超限回调：业务层（state.js）在这里注册清理函数
    //   回调内可以同步调用 storage.set 进行收缩，然后异步落盘自动重试
    onQuotaError(cb) {
      _onQuotaError = cb;
    },
    // 调试用
    _cache: kvCache,
    _isReady: () => _ready
  };

  // ============ 暴露到全局 ============
  window.storage = storage;
  window.idbInit = idbInit;
  window.idbFlush = flushNow;

  // ⭐ 兼容垫片：把"未来希望全部用 storage"的代码，
  //   和"还在用 localStorage 的旧代码"桥接起来。
  //   做法：劫持 localStorage.setItem/removeItem，让旧代码的写入也同步进 IDB。
  //   这样即使你漏改了某处 localStorage.setItem，数据也不会丢。
  //   ⚠️ 副作用：localStorage 仍会被写一次（5-10MB 上限依然存在），所以请
  //      逐步把业务代码迁到 storage.xxx。
  try {
    const _lsSet = localStorage.setItem.bind(localStorage);
    const _lsRem = localStorage.removeItem.bind(localStorage);
    const _lsClr = localStorage.clear.bind(localStorage);
    localStorage.setItem = function (k, v) {
      try { _lsSet(k, v); } catch (e) { /* 满了忽略 */ }
      // 同步进 IDB 缓存
      kvCache.set(k, String(v));
      if (_ready) { dirty.set(k, String(v)); scheduleFlush(); }
    };
    localStorage.removeItem = function (k) {
      try { _lsRem(k); } catch (e) {}
      kvCache.delete(k);
      if (_ready) { dirty.set(k, DELETE_MARK); scheduleFlush(); }
    };
    localStorage.clear = function () {
      try { _lsClr(); } catch (e) {}
      // 注意：clear 通常用户是"重置全部"，IDB 也清掉
      kvCache.clear();
      if (_db) {
        try {
          const tx = _db.transaction(STORE_NAME, 'readwrite');
          tx.objectStore(STORE_NAME).clear();
        } catch (e) {}
      }
      dirty.clear();
    };
    // getItem 也劫持：优先从 IDB 缓存读（防止读到 localStorage 那份"剥离过的旧数据"）
    const _lsGet = localStorage.getItem.bind(localStorage);
    localStorage.getItem = function (k) {
      if (kvCache.has(k)) {
        const v = kvCache.get(k);
        return v == null ? null : v;
      }
      // 缓存没有 → 回退到原始 localStorage（启动阶段 / IDB 未就绪时）
      try { return _lsGet(k); } catch (e) { return null; }
    };
  } catch (e) {
    console.warn('[idb-store] localStorage 垫片安装失败：', e);
  }
})();
