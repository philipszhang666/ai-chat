// ============ Trace 模块（Git 提交记录风格） ============
// 设计原则：
// 1) 完全独立 —— 不依赖其他模块改动，monkey-patch fetch / executeTool 自动插桩
// 2) 仅本地 —— 数据存 localStorage，绝不发往 API
// 3) 可观测 —— 时间轴 + 短 hash + duration + status + token，类似 git log

const TRACE_KEY = 'aichat_traces_v1';
const TRACE_MAX = 500; // 上限，超出 FIFO 删除最旧

if (!window.state) window.state = {};
if (!Array.isArray(state.traces)) state.traces = [];
state._traceFilter = 'session'; // 'all' | 'session'
state._traceExpanded = new Set(); // 展开的 trace id 集合
state._tracePanelOpen = false;

// ---------- 持久化 ----------
function loadTraces() {
  try {
    const raw = storage.get(TRACE_KEY);
    if (raw) state.traces = JSON.parse(raw) || [];
  } catch (e) {
    state.traces = [];
  }
}

function saveTraces() {
  try {
    // 控制单条大小，避免 base64 / 长文本撑爆
    const trimmed = state.traces.slice(-TRACE_MAX).map(t => {
      const cp = { ...t };
      // 限制 input/output 字符串长度
      if (typeof cp.input === 'string' && cp.input.length > 4000) {
        cp.input = cp.input.slice(0, 4000) + `\n…(truncated, ${cp.input.length} chars)`;
      }
      if (typeof cp.output === 'string' && cp.output.length > 4000) {
        cp.output = cp.output.slice(0, 4000) + `\n…(truncated, ${cp.output.length} chars)`;
      }
      return cp;
    });
    storage.set(TRACE_KEY, JSON.stringify(trimmed));
  } catch (e) {
    // 存储满时尝试丢弃一半
    state.traces = state.traces.slice(-Math.floor(TRACE_MAX / 2));
    try { storage.set(TRACE_KEY, JSON.stringify(state.traces)); } catch (_) {}
  }
}

// ---------- 工具函数 ----------
function _traceId() {
  // 仿 git 短 hash：7 位 hex
  return 'tr_' + Math.random().toString(16).slice(2, 9);
}

function _safeStringify(obj, maxLen = 6000) {
  if (obj == null) return '';
  if (typeof obj === 'string') return obj.length > maxLen ? obj.slice(0, maxLen) + '…' : obj;
  try {
    const s = JSON.stringify(obj, (k, v) => {
      // 剥离 base64 大数据
      if (typeof v === 'string' && v.length > 2000 && /^[A-Za-z0-9+/=]+$/.test(v)) {
        return `<binary ${v.length} chars>`;
      }
      return v;
    }, 2);
    return s.length > maxLen ? s.slice(0, maxLen) + '\n…(truncated)' : s;
  } catch (e) {
    return String(obj);
  }
}

function _fmtAgo(ts) {
  const d = Date.now() - ts;
  if (d < 1000) return 'just now';
  if (d < 60000) return Math.floor(d / 1000) + 's ago';
  if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
  if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
  return Math.floor(d / 86400000) + 'd ago';
}

function _fmtDur(ms) {
  if (ms == null) return '-';
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(2) + 's';
}

// ---------- 核心 API ----------
/**
 * 开启一个 trace，返回 id；调用 traceEnd(id, output, status) 收尾
 */
function traceStart(opts) {
  const t = {
    id: _traceId(),
    chatId: (typeof state !== 'undefined' && (state.activeTaskChatId || state.currentId)) || null,
    type: opts.type || 'misc',       // api | tool | plan | reflection | user | system
    role: opts.role || '',
    title: opts.title || '(untitled)',
    startAt: Date.now(),
    endAt: null,
    duration: null,
    status: 'running',
    input: opts.input != null ? opts.input : null,
    output: null,
    error: null,
    meta: opts.meta || {}
  };
  state.traces.push(t);
  if (state.traces.length > TRACE_MAX) state.traces.splice(0, state.traces.length - TRACE_MAX);
  saveTraces();
  if (state._tracePanelOpen) renderTracePanel();
  _updateTraceBadge();
  return t.id;
}

function traceEnd(id, patch) {
  const t = state.traces.find(x => x.id === id);
  if (!t) return;
  t.endAt = Date.now();
  t.duration = t.endAt - t.startAt;
  t.status = patch.status || (patch.error ? 'fail' : 'ok');
  if (patch.output !== undefined) t.output = patch.output;
  if (patch.error !== undefined) t.error = patch.error;
  if (patch.meta) t.meta = { ...t.meta, ...patch.meta };
  if (patch.title) t.title = patch.title;
  saveTraces();
  if (state._tracePanelOpen) renderTracePanel();
  _updateTraceBadge();
}

