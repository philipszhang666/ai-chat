// ============ Token 估算 & 精确计数 & 上下文管理 ============

const MODEL_CONTEXT_LIMITS = {
  'gpt-4o': 128000, 'gpt-4o-mini': 128000, 'gpt-4-turbo': 128000,
  'gpt-4': 8192, 'gpt-3.5-turbo': 16385,
  'claude-3-5-sonnet': 200000, 'claude-3-5-sonnet-20241022': 200000,
  'claude-3-opus': 200000, 'claude-3-haiku': 200000,
  'claude-3-haiku-20240307': 200000, 'claude-opus-4': 200000,
  'claude-opus-4-6': 200000, 'claude-sonnet-4': 200000,
  'deepseek-chat': 64000, 'deepseek-reasoner': 64000,
  'qwen-plus': 128000, 'qwen-max': 32000, 'qwen-turbo': 8000,
  'glm-4-flash': 128000, 'glm-4-plus': 128000,
  '_default': 200000
};

const CONTEXT_LIMIT_OVERRIDE_MIN = 1024;
const CONTEXT_LIMIT_OVERRIDE_MAX = 4000000;

function normalizeContextLimitOverride(value) {
  const n = parseInt(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(CONTEXT_LIMIT_OVERRIDE_MIN, Math.min(CONTEXT_LIMIT_OVERRIDE_MAX, n));
}

function getAutoContextLimit(modelName) {
  if (!modelName) return MODEL_CONTEXT_LIMITS._default;
  if (MODEL_CONTEXT_LIMITS[modelName]) return MODEL_CONTEXT_LIMITS[modelName];
  for (const key of Object.keys(MODEL_CONTEXT_LIMITS)) {
    if (key !== '_default' && modelName.toLowerCase().includes(key.toLowerCase())) {
      return MODEL_CONTEXT_LIMITS[key];
    }
  }
  return MODEL_CONTEXT_LIMITS._default;
}

function getContextLimitInfo(modelName) {
  const autoLimit = getAutoContextLimit(modelName);
  const s = (typeof state !== 'undefined' && state.settings) ? state.settings : {};
  const override = normalizeContextLimitOverride(s.contextLimitOverride);
  const manual = s.contextLimitMode === 'manual' && override > 0;
  return {
    limit: manual ? override : autoLimit,
    autoLimit,
    override,
    mode: manual ? 'manual' : 'auto',
    label: manual ? '手动指定' : '自动识别'
  };
}

function getContextLimit(modelName) {
  return getContextLimitInfo(modelName).limit;
}

// ============ 估算 Token ============
function estimateTokens(text) {
  if (!text) return 0;
  if (typeof text !== 'string') {
    try { text = JSON.stringify(text); } catch (e) { return 0; }
  }
  let tokens = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code > 0x4e00 && code < 0x9fff) tokens += 0.6;
    else if (code > 0x3000 && code < 0x303f) tokens += 0.6;
    else tokens += 0.25;
  }
  return Math.ceil(tokens);
}

function estimateMessageTokens(msg) {
  let total = 4;
  if (msg.role) total += estimateTokens(msg.role);
  if (typeof msg.content === 'string') total += estimateTokens(msg.content);
  else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part.type === 'text') total += estimateTokens(part.text);
      else if (part.type === 'image_url' || part.type === 'image') total += 850;
    }
  }
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      total += estimateTokens(tc.function?.name || '');
      total += estimateTokens(tc.function?.arguments || '');
      total += 10;
    }
  }
  if (msg.attachments) {
    for (const a of msg.attachments) {
      if (a.type === 'image') total += 850;
      if (a.text) total += estimateTokens(a.text);
    }
  }
  return total;
}

function estimateChatTokens(chat) {
  if (!chat || !chat.messages) return 0;
  const systemPrompt = typeof getEffectiveSystemPrompt === 'function'
    ? getEffectiveSystemPrompt()
    : (state.settings.systemPrompt || '');
  let total = estimateTokens(systemPrompt);
  for (const m of chat.messages) total += estimateMessageTokens(m);
  return total;
}

// ============ 精确 Token 统计（多源）============
// ⭐ 统计数据按对话独立持久化，存放在 chat.tokenStats 上
//   - 切换对话时各自保留（修复"切换对话清零"的 bug）
//   - 跟随 saveData() 写入 localStorage，刷新后仍存在

function _emptyTokenStats() {
  return {
    msgCount: 0,
    inputTokens: 0,           // 累计输入 token
    outputTokens: 0,          // 累计输出 token
    lastInputTokens: 0,       // 上次请求的输入
    lastOutputTokens: 0,      // 上次请求的输出
    cacheReadTokens: 0,       // 缓存命中（节省成本）
    cacheCreateTokens: 0,     // 缓存创建
    thinkingTokens: 0,        // extended thinking
    totalRequests: 0,         // 累计请求次数
    source: null,
    time: 0,
    // ⭐ 全局 Token 统计用：逐次记录每次 API usage，来源与对话栏统计一致
    //   旧数据没有 events 时，统计页会用累计值做一次性兼容汇总。
    events: []
  };
}

// 取/建当前对话的统计对象（按需创建并补齐缺失字段，兼容旧数据）
function getChatTokenStats(chat) {
  if (!chat) return null;
  if (!chat.tokenStats || typeof chat.tokenStats !== 'object') {
    chat.tokenStats = _emptyTokenStats();
  } else {
    const def = _emptyTokenStats();
    for (const k of Object.keys(def)) {
      if (typeof chat.tokenStats[k] === 'undefined') chat.tokenStats[k] = def[k];
    }
  }
  return chat.tokenStats;
}

let _tokenFetchTimer = null;
let _tokenFetchTimersByChat = {};
let _tokenFetchInflight = false;
let _tokenFetchInflightByChat = {};

// ============ 独立 Token 使用账本 ============
// 与对话数据分开保存：删除对话不会影响这里的历史统计。
const TOKEN_USAGE_LEDGER_KEY = 'aichat_token_usage_ledger_v1';

