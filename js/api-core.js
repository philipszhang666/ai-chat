// ============ 🔌 API - 请求构造 + 核心调用 + 响应处理 ============
// 【模块定位】buildRequestBody/Headers + callAPI + handleStream/NonStream + callOnceWithRole
// 依赖：api-adapters.js（buildOpenAIMessages / buildAnthropicMessages / fixAnthropicMessageSequence）
//       state.js / chat.js / tools.js / api-stream.js（updateLastMsg）
// 加载顺序：在 api-adapters.js 之后

function buildRequestBody(history, modelOverride, streamOverride, options = {}) {
  const s = state.settings;
  const model = modelOverride || s.currentModel;
  const stream = streamOverride !== undefined ? streamOverride : !!s.stream;
  
  // ⭐ system 保持稳定（不混入动态摘要），最大化 prompt cache 命中率
  // 摘要由各适配器自行注入到 messages 数组中（OpenAI: 作为 system message；Anthropic: prepend 到首条 user）
  const systemContent = typeof getEffectiveSystemPrompt === 'function'
    ? getEffectiveSystemPrompt()
    : (s.systemPrompt || '');
  
  // 准备所有占位符的值
  const apiMessages = s.apiFormat === 'anthropic' 
    ? buildAnthropicMessages(history)
    : (s.apiFormat === 'responses' ? buildOpenAIResponsesInput(history) : buildOpenAIMessages(history));
  const toolsEnabled = options.useTools !== undefined ? !!options.useTools : !!s.useTools;
  const tools = toolsEnabled ? buildToolsArray({ force: true }) : null;
  
  // ⭐ 先构造默认请求体
  let body;
  if (s.apiFormat === 'anthropic') {
    body = {
      model,
      messages: apiMessages,
      max_tokens: parseInt(s.maxTokens),
      temperature: parseFloat(s.temperature),
      stream
    };
    if (systemContent) body.system = systemContent;
    if (tools) body.tools = tools;
  } else if (s.apiFormat === 'responses') {
    body = {
      model,
      input: apiMessages,
      temperature: parseFloat(s.temperature),
      max_output_tokens: parseInt(s.maxTokens),
      stream
    };
    if (systemContent) body.instructions = systemContent;
    if (tools) body.tools = tools;
  } else {
    body = {
      model,
      messages: apiMessages,
      temperature: parseFloat(s.temperature),
      max_tokens: parseInt(s.maxTokens),
      stream
    };
    if (tools) body.tools = tools;
    if (stream) {
      body.stream_options = { include_usage: true };
    }
  }
  
  // ⭐ 关键改造：如果启用自定义模板，合并额外字段
  if (s.useCustomJson && s.jsonTemplate && s.jsonTemplate.trim()) {
    try {
      // 1. 用占位符字符串替换法解析模板，但只用"小数据"占位符（避免大数据导致解析失败）
      let tpl = s.jsonTemplate;
      
      // 用占位符替换（先用安全的字符串替换，不带真实大数据）
      tpl = tpl
        .replace(/"\{\{messages\}\}"/g, 'null')
        .replace(/\{\{messages\}\}/g, 'null')
        .replace(/"\{\{model\}\}"/g, JSON.stringify(model))
        .replace(/\{\{model\}\}/g, JSON.stringify(model))
        .replace(/"\{\{system\}\}"/g, 'null')
        .replace(/\{\{system\}\}/g, 'null')
        .replace(/"\{\{temperature\}\}"/g, JSON.stringify(parseFloat(s.temperature)))
        .replace(/\{\{temperature\}\}/g, JSON.stringify(parseFloat(s.temperature)))
        .replace(/"\{\{max_tokens\}\}"/g, JSON.stringify(parseInt(s.maxTokens)))
        .replace(/\{\{max_tokens\}\}/g, JSON.stringify(parseInt(s.maxTokens)))
        .replace(/"\{\{stream\}\}"/g, JSON.stringify(!!stream))
        .replace(/\{\{stream\}\}/g, JSON.stringify(!!stream))
        .replace(/"\{\{tools\}\}"/g, 'null')
        .replace(/\{\{tools\}\}/g, 'null');
      
      // 2. 解析模板（此时模板里都是小数据，安全）
      const templateObj = JSON.parse(tpl);
      
      // 3. 把真实的大数据填回去
      if (s.apiFormat === 'responses') {
        templateObj.input = apiMessages;
        if (systemContent) templateObj.instructions = systemContent;
        else delete templateObj.instructions;
        delete templateObj.messages;
        delete templateObj.system;
      } else {
        templateObj.messages = apiMessages;
        if (systemContent) {
          templateObj.system = systemContent;
        } else {
          delete templateObj.system;
        }
      }
      if (tools) {
        templateObj.tools = tools;
      } else {
        delete templateObj.tools;
      }
      
      // 4. 清理 null 字段
      Object.keys(templateObj).forEach(k => {
        if (templateObj[k] === null) delete templateObj[k];
      });
      
      // 5. OpenAI 流式自动加 stream_options
      if (s.apiFormat === 'openai' && templateObj.stream) {
        templateObj.stream_options = templateObj.stream_options || { include_usage: true };
      }
      
      console.log('[自定义模板] ✓ 已应用自定义字段');
      return templateObj;
      
    } catch (e) {
      console.error('[自定义模板] 解析失败:', e);
      if (typeof toast === 'function') {
        toast('❌ 自定义 JSON 模板格式错误，已回退到默认：' + e.message, 4000);
      }
      // 失败则继续走默认逻辑（返回上面构造好的 body）
    }
  }
  
  return body;
}

function buildHeaders() {
  const s = state.settings;
  const h = { 'Content-Type': 'application/json' };
  if (s.apiFormat === 'anthropic') {
    // Anthropic 官方只认 x-api-key。若中转服务要求额外的 Authorization 头，
    // 可通过下方"自定义 jsonHeaders"显式添加，避免无脑双发被严格网关 401。
    h['x-api-key'] = s.apiKey;
    h['anthropic-version'] = '2023-06-01';
  } else {
    h['Authorization'] = 'Bearer ' + s.apiKey;
  }
  if (s.jsonHeaders && s.jsonHeaders.trim()) {
    try {
      const extra = JSON.parse(s.jsonHeaders);
      Object.assign(h, extra);
    } catch (e) {}
  }
  return h;
}

function extractResponsesText(j) {
  if (!j) return '';
  if (typeof j.output_text === 'string') return j.output_text;
  const output = Array.isArray(j.output) ? j.output : [];
  const parts = [];
  for (const item of output) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const c of item.content) {
      if ((c.type === 'output_text' || c.type === 'text') && c.text) parts.push(c.text);
    }
  }
  return parts.join('');
}

function extractResponsesToolCalls(output) {
  if (!Array.isArray(output)) return [];
  return output
    .filter(item => item && item.type === 'function_call')
    .map(item => ({
      id: item.call_id || item.id,
      name: item.name || '',
      arguments: item.arguments || '{}'
    }))
    .filter(tc => tc.id && tc.name);
}

function normalizeResponsesUsage(usage) {
  if (!usage) return null;
  return {
    prompt_tokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
    completion_tokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
    total_tokens: usage.total_tokens ?? ((usage.input_tokens || 0) + (usage.output_tokens || 0)),
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    input_tokens_details: usage.input_tokens_details,
    output_tokens_details: usage.output_tokens_details
  };
}

function responsesEventKey(j, item) {
  const key = j?.output_index ?? j?.item_id ?? item?.id ?? item?.call_id ?? j?.call_id ?? '';
  return String(key);
}

// ⭐ 单次 fetch 硬超时（毫秒）
// 即使外部 abort 失灵（某些浏览器/代理在 TCP 阶段卡死），到点也会强行抛错
const API_FETCH_TIMEOUT_MS = 5 * 60 * 1000;  // 5 分钟

