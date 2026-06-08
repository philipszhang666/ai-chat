// ============ 设置面板 ============

function openSettings() {
  document.getElementById('settingsModal').classList.add('show');
  // ⭐ 刷新配置档案下拉（API Profile）
  if (typeof renderApiProfileSelect === 'function') renderApiProfileSelect();
  const s = state.settings;
  document.getElementById('provider').value = s.provider;
  document.getElementById('baseUrl').value = s.baseUrl;
  document.getElementById('apiPath').value = s.apiPath;
  document.getElementById('apiFormat').value = s.apiFormat;
  document.getElementById('apiKey').value = s.apiKey;
  document.getElementById('modelName').value = s.modelName;
  document.getElementById('systemPrompt').value = s.systemPrompt;
  document.getElementById('temperature').value = s.temperature;
  document.getElementById('tempVal').textContent = s.temperature;
  document.getElementById('maxTokens').value = s.maxTokens;
  document.getElementById('streamMode').checked = s.stream;
  const completionSoundEl = document.getElementById('completionSoundEnabled');
  if (completionSoundEl) completionSoundEl.checked = !!s.completionSoundEnabled;
  const completionVolumeEl = document.getElementById('completionSoundVolume');
  const completionVolumeValEl = document.getElementById('completionSoundVolumeVal');
  if (completionVolumeEl) {
    const rawVolume = parseInt(s.completionSoundVolume);
    const v = isNaN(rawVolume) ? 80 : Math.max(0, Math.min(100, rawVolume));
    completionVolumeEl.value = v;
    if (completionVolumeValEl) completionVolumeValEl.textContent = v + '%';
  }
  // ⭐ 本地代理开关
  const proxyEl = document.getElementById('useLocalProxy');
  if (proxyEl) proxyEl.checked = !!s.useLocalProxy;
  // ⭐ 自动重试次数
  const retryEl = document.getElementById('retryMaxAttempts');
  const retryValEl = document.getElementById('retryMaxAttemptsVal');
  if (retryEl) {
    const v = (s.retryMaxAttempts === undefined || s.retryMaxAttempts === null) ? 3 : s.retryMaxAttempts;
    retryEl.value = v;
    if (retryValEl) retryValEl.textContent = v;
  }
  
  // 工具调用轮数
  const maxToolRoundsEl = document.getElementById('maxToolRounds');
  const maxToolRoundsValEl = document.getElementById('maxToolRoundsVal');
  const maxToolRoundsInputEl = document.getElementById('maxToolRoundsInput');
  if (maxToolRoundsEl) {
    const v = s.maxToolRounds || 15;
    maxToolRoundsEl.value = Math.max(1, Math.min(100, v));
    if (maxToolRoundsInputEl) maxToolRoundsInputEl.value = v;
    if (maxToolRoundsValEl) maxToolRoundsValEl.textContent = v;
  }
  
  // ⭐ 终端 Token 显示
  refreshTerminalTokenView();
  
  document.getElementById('testResult').className = 'test-result';
  document.getElementById('testResult').textContent = '';
  
  // 压缩设置
  const compEnabled = document.getElementById('compressAutoEnabled');
  const compThreshold = document.getElementById('compressAutoThreshold');
  const compThresholdVal = document.getElementById('compressThresholdVal');
  const compKeep = document.getElementById('compressKeepLast');
  const compKeepVal = document.getElementById('compressKeepLastVal');
  if (compEnabled) compEnabled.checked = !!s.compressAutoEnabled;
  if (compThreshold) compThreshold.value = s.compressAutoThreshold || 75;
  if (compThresholdVal) compThresholdVal.textContent = (s.compressAutoThreshold || 75) + '%';
  if (compKeep) compKeep.value = s.compressKeepLast || 4;
  if (compKeepVal) compKeepVal.textContent = s.compressKeepLast || 4;
  const contextMode = document.getElementById('contextLimitMode');
  const contextOverride = document.getElementById('contextLimitOverride');
  if (contextMode) contextMode.value = s.contextLimitMode === 'manual' ? 'manual' : 'auto';
  if (contextOverride) contextOverride.value = s.contextLimitOverride ? s.contextLimitOverride : '';
  updateContextLimitModeUI();
  
  // 🧪 自动信标
  const bEnabled = document.getElementById('beaconEnabled');
  const bInterval = document.getElementById('beaconInterval');
  const bIntervalVal = document.getElementById('beaconIntervalVal');
  if (bEnabled) bEnabled.checked = !!s.beaconEnabled;
  if (bInterval) bInterval.value = s.beaconInterval || 5;
  if (bIntervalVal) bIntervalVal.textContent = s.beaconInterval || 5;
  
  updateUrlPreview();
}