function loadTokenUsageLedger() {
  try {
    const raw = storage.get(TOKEN_USAGE_LEDGER_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.warn('[token-ledger] 加载失败:', e);
    return [];
  }
}

function saveTokenUsageLedger(list) {
  try {
    storage.set(TOKEN_USAGE_LEDGER_KEY, JSON.stringify(Array.isArray(list) ? list : []));
  } catch (e) {
    console.warn('[token-ledger] 保存失败:', e);
  }
}

function appendTokenUsageLedger(event) {
  if (!event) return;
  const list = loadTokenUsageLedger();
  list.push(event);
  saveTokenUsageLedger(list);
}

function migrateChatTokenStatsToLedger() {
  const ledger = loadTokenUsageLedger();
  const seen = new Set(ledger.map(e => e && e.id).filter(Boolean));
  let added = 0;
  const chats = Array.isArray(state.chats) ? state.chats : [];
  for (const chat of chats) {
    const stats = chat && chat.tokenStats;
    if (!stats || typeof stats !== 'object') continue;
    if (Array.isArray(stats.events) && stats.events.length) {
      stats.events.forEach((ev, i) => {
        const id = ev.id || `${chat.id || 'chat'}_${ev.ts || stats.time || 0}_${ev.model || 'model'}_${ev.inputTokens || 0}_${ev.outputTokens || 0}_${i}`;
        if (seen.has(id)) return;
        seen.add(id);
        ledger.push({
          id,
          chatId: chat.id || '',
          chatTitle: chat.title || '未命名对话',
          ts: ev.ts || stats.time || chat.createdAt || Date.now(),
          model: ev.model || '未知模型',
          provider: ev.provider || '',
          format: ev.format || '',
          inputTokens: Number(ev.inputTokens || 0),
          outputTokens: Number(ev.outputTokens || 0),
          cacheReadTokens: Number(ev.cacheReadTokens || 0),
          cacheCreateTokens: Number(ev.cacheCreateTokens || 0),
          thinkingTokens: Number(ev.thinkingTokens || 0),
          source: ev.source || stats.source || 'usage',
          migratedFromChat: true
        });
        added++;
      });
    } else if (stats.totalRequests > 0) {
      const id = `${chat.id || 'chat'}_legacy_${stats.time || chat.createdAt || 0}`;
      if (seen.has(id)) continue;
      seen.add(id);
      ledger.push({
        id,
        chatId: chat.id || '',
        chatTitle: chat.title || '未命名对话',
        ts: stats.time || chat.createdAt || Date.now(),
        model: '历史累计（未记录模型）',
        provider: '',
        format: '',
        inputTokens: Number(stats.inputTokens || 0),
        outputTokens: Number(stats.outputTokens || 0),
        cacheReadTokens: Number(stats.cacheReadTokens || 0),
        cacheCreateTokens: Number(stats.cacheCreateTokens || 0),
        thinkingTokens: Number(stats.thinkingTokens || 0),
        source: stats.source || 'legacy',
        _legacy: true,
        _requests: Number(stats.totalRequests || 1),
        migratedFromChat: true
      });
      added++;
    }
  }
  if (added > 0) saveTokenUsageLedger(ledger);
  return added;
}

/**
 * 从响应的 usage 字段记录详细 token 信息
 * 支持 OpenAI 和 Anthropic 两种格式
 */
function recordUsageFromResponse(chat, usage, meta = {}) {
  if (!chat || !usage) return;
  const stats = getChatTokenStats(chat);
  
  // 兼容两种格式的字段
  // Anthropic: input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens
  // OpenAI:    prompt_tokens, completion_tokens, prompt_tokens_details.cached_tokens
  
  const inputTokens = usage.input_tokens || usage.prompt_tokens || 0;
  const outputTokens = usage.output_tokens || usage.completion_tokens || 0;
  
  // 缓存（Anthropic 直接给字段；OpenAI 在 prompt_tokens_details.cached_tokens）
  const cacheRead = usage.cache_read_input_tokens 
    || usage.prompt_tokens_details?.cached_tokens 
    || 0;
  const cacheCreate = usage.cache_creation_input_tokens || 0;
  
  // 思考 token（Anthropic extended thinking / OpenAI o1 reasoning）
  const thinking = usage.output_tokens_details?.thinking_tokens 
    || usage.completion_tokens_details?.reasoning_tokens 
    || 0;
  
  const now = Date.now();
  const model = meta.model || state.settings.currentModel || 'unknown';
  
  // 累计统计（注意：累加，不是覆盖）
  stats.msgCount = chat.messages.length;
  stats.inputTokens += inputTokens;
  stats.outputTokens += outputTokens;
  stats.lastInputTokens = inputTokens;
  stats.lastOutputTokens = outputTokens;
  stats.cacheReadTokens += cacheRead;
  stats.cacheCreateTokens += cacheCreate;
  stats.thinkingTokens += thinking;
  stats.totalRequests += 1;
  stats.source = meta.source || (state.settings.apiFormat === 'anthropic' ? 'anthropic' : 'openai');
  stats.time = now;
  const usageEvent = {
    id: `usage_${now}_${Math.random().toString(36).slice(2, 10)}`,
    chatId: chat.id || '',
    chatTitle: chat.title || '未命名对话',
    ts: now,
    model,
    provider: meta.provider || state.settings.provider || '',
    format: meta.format || state.settings.apiFormat || '',
    inputTokens,
    outputTokens,
    cacheReadTokens: cacheRead,
    cacheCreateTokens: cacheCreate,
    thinkingTokens: thinking,
    source: stats.source
  };
  if (!Array.isArray(stats.events)) stats.events = [];
  stats.events.push(usageEvent);
  appendTokenUsageLedger(usageEvent);
  
  // 持久化（让累计数字跟着对话一起存到 localStorage）
  if (typeof saveData === 'function') {
    try { saveData(); } catch (e) {}
  }
  updateTokenDisplay();
}

/**
 * 通过 Anthropic count_tokens API 获取当前上下文精确大小
 */
async function fetchAnthropicTokenCount(chat) {
  const s = state.settings;
  if (s.apiFormat !== 'anthropic') return null;
  if (!s.apiKey) return null;
  
  try {
    const messages = buildAnthropicMessages(chat.messages);
    if (!messages.length) return null;
    
    const body = { model: s.currentModel, messages: messages };
    const systemPrompt = typeof getEffectiveSystemPrompt === 'function'
      ? getEffectiveSystemPrompt()
      : (s.systemPrompt || '');
    if (systemPrompt) body.system = systemPrompt;
    const tools = buildToolsArray();
    if (tools) body.tools = tools;
    
    const baseUrl = s.baseUrl.replace(/\/+$/, '');
    let path = s.apiPath;
    if (/\/messages\/?$/.test(path)) {
      path = path.replace(/\/messages\/?$/, '/messages/count_tokens');
    } else {
      path = path.replace(/\/+$/, '') + '/count_tokens';
    }
    const url = baseUrl + (path.startsWith('/') ? path : '/' + path);
    
    const resp = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify(body)
    });
    
    if (!resp.ok) {
      console.warn(`[count_tokens] HTTP ${resp.status}`);
      return null;
    }
    const ct = resp.headers.get('content-type') || '';
    if (!ct.includes('json')) return null;
    const j = await resp.json();
    return j.input_tokens || null;
  } catch (e) {
    console.warn('[count_tokens] 失败:', e.message);
    return null;
  }
}