// ============ 🔁 自动重试机制 ============
// 判定一个错误是否值得重试
function _isRetryableError(e, httpStatus, signal) {
  if (!e && !httpStatus) return false;
  // 用户主动中止：绝不重试
  if (e && e.name === 'AbortError') return false;
  if (signal && signal.aborted) return false;
  if (!signal && state.abortCtrl && state.abortCtrl.signal && state.abortCtrl.signal.aborted) return false;
  // Token 拿不到这种本地配置错，重试也没用
  if (e && e.name === 'LocalProxyAuthError') return false;
  
  // HTTP 状态码：5xx 服务端临时错 + 429 限流 + 408 超时 + 502/503/504 网关错都重试
  if (httpStatus) {
    if (httpStatus === 408 || httpStatus === 429) return true;
    if (httpStatus >= 500 && httpStatus < 600) return true;
    // 其他 4xx（鉴权 / 参数错）重试无意义
    return false;
  }
  
  // 网络层错误：fetch 没拿到响应 / 流读到一半断开 / 硬超时
  if (e) {
    if (e.name === 'NetworkError' || e.name === 'TimeoutError') return true;
    const msg = (e.message || '') + ' ' + (e.name || '');
    if (/Failed to fetch|NetworkError|network|ECONN|ETIMEDOUT|ENOTFOUND|stream|chunk|aborted/i.test(msg)) {
      // 但如果是用户 abort 触发的 AbortError，上面已经拦了
      return true;
    }
  }
  return false;
}

// 退避等待，支持 Retry-After 头（秒数或 HTTP-date）
function _retryDelay(attempt, retryAfter, baseMs) {
  if (retryAfter) {
    const n = parseInt(retryAfter);
    if (!isNaN(n) && n > 0 && n < 120) return n * 1000; // 1~120s 之间才信
    const t = Date.parse(retryAfter);
    if (!isNaN(t)) {
      const ms = t - Date.now();
      if (ms > 0 && ms < 120000) return ms;
    }
  }
  const base = baseMs || 1000;
  const exp = base * Math.pow(2, Math.max(0, attempt - 1));  // 1s, 2s, 4s...
  const jitter = Math.floor(Math.random() * 500);            // 0~500ms 抖动
  return Math.min(exp + jitter, 30000);                       // 上限 30s
}

// 可被 abort 中断的 sleep
function _sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// 与 outline-core.js 中 _outlineFetchWithTimeout 同理：合并外部 signal 和内部超时
async function _apiFetchWithTimeout(url, init, externalSignal, timeoutMs) {
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(), timeoutMs || API_FETCH_TIMEOUT_MS);
  
  let externalAbortHandler = null;
  if (externalSignal) {
    if (externalSignal.aborted) {
      timeoutCtrl.abort();
    } else {
      externalAbortHandler = () => timeoutCtrl.abort();
      externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
    }
  }
  
  // ⭐ 跨域代理：如果开启了 useLocalProxy 且目标不是 localhost，则改走本地服务转发
  //    浏览器 → http://localhost:8765/llm-proxy → 上游 LLM（服务端转发，无 CORS）
  let realUrl = url;
  let realInit = { ...(init || {}), signal: timeoutCtrl.signal };
  try {
    const s = (typeof state !== 'undefined') && state.settings;
    const tc = (typeof TERMINAL_CONFIG !== 'undefined') ? TERMINAL_CONFIG : null;
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(url);
    if (s && s.useLocalProxy && tc && tc.serverUrl && !isLocal) {
      // ⭐ 没 token 就自动静默拉取（服务端已对本机来源免确认放行）
      if (!tc.token && typeof fetchTerminalToken === 'function') {
        try { await fetchTerminalToken(true); } catch (e) { /* 失败也继续，下面 fetch 会自然报错 */ }
      }
      const proxyHeaders = {
        'Content-Type': 'application/json',
        'X-Token': tc.token || '',
        'X-Target-Url': url,
        'X-Target-Headers': JSON.stringify(init && init.headers ? init.headers : {})
      };
      realUrl = tc.serverUrl.replace(/\/+$/, '') + '/llm-proxy';
      realInit = {
        ...realInit,
        method: (init && init.method) || 'POST',
        headers: proxyHeaders,
        body: init && init.body // 原样转发
      };
    }
  } catch (e) {
    console.warn('[apiFetch] 代理改写失败，回退到直连:', e);
  }
  
  return fetch(realUrl, realInit).finally(() => {
    clearTimeout(timer);
    if (externalSignal && externalAbortHandler) {
      externalSignal.removeEventListener('abort', externalAbortHandler);
    }
  }).catch(e => {
    if (e.name === 'AbortError' && externalSignal && !externalSignal.aborted) {
      const err = new Error(`⏱ 请求超时（${Math.round((timeoutMs || API_FETCH_TIMEOUT_MS) / 1000)}s 无响应）`);
      err.name = 'TimeoutError';
      throw err;
    }
    // ⭐ TypeError: Failed to fetch / NetworkError 这种"瞎报错"翻译成人话
    if (e instanceof TypeError || /Failed to fetch|NetworkError|Network request failed/i.test(e.message || '')) {
      const usingProxy = realUrl !== url;
      const hints = usingProxy ? [
        '⚠️ 已开启「本地代理」但请求失败，请检查：',
        '  1) 本地服务是否在跑？  python local_terminal_server.py',
        `  2) 服务地址是否正确？  当前：${realUrl}`,
        `目标 URL：${url}`
      ].join('\n') : [
        '可能原因：',
        '  1) URL 错误或域名无法访问（检查 baseUrl/apiPath）',
        '  2) 跨域被浏览器拦截（CORS）',
        '     👉 设置 → 勾选「通过本地服务代理」并启动 python local_terminal_server.py',
        '  3) 网络不通 / 代理未开',
        `目标 URL：${url}`
      ].join('\n');
      const err = new Error(`🌐 网络请求失败（fetch 未拿到任何响应）\n${hints}\n\n原始错误：${e.message || e.name}`);
      err.name = 'NetworkError';
      throw err;
    }
    throw e;
  });
}