function currentSettingsModelName() {
  const current = state.settings.currentModel || '';
  const modelInput = document.getElementById('modelName');
  const list = (modelInput?.value || state.settings.modelName || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (current && (!list.length || list.includes(current))) return current;
  return list[0] || current || 'unknown';
}

function updateContextLimitModeUI() {
  const modeEl = document.getElementById('contextLimitMode');
  const inputEl = document.getElementById('contextLimitOverride');
  const hintEl = document.getElementById('contextLimitHint');
  if (!modeEl || !inputEl) return;
  const isManual = modeEl.value === 'manual';
  inputEl.disabled = !isManual;
  inputEl.placeholder = isManual ? '例如 200000' : '自动识别时不需要填写';
  
  if (hintEl) {
    const model = currentSettingsModelName();
    const autoLimit = typeof getAutoContextLimit === 'function'
      ? getAutoContextLimit(model)
      : 200000;
    const autoText = typeof formatNumber === 'function' ? formatNumber(autoLimit) : String(autoLimit);
    if (isManual) {
      hintEl.textContent = `当前模型自动识别值：${autoText} tokens；手动值会覆盖它并影响 token 条、自动压缩和长流程上下文检查。`;
    } else {
      hintEl.textContent = `当前模型自动识别值：${autoText} tokens。未知模型默认按 200k 估算。`;
    }
  }
}

function readContextLimitSettingsFromModal() {
  const s = state.settings;
  const modeEl = document.getElementById('contextLimitMode');
  const inputEl = document.getElementById('contextLimitOverride');
  if (!modeEl || !inputEl) return true;
  const mode = modeEl.value === 'manual' ? 'manual' : 'auto';
  const raw = inputEl.value.trim();
  const n = parseInt(raw);
  
  if (mode === 'manual') {
    if (!Number.isFinite(n) || n < 1024) {
      toast('手动上下文长度至少需要 1024 tokens');
      inputEl.focus();
      return false;
    }
    s.contextLimitMode = 'manual';
    s.contextLimitOverride = Math.min(n, 4000000);
    inputEl.value = s.contextLimitOverride;
  } else {
    s.contextLimitMode = 'auto';
    if (Number.isFinite(n) && n > 0) {
      s.contextLimitOverride = Math.min(Math.max(n, 1024), 4000000);
    }
  }
  return true;
}

function openContextLimitSettings() {
  const wrap = document.querySelector('.more-menu-wrap');
  if (wrap) wrap.classList.remove('open');
  openSettings();
  setTimeout(() => {
    const group = document.getElementById('contextLimitSettingsGroup');
    if (group) {
      group.scrollIntoView({ block: 'center', behavior: 'smooth' });
      group.classList.add('settings-focus');
      setTimeout(() => group.classList.remove('settings-focus'), 1800);
    }
    const modeEl = document.getElementById('contextLimitMode');
    const inputEl = document.getElementById('contextLimitOverride');
    if (state.settings.contextLimitMode === 'manual' && inputEl) inputEl.focus();
    else if (modeEl) modeEl.focus();
  }, 80);
}

function closeSettings() {
  document.getElementById('settingsModal').classList.remove('show');
}

function saveAndClose() {
  const s = state.settings;
  s.provider = document.getElementById('provider').value;
  s.baseUrl = document.getElementById('baseUrl').value.trim();
  s.apiFormat = document.getElementById('apiFormat').value;
  s.apiPath = document.getElementById('apiPath').value.trim()
    || (s.apiFormat === 'responses' ? '/responses' : (s.apiFormat === 'anthropic' ? '/messages' : '/chat/completions'));
  s.apiKey = document.getElementById('apiKey').value.trim();
  s.modelName = document.getElementById('modelName').value.trim();
  s.systemPrompt = document.getElementById('systemPrompt').value;
  s.temperature = parseFloat(document.getElementById('temperature').value);
  s.maxTokens = parseInt(document.getElementById('maxTokens').value);
  s.stream = document.getElementById('streamMode').checked;
  const completionSoundEl = document.getElementById('completionSoundEnabled');
  if (completionSoundEl) s.completionSoundEnabled = completionSoundEl.checked;
  const completionVolumeEl = document.getElementById('completionSoundVolume');
  if (completionVolumeEl) {
    const v = parseInt(completionVolumeEl.value);
    s.completionSoundVolume = isNaN(v) ? 80 : Math.max(0, Math.min(100, v));
  }
  if (s.completionSoundEnabled && typeof ensureCompletionSoundReady === 'function') ensureCompletionSoundReady();
  // ⭐ 本地代理开关
  const proxyEl = document.getElementById('useLocalProxy');
  if (proxyEl) s.useLocalProxy = proxyEl.checked;
  // ⭐ 自动重试次数
  const retryEl = document.getElementById('retryMaxAttempts');
  if (retryEl) {
    const v = parseInt(retryEl.value);
    s.retryMaxAttempts = (isNaN(v) || v < 0) ? 3 : v;
  }
  
  // 工具调用轮数
  const maxToolRoundsEl = document.getElementById('maxToolRounds');
  const maxToolRoundsInputEl = document.getElementById('maxToolRoundsInput');
  if (maxToolRoundsInputEl || maxToolRoundsEl) {
    const raw = maxToolRoundsInputEl ? maxToolRoundsInputEl.value : maxToolRoundsEl.value;
    const v = parseInt(raw);
    s.maxToolRounds = (isNaN(v) || v < 1) ? 15 : v;
  }
  
  // 压缩设置
  const compEnabled = document.getElementById('compressAutoEnabled');
  const compThreshold = document.getElementById('compressAutoThreshold');
  const compKeep = document.getElementById('compressKeepLast');
  if (compEnabled) s.compressAutoEnabled = compEnabled.checked;
  if (compThreshold) s.compressAutoThreshold = parseInt(compThreshold.value);
  if (compKeep) s.compressKeepLast = parseInt(compKeep.value);
  if (!readContextLimitSettingsFromModal()) return false;
  
  // 🧪 自动信标
  const bEnabled = document.getElementById('beaconEnabled');
  const bInterval = document.getElementById('beaconInterval');
  if (bEnabled) s.beaconEnabled = bEnabled.checked;
  if (bInterval) {
    const v = parseInt(bInterval.value);
    s.beaconInterval = (isNaN(v) || v < 1) ? 5 : v;
  }
  
  refreshModelSelect();
  persistSettings();
  closeSettings();
  updateTopUrlPreview();
  updateSendBtn();
  if (typeof updateTokenDisplay === 'function') updateTokenDisplay();
  // ⭐ 切换 apiFormat（OpenAI ↔ Anthropic）会让 count_tokens 的可用性变化，
  // 且不同模型的上下文限制不同 → 立即重新拉一次精确 token 数
  if (typeof scheduleAccurateTokenCount === 'function') scheduleAccurateTokenCount();
  return true;
}

function saveSettings() {
  state.settings.currentModel = document.getElementById('modelSelect').value;
  persistSettings();
  if (typeof updateTokenDisplay === 'function') updateTokenDisplay();
  if (document.getElementById('settingsModal')?.classList.contains('show')) {
    updateContextLimitModeUI();
  }
}

function onProviderChange() {
  const p = document.getElementById('provider').value;
  if (PROVIDERS[p]) {
    document.getElementById('baseUrl').value = PROVIDERS[p].url;
    document.getElementById('apiPath').value = PROVIDERS[p].path;
    document.getElementById('apiFormat').value = PROVIDERS[p].format;
    document.getElementById('modelName').value = PROVIDERS[p].models;
    updateUrlPreview();
    updateContextLimitModeUI();
  }
}

function toggleKey() {
  const inp = document.getElementById('apiKey');
  const btn = document.getElementById('keyToggle');
  if (inp.type === 'password') {
    inp.type = 'text';
    btn.textContent = '隐藏';
  } else {
    inp.type = 'password';
    btn.textContent = '显示';
  }
}

function refreshModelSelect() {
  const sel = document.getElementById('modelSelect');
  const list = state.settings.modelName.split(',').map(s => s.trim()).filter(Boolean);
  sel.innerHTML = list.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
  if (list.includes(state.settings.currentModel)) sel.value = state.settings.currentModel;
  else if (list[0]) {
    sel.value = list[0];
    state.settings.currentModel = list[0];
  }
}

async function testConnection() {
  const r = document.getElementById('testResult');
  r.className = 'test-result';
  r.textContent = '测试中...';
  r.style.display = 'block';
  const baseUrl = document.getElementById('baseUrl').value.trim();
  const apiFormat = document.getElementById('apiFormat').value;
  const apiPath = document.getElementById('apiPath').value.trim()
    || (apiFormat === 'responses' ? '/responses' : (apiFormat === 'anthropic' ? '/messages' : '/chat/completions'));
  const key = document.getElementById('apiKey').value.trim();
  const model = (document.getElementById('modelName').value.split(',')[0] || '').trim();
  
  if (!baseUrl || !key || !model) {
    r.className = 'test-result error';
    r.textContent = '❌ 请先填写 Base URL、API Key、模型';
    return;
  }
  
  const url = buildFullUrl(baseUrl, apiPath);
  let body, headers;
  if (apiFormat === 'anthropic') {
    body = { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 };
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'Authorization': 'Bearer ' + key
    };
  } else if (apiFormat === 'responses') {
    body = { model, input: 'hi', max_output_tokens: 10 };
    headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key };
  } else {
    body = { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 };
    headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key };
  }
  
  try {
    // ⭐ 与正式请求保持一致：如果开启了本地代理，测试也走代理
    let realUrl = url;
    let realInit = { method: 'POST', headers, body: JSON.stringify(body) };
    const useProxy = document.getElementById('useLocalProxy');
    if (useProxy && useProxy.checked) {
      const tc = (typeof TERMINAL_CONFIG !== 'undefined') ? TERMINAL_CONFIG : null;
      if (!tc || !tc.token) {
        r.className = 'test-result error';
        r.innerHTML = '❌ 已勾选「本地代理」，但还没获取本地服务 Token。<br>请到「本地终端 Token」一栏点【拉取 Token】并在 Python 终端按 y 授权。';
        return;
      }
      realUrl = tc.serverUrl.replace(/\/+$/, '') + '/llm-proxy';
      realInit = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Token': tc.token,
          'X-Target-Url': url,
          'X-Target-Headers': JSON.stringify(headers)
        },
        body: JSON.stringify(body)
      };
    }
    const resp = await fetch(realUrl, realInit);
    const ct = resp.headers.get('content-type') || '';
    const txt = await resp.text();
    
    if (!resp.ok) {
      r.className = 'test-result error';
      r.innerHTML = `❌ HTTP ${resp.status}<br>URL: <code>${escapeHtml(url)}</code><pre>${escapeHtml(txt.slice(0, 400))}</pre>`;
      return;
    }
    if (!ct.includes('json')) {
      r.className = 'test-result error';
      r.innerHTML = `❌ 非 JSON 响应<br>URL: <code>${escapeHtml(url)}</code><br>Content-Type: <code>${escapeHtml(ct)}</code><pre>${escapeHtml(txt.slice(0, 400))}</pre>`;
      return;
    }
    let j;
    try { j = JSON.parse(txt); }
    catch (e) {
      r.className = 'test-result error';
      r.innerHTML = `❌ JSON 解析失败<pre>${escapeHtml(txt.slice(0, 400))}</pre>`;
      return;
    }
    let content = '';
    if (apiFormat === 'anthropic') content = (j.content || []).filter(p => p.type === 'text').map(p => p.text).join('');
    else if (apiFormat === 'responses') content = extractResponsesText(j);
    else content = j.choices?.[0]?.message?.content || '';
    
    r.className = 'test-result success';
    r.innerHTML = `✅ 连接成功！<br>URL: <code>${escapeHtml(url)}</code><br>回复: <code>${escapeHtml(content.slice(0, 100) || '(空)')}</code>`;
  } catch (e) {
    r.className = 'test-result error';
    r.innerHTML = `❌ 网络错误: ${escapeHtml(e.message)}<br>URL: <code>${escapeHtml(url)}</code>`;
  }
}