async function refreshAccurateTokenCount(force = false, chatId) {
  const c = chatId && typeof chatById === 'function' ? chatById(chatId) : currentChat();
  if (!c || !c.messages.length) return;
  const targetChatId = c.id || chatId || state.currentId || 'default';
  const stats = getChatTokenStats(c);
  if (!force && stats.msgCount === c.messages.length
      && Date.now() - stats.time < 30000) return;
  if (_tokenFetchInflightByChat[targetChatId]) return;
  if (state.settings.apiFormat !== 'anthropic') return;
  
  _tokenFetchInflightByChat[targetChatId] = true;
  try {
    const tokens = await fetchAnthropicTokenCount(c);
    if (tokens !== null) {
      // 只更新输入快照，不动累计输出
      stats.lastInputTokens = tokens;
      stats.msgCount = c.messages.length;
      stats.time = Date.now();
      if (!stats.source) stats.source = 'anthropic_count_api';
      if (typeof isCurrentChat === 'function' ? isCurrentChat(c) : c === currentChat()) {
        updateTokenDisplay();
      }
    }
  } finally {
    delete _tokenFetchInflightByChat[targetChatId];
  }
}

function scheduleAccurateTokenCount(chatId) {
  if (state.settings.apiFormat !== 'anthropic') return;
  const targetChatId = chatId || state.currentId;
  if (!targetChatId) return;
  if (_tokenFetchTimersByChat[targetChatId]) clearTimeout(_tokenFetchTimersByChat[targetChatId]);
  _tokenFetchTimersByChat[targetChatId] = setTimeout(() => {
    delete _tokenFetchTimersByChat[targetChatId];
    refreshAccurateTokenCount(false, targetChatId);
  }, 1500);
}

// ============ 显示 Token 统计 ============

function updateTokenDisplay() {
  const el = document.getElementById('tokenStats');
  if (!el) return;
  const c = currentChat();
  if (!c || !c.messages.length) {
    el.innerHTML = '<span class="token-empty">📊 暂无对话</span>';
    return;
  }
  
  const stats = getChatTokenStats(c);
  // 看是否有当前对话的精确统计
  const hasAccurate = stats.totalRequests > 0;
  
  let inputTokens, outputTokens, cacheRead, thinking, totalRequests;
  let isAccurate, sourceLabel;
  
  if (hasAccurate) {
    inputTokens = stats.lastInputTokens;     // 当前输入
    outputTokens = stats.outputTokens;        // 累计输出
    cacheRead = stats.cacheReadTokens;
    thinking = stats.thinkingTokens;
    totalRequests = stats.totalRequests;
    isAccurate = true;
    sourceLabel = '精确值（来自 API usage）';
  } else if (stats.lastInputTokens > 0) {
    // count_tokens 拿到的输入值（但还没有真实 usage）
    inputTokens = stats.lastInputTokens;
    outputTokens = 0;
    cacheRead = 0;
    thinking = 0;
    totalRequests = 0;
    isAccurate = true;
    sourceLabel = '精确值（来自 count_tokens API）';
  } else {
    inputTokens = estimateChatTokens(c);
    outputTokens = 0;
    cacheRead = 0;
    thinking = 0;
    totalRequests = 0;
    isAccurate = false;
    sourceLabel = '估算值（可能误差 ±20%）';
  }
  
  const limitInfo = getContextLimitInfo(state.settings.currentModel);
  const limit = limitInfo.limit;
  const pct = Math.min(100, Math.round(inputTokens / limit * 100));
  const msgCount = c.messages.filter(m => m.role !== 'tool').length;
  
  let pctClass = 'safe';
  if (pct >= 80) pctClass = 'danger';
  else if (pct >= 60) pctClass = 'warning';
  
  const accuracyIcon = isAccurate ? '✓' : '~';
  
  // 构建详细信息
  let extras = '';
  if (outputTokens > 0) {
    extras += `<span class="token-count token-output" title="累计输出 token（${totalRequests} 次请求）">📤 ${formatNumber(outputTokens)}</span>`;
  }
  if (cacheRead > 0) {
    extras += `<span class="token-count token-cache" title="缓存命中（节省成本）">💾 ${formatNumber(cacheRead)}</span>`;
  }
  if (thinking > 0) {
    extras += `<span class="token-count token-thinking" title="思考 token（extended thinking）">💭 ${formatNumber(thinking)}</span>`;
  }
  
  const showRefreshBtn = state.settings.apiFormat === 'anthropic';
  
  el.innerHTML = `
    <span class="token-msgs" title="消息数">💬 ${msgCount}</span>
    <span class="token-count token-input" title="输入 token · ${sourceLabel} · 上下文${limitInfo.label}">${accuracyIcon} 📥 ${formatNumber(inputTokens)} / ${formatNumber(limit)}</span>
    ${extras}
    <div class="token-bar" title="输入 token 占上下文 ${pct}%">
      <div class="token-bar-fill ${pctClass}" style="width:${pct}%"></div>
    </div>
    <span class="token-pct ${pctClass}">${pct}%</span>
    <button class="token-compress-btn" onclick="manualCompress()" title="压缩对话历史">🗜️</button>
    <button class="token-compress-btn" onclick="showTokenDetails()" title="查看详细统计">📊</button>
    ${showRefreshBtn ? `<button class="token-compress-btn" onclick="refreshAccurateTokenCount(true)" title="从 API 获取精确值">🎯</button>` : ''}
  `;
}

function formatNumber(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return n.toString();
}

// ============ Token 详细统计弹窗 ============

