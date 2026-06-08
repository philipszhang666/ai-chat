// ============ 请求频率管理 ============

const RATE_LIMITER_KEY = 'aichat_rate_v1';

let _requestLog = {
  timestamps: [],
  totalRequests: 0,
  todayCount: 0,
  todayDate: '',
  paused: false,
  lastRequestTime: 0
};

function loadRateLimiter() {
  try {
    const raw = storage.get(RATE_LIMITER_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      _requestLog = { ..._requestLog, ...data };
    }
  } catch (e) {}
  
  const today = new Date().toLocaleDateString('zh-CN');
  if (_requestLog.todayDate !== today) {
    _requestLog.todayDate = today;
    _requestLog.todayCount = 0;
    saveRateLimiter();
  }
  
  const oneHourAgo = Date.now() - 3600000;
  _requestLog.timestamps = _requestLog.timestamps.filter(t => t > oneHourAgo);
}

function saveRateLimiter() {
  try {
    storage.set(RATE_LIMITER_KEY, JSON.stringify({
      totalRequests: _requestLog.totalRequests,
      todayCount: _requestLog.todayCount,
      todayDate: _requestLog.todayDate,
      paused: _requestLog.paused
    }));
  } catch (e) {}
}

// ⭐ 中断等待用：可监听用户点"停止"
// 多对话并行时必须按 AbortSignal 精确中断，否则停止 A 会误伤正在限速等待的 B。
let _rateWaitAborters = new Map();
let _rateWaitAbort = function(signalOverride) {
  if (signalOverride && _rateWaitAborters.has(signalOverride)) {
    _rateWaitAborters.get(signalOverride)();
    return;
  }
  if (!signalOverride) {
    for (const aborter of Array.from(_rateWaitAborters.values())) aborter();
  }
};
if (typeof window !== 'undefined') window._rateWaitAbort = _rateWaitAbort;

// ⭐ 等待倒计时显示 + 可中断的 sleep
function _interruptibleSleep(ms, onTick, signalOverride) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let cancelled = false;

    const signal = signalOverride || ((typeof state !== 'undefined' && state.abortCtrl) ? state.abortCtrl.signal : null);
    const waitKey = signal || Symbol('rate-wait');

    const cleanup = () => {
      clearInterval(tickTimer);
      clearTimeout(endTimer);
      if (_rateWaitAborters.get(waitKey) === abortWait) _rateWaitAborters.delete(waitKey);
      if (signal) {
        try { signal.removeEventListener('abort', onAbort); } catch (e) {}
      }
    };
    
    const abortWait = () => {
      if (cancelled) return;
      cancelled = true;
      cleanup();
      const err = new Error('⏹ 等待已被用户中断');
      err.name = 'AbortError';
      reject(err);
    };
    _rateWaitAborters.set(waitKey, abortWait);
    
    // 同时监听 state.abortCtrl（用户点"停止生成"按钮）
    const onAbort = () => {
      if (cancelled) return;
      cancelled = true;
      cleanup();
      const err = new Error('⏹ 等待已被用户中断');
      err.name = 'AbortError';
      reject(err);
    };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    
    // 立即触发一次显示
    if (typeof onTick === 'function') onTick(Math.ceil(ms / 1000));
    
    // 每 500ms 更新倒计时
    const tickTimer = setInterval(() => {
      const remain = Math.max(0, Math.ceil((start + ms - Date.now()) / 1000));
      if (typeof onTick === 'function') onTick(remain);
    }, 500);
    
    const endTimer = setTimeout(() => {
      if (cancelled) return;
      cleanup();
      resolve();
    }, ms);
  });
}