/** 一次性 trace（即开即结） */
function traceLog(opts) {
  const id = traceStart(opts);
  traceEnd(id, { output: opts.output, status: opts.status || 'ok', meta: opts.meta });
  return id;
}

// ---------- 自动 Hook ----------
let _traceHooksInstalled = false;
function installTraceHooks() {
  if (_traceHooksInstalled) return;
  _traceHooksInstalled = true;

  // 1) Hook fetch —— 只追踪发往 LLM API 的请求（匹配 baseUrl）
  const _origFetch = window.fetch.bind(window);
  window.fetch = async function(url, init) {
    const urlStr = typeof url === 'string' ? url : (url && url.url) || '';
    const baseUrl = (state.settings && state.settings.baseUrl) || '';
    const isApiCall = baseUrl && urlStr.startsWith(baseUrl);
    if (!isApiCall) return _origFetch(url, init);

    // 解析请求体得到 model / 消息数
    let model = '?', msgCount = 0, hasTools = false, hasStream = false;
    try {
      if (init && typeof init.body === 'string') {
        const body = JSON.parse(init.body);
        model = body.model || '?';
        msgCount = Array.isArray(body.messages) ? body.messages.length : 0;
        hasTools = !!(body.tools && body.tools.length);
        hasStream = !!body.stream;
      }
    } catch (e) {}

    const id = traceStart({
      type: 'api',
      role: 'llm',
      title: `${model}  ·  ${msgCount} msgs${hasTools ? ' · 🛠' : ''}${hasStream ? ' · ⚡' : ''}`,
      input: init && init.body ? _safeStringify(JSON.parse(init.body)) : null,
      meta: { url: urlStr.replace(/(api[_-]?key|authorization)=[^&]+/gi, '$1=***'), model, msgCount, hasTools, stream: hasStream }
    });

    try {
      const resp = await _origFetch(url, init);
      // clone 以便读取 body 而不破坏后续流式消费
      const clone = resp.clone();
      const ct = clone.headers.get('content-type') || '';
      // 流式响应不消费 body（会阻塞 SSE），只记录状态
      if (hasStream && ct.includes('event-stream')) {
        traceEnd(id, {
          status: resp.ok ? 'ok' : 'fail',
          output: `(stream ${resp.status}, body not captured)`,
          meta: { httpStatus: resp.status }
        });
      } else {
        // 异步读响应体，不阻塞主流程
        clone.text().then(txt => {
          // 尝试 token 用量
          let usage = null;
          try {
            const j = JSON.parse(txt);
            usage = j.usage || (j.message && j.message.usage) || null;
          } catch (e) {}
          traceEnd(id, {
            status: resp.ok ? 'ok' : 'fail',
            output: txt,
            error: resp.ok ? null : `HTTP ${resp.status}`,
            meta: { httpStatus: resp.status, usage }
          });
        }).catch(() => {
          traceEnd(id, { status: resp.ok ? 'ok' : 'fail', meta: { httpStatus: resp.status } });
        });
      }
      return resp;
    } catch (e) {
      traceEnd(id, { status: 'fail', error: e.message || String(e) });
      throw e;
    }
  };

  // 2) Hook executeTool —— 追踪所有工具调用
  if (typeof window.executeTool === 'function') {
    const _origExec = window.executeTool;
    window.executeTool = async function(name, args) {
      const id = traceStart({
        type: 'tool',
        role: 'tool',
        title: `🛠 ${name}`,
        input: args,
        meta: { toolName: name }
      });
      try {
        const result = await _origExec(name, args);
        const ok = result && result.ok !== false;
        traceEnd(id, {
          status: ok ? 'ok' : 'fail',
          output: result && result.value !== undefined ? result.value : result,
          error: ok ? null : (result && (result.error || (typeof result.value === 'string' ? result.value : null))),
          meta: { toolName: name }
        });
        return result;
      } catch (e) {
        traceEnd(id, { status: 'fail', error: e.message || String(e) });
        throw e;
      }
    };
  }

  console.log('[trace] hooks installed');
}