function showTokenDetails() {
  const c = currentChat();
  if (!c || !c.messages.length) {
    toast('当前没有对话');
    return;
  }
  
  const stats = getChatTokenStats(c);
  const model = state.settings.currentModel;
  const limitInfo = getContextLimitInfo(model);
  const limit = limitInfo.limit;
  
  // ⭐ 从可配置定价表查价（来源：pricing.js）
  //   用户可在 ⋯ 更多 → 定价管理 中自定义。pricing.js 没加载时走简单内置 fallback。
  let pricing;
  if (typeof getPricing === 'function') {
    pricing = getPricing(model);
  } else {
    pricing = { input: 1.0, output: 3.0, cacheRead: 0.1, matched: null };
  }
  const exchangeRate = (typeof getExchangeRate === 'function') ? getExchangeRate() : 7.2;
  const showCny = (typeof shouldShowCny === 'function') ? shouldShowCny() : true;
  
  let html = `<div style="font-size:13px;line-height:1.8;">`;
  html += `<h3 style="margin:0 0 12px;font-size:15px;">📊 Token 详细统计</h3>`;
  html += `<div style="background:var(--bg-input);padding:12px;border-radius:8px;margin-bottom:12px;">`;
  html += `<div><strong>模型：</strong>${escapeHtml(model)}</div>`;
  const limitModeText = limitInfo.mode === 'manual'
    ? `手动指定，自动识别值 ${formatNumber(limitInfo.autoLimit)}`
    : '自动识别';
  html += `<div><strong>上下文限制：</strong>${formatNumber(limit)} tokens <span style="color:var(--text-secondary);">(${limitModeText})</span> <a href="javascript:void(0)" onclick="document.getElementById('tokenDetailModal') && document.getElementById('tokenDetailModal').classList.remove('show'); if (typeof openContextLimitSettings === 'function') openContextLimitSettings();" style="margin-left:6px;">设置</a></div>`;
  html += `<div><strong>消息数：</strong>${c.messages.length}</div>`;
  html += `</div>`;
  
  if (stats && stats.totalRequests > 0) {
    html += `<h4 style="margin:12px 0 8px;font-size:14px;">📈 本对话累计</h4>`;
    html += `<div style="background:var(--bg-input);padding:12px;border-radius:8px;">`;
    html += `<table style="width:100%;font-size:13px;">`;
    html += `<tr><td>📊 总请求次数</td><td style="text-align:right;font-family:monospace;">${stats.totalRequests}</td></tr>`;
    html += `<tr><td>📥 累计输入 token</td><td style="text-align:right;font-family:monospace;">${formatNumber(stats.inputTokens)}</td></tr>`;
    html += `<tr><td>📤 累计输出 token</td><td style="text-align:right;font-family:monospace;">${formatNumber(stats.outputTokens)}</td></tr>`;
    if (stats.cacheReadTokens > 0) {
      html += `<tr><td>💾 缓存命中（节省）</td><td style="text-align:right;font-family:monospace;color:var(--success);">${formatNumber(stats.cacheReadTokens)}</td></tr>`;
    }
    if (stats.cacheCreateTokens > 0) {
      html += `<tr><td>💾 缓存创建</td><td style="text-align:right;font-family:monospace;">${formatNumber(stats.cacheCreateTokens)}</td></tr>`;
    }
    if (stats.thinkingTokens > 0) {
      html += `<tr><td>💭 思考 token</td><td style="text-align:right;font-family:monospace;">${formatNumber(stats.thinkingTokens)}</td></tr>`;
    }
    html += `<tr style="border-top:1px solid var(--border);"><td><strong>总计</strong></td><td style="text-align:right;font-family:monospace;"><strong>${formatNumber(stats.inputTokens + stats.outputTokens)}</strong></td></tr>`;
    html += `</table></div>`;
    
    html += `<h4 style="margin:12px 0 8px;font-size:14px;display:flex;align-items:center;gap:8px;">💰 估算费用（参考） <span style="font-size:11px;font-weight:normal;color:var(--text-secondary);">${pricing.matched ? '匹配关键词：<code>' + escapeHtml(pricing.matched) + '</code>' : '⚠️ 未匹配，使用默认价'}<a href="javascript:void(0)" onclick="document.getElementById('tokenDetailModal') && document.getElementById('tokenDetailModal').classList.remove('show'); openPricingManager && openPricingManager();" style="margin-left:6px;">编辑</a></span></h4>`;
    html += `<div style="background:var(--bg-input);padding:12px;border-radius:8px;font-size:12px;">`;
    
    const costInput = (stats.inputTokens - stats.cacheReadTokens) * pricing.input / 1000000;
    const costOutput = stats.outputTokens * pricing.output / 1000000;
    const costCache = stats.cacheReadTokens * pricing.cacheRead / 1000000;
    const total = costInput + costOutput + costCache;
    const saved = stats.cacheReadTokens * (pricing.input - pricing.cacheRead) / 1000000;
    
    html += `<div>输入费用：$${costInput.toFixed(6)} (${formatNumber(stats.inputTokens - stats.cacheReadTokens)} × $${pricing.input}/M)</div>`;
    if (costCache > 0) {
      html += `<div>缓存费用：$${costCache.toFixed(6)} (${formatNumber(stats.cacheReadTokens)} × $${pricing.cacheRead}/M)</div>`;
    }
    html += `<div>输出费用：$${costOutput.toFixed(6)} (${formatNumber(stats.outputTokens)} × $${pricing.output}/M)</div>`;
    html += `<div style="border-top:1px solid var(--border);margin-top:6px;padding-top:6px;"><strong>总计：$${total.toFixed(6)}</strong>${showCny ? ` ≈ ¥${(total * exchangeRate).toFixed(4)}` : ''}</div>`;
    if (saved > 0) {
      html += `<div style="color:var(--success);margin-top:4px;">💚 缓存节省：$${saved.toFixed(6)}</div>`;
    }
    html += `<div style="margin-top:6px;font-size:11px;color:var(--text-secondary);">⚠️ 价格仅供参考，以服务商实际计费为准</div>`;
    html += `</div>`;
    
    if (stats.lastInputTokens > 0) {
      html += `<h4 style="margin:12px 0 8px;font-size:14px;">⏱ 最近一次请求</h4>`;
      html += `<div style="background:var(--bg-input);padding:12px;border-radius:8px;">`;
      html += `<div>📥 输入：${formatNumber(stats.lastInputTokens)} tokens</div>`;
      html += `<div>📤 输出：${formatNumber(stats.lastOutputTokens)} tokens</div>`;
      html += `</div>`;
    }
  } else {
    html += `<div style="padding:20px;text-align:center;color:var(--text-secondary);">还没有发送过请求</div>`;
  }
  
  html += `<div style="margin-top:16px;font-size:12px;color:var(--text-secondary);">`;
  html += `💡 提示：缓存命中能大幅降低成本（Anthropic 缓存读取约为正常输入价的 1/10）`;
  html += `</div></div>`;
  
  // 显示在一个简单的模态框里
  showTokenModal(html);
}