// ⭐ 每次发请求前调用：检查频率 + 应用延迟（超限时自动等待，不再抛错）
async function applyRateLimit(signalOverride) {
  const s = state.settings;
  
  if (_requestLog.paused) {
    throw new Error('⏸ 请求已暂停。点击顶部「▶️ 继续」恢复');
  }
  
  // ⭐ 超过每分钟上限 → 自动等待最早请求"老化"
  const MAX_WAIT_MS = 120 * 1000;  // 单次最长等 2 分钟，避免无限挂起
  let waitTotalElapsed = 0;
  
  while (true) {
    const maxPerMinute = s.rateMaxPerMinute || 20;
    // 顺手清理过期时间戳
    _requestLog.timestamps = _requestLog.timestamps.filter(t => t > Date.now() - 3600000);
    const oneMinuteAgo = Date.now() - 60000;
    const recentTimes = _requestLog.timestamps.filter(t => t > oneMinuteAgo);
    const recentCount = recentTimes.length;
    
    if (recentCount < maxPerMinute) break;
    
    // 最早那条请求 + 60s 后就能让出一个名额
    const oldestRecent = recentTimes[0];
    const waitMs = Math.max(500, oldestRecent + 60000 - Date.now() + 200);
    
    if (waitTotalElapsed + waitMs > MAX_WAIT_MS) {
      updateRateDisplay();
      throw new Error(`🚦 等待超时（已等 ${Math.round(waitTotalElapsed/1000)}s）。请调高每分钟上限或稍后再试`);
    }
    
    console.log(`[频率限制] ${recentCount}/${maxPerMinute}，自动等待 ${waitMs}ms`);
    try {
      await _interruptibleSleep(waitMs, (remain) => {
        updateRateDisplay(`🚦 已达上限 ${recentCount}/${maxPerMinute}，等待 ${remain}s…`);
      }, signalOverride);
    } catch (e) {
      updateRateDisplay();
      throw e;
    }
    waitTotalElapsed += waitMs;
    // 循环回到顶部再校验（避免并发请求把刚释放的名额抢走还是超限）
  }
  
  // ⭐ 最小请求间隔
  const minInterval = (s.rateMinIntervalMs || 0);
  if (minInterval > 0) {
    const elapsed = Date.now() - _requestLog.lastRequestTime;
    if (elapsed < minInterval) {
      const wait = minInterval - elapsed;
      console.log(`[节流] 等待 ${wait}ms`);
      try {
        await _interruptibleSleep(wait, (remain) => {
          updateRateDisplay(`⏳ 节流等待 ${remain}s…`);
        }, signalOverride);
      } catch (e) { updateRateDisplay(); throw e; }
    }
  }
  
  // ⭐ 随机延迟
  const randomMin = s.rateRandomMinMs || 0;
  const randomMax = s.rateRandomMaxMs || 0;
  if (randomMax > 0 && randomMax >= randomMin) {
    const delay = randomMin + Math.random() * (randomMax - randomMin);
    if (delay > 100) {
      console.log(`[随机延迟] ${Math.round(delay)}ms`);
      try {
        await _interruptibleSleep(delay, (remain) => {
          updateRateDisplay(`🎲 随机延迟 ${remain}s…`);
        }, signalOverride);
      } catch (e) { updateRateDisplay(); throw e; }
    }
  }
  
  updateRateDisplay();
}

function recordRequest() {
  const now = Date.now();
  _requestLog.timestamps.push(now);
  _requestLog.lastRequestTime = now;
  _requestLog.totalRequests += 1;
  _requestLog.todayCount += 1;
  
  const today = new Date().toLocaleDateString('zh-CN');
  if (_requestLog.todayDate !== today) {
    _requestLog.todayDate = today;
    _requestLog.todayCount = 1;
  }
  
  const oneHourAgo = now - 3600000;
  _requestLog.timestamps = _requestLog.timestamps.filter(t => t > oneHourAgo);
  
  saveRateLimiter();
  updateRateDisplay();
}

function updateRateDisplay(extraText) {
  const el = document.getElementById('rateStats');
  if (!el) return;
  
  const now = Date.now();
  const oneMinuteAgo = now - 60000;
  const fiveMinAgo = now - 300000;
  
  const last1min = _requestLog.timestamps.filter(t => t > oneMinuteAgo).length;
  const last5min = _requestLog.timestamps.filter(t => t > fiveMinAgo).length;
  
  const s = state.settings;
  const maxPerMin = s.rateMaxPerMinute || 20;
  
  let rateClass = 'safe';
  if (last1min >= maxPerMin * 0.8) rateClass = 'danger';
  else if (last1min >= maxPerMin * 0.5) rateClass = 'warning';
  
  let html = '';
  
  if (_requestLog.paused) {
    html = `
      <span class="rate-paused">⏸ 已暂停</span>
      <button class="rate-btn rate-resume" onclick="toggleRatePause()">▶️ 继续</button>
    `;
  } else {
    html = `
      <span class="rate-item ${rateClass}" title="最近 1 分钟请求数">⚡ ${last1min}/${maxPerMin}分</span>
      <span class="rate-item" title="最近 5 分钟请求数">📊 ${last5min}/5分</span>
      <span class="rate-item" title="今日总请求数">📅 ${_requestLog.todayCount}</span>
      <span class="rate-item" title="累计请求数">∑ ${_requestLog.totalRequests}</span>
    `;
    
    if (extraText) {
      html += `<span class="rate-extra">${escapeHtml(extraText)}</span>`;
    }
    
    html += `
      <button class="rate-btn" onclick="openRateSettings()" title="频率设置">⚙</button>
      <button class="rate-btn rate-pause" onclick="toggleRatePause()" title="暂停所有请求">⏸</button>
    `;
  }
  
  el.innerHTML = html;
}