// ---------- 暴露给 chat.js 等的轻量 API（可选调用） ----------
function traceUserMessage(text) {
  if (!text) return;
  traceLog({
    type: 'user',
    role: 'user',
    title: '💬 ' + (text.length > 60 ? text.slice(0, 60) + '…' : text),
    input: text,
    output: null,
    status: 'ok'
  });
}

// ---------- UI 渲染 ----------
function openTracePanel() {
  const el = document.getElementById('tracePanel');
  if (!el) return;
  el.classList.add('show');
  state._tracePanelOpen = true;
  renderTracePanel();
  _updateTraceBadge();
}

function closeTracePanel() {
  const el = document.getElementById('tracePanel');
  if (!el) return;
  el.classList.remove('show');
  state._tracePanelOpen = false;
}

function toggleTracePanel() {
  if (state._tracePanelOpen) closeTracePanel();
  else openTracePanel();
}

function _getFilteredTraces() {
  let arr = state.traces.slice();
  if (state._traceFilter === 'session' && state.currentId) {
    arr = arr.filter(t => t.chatId === state.currentId);
  }
  const q = (document.getElementById('traceSearchInput')?.value || '').trim().toLowerCase();
  if (q) {
    arr = arr.filter(t =>
      (t.title || '').toLowerCase().includes(q) ||
      (t.id || '').toLowerCase().includes(q) ||
      (t.type || '').toLowerCase().includes(q) ||
      _safeStringify(t.input, 1500).toLowerCase().includes(q) ||
      _safeStringify(t.output, 1500).toLowerCase().includes(q)
    );
  }
  return arr.reverse(); // 最新在上
}

function _typeIcon(t) {
  switch (t.type) {
    case 'api': return '🌐';
    case 'tool': return '🛠';
    case 'plan': return '📋';
    case 'reflection': return '🎭';
    case 'user': return '💬';
    case 'system': return '⚙️';
    default: return '·';
  }
}

function _statusBadge(t) {
  if (t.status === 'running') return '<span class="tr-st tr-st-run">● running</span>';
  if (t.status === 'fail') return '<span class="tr-st tr-st-fail">✗ fail</span>';
  return '<span class="tr-st tr-st-ok">✓ ok</span>';
}

function renderTracePanel() {
  const body = document.getElementById('traceBody');
  if (!body) return;
  const all = state.traces.length;
  const sessionCount = state.currentId ? state.traces.filter(t => t.chatId === state.currentId).length : 0;
  const list = _getFilteredTraces();

  // 头部统计
  const headerStats = document.getElementById('traceHeaderStats');
  if (headerStats) {
    const totalDur = list.reduce((s, t) => s + (t.duration || 0), 0);
    const fails = list.filter(t => t.status === 'fail').length;
    headerStats.innerHTML = `${list.length} entries · ${_fmtDur(totalDur)} total${fails ? ` · <span style="color:var(--danger)">${fails} fail</span>` : ''}`;
  }

  // Tab 计数
  const tabAll = document.getElementById('traceTabAll');
  const tabSess = document.getElementById('traceTabSession');
  if (tabAll) tabAll.textContent = `All (${all})`;
  if (tabSess) tabSess.textContent = `Session (${sessionCount})`;
  if (tabAll && tabSess) {
    tabAll.classList.toggle('active', state._traceFilter === 'all');
    tabSess.classList.toggle('active', state._traceFilter === 'session');
  }

  if (!list.length) {
    body.innerHTML = `<div class="trace-empty">
      <div style="font-size:36px;opacity:.4;">📭</div>
      <div>No traces yet</div>
      <div class="hint">Send a message to start recording.</div>
    </div>`;
    return;
  }

  body.innerHTML = list.map(t => {
    const expanded = state._traceExpanded.has(t.id);
    const short = t.id.replace('tr_', '');
    const dur = t.duration != null ? _fmtDur(t.duration) : (t.status === 'running' ? '…' : '-');
    const usage = t.meta && t.meta.usage;
    const tok = usage ? ` · <span class="tr-tok">${usage.prompt_tokens || usage.input_tokens || 0}↑/${usage.completion_tokens || usage.output_tokens || 0}↓</span>` : '';
    const httpSt = (t.meta && t.meta.httpStatus) ? ` · HTTP ${t.meta.httpStatus}` : '';
    const runningCls = t.status === 'running' ? ' tr-running' : '';
    const failCls = t.status === 'fail' ? ' tr-fail' : '';

    const detail = expanded ? `
      <div class="tr-detail">
        ${t.input != null ? `<div class="tr-section"><div class="tr-section-head">▼ input</div><pre>${_escapeHtml(_safeStringify(t.input))}</pre></div>` : ''}
        ${t.output != null ? `<div class="tr-section"><div class="tr-section-head">▼ output</div><pre>${_escapeHtml(_safeStringify(t.output))}</pre></div>` : ''}
        ${t.error ? `<div class="tr-section"><div class="tr-section-head tr-section-err">▼ error</div><pre>${_escapeHtml(_safeStringify(t.error))}</pre></div>` : ''}
        <div class="tr-actions">
          <button class="tr-mini-btn" onclick="copyTraceJson('${t.id}')">📋 Copy JSON</button>
          <button class="tr-mini-btn" onclick="deleteTrace('${t.id}')">🗑 Delete</button>
        </div>
      </div>
    ` : '';

    return `
      <div class="trace-entry${runningCls}${failCls}" data-id="${t.id}">
        <div class="tr-graph"><div class="tr-dot tr-dot-${t.type}"></div><div class="tr-line"></div></div>
        <div class="tr-body" onclick="toggleTraceExpand('${t.id}')">
          <div class="tr-row1">
            <span class="tr-hash">${short}</span>
            <span class="tr-icon">${_typeIcon(t)}</span>
            <span class="tr-title">${_escapeHtml(t.title || '')}</span>
            ${_statusBadge(t)}
          </div>
          <div class="tr-row2">
            <span class="tr-time" title="${new Date(t.startAt).toLocaleString()}">${_fmtAgo(t.startAt)}</span>
            <span class="tr-sep">·</span>
            <span class="tr-dur">${dur}</span>${tok}${httpSt}
            ${t.role ? `<span class="tr-sep">·</span><span class="tr-role">${t.role}</span>` : ''}
          </div>
          ${detail}
        </div>
      </div>
    `;
  }).join('');
}