async function callAPI(roundLimit, options = {}) {
  const requestedChatId = options && options.chatId;
  const c = requestedChatId ? chatById(requestedChatId) : currentChat();
  if (!c) {
    console.error('[callAPI] 没有当前对话');
    if (typeof syncGlobalTaskState === 'function') syncGlobalTaskState(state.currentId);
    else state.isGenerating = false;
    updateSendBtn();
    return;
  }
  const taskChatId = c.id;
  const isTaskVisible = () => isCurrentChat(taskChatId);
  const taskUseTools = options.useTools !== undefined ? !!options.useTools : !!state.settings.useTools;
  const suppressCompletionSound = !!options.suppressCompletionSound;
  
  const s = state.settings;
  
  // 如果未显式传入 roundLimit，则使用设置中的值（首次调用）
  const isFirstCall = (typeof roundLimit !== 'number');
  if (isFirstCall) {
    const cfg = parseInt(s.maxToolRounds);
    roundLimit = (isNaN(cfg) || cfg < 0) ? 15 : cfg;
    // ⭐ 关键：首次进入时清掉"停止请求"标志（递归进入不清，以便传递停止意图）
    state.stopRequested = false;
  }
  
  const task = (typeof beginChatTask === 'function')
    ? beginChatTask(taskChatId, null, { resetStop: isFirstCall })
    : null;
  if (!task) {
    state.isGenerating = true;
    state.activeTaskChatId = taskChatId;
  }
  updateSendBtn();
  if (typeof renderChatList === 'function') renderChatList();
  
  if (!options.contextChecked && typeof ensureContextBeforeAgentRun === 'function') {
    const ok = await ensureContextBeforeAgentRun(c, { label: '普通对话' });
    if (!ok) {
      if (typeof clearChatTask === 'function') clearChatTask(taskChatId);
      else {
        state.isGenerating = false;
        state.abortCtrl = null;
        if (state.activeTaskChatId === taskChatId) state.activeTaskChatId = null;
      }
      if (typeof updateSendBtn === 'function') updateSendBtn();
      if (typeof renderChatList === 'function') renderChatList();
      return;
    }
  }
  
  c.messages.push({ role: 'assistant', content: '', _startTime: Date.now() });
  // ⭐ 增量追加新的 assistant 占位（不重建整个列表）
  if (typeof appendMsgNode === 'function') {
    appendMsgNode(c.messages.length - 1, c);
  } else {
    if (isTaskVisible()) renderMessages();
  }
  let lastIdx = c.messages.length - 1;
  
  const url = buildFullUrl(s.baseUrl, s.apiPath);
  let body;
  try {
    body = buildRequestBody(c.messages.slice(0, -1), undefined, undefined, { useTools: taskUseTools });
  } catch (e) {
    c.messages[lastIdx].content = `❌ 构造请求失败：${e.message}`;
    if (isTaskVisible()) renderMessages();
    saveData();
    if (typeof clearChatTask === 'function') clearChatTask(taskChatId);
    else {
      state.isGenerating = false;
      state.abortCtrl = null;
      if (state.activeTaskChatId === taskChatId) state.activeTaskChatId = null;
    }
    updateSendBtn();
    return;
  }
  
  const requestHeaders = buildHeaders();
  const abortCtrl = new AbortController();
  if (typeof updateChatTaskController === 'function') updateChatTaskController(taskChatId, abortCtrl);
  else state.abortCtrl = abortCtrl;
  
  // ⭐ 自动重试：把"发请求 + 读响应"包成可重试单元
  const maxAttempts = Math.max(1, (parseInt(s.retryMaxAttempts) || 3) + 1);  // 总尝试次数 = 重试次数+1
  const baseDelay = Math.max(100, parseInt(s.retryBaseDelayMs) || 1000);
  let lastError = null;
  let succeeded = false;
  
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // 重试前清空上次的部分内容（避免半截回复和重试结果拼接）
      if (attempt > 1) {
        const m = c.messages[lastIdx];
        if (m) {
          m.content = '';
          delete m.tool_calls;
          delete m._firstTokenAt;
          m._startTime = Date.now();
          if (typeof refreshMsgNode === 'function') refreshMsgNode(lastIdx, c);
        }
      }
      
      let httpStatus = 0;
      let retryAfter = null;
      try {
        if (typeof applyRateLimit === 'function') {
          await applyRateLimit(abortCtrl.signal);
        }
        
        const resp = await _apiFetchWithTimeout(url, {
          method: 'POST',
          headers: requestHeaders,
          body: JSON.stringify(body)
        }, abortCtrl.signal, API_FETCH_TIMEOUT_MS);
        
        if (typeof recordRequest === 'function') {
          recordRequest();
        }
        
        const ct = resp.headers.get('content-type') || '';
        if (!resp.ok) {
          httpStatus = resp.status;
          retryAfter = resp.headers.get('retry-after');
          const t = await resp.text();
          if (typeof saveRequestToHistory === 'function') {
            saveRequestToHistory(url, requestHeaders, body, t, `HTTP ${resp.status}`);
          }
          const err = new Error(`HTTP ${resp.status}: ${t.slice(0, 500)}`);
          err.httpStatus = resp.status;
          err.retryAfter = retryAfter;
          throw err;
        }
        // ⭐ 兼容更多服务：
        //   - 标准：text/event-stream
        //   - 某些中转：application/stream+json / text/plain / 缺失 content-type
        const ctLower = ct.toLowerCase();
        const looksLikeStream = ctLower.includes('event-stream')
                             || ctLower.includes('stream+json')
                             || (body.stream && !ctLower.includes('json') && !ctLower.includes('html'));
        if (body.stream && looksLikeStream && resp.body && typeof resp.body.getReader === 'function') {
          await handleStream(resp, c, lastIdx, { url, method: 'POST', headers: requestHeaders, body });
        } else {
          const txt = await resp.text();
          await handleNonStream(txt, c, lastIdx, ct, { url, method: 'POST', headers: requestHeaders, body });
        }
        
        succeeded = true;
        break;  // 跳出重试循环
      } catch (attemptErr) {
        lastError = attemptErr;
        // 用户主动 abort：不重试，让外层 catch 处理
        if (attemptErr.name === 'AbortError' || abortCtrl.signal.aborted) {
          throw attemptErr;
        }
        const retryable = _isRetryableError(attemptErr, httpStatus || attemptErr.httpStatus, abortCtrl.signal);
        const remaining = maxAttempts - attempt;
        if (!retryable || remaining <= 0) {
          throw attemptErr;
        }
        const wait = _retryDelay(attempt, retryAfter || attemptErr.retryAfter, baseDelay);
        console.warn(`[callAPI] 第 ${attempt}/${maxAttempts} 次尝试失败：${attemptErr.message}\n  → ${wait}ms 后重试`);
        // 把"正在重试"信息显示给用户看
        const m = c.messages[lastIdx];
        if (m) {
          m.content = `🔁 第 ${attempt} 次尝试失败，${Math.round(wait / 1000) || 1}s 后自动重试…\n\n_${attemptErr.message.split('\n')[0]}_`;
          if (typeof refreshMsgNode === 'function') refreshMsgNode(lastIdx, c);
        }
        try {
          await _sleepAbortable(wait, abortCtrl.signal);
        } catch (sleepErr) {
          // sleep 被 abort 中断
          throw sleepErr;
        }
      }
    }
    
    if (!succeeded) {
      // 理论上不会到这里（要么 break 要么 throw），保险起见
      throw lastError || new Error('请求失败');
    }
    
    if (typeof saveRequestToHistory === 'function') {
      saveRequestToHistory(url, requestHeaders, body, c.messages[lastIdx].content, null);
    }
    
    const msg = c.messages[lastIdx];
    if (msg.tool_calls && msg.tool_calls.length && roundLimit > 0) {
      // ⭐ 关键修复：本轮 assistant 回复（含工具调用）已结束，冻结其 timer
      // 否则 tickMsgTimers 会一直按 Date.now()-_startTime 刷新，导致"模型回答完计时还在涨"
      if (!msg._endTime) msg._endTime = Date.now();
      // ⭐ 清掉流式残留 + 光标
      if (typeof cancelPendingStreamFlush === 'function') cancelPendingStreamFlush();
      if (typeof refreshMsgNode === 'function') refreshMsgNode(lastIdx, c);
      
      let userStoppedAll = false;
      const executedToolCallIds = [];  // ⭐ 记录已执行完成的 tool_call_id
      
      for (const tc of msg.tool_calls) {
        // ⭐ 用户点了"停止"：立刻退出工具循环，不再执行后续工具
        //   即使当前轮的 fetch 已结束、abortCtrl 已 null，stopRequested 仍能拦住
        if (task ? task.stopRequested : state.stopRequested) {
          userStoppedAll = true;
          // ⭐ 关键修复：去掉未执行的 tool_calls，避免下次请求时
          //   DeepSeek/OpenAI 报 400："tool_calls must be followed by tool messages"
          msg.tool_calls = msg.tool_calls.filter(tc => executedToolCallIds.includes(tc.id));
          break;
        }
        const fname = tc.function?.name || '';
        let args = {};
        try { args = JSON.parse(tc.function?.arguments || '{}'); } catch (e) {}
        const result = await executeTool(fname, args, { chatId: taskChatId, chat: c });
        
        let contentText;
        let isError = false;
        let stopAll = false;
        
        if (typeof result.value === 'string') {
          contentText = result.value;
          isError = !result.ok;
        } else if (typeof result.value === 'object' && result.value !== null) {
          if (result.value._stopAll) {
            stopAll = true;
            contentText = result.value.error || '用户要求停止所有操作';
            isError = true;
            userStoppedAll = true;
          } else if (result.value._userRejected) {
            contentText = result.value.error || '用户拒绝此操作';
            isError = true;
          } else if (result.value.ok === false) {
            contentText = result.value.error || JSON.stringify(result.value);
            isError = true;
          } else {
            contentText = JSON.stringify(result.value);
            isError = !result.ok;
          }
        } else {
          contentText = JSON.stringify(result.value);
          isError = !result.ok;
        }
        
        const preparedToolResult = typeof prepareToolResultForContext === 'function'
          ? prepareToolResultForContext({
              content: contentText,
              toolName: fname,
              toolCallId: tc.id,
              chatId: taskChatId,
              chat: c,
              status: isError ? 'error' : 'success',
              args
            })
          : { content: contentText, archived: false };
        contentText = preparedToolResult.content;
        
        c.messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: fname,
          content: contentText,
          status: isError ? 'error' : 'success',
          _artifactId: preparedToolResult.artifactId,
          _artifactMeta: preparedToolResult.artifactMeta,
          _startTime: Date.now(),
          _endTime: Date.now()
        });
        executedToolCallIds.push(tc.id);  // ⭐ 记录已执行
        // ⭐ 增量追加单条工具消息（不重建整个列表），避免闪烁
        if (typeof appendMsgNode === 'function') {
          appendMsgNode(c.messages.length - 1, c);
        } else {
          if (isTaskVisible()) renderMessages();
        }
        saveData();
        
        if (stopAll) {
          // ⭐ stopAll 也会导致后续 tool_calls 不执行，同样需要清理
          msg.tool_calls = msg.tool_calls.filter(tc => executedToolCallIds.includes(tc.id));
          break;
        }
      }
      
      if (typeof syncGlobalTaskState === 'function') syncGlobalTaskState(taskChatId);
      
      // ⭐ 用户点了"停止"：不再递归发下一轮请求
      //   关键修复：避免"工具执行完后照样再发一轮 API"的死循环
      if (task ? task.stopRequested : state.stopRequested) {
        // 在最后一条 assistant 消息上留个标记，让用户看清楚是被停了
        const lastMsg = c.messages[c.messages.length - 1];
        if (lastMsg && lastMsg.role === 'tool') {
          // 工具消息后面再补一条占位的 assistant，写明已停止
          c.messages.push({
            role: 'assistant',
            content: '*[已停止]*',
            _startTime: Date.now(),
            _endTime: Date.now()
          });
          if (typeof appendMsgNode === 'function') {
            appendMsgNode(c.messages.length - 1, c);
          } else {
            if (isTaskVisible()) renderMessages();
          }
        }
        saveData();
        return;
      }
      
      if (userStoppedAll) {
        await callAPI(0, { chatId: taskChatId, useTools: taskUseTools, suppressCompletionSound });
      } else {
        await callAPI(roundLimit - 1, { chatId: taskChatId, useTools: taskUseTools, suppressCompletionSound });
      }
      return;
    }
    
    // ⭐ 关键修复：如果 roundLimit=0 但 API 仍返回了 tool_calls，
    //   工具不会执行，但 assistant 消息中的 tool_calls 会被保留。
    //   下次请求时 DeepSeek 会报 400：tool_calls must be followed by tool messages。
    //   这里在保存前主动清除，从源头消灭问题。
    if (msg.tool_calls && msg.tool_calls.length && roundLimit <= 0) {
      console.warn('[callAPI] 工具轮次已用完但仍有 tool_calls，自动清除：',
        msg.tool_calls.map(tc => tc.id || tc.function?.name).join(', '));
      delete msg.tool_calls;
    }
    
    saveData();
    // ⭐ 完成时标记结束时间，并对当前消息节点做一次"完整"渲染（含 KaTeX）
    if (c.messages[lastIdx]) c.messages[lastIdx]._endTime = Date.now();
    // ⭐ 清掉任何待执行的流式刷新 + 残留光标，避免完成后还闪
    if (typeof cancelPendingStreamFlush === 'function') cancelPendingStreamFlush();
    if (typeof refreshMsgNode === 'function') {
      refreshMsgNode(lastIdx, c);
    } else {
      if (isTaskVisible()) renderMessages();
    }
    if (isTaskVisible() && typeof scheduleAccurateTokenCount === 'function') scheduleAccurateTokenCount(taskChatId);
    if (!suppressCompletionSound && typeof playCompletionSound === 'function') playCompletionSound();
  } catch (e) {
    if (e.name === 'AbortError') c.messages[lastIdx].content += '\n\n*[已停止]*';
    else {
      c.messages[lastIdx].content = `❌ ${e.message}\n\n💡 URL: ${url}`;
      if (typeof saveRequestToHistory === 'function') {
        saveRequestToHistory(url, requestHeaders, body, null, e.message);
      }
    }
    if (c.messages[lastIdx]) c.messages[lastIdx]._endTime = Date.now();
    // ⭐ 错误/abort 时同样清掉残留光标
    if (typeof cancelPendingStreamFlush === 'function') cancelPendingStreamFlush();
    if (typeof refreshMsgNode === 'function') {
      refreshMsgNode(lastIdx, c);
    } else {
      if (isTaskVisible()) renderMessages();
    }
    saveData();
  } finally {
    if (typeof clearChatTask === 'function') clearChatTask(taskChatId);
    else {
      state.isGenerating = false;
      state.abortCtrl = null;
      if (state.activeTaskChatId === taskChatId) state.activeTaskChatId = null;
    }
    if (typeof updateSendBtn === 'function') updateSendBtn();
    if (typeof renderChatList === 'function') renderChatList();
    
    const sendBtn = document.getElementById('sendBtn');
    const currentGenerating = (typeof isCurrentChatGenerating === 'function') ? isCurrentChatGenerating() : !!state.isGenerating;
    if (sendBtn && !currentGenerating) {
      sendBtn.textContent = '↑';
      sendBtn.classList.remove('stop');
    }
  }
}

