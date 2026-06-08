// ============ JSON 请求体查看与编辑 ============

// ⭐ 最近若干次原始响应（内存中，刷新页面会丢失，避免占用 localStorage）
const MAX_RAW_RESPONSES = 10;
let _rawResponses = [];

// 对请求头里的敏感字段做脱敏
function _sanitizeReqHeaders(headers) {
  if (!headers || typeof headers !== 'object') return {};
  const out = {};
  for (const k of Object.keys(headers)) {
    const v = headers[k];
    const kl = k.toLowerCase();
    if (kl === 'authorization' && typeof v === 'string') {
      // Bearer sk-xxxx... → Bearer sk-***xxxx（保留前缀和末 4 位）
      const m = v.match(/^(Bearer\s+)?(.*)$/i);
      const prefix = m && m[1] ? m[1] : '';
      const tok = (m && m[2]) || v;
      const tail = tok.length > 8 ? tok.slice(-4) : '';
      out[k] = `${prefix}${tok.slice(0, 6)}***${tail}`;
    } else if (kl === 'x-api-key' && typeof v === 'string') {
      const tail = v.length > 8 ? v.slice(-4) : '';
      out[k] = `${v.slice(0, 4)}***${tail}`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function recordRawResponse(entry) {
  // 若调用方传了 request 字段，把请求头脱敏一份存到 _safeHeaders
  if (entry && entry.request && entry.request.headers) {
    entry.request._safeHeaders = _sanitizeReqHeaders(entry.request.headers);
  }
  _rawResponses.unshift(entry);
  if (_rawResponses.length > MAX_RAW_RESPONSES) {
    _rawResponses.length = MAX_RAW_RESPONSES;
  }
  // 若 JSON 编辑器正打开且在"响应"标签页，自动刷新
  const modal = document.getElementById('jsonEditorModal');
  if (modal && modal.classList.contains('show')) {
    const respTab = document.getElementById('jsonTab-response');
    if (respTab && respTab.style.display !== 'none') {
      refreshJsonResponse();
    }
  }
}

const DEFAULT_JSON_TEMPLATE_OPENAI = `{
  "model": "{{model}}",
  "messages": {{messages}},
  "temperature": {{temperature}},
  "max_tokens": {{max_tokens}},
  "stream": {{stream}},
  "tools": {{tools}}
}`;

const DEFAULT_JSON_TEMPLATE_ANTHROPIC = `{
  "model": "{{model}}",
  "system": {{system}},
  "messages": {{messages}},
  "temperature": {{temperature}},
  "max_tokens": {{max_tokens}},
  "stream": {{stream}},
  "tools": {{tools}}
}`;

function openJsonEditor() {
  document.getElementById('jsonEditorModal').classList.add('show');
  switchJsonTab('preview', document.querySelector('[data-jsontab="preview"]'));
  refreshJsonPreview();
  
  const s = state.settings;
  document.getElementById('jsonTemplate').value = s.jsonTemplate ||
    (s.apiFormat === 'anthropic' ? DEFAULT_JSON_TEMPLATE_ANTHROPIC : DEFAULT_JSON_TEMPLATE_OPENAI);
  document.getElementById('jsonHeaders').value = s.jsonHeaders || '{}';
  document.getElementById('jsonUseCustom').checked = !!s.useCustomJson;
}

function closeJsonEditor() {
  document.getElementById('jsonEditorModal').classList.remove('show');
}

function switchJsonTab(tab, btn) {
  document.querySelectorAll('.json-tab').forEach(t => t.classList.remove('active'));
  if (btn) btn.classList.add('active');
  ['preview', 'response', 'template', 'headers', 'history'].forEach(t => {
    const el = document.getElementById('jsonTab-' + t);
    if (el) el.style.display = (t === tab) ? 'block' : 'none';
  });
  if (tab === 'preview') refreshJsonPreview();
  if (tab === 'response') refreshJsonResponse();
  if (tab === 'history') refreshJsonHistory();
}

function refreshJsonPreview() {
  const previewEl = document.getElementById('jsonPreview');
  if (!previewEl) return;
  try {
    const c = currentChat();
    if (!c || !c.messages.length) {
      previewEl.value = '// 当前没有对话，请先发送一条消息';
      updateJsonStats(0, 0);
      return;
    }
    const body = buildRequestBody(c.messages);
    const url = buildFullUrl(state.settings.baseUrl, state.settings.apiPath);
    const headers = buildHeaders();
    const safeHeaders = { ...headers };
    if (safeHeaders.Authorization) safeHeaders.Authorization = 'Bearer sk-***隐藏***';
    if (safeHeaders['x-api-key']) safeHeaders['x-api-key'] = '***隐藏***';
    
    const fullRequest = {
      _meta: {
        url: url,
        method: 'POST',
        format: state.settings.apiFormat,
        model: state.settings.currentModel,
        '注意': '_meta 字段仅用于展示，不会真的发送'
      },
      _headers: safeHeaders,
      _body: body
    };
    const json = JSON.stringify(fullRequest, null, 2);
    previewEl.value = json;
    const tokens = estimateTokens(JSON.stringify(body));
    const msgCount = body.messages ? body.messages.length : 0;
    updateJsonStats(tokens, msgCount, JSON.stringify(body).length);
  } catch (e) {
    previewEl.value = '❌ 构造请求出错：\n' + e.message + '\n\n' + e.stack;
    updateJsonStats(0, 0);
  }
}

// ⭐ 渲染"📥 响应"标签页：显示最近若干次 AI 返回的原始内容
function refreshJsonResponse() {
  const listEl = document.getElementById('jsonResponseList');
  const detailEl = document.getElementById('jsonResponseDetail');
  if (!listEl || !detailEl) return;
  
  if (!_rawResponses.length) {
    listEl.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:20px;font-size:13px;">暂无响应记录<br><span style="font-size:11px;opacity:.7;">发送一条消息后这里会显示原始 API 返回</span></div>';
    detailEl.value = '// 选择左侧一条响应查看详情';
    const meta = document.getElementById('jsonResponseMeta');
    if (meta) meta.innerHTML = '';
    return;
  }
  
  // 列表
  listEl.innerHTML = _rawResponses.map((r, i) => {
    const time = new Date(r.ts).toLocaleTimeString('zh-CN');
    const date = new Date(r.ts).toLocaleDateString('zh-CN');
    const today = new Date().toLocaleDateString('zh-CN');
    const dateStr = (date === today) ? '' : (date + ' ');
    const sizeKB = (r.raw.length / 1024).toFixed(1);
    const typeBadge = r.isStream 
      ? '<span class="resp-type-badge stream">SSE</span>'
      : '<span class="resp-type-badge json">JSON</span>';
    const usageStr = r.usage 
      ? ` · ${r.usage.input_tokens || r.usage.prompt_tokens || 0}↗/${r.usage.output_tokens || r.usage.completion_tokens || 0}↙`
      : '';
    const sourceStr = r._source 
      ? `<div class="resp-list-source">${escapeHtml(r._source)}</div>`
      : '';
    return `
      <div class="resp-list-item ${i === 0 ? 'active' : ''}" data-resp-idx="${i}" onclick="selectJsonResponse(${i})">
        <div class="resp-list-head">
          <span class="resp-list-time">${dateStr}${time}</span>
          ${typeBadge}
        </div>
        <div class="resp-list-meta">${sizeKB} KB${usageStr}</div>
        ${sourceStr}
      </div>
    `;
  }).join('');
  
  // 默认展示第一条
  selectJsonResponse(0);
}

function selectJsonResponse(idx) {
  const detailEl = document.getElementById('jsonResponseDetail');
  const metaEl = document.getElementById('jsonResponseMeta');
  if (!detailEl || !_rawResponses[idx]) return;
  
  // 切换 active 样式
  document.querySelectorAll('.resp-list-item').forEach((el, i) => {
    el.classList.toggle('active', i === idx);
  });
  
  const r = _rawResponses[idx];
  
  // 元信息栏
  if (metaEl) {
    const time = new Date(r.ts).toLocaleString('zh-CN');
    let html = `<span>⏱ ${time}</span> · <span>📦 ${(r.raw.length / 1024).toFixed(2)} KB</span> · <span>📡 ${escapeHtml(r.contentType || '?')}</span>`;
    if (r.isStream) html += ' · <span style="color:#0ea5e9;">流式（SSE）</span>';
    else html += ' · <span style="color:var(--success);">非流式</span>';
    if (r._source) html += ` · <span style="color:#8b5cf6;font-weight:600;">${escapeHtml(r._source)}</span>`;
    if (r.usage) {
      const inT = r.usage.input_tokens || r.usage.prompt_tokens || 0;
      const outT = r.usage.output_tokens || r.usage.completion_tokens || 0;
      html += ` · <span>🔤 ${inT}↗ ${outT}↙ tokens</span>`;
    }
    metaEl.innerHTML = html;
  }
  
  // ===== 拼装显示内容 =====
  const parts = [];
  
  // 1) 请求段（如果记录到了）
  if (r.request) {
    const req = r.request;
    parts.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    parts.push('📤 请求（浏览器实际发送的内容）');
    parts.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    parts.push(`${req.method || 'POST'} ${req.url || ''}`);
    parts.push('');
    parts.push('-- Headers (敏感字段已脱敏) --');
    const safeH = req._safeHeaders || _sanitizeReqHeaders(req.headers || {});
    parts.push(JSON.stringify(safeH, null, 2));
    parts.push('');
    parts.push('-- Body --');
    if (req.body !== undefined && req.body !== null) {
      try {
        const bodyObj = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        parts.push(JSON.stringify(bodyObj, null, 2));
      } catch (e) {
        // 不是 JSON 就原样输出
        parts.push(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
      }
    } else {
      parts.push('(无 body)');
    }
    parts.push('');
  }
  
  // 2) 响应段
  parts.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  parts.push(r.isStream ? '📥 响应（原始 SSE 流）' : '📥 响应（JSON Body）');
  parts.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  if (r.isStream) {
    parts.push(r.raw);
    // 同时附加一份"解析后"的简要信息
    parts.push('');
    parts.push('-- 解析结果（前端拼接后）--');
    parts.push(JSON.stringify({
      parsedContent: r.parsedContent || '',
      parsedToolCalls: r.parsedToolCalls || null,
      usage: r.usage || null
    }, null, 2));
  } else {
    // 优先美化 parsedJson
    if (r.parsedJson) {
      try {
        parts.push(JSON.stringify(r.parsedJson, null, 2));
      } catch (e) {
        parts.push(r.raw);
      }
    } else {
      parts.push(r.raw);
    }
  }
  
  detailEl.value = parts.join('\n');
}

function copyJsonResponse() {
  const el = document.getElementById('jsonResponseDetail');
  if (!el || !el.value || el.value.startsWith('//')) {
    toast('暂无响应可复制');
    return;
  }
  navigator.clipboard.writeText(el.value).then(() => toast('✓ 响应已复制'));
}

function clearJsonResponses() {
  if (!_rawResponses.length) return;
  if (!confirm('清空当前会话的响应记录？')) return;
  _rawResponses = [];
  refreshJsonResponse();
  toast('✓ 已清空');
}

function updateJsonStats(tokens, msgs, bytes) {
  const el = document.getElementById('jsonStats');
  if (!el) return;
  let html = `<span>💬 ${msgs} 条消息</span> · <span>🔤 ${formatNumber(tokens)} tokens</span>`;
  if (bytes) html += ` · <span>📦 ${formatSize(bytes)}</span>`;
  el.innerHTML = html;
}

// ⚠️ formatBytes 已合并到 utils.js 的 formatSize（统一格式：带空格 + MB 用 .toFixed(2)）

function copyJsonPreview() {
  const txt = document.getElementById('jsonPreview').value;
  navigator.clipboard.writeText(txt).then(() => toast('✓ JSON 已复制到剪贴板'));
}

function copyJsonBodyOnly() {
  try {
    const c = currentChat();
    if (!c || !c.messages.length) { toast('当前没有对话'); return; }
    const body = buildRequestBody(c.messages);
    navigator.clipboard.writeText(JSON.stringify(body, null, 2)).then(() => toast('✓ 请求体已复制'));
  } catch (e) {
    toast('❌ ' + e.message);
  }
}

function copyAsCurl() {
  try {
    const c = currentChat();
    if (!c || !c.messages.length) { toast('当前没有对话'); return; }
    const body = buildRequestBody(c.messages);
    const url = buildFullUrl(state.settings.baseUrl, state.settings.apiPath);
    const headers = buildHeaders();
    let curl = `curl -X POST '${url}' \\\n`;
    for (const [k, v] of Object.entries(headers)) {
      curl += `  -H '${k}: ${v}' \\\n`;
    }
    curl += `  -d '${JSON.stringify(body).replace(/'/g, "'\\''")}'`;
    navigator.clipboard.writeText(curl).then(() => toast('✓ cURL 命令已复制（⚠️ 包含 API Key）'));
  } catch (e) {
    toast('❌ ' + e.message);
  }
}

function saveJsonTemplate() {
  const tpl = document.getElementById('jsonTemplate').value;
  const headers = document.getElementById('jsonHeaders').value;
  if (headers.trim()) {
    try { JSON.parse(headers); }
    catch (e) { alert('请求头 JSON 格式错误：' + e.message); return; }
  }
  state.settings.jsonTemplate = tpl;
  state.settings.jsonHeaders = headers;
  state.settings.useCustomJson = document.getElementById('jsonUseCustom').checked;
  persistSettings();
  toast('✓ JSON 模板已保存');
  refreshJsonPreview();
}

function setCodexUserAgentHeader() {
  const ta = document.getElementById('jsonHeaders');
  if (!ta) return;
  let headers = {};
  const raw = (ta.value || '').trim();
  if (raw) {
    try {
      headers = JSON.parse(raw);
      if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
        headers = {};
      }
    } catch (e) {
      alert('当前请求头 JSON 格式错误，请先修正：' + e.message);
      return;
    }
  }
  headers['User-Agent'] = 'codex-tui/0.118.0 (Mac OS 26.3.1; arm64)';
  ta.value = JSON.stringify(headers, null, 2);
  toast('✓ 已填入 Codex User-Agent，点击保存后生效');
  refreshJsonPreview();
}

function resetJsonTemplate() {
  if (!confirm('恢复默认模板？')) return;
  const s = state.settings;
  document.getElementById('jsonTemplate').value =
    (s.apiFormat === 'anthropic' ? DEFAULT_JSON_TEMPLATE_ANTHROPIC : DEFAULT_JSON_TEMPLATE_OPENAI);
}

function formatJsonTemplate() {
  const ta = document.getElementById('jsonTemplate');
  try {
    const tmp = ta.value
      .replace(/"?\{\{messages\}\}"?/g, '"__MSG__"')
      .replace(/"?\{\{model\}\}"?/g, '"__MODEL__"')
      .replace(/"?\{\{system\}\}"?/g, '"__SYS__"')
      .replace(/"?\{\{temperature\}\}"?/g, '0')
      .replace(/"?\{\{max_tokens\}\}"?/g, '0')
      .replace(/"?\{\{stream\}\}"?/g, 'false')
      .replace(/"?\{\{tools\}\}"?/g, 'null');
    const obj = JSON.parse(tmp);
    let out = JSON.stringify(obj, null, 2);
    out = out.replace(/"__MSG__"/g, '{{messages}}')
             .replace(/"__MODEL__"/g, '{{model}}')
             .replace(/"__SYS__"/g, '{{system}}')
             .replace(/("temperature":\s*)0/, '$1{{temperature}}')
             .replace(/("max_tokens":\s*)0/, '$1{{max_tokens}}')
             .replace(/("stream":\s*)false/, '$1{{stream}}')
             .replace(/("tools":\s*)null/, '$1{{tools}}');
    ta.value = out;
    toast('✓ 已格式化');
  } catch (e) {
    alert('JSON 格式有误：' + e.message);
  }
}

// ============ 请求历史 ============
const REQUEST_HISTORY_KEY = 'aichat_request_history_v1';
const MAX_HISTORY = 20;

function saveRequestToHistory(url, headers, body, response, error) {
  try {
    const history = JSON.parse(storage.get(REQUEST_HISTORY_KEY) || '[]');
    const safeHeaders = { ...headers };
    if (safeHeaders.Authorization) safeHeaders.Authorization = 'Bearer sk-***';
    if (safeHeaders['x-api-key']) safeHeaders['x-api-key'] = '***';
    history.unshift({
      time: Date.now(),
      url, headers: safeHeaders, body,
      response: response ? String(response).slice(0, 2000) : null,
      error: error || null
    });
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    storage.set(REQUEST_HISTORY_KEY, JSON.stringify(history));
  } catch (e) {
    console.warn('保存请求历史失败:', e);
  }
}

function refreshJsonHistory() {
  const el = document.getElementById('jsonHistory');
  if (!el) return;
  try {
    const history = JSON.parse(storage.get(REQUEST_HISTORY_KEY) || '[]');
    if (!history.length) {
      el.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:20px;">暂无历史请求</div>';
      return;
    }
    el.innerHTML = history.map((h, i) => {
      const date = new Date(h.time).toLocaleString('zh-CN');
      const status = h.error
        ? `<span style="color:var(--danger);">❌ ${escapeHtml(h.error.slice(0, 50))}</span>`
        : `<span style="color:var(--success);">✅ 成功</span>`;
      return `
        <div class="json-history-item">
          <div class="json-history-header" onclick="this.parentElement.classList.toggle('expanded')">
            <span class="json-history-time">${date}</span>
            <span class="json-history-status">${status}</span>
            <span style="margin-left:auto;font-size:11px;color:var(--text-secondary);">点击展开</span>
          </div>
          <div class="json-history-body">
            <div class="json-history-section">
              <div class="json-history-label">📡 URL</div>
              <code>${escapeHtml(h.url)}</code>
            </div>
            <div class="json-history-section">
              <div class="json-history-label">📦 请求体</div>
              <pre>${escapeHtml(JSON.stringify(h.body, null, 2).slice(0, 1500))}${JSON.stringify(h.body).length > 1500 ? '\n...(已截断)' : ''}</pre>
            </div>
            ${h.response ? `<div class="json-history-section"><div class="json-history-label">📥 响应（前 2000 字符）</div><pre>${escapeHtml(h.response)}</pre></div>` : ''}
            <button class="btn" onclick="copyHistoryRequest(${i})" style="margin-top:8px;font-size:12px;padding:4px 10px;">📋 复制此请求</button>
          </div>
        </div>`;
    }).join('');
  } catch (e) {
    el.innerHTML = '<div style="color:var(--danger);">加载历史失败：' + escapeHtml(e.message || String(e)) + '</div>';
  }
}

function copyHistoryRequest(i) {
  try {
    const history = JSON.parse(storage.get(REQUEST_HISTORY_KEY) || '[]');
    if (!history[i]) return;
    navigator.clipboard.writeText(JSON.stringify(history[i].body, null, 2)).then(() => toast('✓ 已复制'));
  } catch (e) {
    toast('❌ ' + e.message);
  }
}

function clearJsonHistory() {
  if (!confirm('清空所有请求历史？')) return;
  storage.remove(REQUEST_HISTORY_KEY);
  refreshJsonHistory();
  toast('✓ 已清空');
}