// ============ 本地终端 Token 管理 ============

function refreshTerminalTokenView() {
  const input = document.getElementById('terminalTokenView');
  const status = document.getElementById('terminalTokenStatus');
  const toggle = document.getElementById('termTokenToggle');
  if (!input) return;
  
  const tk = (typeof TERMINAL_CONFIG !== 'undefined' && TERMINAL_CONFIG.token) || '';
  input.value = tk;
  input.type = 'password';  // 每次打开默认隐藏
  if (toggle) toggle.textContent = '显示';
  
  if (status) {
    if (tk) {
      status.textContent = `状态：✅ 已授权（${tk.length} 字符）`;
      status.style.color = 'var(--success, #16a34a)';
    } else {
      status.textContent = '状态：⚠️ 未授权（首次调用工具时会自动请求）';
      status.style.color = 'var(--warning, #d97706)';
    }
  }
}

function toggleTerminalTokenView() {
  const input = document.getElementById('terminalTokenView');
  const btn = document.getElementById('termTokenToggle');
  if (!input || !btn) return;
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = '隐藏';
  } else {
    input.type = 'password';
    btn.textContent = '显示';
  }
}

async function onFetchTerminalToken() {
  if (typeof fetchTerminalToken !== 'function') {
    toast('❌ terminal.js 未加载', 3000);
    return;
  }
  // 先清掉旧的，确保拿到的是新 token
  if (typeof saveTerminalToken === 'function') saveTerminalToken('');
  refreshTerminalTokenView();
  
  const tk = await fetchTerminalToken(false);
  refreshTerminalTokenView();
  if (tk) {
    toast('✅ 新 Token 已保存到浏览器', 2500);
  }
}