async function handleStream(resp, c, lastIdx, reqCtx) {
  const s = state.settings;
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const tcMap = {};
  const anthropicToolBlocks = {};
  const responsesToolBlocks = {};
  let responsesOutput = null;
  let streamUsage = null;
  let rawAccumulated = '';  // ⭐ 累积原始 SSE 文本，用于响应预览
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    rawAccumulated += chunk;  // ⭐ 保留原始字节流
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t || !t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        if (s.apiFormat === 'anthropic') {
          if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') {
            // ⭐ 立即标记首字时间（让 timer 立刻从"等待"切到"流式中"）
            if (!c.messages[lastIdx]._firstTokenAt) c.messages[lastIdx]._firstTokenAt = Date.now();
            c.messages[lastIdx].content += j.delta.text || '';
            if (typeof markMsgTimerActivity === 'function') markMsgTimerActivity(c.messages[lastIdx]);
            updateLastMsg(c, lastIdx);
          }
          if (j.type === 'content_block_start' && j.content_block?.type === 'tool_use') {
            const idx = j.index ?? 0;
            anthropicToolBlocks[idx] = {
              id: j.content_block.id,
              name: j.content_block.name,
              partial_input: ''
            };
          }
          if (j.type === 'content_block_delta' && j.delta?.type === 'input_json_delta') {
            const idx = j.index ?? 0;
            if (anthropicToolBlocks[idx]) {
              anthropicToolBlocks[idx].partial_input += j.delta.partial_json || '';
            }
          }
          if (j.type === 'message_start' && j.message?.usage) {
            streamUsage = j.message.usage;
          }
          if (j.type === 'message_delta' && j.usage) {
            streamUsage = { ...streamUsage, ...j.usage };
          }
        } else if (s.apiFormat === 'responses') {
          if (j.type === 'response.output_text.delta') {
            if (!c.messages[lastIdx]._firstTokenAt) c.messages[lastIdx]._firstTokenAt = Date.now();
            c.messages[lastIdx].content += j.delta || '';
            if (typeof markMsgTimerActivity === 'function') markMsgTimerActivity(c.messages[lastIdx]);
            updateLastMsg(c, lastIdx);
          }
          if (j.type === 'response.output_item.added' && j.item?.type === 'function_call') {
            const key = responsesEventKey(j, j.item);
            responsesToolBlocks[key] = {
              id: j.item.call_id || j.item.id || key,
              name: j.item.name || '',
              arguments: j.item.arguments || ''
            };
          }
          if (j.type === 'response.function_call_arguments.delta') {
            const key = responsesEventKey(j);
            if (!responsesToolBlocks[key]) {
              responsesToolBlocks[key] = { id: key, name: '', arguments: '' };
            }
            responsesToolBlocks[key].arguments += j.delta || '';
          }
          if (j.type === 'response.output_item.done' && j.item?.type === 'function_call') {
            const key = responsesEventKey(j, j.item);
            responsesToolBlocks[key] = {
              id: j.item.call_id || j.item.id || key,
              name: j.item.name || responsesToolBlocks[key]?.name || '',
              arguments: j.item.arguments || responsesToolBlocks[key]?.arguments || '{}'
            };
          }
          if (j.type === 'response.completed' && j.response) {
            responsesOutput = Array.isArray(j.response.output) ? j.response.output : null;
            streamUsage = normalizeResponsesUsage(j.response.usage) || streamUsage;
            if (!c.messages[lastIdx].content) {
              c.messages[lastIdx].content = extractResponsesText(j.response);
              updateLastMsg(c, lastIdx);
            }
          }
        } else {
          const delta = j.choices?.[0]?.delta;
          if (delta) {
            if (delta.content) {
              // ⭐ 立即标记首字时间
              if (!c.messages[lastIdx]._firstTokenAt) c.messages[lastIdx]._firstTokenAt = Date.now();
              c.messages[lastIdx].content += delta.content;
              if (typeof markMsgTimerActivity === 'function') markMsgTimerActivity(c.messages[lastIdx]);
              updateLastMsg(c, lastIdx);
            }
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!tcMap[idx]) tcMap[idx] = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
                if (tc.id) tcMap[idx].id = tc.id;
                if (tc.function?.name) tcMap[idx].function.name += tc.function.name;
                if (tc.function?.arguments) tcMap[idx].function.arguments += tc.function.arguments;
              }
            }
          }
          if (j.usage) {
            streamUsage = j.usage;
          }
        }
      } catch (e) {}
    }
  }
  
  const openaiTcs = Object.values(tcMap);
  if (openaiTcs.length) c.messages[lastIdx].tool_calls = openaiTcs;
  
  const anthropicTcs = Object.values(anthropicToolBlocks);
  if (anthropicTcs.length) {
    c.messages[lastIdx].tool_calls = anthropicTcs.map(tb => ({
      id: tb.id,
      type: 'function',
      function: {
        name: tb.name,
        arguments: tb.partial_input || '{}'
      }
    }));
  }
  
  if (responsesOutput) {
    c.messages[lastIdx]._responsesOutput = responsesOutput;
    const responseTcs = extractResponsesToolCalls(responsesOutput);
    if (responseTcs.length) {
      c.messages[lastIdx].tool_calls = responseTcs.map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: tc.arguments || '{}'
        }
      }));
    }
  } else if (s.apiFormat === 'responses') {
    const responseTcs = Object.values(responsesToolBlocks).filter(tc => tc.id && tc.name);
    if (responseTcs.length) {
      c.messages[lastIdx].tool_calls = responseTcs.map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: tc.arguments || '{}'
        }
      }));
    }
  }
  
  if (streamUsage && typeof recordUsageFromResponse === 'function') {
    recordUsageFromResponse(c, streamUsage, { model: reqCtx?.body?.model });
  }
  
  // ⭐ 保存原始响应到全局（仅本会话，刷新失效）
  if (typeof recordRawResponse === 'function') {
    recordRawResponse({
      ts: Date.now(),
      isStream: true,
      contentType: resp.headers.get('content-type') || '',
      raw: rawAccumulated,
      usage: streamUsage,
      parsedContent: c.messages[lastIdx].content,
      parsedToolCalls: c.messages[lastIdx].tool_calls,
      request: reqCtx || null,
      _source: '主对话流 · 流式'
    });
  }
}