function showTokenModal(html) {
  let modal = document.getElementById('tokenDetailModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'tokenDetailModal';
    modal.className = 'modal-mask';
    modal.innerHTML = `
      <div class="modal" style="width:480px;">
        <div id="tokenDetailContent"></div>
        <div class="modal-footer">
          <button class="btn" onclick="document.getElementById('tokenDetailModal').classList.remove('show')">关闭</button>
          <button class="btn" onclick="resetTokenStats()">🔄 重置统计</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
  }
  document.getElementById('tokenDetailContent').innerHTML = html;
  modal.classList.add('show');
}

function resetTokenStats() {
  if (!confirm('重置当前对话的 token 统计？\n（不影响实际对话内容，其它对话的统计不动）')) return;
  const c = currentChat();
  if (c) {
    c.tokenStats = _emptyTokenStats();
    if (typeof saveData === 'function') saveData();
  }
  updateTokenDisplay();
  document.getElementById('tokenDetailModal').classList.remove('show');
  toast('✓ 已重置');
}

// ============ 压缩对话 ============

const COMPRESSION_UNDO_TTL_MS = 30 * 60 * 1000;
const _compressionUndoSnapshots = {};

function compressionJsonClone(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch (e) { return value; }
}

function cleanupCompressionUndoSnapshots() {
  const now = Date.now();
  for (const id of Object.keys(_compressionUndoSnapshots)) {
    const snap = _compressionUndoSnapshots[id];
    if (!snap || now - snap.createdAt > COMPRESSION_UNDO_TTL_MS) {
      delete _compressionUndoSnapshots[id];
    }
  }
}

function rememberCompressionUndo(chat, compressedMessages, meta = {}) {
  cleanupCompressionUndoSnapshots();
  const id = `cmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  _compressionUndoSnapshots[id] = {
    chatId: chat?.id || null,
    createdAt: Date.now(),
    compressedMessages: compressionJsonClone(compressedMessages),
    meta: { ...meta }
  };
  return id;
}

function canUndoCompression(undoId, chat) {
  cleanupCompressionUndoSnapshots();
  const snap = undoId ? _compressionUndoSnapshots[undoId] : null;
  if (!snap) return false;
  return !snap.chatId || !chat || snap.chatId === chat.id;
}

function undoCompressionSnapshot(undoId) {
  const c = currentChat();
  const snap = undoId ? _compressionUndoSnapshots[undoId] : null;
  if (!c || !snap || (snap.chatId && snap.chatId !== c.id)) {
    toast('压缩快照已失效，无法撤销');
    return;
  }
  const summaryIdx = c.messages.findIndex(m => m && m._isSummary && m._compressionUndoId === undoId);
  if (summaryIdx < 0) {
    toast('未找到对应的压缩摘要，无法撤销');
    return;
  }
  if (!confirm(`撤销这次压缩？\n\n会把摘要还原为原来的 ${snap.compressedMessages.length} 条消息，摘要之后的新消息会保留。`)) {
    return;
  }
  const restored = compressionJsonClone(snap.compressedMessages);
  c.messages.splice(summaryIdx, 1, ...restored);
  delete _compressionUndoSnapshots[undoId];
  
  const stats = getChatTokenStats(c);
  stats.lastInputTokens = 0;
  stats.msgCount = c.messages.length;
  stats.time = 0;
  
  saveData();
  renderChatList();
  renderMessages();
  updateTokenDisplay();
  if (typeof scheduleAccurateTokenCount === 'function') scheduleAccurateTokenCount(c.id);
  toast(`已撤销压缩，恢复 ${restored.length} 条消息`);
}

function compressionString(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try { return JSON.stringify(value, null, 2); } catch (e) { return String(value); }
}

function middleTrimText(text, maxChars) {
  const s = compressionString(text);
  if (s.length <= maxChars) return s;
  const head = Math.floor(maxChars * 0.45);
  const tail = Math.floor(maxChars * 0.45);
  return `${s.slice(0, head)}\n\n[中间省略约 ${s.length - head - tail} 字符]\n\n${s.slice(-tail)}`;
}

const COMPRESSION_REQUIRED_HEADINGS = [
  '当前任务',
  '用户目标和约束',
  '已完成事项',
  '关键决策和事实',
  '已查看或修改的文件',
  '工具/命令结果',
  '计划/大纲状态',
  '测试和验证状态',
  '未完成事项',
  '风险/阻塞',
  '下一步建议',
  '可丢弃上下文'
];

function compressHeadingSet(text) {
  const headings = new Set();
  for (const line of compressionString(text).split(/\r?\n/)) {
    const m = line.match(/^\s*#{1,4}\s+(.+?)\s*$/);
    if (m) headings.add(m[1].replace(/[：:]+$/, '').trim());
  }
  return headings;
}

function compressionExtractArtifactIds(text) {
  const out = new Set();
  const s = compressionString(text);
  for (const m of s.matchAll(/\btool_art_\d+_[a-z0-9]+\b/gi)) out.add(m[0]);
  for (const m of s.matchAll(/\bartifact_id\s*[:=]\s*([A-Za-z0-9_-]+)/gi)) out.add(m[1]);
  return out;
}

function compressionExtractCheckpointIds(text) {
  const out = new Set();
  const s = compressionString(text);
  for (const m of s.matchAll(/\bckpt_\d{8}_\d{6}_[A-Za-z0-9]+\b/g)) out.add(m[0]);
  for (const m of s.matchAll(/\bcheckpoint(?:_id|Id)?\s*["']?\s*[:=]\s*["']?([A-Za-z0-9_-]*ckpt_[A-Za-z0-9_-]+|[A-Za-z0-9_-]{8,})/gi)) {
    const id = m[1].replace(/["',，。；;]+$/, '');
    if (/ckpt_|checkpoint/i.test(id)) out.add(id);
  }
  return out;
}

function compressionExtractFilePaths(text) {
  const out = new Set();
  const s = compressionString(text);
  const pathRe = /(?:^|[\s"'([{])((?:[A-Za-z]:[\\/])?(?:\.{1,2}[\\/])?(?:[\w\u4e00-\u9fa5 .@()+-]+[\\/])+[\w\u4e00-\u9fa5 .@()+-]+\.(?:js|ts|jsx|tsx|py|java|c|cpp|h|hpp|cs|go|rs|rb|php|html|css|scss|json|md|yml|yaml|toml|ini|sql|sh|bat|ps1|txt|csv|xml|vue|svelte|tsx?))/g;
  for (const m of s.matchAll(pathRe)) {
    const p = m[1].replace(/[),.;:，。；]+$/, '');
    if (p.length >= 4 && p.length <= 240) out.add(p);
  }
  const backtickRe = /`([^`\n]+\.(?:js|ts|jsx|tsx|py|java|c|cpp|h|hpp|cs|go|rs|rb|php|html|css|scss|json|md|yml|yaml|toml|ini|sql|sh|bat|ps1|txt|csv|xml|vue|svelte))`/g;
  for (const m of s.matchAll(backtickRe)) out.add(m[1]);
  return out;
}

function compressionRefsFromMessage(m) {
  const textParts = [];
  textParts.push(m.content || '');
  if (m._artifactId) textParts.push(m._artifactId);
  if (m._artifactMeta) textParts.push(m._artifactMeta);
  if (m.attachments?.length) textParts.push(m.attachments.map(a => a.name || a.path || '').join('\n'));
  if (m.tool_calls?.length) textParts.push(m.tool_calls.map(tc => `${tc.function?.name || tc.name || ''}\n${tc.function?.arguments || tc.arguments || ''}`).join('\n'));
  if (m.plan) textParts.push(m.plan);
  if (m.outline) textParts.push(m.outline);
  if (m.reflection) textParts.push(m.reflection);
  const combined = textParts.map(compressionString).join('\n');
  return {
    artifactIds: compressionExtractArtifactIds(combined),
    checkpointIds: compressionExtractCheckpointIds(combined),
    filePaths: compressionExtractFilePaths(combined)
  };
}

function compressionCollectRequiredRefs(messages) {
  const refs = {
    artifactIds: new Set(),
    checkpointIds: new Set(),
    filePaths: new Set()
  };
  for (const m of messages || []) {
    const r = compressionRefsFromMessage(m || {});
    for (const id of r.artifactIds) refs.artifactIds.add(id);
    for (const id of r.checkpointIds) refs.checkpointIds.add(id);
    for (const p of r.filePaths) refs.filePaths.add(p);
  }
  return refs;
}

function compressionMissingRefs(summary, refs) {
  const s = compressionString(summary);
  const missing = {
    artifactIds: [],
    checkpointIds: [],
    filePaths: []
  };
  for (const id of refs.artifactIds || []) if (!s.includes(id)) missing.artifactIds.push(id);
  for (const id of refs.checkpointIds || []) if (!s.includes(id)) missing.checkpointIds.push(id);
  for (const p of refs.filePaths || []) if (!s.includes(p)) missing.filePaths.push(p);
  return missing;
}

function compressionValidateSummary(summary, refs) {
  const headings = compressHeadingSet(summary);
  const missingHeadings = COMPRESSION_REQUIRED_HEADINGS.filter(h => !headings.has(h));
  const missingRefs = compressionMissingRefs(summary, refs);
  const missingRefCount = missingRefs.artifactIds.length + missingRefs.checkpointIds.length + missingRefs.filePaths.length;
  return {
    ok: missingHeadings.length === 0 && missingRefCount === 0,
    missingHeadings,
    missingRefs,
    missingRefCount
  };
}

function compressionValidationFeedback(validation) {
  const lines = [];
  if (validation.missingHeadings.length) {
    lines.push(`缺少固定标题：${validation.missingHeadings.map(h => `## ${h}`).join('，')}`);
  }
  if (validation.missingRefs.artifactIds.length) {
    lines.push(`必须保留 artifact_id：${validation.missingRefs.artifactIds.join(', ')}`);
  }
  if (validation.missingRefs.checkpointIds.length) {
    lines.push(`必须保留 checkpoint_id：${validation.missingRefs.checkpointIds.join(', ')}`);
  }
  if (validation.missingRefs.filePaths.length) {
    lines.push(`必须保留文件路径：${validation.missingRefs.filePaths.slice(0, 80).join(', ')}`);
  }
  return lines.join('\n');
}

function compressionBudgetInfo(chat, extraMessages = []) {
  const c = chat || currentChat();
  let tokens = c ? estimateChatTokens(c) : 0;
  for (const m of extraMessages || []) tokens += estimateMessageTokens(m || {});
  const limit = getContextLimit(state.settings.currentModel);
  const pct = tokens / limit * 100;
  const threshold = state.settings.compressAutoThreshold || 75;
  const maxOutput = Math.max(0, parseInt(state.settings.maxTokens) || 0);
  const safetyBuffer = Math.max(1024, Math.min(8192, Math.round(limit * 0.03)));
  const reserve = maxOutput + safetyBuffer;
  const remaining = limit - tokens;
  return {
    tokens,
    limit,
    pct,
    threshold,
    reserve,
    remaining,
    needsCompression: pct >= threshold || remaining < reserve
  };
}

function findTransientCompressionCut(messages, keepLast) {
  const list = messages || [];
  if (list.length < Math.max(4, keepLast + 2)) return -1;
  const initialCutIdx = Math.max(0, list.length - keepLast);
  for (let i = initialCutIdx; i < list.length; i++) {
    if (list[i] && list[i].role !== 'tool') return i;
  }
  for (let i = initialCutIdx - 1; i > 0; i--) {
    if (list[i] && list[i].role !== 'tool') return i;
  }
  return -1;
}

async function compressTransientMessagesForAgent(messages, options = {}) {
  if (!Array.isArray(messages) || messages.length < 6) return false;
  if (typeof callOnceWithRole !== 'function') return false;
  const keepLast = Math.max(4, parseInt(options.keepLast) || Math.max(6, state.settings.compressKeepLast || 4));
  const preserveFirstUser = !!options.preserveFirstUser;
  const preserved = [];
  let workMessages = messages;
  if (preserveFirstUser && messages[0] && messages[0].role === 'user') {
    preserved.push(messages[0]);
    workMessages = messages.slice(1);
  }
  const cutIdx = findTransientCompressionCut(workMessages, keepLast);
  if (cutIdx <= 0) return false;
  
  const rawToCompress = workMessages.slice(0, cutIdx);
  const toCompress = archiveLongToolMessagesForCompression(rawToCompress, options.chat || null);
  const toKeep = workMessages.slice(cutIdx);
  const realMessages = toCompress.filter(m => !m._isSummary && !m._isCompressing);
  if (!realMessages.length) return false;
  
  const requiredRefs = compressionCollectRequiredRefs(toCompress);
  const label = options.label || '内部工具循环';
  const conversationText = middleTrimText(
    realMessages.map((m, idx) => formatMessageForCompression(m, idx)).join('\n\n'),
    50000
  );
  const compressPrompt = `你正在为一个长流程 agent 压缩“${label}”中的内部历史。这个摘要会替代旧的内部工具循环记录，并继续参与后续模型请求。

要求：
- 不要编造；不知道或没有就写“无”。
- 所有 artifact_id、checkpoint_id 和重要文件路径必须逐字保留。
- 如果看到“[工具结果已归档]”，必须保留 artifact_id，并说明可用 read_tool_artifact 读取。
- 保留工具调用结果、用户约束、关键错误、已验证事项和下一步。
- 严格使用下面的 Markdown 结构输出：

## 当前任务
## 用户目标和约束
## 已完成事项
## 关键决策和事实
## 已查看或修改的文件
## 工具/命令结果
## 计划/大纲状态
## 测试和验证状态
## 未完成事项
## 风险/阻塞
## 下一步建议
## 可丢弃上下文

【需要压缩的内部历史】
${conversationText}

请输出结构化内部上下文摘要：`;
  
  let summary = await callOnceWithRole(
    [{ role: 'user', content: compressPrompt }],
    state.settings.currentModel,
    '你是一个严谨的长流程 agent 内部上下文压缩器，必须保留可继续执行的关键信息。'
  );
  if (!summary || !String(summary).trim()) throw new Error(`${label} 内部压缩返回空摘要`);
  let finalSummary = String(summary).trim();
  let validation = compressionValidateSummary(finalSummary, requiredRefs);
  if (!validation.ok) {
    const feedback = compressionValidationFeedback(validation);
    const retryPrompt = `${compressPrompt}

【上一次摘要】
${finalSummary}

【校验失败】
${feedback}

请重写摘要，只输出修正后的结构化摘要。`;
    summary = await callOnceWithRole(
      [{ role: 'user', content: retryPrompt }],
      state.settings.currentModel,
      '你正在修复未通过校验的内部上下文摘要，必须保留指定引用。'
    );
    if (!summary || !String(summary).trim()) throw new Error(`${label} 内部压缩重写返回空摘要`);
    finalSummary = String(summary).trim();
    validation = compressionValidateSummary(finalSummary, requiredRefs);
  }
  if (!validation.ok) {
    throw new Error(`${label} 内部摘要校验失败：${compressionValidationFeedback(validation)}`);
  }
  
  const summaryMsg = {
    role: 'user',
    content: `【${label}历史摘要】（自动压缩 ${toCompress.length} 条内部消息）\n\n${finalSummary}`,
    _isTransientSummary: true,
    _originalCount: toCompress.length,
    _compressTime: Date.now()
  };
  messages.splice(0, messages.length, ...preserved, summaryMsg, ...toKeep);
  return true;
}

function archiveLongToolMessagesForCompression(messages, chat) {
  if (typeof prepareToolResultForContext !== 'function') return messages;
  return (messages || []).map(m => {
    if (!m || m.role !== 'tool' || m._artifactId) return m;
    const content = compressionString(m.content || '');
    const prepared = prepareToolResultForContext({
      content,
      toolName: m.name || 'tool',
      toolCallId: m.tool_call_id || '',
      chatId: chat?.id || '',
      chat,
      status: m.status || 'success',
      args: { compression_backfill: true }
    });
    if (!prepared || !prepared.archived) return m;
    return {
      ...m,
      content: prepared.content,
      _artifactId: prepared.artifactId,
      _artifactMeta: prepared.artifactMeta,
      _compressionBackfilledArtifact: true
    };
  });
}

function formatMessageForCompression(m, idx) {
  const role = m.role === 'user' ? '用户'
    : (m.role === 'assistant' ? 'AI'
      : (m.role === 'tool' ? '工具结果' : (m.role || '消息')));
  const blocks = [`### ${idx + 1}. ${role}`];
  const content = middleTrimText(m.content || '', m.role === 'tool' ? 2200 : 1800).trim();
  if (content) blocks.push(content);
  
  if (m.attachments?.length) {
    const atts = m.attachments.map(a => {
      const flags = [];
      if (a._fromAI) flags.push('AI生成');
      if (a._stripped) flags.push('数据已剥离');
      return `- ${a.name || a.id || 'attachment'} (${a.mime || a.type || 'unknown'}, ${formatSize(a.size || 0)}${flags.length ? ', ' + flags.join(', ') : ''})`;
    }).join('\n');
    blocks.push(`[附件]\n${atts}`);
  }
  
  if (m.tool_calls?.length) {
    const calls = m.tool_calls.map(tc => {
      const name = tc.function?.name || tc.name || 'unknown_tool';
      const args = middleTrimText(tc.function?.arguments || tc.arguments || '', 1000);
      return `- ${name}${args ? `\n  参数: ${args}` : ''}`;
    }).join('\n');
    blocks.push(`[工具调用]\n${calls}`);
  }
  
  if (m.name || m.tool_call_id) {
    blocks.push(`[工具元信息] name=${m.name || ''} tool_call_id=${m.tool_call_id || ''}`);
  }
  if (m.plan) {
    blocks.push(`[计划状态]\n${middleTrimText(m.plan, 1800)}`);
  }
  if (m.outline) {
    blocks.push(`[大纲状态]\n${middleTrimText(m.outline, 2200)}`);
  }
  if (m.reflection) {
    blocks.push(`[反思/评审状态]\n${middleTrimText(m.reflection, 1400)}`);
  }
  
  return blocks.join('\n');
}

async function manualCompress() {
  const c = currentChat();
  if (!c || c.messages.length < 4) { toast('对话太短，无需压缩'); return; }
  if (!state.settings.apiKey) { toast('请先配置 API Key'); return; }
  if (!confirm(`确定要压缩当前对话历史吗？\n\n会保留最近 ${state.settings.compressKeepLast || 4} 条消息，前面的对话会被 AI 总结成结构化摘要。\n\n压缩完成后可在摘要卡片撤销（刷新页面前有效）。`)) return;
  await compressChat(c, { reason: 'manual' });
}

async function autoCompressCheck(chat = null, options = {}) {
  if (!state.settings.compressAutoEnabled) return false;
  const c = chat || currentChat();
  if (!c || c.messages.length < 6) return false;
  
  // 自动压缩必须看当前消息数组。stats.lastInputTokens 可能是上一轮请求的精确值，
  // 在新 user 消息刚入队时已经过期。
  const tokens = estimateChatTokens(c);
  
  const limit = getContextLimit(state.settings.currentModel);
  const pct = tokens / limit * 100;
  const threshold = state.settings.compressAutoThreshold || 75;
  const maxOutput = Math.max(0, parseInt(state.settings.maxTokens) || 0);
  const safetyBuffer = Math.max(1024, Math.min(8192, Math.round(limit * 0.03)));
  const reserve = maxOutput + safetyBuffer;
  const remaining = limit - tokens;
  if (pct >= threshold || remaining < reserve) {
    const reason = pct >= threshold
      ? `上下文已达 ${Math.round(pct)}%`
      : `剩余上下文不足 ${formatNumber(reserve)} token`;
    toast(`📦 ${reason}，自动压缩中...`, 3000);
    const ok = await compressChat(c, {
      reason: 'auto',
      estimatedBefore: tokens,
      pct,
      reserve,
      preserveGeneratingState: !!options.preserveGeneratingState
    });
    return ok ? true : 'failed';
  }
  return false;
}

async function ensureContextBeforeAgentRun(chat = null, options = {}) {
  if (!state.settings.compressAutoEnabled) return true;
  if (typeof autoCompressCheck !== 'function') return true;
  const c = chat || currentChat();
  const extraMessages = Array.isArray(options.extraMessages) ? options.extraMessages : [];
  if ((!c || !c.messages || !c.messages.length) && !extraMessages.length) return true;
  if (extraMessages.length) {
    const budget = compressionBudgetInfo(c, extraMessages);
    if (budget.needsCompression && Array.isArray(options.mutableMessages) && typeof compressTransientMessagesForAgent === 'function') {
      await compressTransientMessagesForAgent(options.mutableMessages, {
        label: options.label || '内部工具循环',
        chat: c,
        preserveFirstUser: !!options.preserveFirstUser
      });
    }
  }
  if (!c || !c.messages || !c.messages.length) return true;
  const result = await autoCompressCheck(c, {
    preserveGeneratingState: options.preserveGeneratingState !== false
  });
  if (result === 'failed') {
    const label = options.label ? `（${options.label}）` : '';
    if (typeof toast === 'function') {
      toast(`自动压缩失败${label}，已暂停本次请求以避免超长上下文`, 4000);
    }
    return false;
  }
  return true;
}

async function compressChat(chat, options = {}) {
  const keepLast = Math.max(2, parseInt(state.settings.compressKeepLast) || 4);
  const sourceMessages = (chat.messages || []).filter(m => !m._isCompressing);
  const estimatedBefore = options.estimatedBefore || estimateChatTokens(chat);
  const prevGenerating = !!state.isGenerating;
  const prevAbortCtrl = state.abortCtrl || null;
  
  // ⭐ 切点策略：toKeep 必须以 user 消息开头（且不能是摘要消息）
  //   否则压缩后会出现 assistant(tool_calls) 紧跟摘要的情况，
  //   导致摘要 text 块被 prepend 到 tool_result 前面 → Anthropic 报
  //   "tool_use ids were found without tool_result blocks immediately after"
  //
  // 算法（双向查找，避免末尾全是 tool/assistant 时找不到切点）：
  //   1) 先尝试在 [length-keepLast, end) 范围内向后找第一条真实 user 消息
  //      —— 命中：正好保留约 keepLast 条
  //   2) 找不到（末尾全是工具循环 / assistant 收尾）→ 从末尾向前找最近一条真实 user
  //      —— 这种情况会"多保留几条"，但能保证压缩成功而不是直接报错
  const initialCutIdx = Math.max(0, sourceMessages.length - keepLast);
  const isRealUser = (m) => m && m.role === 'user' && !m._isSummary;
  
  let cutIdx = -1;
  // 第 1 步：向后找
  for (let i = initialCutIdx; i < sourceMessages.length; i++) {
    if (isRealUser(sourceMessages[i])) { cutIdx = i; break; }
  }
  // 第 2 步：向后没找到 → 向前找（兜底，保留更多消息但能成功压缩）
  if (cutIdx < 0) {
    for (let i = sourceMessages.length - 1; i >= 0; i--) {
      if (isRealUser(sourceMessages[i])) { cutIdx = i; break; }
    }
  }
  
  if (cutIdx < 0) {
    toast('对话里没有任何 user 消息，无法压缩');
    return false;
  }
  if (cutIdx <= 0) {
    toast('对话太短，无需压缩');
    return false;
  }
  
  const rawToCompress = sourceMessages.slice(0, cutIdx);
  const toCompress = archiveLongToolMessagesForCompression(rawToCompress, chat);
  const toKeep = sourceMessages.slice(cutIdx);
  const previousSummary = toCompress
    .filter(m => m._isSummary)
    .map(m => m.content || '')
    .filter(Boolean)
    .join('\n\n');
  const realMessages = toCompress.filter(m => !m._isSummary && !m._isCompressing);
  if (!realMessages.length) {
    toast('没有新的历史内容需要压缩');
    return false;
  }
  const requiredRefs = compressionCollectRequiredRefs(toCompress);
  
  const conversationText = middleTrimText(
    realMessages.map((m, idx) => formatMessageForCompression(m, idx)).join('\n\n'),
    70000
  );
  
  const compressPrompt = `${previousSummary ? '【已有摘要】\n' + previousSummary + '\n\n' : ''}你正在为一个会调用工具、读写项目文件的 AI agent 压缩上下文。
目标：丢弃噪声，但保留之后继续执行任务所需的事实、约束、文件路径、命令结果、用户决定、权限/拒绝记录、计划/大纲状态和验证状态。

要求：
- 不要编造；不知道或没有就写“无”。
- 文件路径、函数名、命令、错误信息、checkpoint/回滚信息必须尽量原样保留。
- 摘要应紧凑，但要足够让后续模型不用重读全部历史也能继续工作。
- 所有 artifact_id、checkpoint_id 和重要文件路径必须逐字保留，不得改写。
- 如果看到“[工具结果已归档]”，必须在“工具/命令结果”或“下一步建议”里保留对应 artifact_id，并说明可用 read_tool_artifact 读取。
- 如果某些内容只适合按需重读，请写入“下一步建议”或“可丢弃上下文”。
- 严格使用下面的 Markdown 结构输出：

## 当前任务
## 用户目标和约束
## 已完成事项
## 关键决策和事实
## 已查看或修改的文件
## 工具/命令结果
## 计划/大纲状态
## 测试和验证状态
## 未完成事项
## 风险/阻塞
## 下一步建议
## 可丢弃上下文

【需要总结的对话】
${conversationText}

请输出结构化上下文摘要：`;

  const undoId = rememberCompressionUndo(chat, rawToCompress, {
    originalCount: toCompress.length,
    reason: options.reason || 'manual',
    estimatedBefore
  });
  chat.messages.push({ role: 'assistant', content: '🗜️ 正在压缩对话历史...', _isCompressing: true });
  renderMessages();
  
  // ⭐ 用闭包函数代替 pop()，避免误删用户消息
  const removeCompressingPlaceholder = () => {
    const idx = chat.messages.findIndex(m => m._isCompressing);
    if (idx >= 0) chat.messages.splice(idx, 1);
  };
  
  try {
    state.isGenerating = true;
    updateSendBtn();
    const summary = await callOnceWithRole(
      [{ role: 'user', content: compressPrompt }],
      state.settings.currentModel,
      '你是一个严谨的上下文压缩器，专门为长任务 agent 保留可继续执行的关键信息。'
    );
    if (!summary || !String(summary).trim()) {
      throw new Error('压缩模型返回了空摘要');
    }
    let finalSummary = String(summary).trim();
    let validation = compressionValidateSummary(finalSummary, requiredRefs);
    if (!validation.ok) {
      const feedback = compressionValidationFeedback(validation);
      const retryPrompt = `${compressPrompt}

【上一次摘要】
${finalSummary}

【校验失败】
${feedback}

请重写摘要。要求：
- 必须补齐全部固定标题。
- 必须逐字保留上面列出的 artifact_id / checkpoint_id / 文件路径。
- 不要解释校验过程，只输出修正后的结构化摘要。`;
      const retrySummary = await callOnceWithRole(
        [{ role: 'user', content: retryPrompt }],
        state.settings.currentModel,
        '你是一个严谨的上下文压缩器。你正在修复一份未通过校验的摘要，必须保留指定引用。'
      );
      if (!retrySummary || !String(retrySummary).trim()) {
        throw new Error('摘要校验失败，重写返回空结果');
      }
      finalSummary = String(retrySummary).trim();
      validation = compressionValidateSummary(finalSummary, requiredRefs);
    }
    if (!validation.ok) {
      throw new Error(`摘要校验失败：${compressionValidationFeedback(validation)}`);
    }
    removeCompressingPlaceholder();
    
    const summaryMsg = {
      role: 'system',
      content: `【对话历史摘要】（由 AI ${options.reason === 'auto' ? '自动' : '手动'}压缩，原 ${toCompress.length} 条消息）\n\n${finalSummary}`,
      _isSummary: true,
      _originalCount: toCompress.length,
      _compressTime: Date.now(),
      _compressionReason: options.reason || 'manual',
      _compressionUndoId: undoId,
      _estimatedBefore: estimatedBefore
    };
    chat.messages = [summaryMsg, ...toKeep];
    summaryMsg._estimatedAfter = estimateChatTokens(chat);
    
    // 清除精确统计缓存（消息变了）
    const compStats = getChatTokenStats(chat);
    compStats.lastInputTokens = 0;
    compStats.msgCount = chat.messages.length;
    compStats.time = 0;
    
    saveData();
    renderMessages();
    updateTokenDisplay();
    scheduleAccurateTokenCount(chat.id);
    const saved = Math.max(0, estimatedBefore - summaryMsg._estimatedAfter);
    toast(`✓ 已压缩 ${toCompress.length} 条消息，预计节省 ${formatNumber(saved)} token`);
    return true;
  } catch (e) {
    delete _compressionUndoSnapshots[undoId];
    removeCompressingPlaceholder();
    renderMessages();
    toast(`❌ 压缩失败：${e.message}`, 3000);
    return false;
  } finally {
    if (options.preserveGeneratingState) {
      state.isGenerating = prevGenerating;
      state.abortCtrl = prevAbortCtrl;
    } else {
      state.isGenerating = false;
      state.abortCtrl = null;
    }
    updateSendBtn();
  }
}