function _escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toggleTraceExpand(id) {
  if (state._traceExpanded.has(id)) state._traceExpanded.delete(id);
  else state._traceExpanded.add(id);
  renderTracePanel();
}

function setTraceFilter(mode) {
  state._traceFilter = mode;
  renderTracePanel();
}

function clearAllTraces() {
  if (!confirm('清空所有 Trace 记录？此操作不可恢复。')) return;
  state.traces = [];
  state._traceExpanded.clear();
  saveTraces();
  renderTracePanel();
  _updateTraceBadge();
}

function clearSessionTraces() {
  if (!state.currentId) return;
  if (!confirm('清空当前会话的 Trace？')) return;
  state.traces = state.traces.filter(t => t.chatId !== state.currentId);
  saveTraces();
  renderTracePanel();
  _updateTraceBadge();
}

function deleteTrace(id) {
  state.traces = state.traces.filter(t => t.id !== id);
  state._traceExpanded.delete(id);
  saveTraces();
  renderTracePanel();
  _updateTraceBadge();
}

function copyTraceJson(id) {
  const t = state.traces.find(x => x.id === id);
  if (!t) return;
  navigator.clipboard.writeText(JSON.stringify(t, null, 2)).then(() => {
    if (typeof toast === 'function') toast('✓ 已复制 Trace JSON');
  });
}

function exportTraces() {
  const list = _getFilteredTraces().slice().reverse();
  const data = {
    exportedAt: new Date().toISOString(),
    filter: state._traceFilter,
    chatId: state.currentId,
    count: list.length,
    traces: list
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `traces_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function _updateTraceBadge() {
  const btn = document.getElementById('traceToggleBtn');
  if (!btn) return;
  const running = state.traces.filter(t => t.status === 'running').length;
  let badge = btn.querySelector('.tr-badge');
  if (running > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'tr-badge';
      btn.appendChild(badge);
    }
    badge.textContent = running;
  } else if (badge) {
    badge.remove();
  }
}

// 启动时加载
loadTraces();

// 暴露给全局
window.traceStart = traceStart;
window.traceEnd = traceEnd;
window.traceLog = traceLog;
window.traceUserMessage = traceUserMessage;
window.installTraceHooks = installTraceHooks;
window.openTracePanel = openTracePanel;
window.closeTracePanel = closeTracePanel;
window.toggleTracePanel = toggleTracePanel;
window.renderTracePanel = renderTracePanel;
window.toggleTraceExpand = toggleTraceExpand;
window.setTraceFilter = setTraceFilter;
window.clearAllTraces = clearAllTraces;
window.clearSessionTraces = clearSessionTraces;
window.deleteTrace = deleteTrace;
window.copyTraceJson = copyTraceJson;
window.exportTraces = exportTraces;