function toggleRatePause() {
  _requestLog.paused = !_requestLog.paused;
  saveRateLimiter();
  updateRateDisplay();
  toast(_requestLog.paused ? '⏸ 请求已暂停' : '▶️ 请求已恢复');
}

function openRateSettings() {
  let modal = document.getElementById('rateSettingsModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'rateSettingsModal';
    modal.className = 'modal-mask';
    modal.innerHTML = `
      <div class="modal">
        <h2>⚡ 请求频率设置 <button class="modal-close" onclick="closeRateSettings()">×</button></h2>
        
        <div class="json-help">
          💡 控制 API 请求节奏，避免被服务商检测为异常高频。<br>
          推荐设置：<strong>最小间隔 1-3 秒、随机延迟 0-2 秒、每分钟上限 10-20 次</strong>
        </div>
        
        <div class="form-group">
          <label>每分钟最大请求数</label>
          <div class="slider-row">
            <input type="range" id="rate_maxPerMinute" min="5" max="100" step="5" oninput="document.getElementById('rateMaxPerMinVal').textContent=this.value">
            <span class="slider-val" id="rateMaxPerMinVal">20</span>
          </div>
          <div class="form-hint">超过会拒绝请求。普通聊天 5-20 即可；Agent 任务可能需要 30-60</div>
        </div>
        
        <div class="form-group">
          <label>最小请求间隔（毫秒）</label>
          <div class="slider-row">
            <input type="range" id="rate_minInterval" min="0" max="10000" step="500" oninput="document.getElementById('rateMinIntervalVal').textContent=this.value+'ms'">
            <span class="slider-val" id="rateMinIntervalVal">0ms</span>
          </div>
          <div class="form-hint">两次请求之间至少等待这么久。0 = 不限制</div>
        </div>
        
        <div class="form-group">
          <label>随机延迟范围（毫秒）</label>
          <div class="slider-row">
            <span style="font-size:12px;width:30px;">最小</span>
            <input type="range" id="rate_randomMin" min="0" max="5000" step="100" oninput="document.getElementById('rateRandomMinVal').textContent=this.value+'ms'">
            <span class="slider-val" id="rateRandomMinVal">0ms</span>
          </div>
          <div class="slider-row" style="margin-top:6px;">
            <span style="font-size:12px;width:30px;">最大</span>
            <input type="range" id="rate_randomMax" min="0" max="10000" step="100" oninput="document.getElementById('rateRandomMaxVal').textContent=this.value+'ms'">
            <span class="slider-val" id="rateRandomMaxVal">0ms</span>
          </div>
          <div class="form-hint">每次请求前随机等待 X 毫秒（模拟人类操作节奏，避免规律性）</div>
        </div>
        
        <h3 style="font-size:14px;margin:16px 0 10px;">📊 当前统计</h3>
        <div id="rateCurrentStats" style="padding:12px;background:var(--bg-input);border-radius:8px;font-size:13px;line-height:1.8;"></div>
        
        <h3 style="font-size:14px;margin:16px 0 10px;">🎯 预设配置</h3>
        <div class="preset-grid">
          <div class="preset-card" onclick="applyRatePreset('off')"><strong>🚀 无限制</strong><span>开发测试用</span></div>
          <div class="preset-card" onclick="applyRatePreset('chat')"><strong>💬 普通聊天</strong><span>20/分，1-2s 延迟</span></div>
          <div class="preset-card" onclick="applyRatePreset('safe')"><strong>🛡️ 低调模式</strong><span>10/分，2-5s 延迟</span></div>
          <div class="preset-card" onclick="applyRatePreset('stealth')"><strong>🥷 极致低调</strong><span>5/分，5-10s 延迟</span></div>
          <div class="preset-card" onclick="applyRatePreset('agent')"><strong>🤖 Agent 模式</strong><span>30/分，1s 延迟</span></div>
          <div class="preset-card" onclick="applyRatePreset('humanlike')"><strong>👤 类人节奏</strong><span>不规律的延迟</span></div>
        </div>
        
        <div class="modal-footer">
          <button class="btn btn-warning" onclick="resetRateStats()">🔄 重置统计</button>
          <button class="btn" onclick="closeRateSettings()">取消</button>
          <button class="btn btn-primary" onclick="saveRateSettings()">保存</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
  }
  
  modal.classList.add('show');
  
  const s = state.settings;
  document.getElementById('rate_maxPerMinute').value = s.rateMaxPerMinute || 20;
  document.getElementById('rateMaxPerMinVal').textContent = s.rateMaxPerMinute || 20;
  document.getElementById('rate_minInterval').value = s.rateMinIntervalMs || 0;
  document.getElementById('rateMinIntervalVal').textContent = (s.rateMinIntervalMs || 0) + 'ms';
  document.getElementById('rate_randomMin').value = s.rateRandomMinMs || 0;
  document.getElementById('rateRandomMinVal').textContent = (s.rateRandomMinMs || 0) + 'ms';
  document.getElementById('rate_randomMax').value = s.rateRandomMaxMs || 0;
  document.getElementById('rateRandomMaxVal').textContent = (s.rateRandomMaxMs || 0) + 'ms';
  
  updateRateCurrentStats();
}

function updateRateCurrentStats() {
  const el = document.getElementById('rateCurrentStats');
  if (!el) return;
  
  const now = Date.now();
  const last1m = _requestLog.timestamps.filter(t => t > now - 60000).length;
  const last5m = _requestLog.timestamps.filter(t => t > now - 300000).length;
  const last15m = _requestLog.timestamps.filter(t => t > now - 900000).length;
  const last1h = _requestLog.timestamps.filter(t => t > now - 3600000).length;
  
  el.innerHTML = `
    <div>⚡ 最近 1 分钟：<strong>${last1m}</strong> 次</div>
    <div>📊 最近 5 分钟：<strong>${last5m}</strong> 次</div>
    <div>🕒 最近 15 分钟：<strong>${last15m}</strong> 次</div>
    <div>⏰ 最近 1 小时：<strong>${last1h}</strong> 次</div>
    <div>📅 今日累计：<strong>${_requestLog.todayCount}</strong> 次</div>
    <div>∑ 总累计：<strong>${_requestLog.totalRequests}</strong> 次</div>
  `;
}

function closeRateSettings() {
  const modal = document.getElementById('rateSettingsModal');
  if (modal) modal.classList.remove('show');
}

function saveRateSettings() {
  const s = state.settings;
  s.rateMaxPerMinute = parseInt(document.getElementById('rate_maxPerMinute').value);
  s.rateMinIntervalMs = parseInt(document.getElementById('rate_minInterval').value);
  s.rateRandomMinMs = parseInt(document.getElementById('rate_randomMin').value);
  s.rateRandomMaxMs = parseInt(document.getElementById('rate_randomMax').value);
  
  if (s.rateRandomMaxMs < s.rateRandomMinMs) {
    s.rateRandomMaxMs = s.rateRandomMinMs;
  }
  
  persistSettings();
  updateRateDisplay();
  closeRateSettings();
  toast('✓ 频率设置已保存');
}

function applyRatePreset(key) {
  const presets = {
    off: { max: 100, min: 0, randMin: 0, randMax: 0, name: '🚀 无限制' },
    chat: { max: 20, min: 500, randMin: 500, randMax: 1500, name: '💬 普通聊天' },
    safe: { max: 10, min: 1500, randMin: 1000, randMax: 3000, name: '🛡️ 低调模式' },
    stealth: { max: 5, min: 3000, randMin: 2000, randMax: 5000, name: '🥷 极致低调' },
    agent: { max: 30, min: 500, randMin: 200, randMax: 800, name: '🤖 Agent 模式' },
    humanlike: { max: 15, min: 800, randMin: 500, randMax: 4500, name: '👤 类人节奏' }
  };
  const p = presets[key];
  if (!p) return;
  
  document.getElementById('rate_maxPerMinute').value = p.max;
  document.getElementById('rateMaxPerMinVal').textContent = p.max;
  document.getElementById('rate_minInterval').value = p.min;
  document.getElementById('rateMinIntervalVal').textContent = p.min + 'ms';
  document.getElementById('rate_randomMin').value = p.randMin;
  document.getElementById('rateRandomMinVal').textContent = p.randMin + 'ms';
  document.getElementById('rate_randomMax').value = p.randMax;
  document.getElementById('rateRandomMaxVal').textContent = p.randMax + 'ms';
  
  toast('✓ 已应用预设：' + p.name);
}

function resetRateStats() {
  if (!confirm('重置所有统计数据？\n（不影响设置）')) return;
  _requestLog.timestamps = [];
  _requestLog.totalRequests = 0;
  _requestLog.todayCount = 0;
  saveRateLimiter();
  updateRateDisplay();
  updateRateCurrentStats();
  toast('✓ 统计已重置');
}

// 每 5 秒自动刷新显示
setInterval(() => {
  if (document.getElementById('rateStats') && !_requestLog.paused) {
    updateRateDisplay();
  }
  if (document.getElementById('rateSettingsModal')?.classList.contains('show')) {
    updateRateCurrentStats();
  }
}, 5000);