function onClearTerminalToken() {
  if (!confirm('确定要使当前 Token 失效吗？\n（只清除浏览器端，下次调用工具时会自动重新申请）')) return;
  if (typeof saveTerminalToken === 'function') saveTerminalToken('');
  refreshTerminalTokenView();
  toast('🗑️ Token 已清除', 2000);
}

// ============================================================
// 📡 拉取模型列表（OpenAI / Anthropic 兼容）
// ============================================================
//
// 行为：
//   1. 读取设置弹窗当前填写的 Base URL / API Key / API 格式
//   2. 调用 GET {baseUrl}/models（如已开启本地代理则走 /llm-proxy）
//   3. 解析返回，弹出复选框选择窗口
//   4. 用户勾选后追加到模型名称输入框（已存在的自动跳过）
//
// 注意：
//   - Anthropic 的 /v1/models 自 2024-10 起官方支持，需要 anthropic-version
//   - 部分代理商不实现 /models（如某些转发服务），会优雅降级
//

let _fetchModelsBuffer = [];   // 当前拉取到的模型列表（用于过滤/全选）
let _fetchModelsExisting = new Set();  // 当前输入框已有的模型

async function onFetchModels() {
  const baseUrl = (document.getElementById('baseUrl').value || '').trim();
  const apiKey = (document.getElementById('apiKey').value || '').trim();
  const apiFormat = document.getElementById('apiFormat').value;
  
  if (!baseUrl) { toast('❌ 请先填写 Base URL', 2500); return; }
  if (!apiKey) { toast('❌ 请先填写 API Key', 2500); return; }
  
  // 立即打开弹窗，显示加载中
  openFetchModelsModal();
  const listEl = document.getElementById('fetchModelsList');
  const countEl = document.getElementById('fetchModelsCount');
  const hintEl = document.getElementById('fetchModelsHint');
  if (hintEl) hintEl.style.display = 'none';
  listEl.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:20px;">📡 正在拉取模型列表…</div>';
  if (countEl) countEl.textContent = '加载中…';
  
  // 构造 GET /models 请求
  const url = buildModelsUrl(baseUrl);
  const headers = buildModelsHeaders(apiKey, apiFormat);
  
  let models = [];
  let errorMsg = '';
  try {
    const resp = await fetchModelsViaCorrectChannel(url, headers);
    if (!resp.ok) {
      errorMsg = `HTTP ${resp.status}：${(resp.text || '').slice(0, 200)}`;
    } else {
      models = parseModelsResponse(resp.text, apiFormat);
      if (!models.length) {
        errorMsg = '响应解析后为空。原始响应预览：\n' + (resp.text || '').slice(0, 300);
      }
    }
  } catch (e) {
    errorMsg = '网络错误：' + (e.message || e);
  }
  
  if (errorMsg) {
    listEl.innerHTML = `
      <div style="padding:16px;color:var(--danger,#dc2626);">
        <strong>❌ 拉取失败</strong>
        <pre style="margin-top:8px;white-space:pre-wrap;font-size:12px;background:rgba(220,38,38,0.08);padding:8px;border-radius:6px;">${escapeHtml(errorMsg)}</pre>
        <div style="margin-top:10px;font-size:12.5px;color:var(--text-secondary);line-height:1.6;">
          可能原因：<br>
          • 服务商不支持 <code>/models</code> 端点（如某些第三方转发）<br>
          • Base URL 填错（应为根地址，不含 <code>/chat/completions</code> 或 <code>/responses</code>）<br>
          • 跨域：可在上方勾选「通过本地服务代理」<br>
          • API Key 无效或权限不足
        </div>
      </div>`;
    if (countEl) countEl.textContent = '0 个';
    return;
  }
  
  // 排序：含 deepseek / claude / gpt / qwen / glm / o1 / gemini 之类的优先
  models = sortModelsByRelevance(models);
  _fetchModelsBuffer = models;
  
  // 记录已存在的（去重提示）
  const currentText = (document.getElementById('modelName').value || '').trim();
  _fetchModelsExisting = new Set(currentText.split(',').map(s => s.trim()).filter(Boolean));
  
  renderFetchModelsList(models);
  
  if (hintEl) {
    hintEl.style.display = 'block';
    hintEl.innerHTML = `✅ 从 <code>${escapeHtml(url)}</code> 拉取到 <strong>${models.length}</strong> 个模型。已自动跳过已添加的 ${_fetchModelsExisting.size} 个。`;
  }
}