async function handleNonStream(txt, c, lastIdx, ct, reqCtx) {
  const s = state.settings;
  // ⭐ 不死认 content-type：很多兼容服务返回 text/plain 但内容其实是合法 JSON
  // 优先尝试解析，失败再报"非 JSON"
  let j;
  const trimmed = (txt || '').trim();
  const looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[');
  if (looksLikeJson) {
    try { j = JSON.parse(trimmed); } catch (e) {
      throw new Error(`JSON 解析失败（content-type: ${ct}）\n响应预览：${txt.slice(0, 300)}`);
    }
  } else {
    throw new Error(`服务器返回非 JSON 内容（content-type: ${ct}）\n响应预览：${txt.slice(0, 300)}\n\n💡 检查项：\n  - URL 是否正确（HTML 通常说明走到了网页而非 API）\n  - 是否漏填 /chat/completions 或 /v1\n  - 中转服务是否要求特殊鉴权头`);
  }
  if (j.error) throw new Error(`API 错误：${j.error.message || JSON.stringify(j.error)}`);
  
  // ⭐ 保存原始响应（在解析之前就保存好，方便用户对照）
  if (typeof recordRawResponse === 'function') {
    recordRawResponse({
      ts: Date.now(),
      isStream: false,
      contentType: ct,
      raw: txt,
      parsedJson: j,
      usage: j.usage || null,
      request: reqCtx || null,
      _source: '主对话流 · 非流式'
    });
  }
  
  if (s.apiFormat === 'anthropic') {
    const contents = j.content || [];
    c.messages[lastIdx].content = contents.filter(p => p.type === 'text').map(p => p.text).join('') || '';
    const toolUses = contents.filter(p => p.type === 'tool_use');
    if (toolUses.length) {
      c.messages[lastIdx].tool_calls = toolUses.map(tu => ({
        id: tu.id,
        type: 'function',
        function: {
          name: tu.name,
          arguments: JSON.stringify(tu.input || {})
        }
      }));
    }
    if (j.usage && typeof recordUsageFromResponse === 'function') {
      recordUsageFromResponse(c, j.usage, { model: reqCtx?.body?.model });
    }
  } else if (s.apiFormat === 'responses') {
    c.messages[lastIdx].content = extractResponsesText(j) || '';
    if (Array.isArray(j.output)) c.messages[lastIdx]._responsesOutput = j.output;
    const toolCalls = extractResponsesToolCalls(j.output);
    if (toolCalls.length) {
      c.messages[lastIdx].tool_calls = toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: tc.arguments || '{}'
        }
      }));
    }
    const usage = normalizeResponsesUsage(j.usage);
    if (usage && typeof recordUsageFromResponse === 'function') {
      recordUsageFromResponse(c, usage, { model: reqCtx?.body?.model });
    }
  } else {
    const msg = j.choices?.[0]?.message;
    if (msg) {
      c.messages[lastIdx].content = msg.content || '';
      if (msg.tool_calls?.length) c.messages[lastIdx].tool_calls = msg.tool_calls;
    } else {
      c.messages[lastIdx].content = '(无响应)';
    }
    if (j.usage && typeof recordUsageFromResponse === 'function') {
      recordUsageFromResponse(c, j.usage, { model: reqCtx?.body?.model });
    }
  }
}