function buildModelsUrl(baseUrl) {
  // baseUrl 末尾去 /，并去掉常见的子路径（兼容用户把完整端点填进去的场景）
  let b = baseUrl.replace(/\/+$/, '');
  // 去掉常见结尾路径
  b = b.replace(/\/(chat\/completions|responses|messages|completions)$/i, '');
  return b + '/models';
}

function buildModelsHeaders(apiKey, apiFormat) {
  if (apiFormat === 'anthropic') {
    return {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    };
  }
  return { 'Authorization': 'Bearer ' + apiKey };
}

// 真正发请求：可选择走本地代理（解决 CORS）
async function fetchModelsViaCorrectChannel(url, headers) {
  const useProxy = document.getElementById('useLocalProxy');
  // 1) 不走代理：直接 fetch
  if (!useProxy || !useProxy.checked) {
    const resp = await fetch(url, { method: 'GET', headers });
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, text };
  }
  
  // 2) 走代理：用 /llm-proxy
  const tc = (typeof TERMINAL_CONFIG !== 'undefined') ? TERMINAL_CONFIG : null;
  if (!tc || !tc.token) {
    // 没有 token 也试直连
    const resp = await fetch(url, { method: 'GET', headers });
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, text };
  }
  const proxyUrl = tc.serverUrl.replace(/\/+$/, '') + '/llm-proxy';
  const resp = await fetch(proxyUrl, {
    method: 'POST',  // /llm-proxy 始终用 POST，靠 header 传目标
    headers: {
      'Content-Type': 'application/json',
      'X-Token': tc.token,
      'X-Target-Url': url,
      'X-Target-Method': 'GET',
      'X-Target-Headers': JSON.stringify(headers)
    },
    // /llm-proxy 期望有 body，给空对象避免有的实现报错
    body: '{}'
  });
  const text = await resp.text();
  return { ok: resp.ok, status: resp.status, text };
}