async function callOnceWithRole(history, model, rolePrompt, options = {}) {
  const s = state.settings;
  // ⭐ 使用独立的 AbortController，避免：
  //   1) 抢占主对话 state.abortCtrl（用户点"停止"想停主对话，结果连带停掉辅助调用）
  //   2) 辅助调用未清理 controller 导致主流程状态错乱
  // 同时桥接外层中止信号：若主对话被中止，辅助调用也应一起停
  const localCtrl = new AbortController();
  const signal = localCtrl.signal;
  let _bridgeOuterAbort = null;
  const outerSignal = options && options.signal
    ? options.signal
    : (state.abortCtrl && state.abortCtrl.signal ? state.abortCtrl.signal : null);
  const isStopped = (options && typeof options.isStopped === 'function')
    ? options.isStopped
    : () => !!state.stopRequested;
  if (outerSignal) {
    _bridgeOuterAbort = () => { try { localCtrl.abort(); } catch (_) {} };
    if (outerSignal.aborted) _bridgeOuterAbort();
    else outerSignal.addEventListener('abort', _bridgeOuterAbort, { once: true });
  }
  const tempMessages = history.filter(m => m.role !== 'system' && m.role !== 'tool');
  let body;
  if (s.apiFormat === 'anthropic') {
    body = {
      model,
      messages: buildAnthropicMessages(tempMessages),
      max_tokens: parseInt(s.maxTokens),
      temperature: parseFloat(s.temperature),
      stream: false,
      system: rolePrompt
    };
  } else if (s.apiFormat === 'responses') {
    body = {
      model,
      input: buildOpenAIResponsesInput(tempMessages),
      instructions: rolePrompt,
      temperature: parseFloat(s.temperature),
      max_output_tokens: parseInt(s.maxTokens),
      stream: false
    };
  } else {
    const msgs = [{ role: 'system', content: rolePrompt }];
    for (const m of buildOpenAIMessages(tempMessages)) if (m.role !== 'system') msgs.push(m);
    body = {
      model,
      messages: msgs,
      temperature: parseFloat(s.temperature),
      max_tokens: parseInt(s.maxTokens),
      stream: false
    };
  }
  
  // ⭐ 自动重试：把"发请求 + 读响应 + 解析"整体包成可重试单元
  // 复用主对话的 _isRetryableError / _retryDelay / _sleepAbortable
  // 配置项也用同一套 retryMaxAttempts / retryBaseDelayMs
  const maxAttempts = Math.max(1, (parseInt(s.retryMaxAttempts) || 3) + 1);
  const baseDelay = Math.max(100, parseInt(s.retryBaseDelayMs) || 1000);
  const url = buildFullUrl(s.baseUrl, s.apiPath);
  const reqHeaders = buildHeaders();
  let lastErr = null;
  
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let httpStatus = 0;
      let retryAfter = null;
      try {
        if (isStopped()) {
          const err = new Error('用户中断');
          err.name = 'AbortError';
          throw err;
        }
        if (typeof applyRateLimit === 'function') {
          await applyRateLimit(signal);
        }
        
        const resp = await _apiFetchWithTimeout(url, {
          method: 'POST',
          headers: reqHeaders,
          body: JSON.stringify(body)
        }, signal, API_FETCH_TIMEOUT_MS);
        
        if (typeof recordRequest === 'function') {
          recordRequest();
        }
        
        const ct = resp.headers.get('content-type') || '';
        const txt = await resp.text();
        if (!resp.ok) {
          httpStatus = resp.status;
          retryAfter = resp.headers.get('retry-after');
          const err = new Error(`HTTP ${resp.status}: ${txt.slice(0, 300)}`);
          err.httpStatus = resp.status;
          err.retryAfter = retryAfter;
          throw err;
        }
        
        // ⭐ 放宽 Content-Type 检查：与 handleNonStream 保持一致
        // 一些中转服务会把 JSON 响应错标成 text/plain，只要内容像 JSON 就尝试解析
        let j;
        const trimmed = (txt || '').trim();
        const looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[');
        if (!ct.toLowerCase().includes('json') && !looksLikeJson) {
          throw new Error(`非 JSON 响应 (${ct})\n${txt.slice(0, 200)}`);
        }
        try { j = JSON.parse(trimmed); }
        catch (e) { throw new Error('JSON 解析失败：' + trimmed.slice(0, 200)); }
        if (j.error) throw new Error(`API 错误：${j.error.message || JSON.stringify(j.error)}`);
        
        // ⭐ 记录原始响应（callOnceWithRole 被 Plan 规划/师生评审/Token 摘要等多处复用）
        if (typeof recordRawResponse === 'function') {
          recordRawResponse({
            ts: Date.now(),
            isStream: false,
            contentType: ct,
            raw: txt,
            parsedJson: j,
            usage: j.usage || null,
            request: { url, method: 'POST', headers: reqHeaders, body },
            _source: options.sourceLabel || '辅助调用 (callOnceWithRole)'
          });
        }
        
        // ⭐ 把辅助调用（Plan 规划/审查/整合、师生评审、压缩摘要等）的 usage 计入当前对话统计
        // 之前漏算导致 Plan/大纲/师生 模式的 token 都不进总账
        const usageForRecord = s.apiFormat === 'responses' ? normalizeResponsesUsage(j.usage) : j.usage;
        if (usageForRecord && typeof recordUsageFromResponse === 'function') {
          const _c = options.chat
            || (options.chatId && typeof chatById === 'function' ? chatById(options.chatId) : null)
            || (typeof activeTaskChat === 'function' ? activeTaskChat() : (typeof currentChat === 'function' ? currentChat() : null));
          if (_c) recordUsageFromResponse(_c, usageForRecord, { model });
        }
        
        if (s.apiFormat === 'anthropic') return (j.content || []).filter(p => p.type === 'text').map(p => p.text).join('') || '';
        if (s.apiFormat === 'responses') return extractResponsesText(j) || '';
        return j.choices?.[0]?.message?.content || '';
      } catch (attemptErr) {
        lastErr = attemptErr;
        // 用户主动 abort（含桥接外层主对话中止）：不重试，直接抛
        if (attemptErr.name === 'AbortError' || signal.aborted) throw attemptErr;
        
        const retryable = (typeof _isRetryableError === 'function')
          ? _isRetryableError(attemptErr, httpStatus || attemptErr.httpStatus, signal)
          : false;
        const remaining = maxAttempts - attempt;
        if (!retryable || remaining <= 0) throw attemptErr;
        
        const wait = (typeof _retryDelay === 'function')
          ? _retryDelay(attempt, retryAfter || attemptErr.retryAfter, baseDelay)
          : (baseDelay * Math.pow(2, attempt - 1));
        console.warn(`[callOnceWithRole] 第 ${attempt}/${maxAttempts} 次尝试失败：${attemptErr.message}\n  → ${wait}ms 后重试`);
        
        try {
          if (typeof _sleepAbortable === 'function') {
            await _sleepAbortable(wait, signal);
          } else {
            await new Promise(r => setTimeout(r, wait));
          }
        } catch (sleepErr) {
          throw sleepErr;  // sleep 被 abort 中断
        }
      }
    }
    // 理论上走不到这（要么 return 要么 throw），兜底
    throw lastErr || new Error('callOnceWithRole 未知错误');
  } finally {
    // 解绑桥接监听器，避免外层 controller 累积闭包引用
    if (_bridgeOuterAbort && outerSignal) {
      try { outerSignal.removeEventListener('abort', _bridgeOuterAbort); } catch (_) {}
    }
  }
}



// ============ 🤖 通用 Agent 循环引擎（独立于 c.messages）============
// 【设计目标】
// - 让 LLM 在隔离上下文里多轮调用工具直到自己说"完成"
// - 不污染 c.messages，所有过程通过 onProgress 回调上报
// - 支持流式文本输出（学生回答边写边看）
// - 复用现有 _apiFetchWithTimeout / buildHeaders / executeTool / 重试机制
// 【调用方】reflection.js（学生 / 老师）、未来可扩展给计划模式