function parseModelsResponse(text, apiFormat) {
  if (!text) return [];
  let j;
  try { j = JSON.parse(text); } catch (e) { return []; }
  
  // OpenAI / 兼容：{ data: [{ id: "gpt-4o", ... }, ...] }
  if (Array.isArray(j.data)) {
    return j.data
      .map(m => (m && (m.id || m.name)) || '')
      .filter(Boolean);
  }
  // Anthropic v1/models：{ data: [{ id: "claude-...", display_name, type:"model" }] }
  // 已被上面覆盖
  
  // 兜底：有些代理直接返回数组
  if (Array.isArray(j)) {
    return j.map(m => (typeof m === 'string') ? m : (m.id || m.name || '')).filter(Boolean);
  }
  // 有些返回 { models: [...] }
  if (Array.isArray(j.models)) {
    return j.models.map(m => (typeof m === 'string') ? m : (m.id || m.name || '')).filter(Boolean);
  }
  return [];
}

function sortModelsByRelevance(models) {
  // 把"主流命名"排到前面，便于用户选择
  const PRIORITY_KEYWORDS = [
    'gpt-4o', 'gpt-4', 'o1', 'o3',
    'claude-3-5-sonnet', 'claude-3-7', 'claude-opus', 'claude-sonnet', 'claude-haiku',
    'deepseek-chat', 'deepseek-reasoner', 'deepseek-v3',
    'qwen-max', 'qwen-plus', 'qwen2.5',
    'glm-4', 'gemini-2', 'gemini-1.5',
  ];
  function score(name) {
    const lower = name.toLowerCase();
    for (let i = 0; i < PRIORITY_KEYWORDS.length; i++) {
      if (lower.includes(PRIORITY_KEYWORDS[i])) return i;
    }
    return 999;
  }
  return models.slice().sort((a, b) => {
    const sa = score(a), sb = score(b);
    if (sa !== sb) return sa - sb;
    return a.localeCompare(b);
  });
}

function renderFetchModelsList(models) {
  const listEl = document.getElementById('fetchModelsList');
  const countEl = document.getElementById('fetchModelsCount');
  if (!models.length) {
    listEl.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:20px;">无匹配模型</div>';
    if (countEl) countEl.textContent = '0 个';
    return;
  }
  const html = models.map(m => {
    const exists = _fetchModelsExisting.has(m);
    const safe = escapeHtml(m);
    return `
      <label style="display:flex;align-items:center;gap:8px;padding:6px 10px;cursor:pointer;border-radius:6px;${exists ? 'opacity:.55;' : ''}"
             onmouseover="this.style.background='var(--bg-hover)'" onmouseout="this.style.background='transparent'">
        <input type="checkbox" class="fetchModelItem" value="${safe}" ${exists ? 'checked disabled' : ''}>
        <span style="flex:1;font-family:monospace;font-size:13px;">${safe}</span>
        ${exists ? '<span style="font-size:11px;color:var(--text-secondary);">✓ 已添加</span>' : ''}
      </label>`;
  }).join('');
  listEl.innerHTML = html;
  if (countEl) {
    const newCount = models.filter(m => !_fetchModelsExisting.has(m)).length;
    countEl.textContent = `共 ${models.length} 个（${newCount} 个未添加）`;
  }
}

function filterFetchModels() {
  const kw = (document.getElementById('fetchModelsFilter').value || '').trim().toLowerCase();
  const filtered = kw
    ? _fetchModelsBuffer.filter(m => m.toLowerCase().includes(kw))
    : _fetchModelsBuffer;
  renderFetchModelsList(filtered);
}

function toggleSelectAllFetchModels() {
  const boxes = document.querySelectorAll('.fetchModelItem:not(:disabled)');
  if (!boxes.length) return;
  const anyUnchecked = Array.from(boxes).some(b => !b.checked);
  boxes.forEach(b => { b.checked = anyUnchecked; });
  const btn = document.getElementById('fetchModelsSelAllBtn');
  if (btn) btn.textContent = anyUnchecked ? '全不选' : '全选';
}

function confirmAddFetchedModels() {
  const boxes = document.querySelectorAll('.fetchModelItem:not(:disabled):checked');
  const picked = Array.from(boxes).map(b => b.value).filter(Boolean);
  if (!picked.length) { toast('未选择任何模型', 2000); return; }
  
  const input = document.getElementById('modelName');
  const existing = (input.value || '').split(',').map(s => s.trim()).filter(Boolean);
  const existingSet = new Set(existing);
  let added = 0;
  picked.forEach(m => {
    if (!existingSet.has(m)) { existing.push(m); existingSet.add(m); added++; }
  });
  input.value = existing.join(', ');
  updateContextLimitModeUI();
  
  toast(`✅ 已添加 ${added} 个模型（共 ${existing.length} 个）`, 2500);
  closeFetchModelsModal();
}

function openFetchModelsModal() {
  document.getElementById('fetchModelsModal').classList.add('show');
}

function closeFetchModelsModal() {
  document.getElementById('fetchModelsModal').classList.remove('show');
  _fetchModelsBuffer = [];
  _fetchModelsExisting = new Set();
  const f = document.getElementById('fetchModelsFilter');
  if (f) f.value = '';
}

// 暴露到全局
window.onFetchModels = onFetchModels;
window.filterFetchModels = filterFetchModels;
window.toggleSelectAllFetchModels = toggleSelectAllFetchModels;
window.confirmAddFetchedModels = confirmAddFetchedModels;
window.openFetchModelsModal = openFetchModelsModal;
window.closeFetchModelsModal = closeFetchModelsModal;
window.openContextLimitSettings = openContextLimitSettings;
window.updateContextLimitModeUI = updateContextLimitModeUI;