async function runAgentLoop({
  initialMessages,     // 标准格式：[{role:'user'|'assistant'|'tool', content, tool_calls?, tool_call_id?, name?}]
  systemPrompt,        // 系统提示（独立于 settings.systemPrompt）
  model,               // 模型 ID
  maxRounds = 15,      // 最多工具调用轮数
  signal,              // AbortSignal（用于中断）
  onProgress,          // (event) => void 进度回调
  useTools = true,     // 是否启用工具
  stream = true,       // 是否流式
  temperature,         // 可选，默认从 settings 取
  maxTokens,           // 可选，默认从 settings 取
  isStopped,           // 可选，任务级软停止检查
  chatId,              // 可选，usage 归属对话
  chat                 // 可选，usage 归属对话对象
}) {
  const s = state.settings;
  const _temp = temperature !== undefined ? temperature : parseFloat(s.temperature);
  const _max = maxTokens !== undefined ? maxTokens : parseInt(s.maxTokens);
  const effectiveSystemPrompt = typeof withActiveSkillPrompt === 'function'
    ? withActiveSkillPrompt(systemPrompt || '')
    : (systemPrompt || '');
  
  // 内部维护 messages（不动 c.messages）
  const messages = JSON.parse(JSON.stringify(initialMessages || []));
  const tools = useTools ? buildToolsArray({ force: true }) : null;
  
  let finalText = '';
  let totalUsage = null;
  
  const _emit = (ev) => { try { onProgress && onProgress(ev); } catch (e) { console.warn('[runAgentLoop] onProgress 抛错:', e); } };
  
  // ⭐ 统一的中止检查：同时看传入的 signal 和全局 stopRequested
  // 后者用于跨越 abortCtrl 重建边界的"软停止"（例如用户在等待 API 时点了暂停）
  const _isStopped = typeof isStopped === 'function' ? isStopped : () => !!state.stopRequested;
  const _isAborted = () => (signal && signal.aborted) || _isStopped();
  
  for (let round = 0; round < maxRounds + 1; round++) {
    // 中断检查
    if (_isAborted()) {
      const err = new Error('用户中断'); err.name = 'AbortError'; throw err;
    }
    
    _emit({ type: 'round_start', round: round + 1 });
    if (typeof ensureContextBeforeAgentRun === 'function') {
      const guardChat = chat || (chatId && typeof chatById === 'function' ? chatById(chatId) : null);
      const ok = await ensureContextBeforeAgentRun(guardChat, {
        label: '师生/隔离工具循环',
        extraMessages: messages,
        mutableMessages: messages,
        preserveFirstUser: true
      });
      if (!ok) throw new Error('自动压缩失败，已停止本轮 agent 请求');
    }
    
    // ----- 构造请求 -----
    // 用现有适配器把内部 messages 转成 API 格式
    const apiMessages = s.apiFormat === 'anthropic'
      ? buildAnthropicMessages(messages)
      : (s.apiFormat === 'responses' ? buildOpenAIResponsesInput(messages) : buildOpenAIMessages(messages));
    
    let body;
    if (s.apiFormat === 'anthropic') {
      body = {
        model,
        messages: apiMessages,
        max_tokens: _max,
        temperature: _temp,
        stream
      };
      if (effectiveSystemPrompt) body.system = effectiveSystemPrompt;
      // 最后一轮不带 tools，强制收尾
      if (tools && round < maxRounds) body.tools = tools;
    } else if (s.apiFormat === 'responses') {
      body = {
        model,
        input: apiMessages,
        max_output_tokens: _max,
        temperature: _temp,
        stream
      };
      if (effectiveSystemPrompt) body.instructions = effectiveSystemPrompt;
      if (tools && round < maxRounds) body.tools = tools;
    } else {
      const msgs = effectiveSystemPrompt ? [{ role: 'system', content: effectiveSystemPrompt }] : [];
      for (const m of apiMessages) if (m.role !== 'system') msgs.push(m);
      body = {
        model,
        messages: msgs,
        max_tokens: _max,
        temperature: _temp,
        stream
      };
      if (tools && round < maxRounds) body.tools = tools;
      if (stream) body.stream_options = { include_usage: true };
    }
    
    if (typeof applyRateLimit === 'function') await applyRateLimit(signal);
    
    const url = buildFullUrl(s.baseUrl, s.apiPath);
    const headers = buildHeaders();
    
    const resp = await _apiFetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    }, signal, API_FETCH_TIMEOUT_MS);
    
    if (typeof recordRequest === 'function') recordRequest();
    
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${t.slice(0, 500)}`);
    }
    
    // ----- 解析响应（流式 / 非流式）-----
    let assistantText = '';
    let assistantToolCalls = [];   // [{id, name, arguments(string)}]
    let assistantResponsesOutput = null;
    let usage = null;
    
    const ct = resp.headers.get('content-type') || '';
    const ctLower = ct.toLowerCase();
    const looksLikeStream = ctLower.includes('event-stream')
                         || ctLower.includes('stream+json')
                         || (body.stream && !ctLower.includes('json') && !ctLower.includes('html'));
    
    if (body.stream && looksLikeStream && resp.body && typeof resp.body.getReader === 'function') {
      // === 流式解析 ===
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const tcMap = {};                  // OpenAI: index -> {id, function:{name, arguments}}
      const anthropicToolBlocks = {};    // Anthropic: index -> {id, name, partial_input}
      const responsesToolBlocks = {};
      let responsesOutput = null;
      let rawAccumulated = '';
      
      while (true) {
        if (_isAborted()) {
          try { reader.cancel(); } catch (_) {}
          const err = new Error('用户中断'); err.name = 'AbortError'; throw err;
        }
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        rawAccumulated += chunk;
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t || !t.startsWith('data:')) continue;
          const data = t.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            if (s.apiFormat === 'anthropic') {
              if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') {
                const delta = j.delta.text || '';
                assistantText += delta;
                _emit({ type: 'text_delta', text: delta });
              }
              if (j.type === 'content_block_start' && j.content_block?.type === 'tool_use') {
                const idx = j.index ?? 0;
                anthropicToolBlocks[idx] = {
                  id: j.content_block.id,
                  name: j.content_block.name,
                  partial_input: ''
                };
              }
              if (j.type === 'content_block_delta' && j.delta?.type === 'input_json_delta') {
                const idx = j.index ?? 0;
                if (anthropicToolBlocks[idx]) {
                  anthropicToolBlocks[idx].partial_input += j.delta.partial_json || '';
                }
              }
              if (j.type === 'message_start' && j.message?.usage) {
                usage = { ...(usage || {}), ...j.message.usage };
              }
              if (j.type === 'message_delta' && j.usage) {
                usage = { ...(usage || {}), ...j.usage };
              }
            } else if (s.apiFormat === 'responses') {
              if (j.type === 'response.output_text.delta') {
                const delta = j.delta || '';
                assistantText += delta;
                _emit({ type: 'text_delta', text: delta });
              }
              if (j.type === 'response.output_item.added' && j.item?.type === 'function_call') {
                const key = responsesEventKey(j, j.item);
                responsesToolBlocks[key] = {
                  id: j.item.call_id || j.item.id || key,
                  name: j.item.name || '',
                  arguments: j.item.arguments || ''
                };
              }
              if (j.type === 'response.function_call_arguments.delta') {
                const key = responsesEventKey(j);
                if (!responsesToolBlocks[key]) {
                  responsesToolBlocks[key] = { id: key, name: '', arguments: '' };
                }
                responsesToolBlocks[key].arguments += j.delta || '';
              }
              if (j.type === 'response.output_item.done' && j.item?.type === 'function_call') {
                const key = responsesEventKey(j, j.item);
                responsesToolBlocks[key] = {
                  id: j.item.call_id || j.item.id || key,
                  name: j.item.name || responsesToolBlocks[key]?.name || '',
                  arguments: j.item.arguments || responsesToolBlocks[key]?.arguments || '{}'
                };
              }
              if (j.type === 'response.completed' && j.response) {
                responsesOutput = Array.isArray(j.response.output) ? j.response.output : null;
                usage = normalizeResponsesUsage(j.response.usage) || usage;
                if (!assistantText) {
                  assistantText = extractResponsesText(j.response);
                  if (assistantText) _emit({ type: 'text_delta', text: assistantText });
                }
              }
            } else {
              const delta = j.choices?.[0]?.delta;
              if (delta) {
                if (delta.content) {
                  assistantText += delta.content;
                  _emit({ type: 'text_delta', text: delta.content });
                }
                if (delta.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!tcMap[idx]) tcMap[idx] = { id: tc.id || '', function: { name: '', arguments: '' } };
                    if (tc.id) tcMap[idx].id = tc.id;
                    if (tc.function?.name) tcMap[idx].function.name += tc.function.name;
                    if (tc.function?.arguments) tcMap[idx].function.arguments += tc.function.arguments;
                  }
                }
              }
              if (j.usage) usage = j.usage;
            }
          } catch (e) {}
        }
      }
      
      // 整理 tool_calls
      if (s.apiFormat === 'anthropic') {
        assistantToolCalls = Object.values(anthropicToolBlocks).map(tb => ({
          id: tb.id, name: tb.name, arguments: tb.partial_input || '{}'
        }));
      } else if (s.apiFormat === 'responses') {
        assistantResponsesOutput = responsesOutput;
        assistantToolCalls = responsesOutput
          ? extractResponsesToolCalls(responsesOutput)
          : Object.values(responsesToolBlocks)
              .filter(tc => tc.id && tc.name)
              .map(tc => ({ id: tc.id, name: tc.name, arguments: tc.arguments || '{}' }));
      } else {
        assistantToolCalls = Object.values(tcMap).map(tc => ({
          id: tc.id, name: tc.function.name, arguments: tc.function.arguments || '{}'
        }));
      }
      
      if (typeof recordRawResponse === 'function') {
        recordRawResponse({
          ts: Date.now(), isStream: true, contentType: ct,
          raw: rawAccumulated, usage,
          parsedContent: assistantText,
          parsedToolCalls: assistantToolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } })),
          request: { url, method: 'POST', headers, body },
          _source: 'runAgentLoop · 流式'
        });
      }
    } else {
      // === 非流式解析 ===
      const txt = await resp.text();
      let j;
      try { j = JSON.parse(txt); } catch (e) { throw new Error('JSON 解析失败：' + txt.slice(0, 200)); }
      if (j.error) throw new Error(`API 错误：${j.error.message || JSON.stringify(j.error)}`);
      
      if (s.apiFormat === 'anthropic') {
        const contents = j.content || [];
        assistantText = contents.filter(p => p.type === 'text').map(p => p.text).join('');
        const toolUses = contents.filter(p => p.type === 'tool_use');
        assistantToolCalls = toolUses.map(tu => ({
          id: tu.id, name: tu.name, arguments: JSON.stringify(tu.input || {})
        }));
        if (assistantText) _emit({ type: 'text_delta', text: assistantText });
      } else if (s.apiFormat === 'responses') {
        assistantText = extractResponsesText(j);
        if (assistantText) _emit({ type: 'text_delta', text: assistantText });
        assistantResponsesOutput = Array.isArray(j.output) ? j.output : null;
        assistantToolCalls = extractResponsesToolCalls(j.output);
        usage = normalizeResponsesUsage(j.usage);
      } else {
        const msg = j.choices?.[0]?.message;
        if (msg) {
          assistantText = msg.content || '';
          if (assistantText) _emit({ type: 'text_delta', text: assistantText });
          if (msg.tool_calls?.length) {
            assistantToolCalls = msg.tool_calls.map(tc => ({
              id: tc.id, name: tc.function?.name || '', arguments: tc.function?.arguments || '{}'
            }));
          }
        }
      }
      usage = usage || j.usage || null;
      
      if (typeof recordRawResponse === 'function') {
        recordRawResponse({
          ts: Date.now(), isStream: false, contentType: ct,
          raw: txt, parsedJson: j, usage,
          request: { url, method: 'POST', headers, body },
          _source: 'runAgentLoop · 非流式'
        });
      }
    }
    
    // 把 usage 累计到当前对话（让师生模式的 token 也进总账）
    if (usage && typeof recordUsageFromResponse === 'function') {
      const _c = chat
        || (chatId && typeof chatById === 'function' ? chatById(chatId) : null)
        || (typeof activeTaskChat === 'function' ? activeTaskChat() : (typeof currentChat === 'function' ? currentChat() : null));
      if (_c) recordUsageFromResponse(_c, usage, { model });
      totalUsage = totalUsage ? { ...totalUsage, ...usage } : usage;
    }
    
    // 把 assistant 消息加入内部 messages
    const assistantMsg = { role: 'assistant', content: assistantText };
    if (assistantResponsesOutput) assistantMsg._responsesOutput = assistantResponsesOutput;
    if (assistantToolCalls.length) {
      assistantMsg.tool_calls = assistantToolCalls.map(tc => ({
        id: tc.id, type: 'function',
        function: { name: tc.name, arguments: tc.arguments }
      }));
    }
    messages.push(assistantMsg);
    
    _emit({ type: 'round_end', round: round + 1, hasToolCalls: assistantToolCalls.length > 0, text: assistantText });
    
    // 没工具调用 → 结束
    if (!assistantToolCalls.length) {
      finalText = assistantText;
      break;
    }
    
    // 到了 maxRounds 仍想调工具，但已无 tools → 把这次 assistant 文本当作 final
    // （上面构造 body 时最后一轮已剥掉 tools，模型还硬要 call 极少见，但兜底）
    if (round >= maxRounds) {
      // ⭐ 关键修复：剥离未执行的 tool_calls，避免污染 messages
      if (assistantMsg.tool_calls) {
        console.warn('[runAgentLoop] 工具轮次已用完但仍有 tool_calls，自动清除');
        delete assistantMsg.tool_calls;
      }
      finalText = assistantText || '(已达最大工具调用轮数，强制结束)';
      break;
    }
    
    // 执行每个工具
    const executedIds = [];  // ⭐ 追踪已执行的 tool_call
    for (const tc of assistantToolCalls) {
      if (_isAborted()) {
        // ⭐ 清理未执行的 tool_calls，避免残留
        if (assistantMsg.tool_calls) {
          assistantMsg.tool_calls = assistantMsg.tool_calls.filter(
            t => executedIds.includes(t.id)
          );
        }
        const err = new Error('用户中断'); err.name = 'AbortError'; throw err;
      }
      
      let args = {};
      try { args = JSON.parse(tc.arguments || '{}'); } catch (e) {}
      
      _emit({ type: 'tool_call', id: tc.id, name: tc.name, args });
      
      const result = await executeTool(tc.name, args, { chatId, chat: chat || (chatId && typeof chatById === 'function' ? chatById(chatId) : null) });
      
      let contentText;
      let isError = false;
      if (typeof result.value === 'string') {
        contentText = result.value;
        isError = !result.ok;
      } else if (typeof result.value === 'object' && result.value !== null) {
        if (result.value._stopAll || result.value._userRejected) {
          contentText = result.value.error || '用户中断';
          isError = true;
        } else if (result.value.ok === false) {
          contentText = result.value.error || JSON.stringify(result.value);
          isError = true;
        } else {
          contentText = JSON.stringify(result.value);
          isError = !result.ok;
        }
      } else {
        contentText = JSON.stringify(result.value);
        isError = !result.ok;
      }
      
      const preparedToolResult = typeof prepareToolResultForContext === 'function'
        ? prepareToolResultForContext({
            content: contentText,
            toolName: tc.name,
            toolCallId: tc.id,
            chatId,
            chat: chat || (chatId && typeof chatById === 'function' ? chatById(chatId) : null),
            status: isError ? 'error' : 'success',
            args
          })
        : { content: contentText, archived: false };
      contentText = preparedToolResult.content;
      
      _emit({ type: 'tool_result', id: tc.id, name: tc.name, content: contentText, ok: !isError });
      
      // 加入内部 messages（供下一轮 LLM 参考）
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        name: tc.name,
        content: contentText,
        _artifactId: preparedToolResult.artifactId,
        _artifactMeta: preparedToolResult.artifactMeta
      });
      executedIds.push(tc.id);  // ⭐ 记录已执行
      
      // ⭐ _stopAll / _userRejected → 清理未执行的 tool_calls 并退出工具循环
      if (result.value && result.value._stopAll) {
        if (assistantMsg.tool_calls) {
          assistantMsg.tool_calls = assistantMsg.tool_calls.filter(
            t => executedIds.includes(t.id)
          );
        }
        break;
      }
    }
    
    // 继续下一轮
  }
  
  _emit({ type: 'done', finalText });
  return { finalText, messages, usage: totalUsage };
}
