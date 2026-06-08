// ============ 📑 大纲模式 - 核心执行逻辑 ============
// 【模块定位】主流程 + 工具处理（无 DOM 操作）
// 依赖：outline-prompts.js（OUTLINE_TOOLS / OUTLINE_TOOL_NAMES / DEFAULT_OUTLINE_SYSTEM_PROMPT）
//       state.js / api.js / tools.js / chat.js
// 加载顺序：在 outline-prompts.js 之后，outline-render.js 之前

// ⭐ 单轮 fetch 硬超时（毫秒）。即使外部 abort 信号失灵，到点也会强行抛错
// 5 分钟够长（推理模型也能跑完），但能兜住"网络层死锁"导致的永久挂起
const OUTLINE_FETCH_TIMEOUT_MS = 5 * 60 * 1000;

function outlineExtractTaskText(history) {
  return (history || [])
    .filter(m => m && m.role === 'user')
    .map(m => {
      if (typeof m.content === 'string') return m.content;
      try { return JSON.stringify(m.content); } catch (e) { return ''; }
    })
    .join('\n\n')
    .slice(-12000);
}

function outlineLooksLikeCodeTask(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return false;
  return /(?:代码|项目|仓库|文件|脚本|函数|类|接口|组件|页面|测试|单测|构建|编译|运行|报错|错误|异常|修复|bug|实现|重构|依赖|配置|启动|调试|code|repo|project|file|script|function|class|component|test|pytest|unittest|jest|vitest|npm|pnpm|yarn|mvn|gradle|cargo|go test|build|compile|run|error|exception|traceback|fix|bug|implement|refactor|dependency|config|debug)/i.test(t);
}

function buildOutlineSystemPrompt(basePrompt, history) {
  return buildOutlineSystemPromptForProfile(basePrompt, history, outlineFallbackTaskProfile(history));
}

function outlineFallbackTaskProfile(history, reason) {
  const taskText = outlineExtractTaskText(history);
  const looksCode = outlineLooksLikeCodeTask(taskText);
  return {
    domain: looksCode ? 'coding' : 'general',
    intent: looksCode ? 'code_change' : 'other',
    requiresCodeChange: looksCode,
    requiresVerification: looksCode,
    verificationPolicy: looksCode ? 'if_code_changed' : 'none',
    suggestedCommands: [],
    confidence: looksCode ? 0.55 : 0.45,
    reason: reason || (looksCode ? '关键词规则判断为代码相关任务。' : '关键词规则未判断为代码任务。'),
    source: 'heuristic'
  };
}

function normalizeOutlineTaskProfile(raw, history) {
  const fallback = outlineFallbackTaskProfile(history);
  const allowedDomains = new Set(['coding', 'research', 'writing', 'file_ops', 'general']);
  const allowedIntents = new Set(['read_only', 'code_change', 'debug', 'test_only', 'explain', 'other']);
  const allowedPolicies = new Set(['none', 'if_code_changed', 'after_each_code_change']);
  const profile = raw && typeof raw === 'object' ? raw : {};
  const domain = allowedDomains.has(profile.domain) ? profile.domain : fallback.domain;
  const intent = allowedIntents.has(profile.intent) ? profile.intent : fallback.intent;
  const requiresCodeChange = typeof profile.requiresCodeChange === 'boolean'
    ? profile.requiresCodeChange
    : (typeof profile.requires_code_change === 'boolean' ? profile.requires_code_change : fallback.requiresCodeChange);
  let requiresVerification = typeof profile.requiresVerification === 'boolean'
    ? profile.requiresVerification
    : (typeof profile.requires_verification === 'boolean' ? profile.requires_verification : fallback.requiresVerification);
  let verificationPolicy = allowedPolicies.has(profile.verificationPolicy)
    ? profile.verificationPolicy
    : (allowedPolicies.has(profile.verification_policy) ? profile.verification_policy : fallback.verificationPolicy);
  const confidence = Math.max(0, Math.min(1, Number(profile.confidence)));
  const suggestedRaw = Array.isArray(profile.suggestedCommands)
    ? profile.suggestedCommands
    : (Array.isArray(profile.suggested_commands) ? profile.suggested_commands : []);

  // 运行时门禁只在实际发生代码修改后触发；这里的 true 表示任务策略需要验证。
  if (verificationPolicy === 'none') requiresVerification = false;
  if (requiresVerification && verificationPolicy === 'none') verificationPolicy = 'if_code_changed';

  return {
    domain,
    intent,
    requiresCodeChange: !!requiresCodeChange,
    requiresVerification: !!requiresVerification,
    verificationPolicy,
    suggestedCommands: suggestedRaw.map(x => String(x || '').trim()).filter(Boolean).slice(0, 6),
    confidence: Number.isFinite(confidence) ? confidence : fallback.confidence,
    reason: String(profile.reason || fallback.reason || '').slice(0, 500),
    source: profile.source || 'ai'
  };
}

function parseOutlineTaskProfileJson(raw, history) {
  try {
    let txt = String(raw || '').trim();
    txt = txt.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/, '');
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('missing json');
    return normalizeOutlineTaskProfile(JSON.parse(m[0]), history);
  } catch (e) {
    return outlineFallbackTaskProfile(history, `AI 分类结果不可解析，回退关键词规则：${e.message || e}`);
  }
}

async function classifyOutlineTaskProfile(history, model, options = {}) {
  const taskText = outlineExtractTaskText(history);
  const prompt = `你是任务分流器。请判断用户任务是否需要代码修改和验证。严格只输出 JSON，不要代码块或解释。

字段：
{
  "domain": "coding|research|writing|file_ops|general",
  "intent": "read_only|code_change|debug|test_only|explain|other",
  "requiresCodeChange": true/false,
  "requiresVerification": true/false,
  "verificationPolicy": "none|if_code_changed|after_each_code_change",
  "suggestedCommands": ["可选验证命令"],
  "confidence": 0到1,
  "reason": "一句话理由"
}

判断规则：
- 解释概念、写作、总结、资料查询通常不需要代码验证。
- 只读代码/解释项目可以 domain=coding，但 requiresCodeChange=false，requiresVerification=false。
- 修 bug、实现功能、改代码、调测试、改配置、改依赖时 requiresCodeChange=true，requiresVerification=true。
- 如果不确定是否会改代码，但任务目标明显是修复/实现/调试，requiresVerification=true；运行时只有实际改代码后才会强制验证。
- suggestedCommands 只给明显可能相关的命令，不要编造太具体的脚本名。`;
  try {
    const raw = await callOnceWithRole(
      [{ role: 'user', content: `【用户任务】\n${taskText || '(空)'}` }],
      model,
      prompt,
      {
        ...options,
        sourceLabel: '大纲模式 · 任务分类'
      }
    );
    return parseOutlineTaskProfileJson(raw, history);
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    return outlineFallbackTaskProfile(history, `AI 分类调用失败，回退关键词规则：${e.message || e}`);
  }
}

function outlineShouldUseCodeProfile(taskProfile, history) {
  if (!taskProfile) return outlineLooksLikeCodeTask(outlineExtractTaskText(history));
  return taskProfile.domain === 'coding'
    || taskProfile.requiresCodeChange
    || taskProfile.requiresVerification
    || ['code_change', 'debug', 'test_only'].includes(taskProfile.intent);
}

function buildOutlineSystemPromptForProfile(basePrompt, history, taskProfile) {
  const prompt = basePrompt || DEFAULT_OUTLINE_SYSTEM_PROMPT;
  if (!outlineShouldUseCodeProfile(taskProfile, history)) return prompt;
  let extra = typeof CODE_TASK_OUTLINE_PROFILE_PROMPT === 'string' ? CODE_TASK_OUTLINE_PROFILE_PROMPT : '';
  if (taskProfile && taskProfile.suggestedCommands && taskProfile.suggestedCommands.length) {
    extra += `\n\n【建议验证命令】\n${taskProfile.suggestedCommands.map(x => `- ${x}`).join('\n')}`;
  }
  return prompt + extra;
}

function outlineToolCallEntries(outlineObj) {
  const entries = [];
  const collect = arr => {
    if (Array.isArray(arr)) {
      for (const x of arr) if (x && typeof x === 'object') entries.push(x);
    }
  };
  collect(outlineObj && outlineObj.globalToolCalls);
  for (const item of ((outlineObj && outlineObj.items) || [])) collect(item.toolCalls);
  return entries;
}

function outlineHasExecuteAction(outlineObj) {
  return outlineToolCallEntries(outlineObj).some(tc => tc.name === 'execute_action');
}

function outlineIsCodeMutationCall(tc) {
    if (!tc || !tc.name) return false;
    if (['apply_patch', 'save_note', 'edit_note', 'append_note', 'delete_note'].includes(tc.name)) {
      if (tc.name === 'apply_patch' && tc.args && tc.args.dry_run === true) return false;
      return true;
    }
    if (tc.name !== 'execute_action') return false;
    const cmd = String((tc.args && tc.args.command) || '');
    return /\b(npm|pnpm|yarn|pip)\b.*\b(add|install|remove|uninstall)\b/i.test(cmd)
      || /\b(eslint|ruff)\b.*\b--fix\b/i.test(cmd)
      || /\b(prettier)\b.*\b--write\b/i.test(cmd)
      || /\b(gofmt|rustfmt)\b.*\b-w\b/i.test(cmd)
      || /\b(npm|pnpm|yarn)\b.*\b(format|fix)\b/i.test(cmd)
      || /\b(sed|perl|powershell|python)\b.*\b(-i|set-content|out-file|writealltext|replace)\b/i.test(cmd);
}

function outlineHasCodeMutation(outlineObj) {
  return outlineToolCallEntries(outlineObj).some(outlineIsCodeMutationCall);
}

function outlineLooksLikeVerificationCommand(command) {
  const cmd = String(command || '').toLowerCase();
  return /\b(test|pytest|unittest|jest|vitest|mocha|ava|npm\s+test|pnpm\s+test|yarn\s+test|mvn\s+test|gradle\s+test|cargo\s+test|go\s+test|build|lint|typecheck|check|compile|tsc|eslint|ruff|flake8|mypy|pytest|phpunit|rspec)\b/.test(cmd)
    || /\b(python|node|go|cargo|mvn|gradle|npm|pnpm|yarn)\b.*\b(test|build|lint|check|compile|typecheck)\b/.test(cmd);
}

function outlineVerificationState(outlineObj) {
  const entries = outlineToolCallEntries(outlineObj)
    .map((tc, idx) => ({ tc, idx, ts: Number(tc && tc._ts) || idx }));
  const mutationEntries = entries.filter(x => outlineIsCodeMutationCall(x.tc));
  const lastMutation = mutationEntries.length ? mutationEntries[mutationEntries.length - 1] : null;
  const executeEntries = entries.filter(x => x.tc && x.tc.name === 'execute_action');
  const verificationEntries = executeEntries.filter(x =>
    outlineLooksLikeVerificationCommand(x.tc.args && x.tc.args.command)
  );
  const afterMutation = lastMutation
    ? verificationEntries.filter(x => x.ts > lastMutation.ts || (x.ts === lastMutation.ts && x.idx > lastMutation.idx))
    : verificationEntries;
  const passedAfterMutation = afterMutation.filter(x => {
    const rc = x.tc.rawResult && Number.isFinite(Number(x.tc.rawResult.returncode))
      ? Number(x.tc.rawResult.returncode)
      : null;
    return rc === 0;
  });
  const lastVerification = verificationEntries.length ? verificationEntries[verificationEntries.length - 1].tc : null;
  const lastAfterMutation = afterMutation.length ? afterMutation[afterMutation.length - 1].tc : null;
  return {
    hasMutation: !!lastMutation,
    lastMutation: lastMutation ? lastMutation.tc : null,
    hasExecute: executeEntries.length > 0,
    hasVerification: verificationEntries.length > 0,
    hasVerificationAfterMutation: afterMutation.length > 0,
    hasPassedVerificationAfterMutation: passedAfterMutation.length > 0,
    lastVerification,
    lastVerificationAfterMutation: lastAfterMutation,
    lastVerificationReturncode: lastAfterMutation && lastAfterMutation.rawResult ? lastAfterMutation.rawResult.returncode : null
  };
}

function outlineHasVerificationBlocker(outlineObj) {
  const text = ((outlineObj && outlineObj.items) || [])
    .map(it => `${it.title || ''}\n${it.note || ''}`)
    .join('\n')
    .toLowerCase();
  return /(?:无法运行|不能运行|未能运行|无法执行|不能执行|缺少依赖|缺依赖|缺少配置|缺配置|权限不足|环境限制|没有测试|无测试|阻塞|blocked|cannot run|can't run|unable to run|missing dependency|missing config|permission denied|environment limitation|no test)/i.test(text);
}

function outlineCodeGateNeedsVerification(outlineObj, taskProfile) {
  if (!taskProfile || !taskProfile.requiresVerification || outlineHasVerificationBlocker(outlineObj)) return false;
  const state = outlineVerificationState(outlineObj);
  return state.hasMutation && !state.hasPassedVerificationAfterMutation;
}

function outlineCodeGateMessage(outlineObj) {
  const st = outlineVerificationState(outlineObj);
  if (!st.hasMutation) return '';
  if (!st.hasVerification) {
    return '【系统门禁】这是代码任务，且你已经修改过代码，但还没有运行任何明显的测试、构建、lint、typecheck、启动检查或最小复现命令。不要最终总结。请继续调用 execute_action 运行最相关的验证命令；如果确实无法运行，必须调用 update_outline 记录阻塞原因。';
  }
  if (!st.hasVerificationAfterMutation) {
    return '【系统门禁】你在上一次验证之后又修改了代码，但还没有重新验证。不要最终总结。请继续调用 execute_action 运行与最新改动相关的测试、构建或最小检查；如果确实无法运行，必须调用 update_outline 记录阻塞原因。';
  }
  return `【系统门禁】最新代码修改后的验证命令没有通过（退出码 ${st.lastVerificationReturncode ?? '?'}）。不要最终总结。请读取 stdout/stderr，继续修复后再次运行验证命令；如果失败是环境/依赖/权限阻塞，必须调用 update_outline 明确记录阻塞原因。`;
}

function outlineNormalizePatchPath(path) {
  let p = String(path || '').replace(/\\/g, '/');
  const root = (typeof window !== 'undefined' && window.TERMINAL_CONFIG && window.TERMINAL_CONFIG.workspace) || '';
  if (root) {
    const normRoot = String(root).replace(/\\/g, '/').replace(/\/+$/, '');
    if (p.toLowerCase().startsWith(normRoot.toLowerCase() + '/')) {
      p = p.slice(normRoot.length + 1);
    }
  }
  p = p.replace(/^[a-z]:\//i, '').replace(/^\/+/, '');
  const idx = p.lastIndexOf('/agent/');
  if (idx >= 0) p = p.slice(idx + '/agent/'.length);
  return p || String(path || '');
}

function outlineBuildDiffSummary(outlineObj) {
  const map = new Map();
  const addFile = (path, added, removed, source) => {
    if (!path) return;
    const key = outlineNormalizePatchPath(path);
    const cur = map.get(key) || { path: key, added: 0, removed: 0, sources: new Set() };
    cur.added += Math.max(0, parseInt(added) || 0);
    cur.removed += Math.max(0, parseInt(removed) || 0);
    if (source) cur.sources.add(source);
    map.set(key, cur);
  };

  for (const tc of outlineToolCallEntries(outlineObj)) {
    if (!tc || tc.ok === false || tc._running) continue;
    if (tc.name === 'apply_patch' && !(tc.args && tc.args.dry_run === true)) {
      const files = (tc.rawResult && Array.isArray(tc.rawResult.files)) ? tc.rawResult.files : [];
      for (const f of files) addFile(f.path, f.added, f.removed, 'apply_patch');
    } else if (['save_note', 'edit_note', 'append_note', 'delete_note'].includes(tc.name)) {
      const path = (tc.args && tc.args.path) || '';
      addFile(path, 0, 0, tc.name);
    }
  }

  const files = Array.from(map.values()).map(x => ({
    path: x.path,
    added: x.added,
    removed: x.removed,
    sources: Array.from(x.sources)
  })).sort((a, b) => a.path.localeCompare(b.path));
  if (!files.length) return null;
  return {
    files,
    totalFiles: files.length,
    totalAdded: files.reduce((sum, f) => sum + f.added, 0),
    totalRemoved: files.reduce((sum, f) => sum + f.removed, 0)
  };
}

function outlineResponsesUserContentParts(content) {
  const parts = [];
  const addText = (text) => {
    const value = String(text || '');
    if (value) parts.push({ type: 'input_text', text: value });
  };
  for (const part of (Array.isArray(content) ? content : [])) {
    if (!part) continue;
    if (typeof part === 'string') {
      addText(part);
    } else if (part.type === 'input_text') {
      addText(part.text);
    } else if (part.type === 'text') {
      addText(part.text);
    } else if (part.type === 'image_url') {
      const url = part.image_url && (part.image_url.url || part.image_url);
      if (url) parts.push({ type: 'input_image', image_url: url });
    } else if (part.type === 'input_image' || part.type === 'input_file') {
      parts.push(part);
    } else if (part.type === 'image' && part.source && part.source.type === 'base64') {
      const mediaType = part.source.media_type || 'image/png';
      const data = part.source.data || '';
      if (data) parts.push({ type: 'input_image', image_url: `data:${mediaType};base64,${data}` });
    } else if (part.text) {
      addText(part.text);
    } else {
      try { addText(JSON.stringify(part)); } catch (e) {}
    }
  }
  return parts;
}

function outlineBuildResponsesInput(history, conversationMessages) {
  const out = [];
  const appendViaAdapter = (msg) => {
    if (!msg) return;
    if (typeof buildOpenAIResponsesInput === 'function') {
      out.push(...buildOpenAIResponsesInput([msg]));
    } else {
      out.push(msg);
    }
  };
  const all = [...(history || []), ...(conversationMessages || [])];
  for (const msg of all) {
    if (!msg || typeof msg !== 'object' || msg._isCompressing) continue;
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const parts = outlineResponsesUserContentParts(msg.content);
      out.push({ role: 'user', content: parts.length ? parts : '' });
    } else {
      appendViaAdapter(msg);
    }
  }
  return out;
}

function outlineNormalizeUsage(usage) {
  return state.settings.apiFormat === 'responses' && typeof normalizeResponsesUsage === 'function'
    ? normalizeResponsesUsage(usage)
    : usage;
}

function outlineToolResultText(result) {
  const value = result && result.value;
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.error === 'string') return value.error;
    try { return JSON.stringify(value); } catch (e) { return String(value); }
  }
  return value === undefined ? '' : String(value);
}

function outlineToolResultOutcome(result, content) {
  const value = result && result.value;
  const isObject = value && typeof value === 'object';
  const text = String(content || '');
  const stopAll = !!(isObject && value._stopAll)
    || /(?:🛑|用户拒绝).*?(?:停止|后续|所有)/.test(text);
  const userRejected = !!(isObject && value._userRejected)
    || /(?:⏭️|用户拒绝此次|用户拒绝此操作|用户拒绝了此操作)/.test(text);
  const valueFailed = !!(isObject && value.ok === false);
  return {
    ok: !!(result && result.ok) && !stopAll && !userRejected && !valueFailed,
    stopAll,
    userRejected
  };
}

// ⭐ 直接复用 api-core.js 的 _apiFetchWithTimeout —— 这样大纲模式自动享受：
//    ① 本地代理（绕过 CORS）
//    ② TypeError → 人话错误的翻译
//    ③ 与对话模式完全一致的网络层行为
// 之前自己实现的版本因为没经过代理，会直连第三方 → file:// 下 100% CORS 失败
function _outlineFetchWithTimeout(url, init, externalSignal, timeoutMs) {
  if (typeof _apiFetchWithTimeout === 'function') {
    return _apiFetchWithTimeout(url, init, externalSignal, timeoutMs || OUTLINE_FETCH_TIMEOUT_MS);
  }
  // 兜底：万一 api-core.js 没加载（不该发生），退回最朴素的直连版本
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(), timeoutMs || OUTLINE_FETCH_TIMEOUT_MS);
  let externalAbortHandler = null;
  if (externalSignal) {
    if (externalSignal.aborted) {
      timeoutCtrl.abort();
    } else {
      externalAbortHandler = () => timeoutCtrl.abort();
      externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
    }
  }
  const merged = { ...(init || {}), signal: timeoutCtrl.signal };
  return fetch(url, merged).finally(() => {
    clearTimeout(timer);
    if (externalSignal && externalAbortHandler) {
      externalSignal.removeEventListener('abort', externalAbortHandler);
    }
  }).catch(e => {
    if (e.name === 'AbortError' && externalSignal && !externalSignal.aborted) {
      const err = new Error(`⏱ 请求超时（${Math.round((timeoutMs || OUTLINE_FETCH_TIMEOUT_MS) / 1000)}s 无响应）。可能是网络问题或模型卡死，已自动中断。`);
      err.name = 'TimeoutError';
      throw err;
    }
    throw e;
  });
}

// ⭐ 大纲模式的"带重试 fetch+解析" helper
// 直接复用 api-core.js 的 _isRetryableError / _retryDelay / _sleepAbortable
// 失败时把"正在重试"信息通过 onProgress 回写给 UI
async function _outlineFetchJsonWithRetry(url, init, abortSignal, onProgress) {
  const s = state.settings;
  const maxAttempts = Math.max(1, (parseInt(s.retryMaxAttempts) || 3) + 1);
  const baseDelay = Math.max(100, parseInt(s.retryBaseDelayMs) || 1000);
  let lastErr = null;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let httpStatus = 0;
    let retryAfter = null;
    try {
      const resp = await _outlineFetchWithTimeout(url, init, abortSignal, OUTLINE_FETCH_TIMEOUT_MS);
      if (typeof recordRequest === 'function') recordRequest();
      if (!resp.ok) {
        httpStatus = resp.status;
        retryAfter = resp.headers.get('retry-after');
        const t = await resp.text();
        const err = new Error(`HTTP ${resp.status}: ${t.slice(0, 300)}`);
        err.httpStatus = resp.status;
        err.retryAfter = retryAfter;
        throw err;
      }
      const _rawText = await resp.text();
      let j;
      try { j = JSON.parse(_rawText); }
      catch (e) { throw new Error('JSON 解析失败：' + _rawText.slice(0, 300)); }
      if (j.error) throw new Error(`API 错误：${j.error.message || JSON.stringify(j.error)}`);
      return { resp, rawText: _rawText, json: j };
    } catch (e) {
      lastErr = e;
      if (e.name === 'AbortError' || (abortSignal && abortSignal.aborted)) throw e;
      const retryable = (typeof _isRetryableError === 'function')
        ? _isRetryableError(e, httpStatus || e.httpStatus, abortSignal)
        : false;
      const remaining = maxAttempts - attempt;
      if (!retryable || remaining <= 0) throw e;
      const wait = (typeof _retryDelay === 'function')
        ? _retryDelay(attempt, retryAfter || e.retryAfter, baseDelay)
        : (baseDelay * Math.pow(2, attempt - 1));
      console.warn(`[outline] 第 ${attempt}/${maxAttempts} 次失败：${e.message}\n  → ${wait}ms 后重试`);
      if (typeof onProgress === 'function') {
        onProgress(`🔁 第 ${attempt} 次失败，${Math.round(wait / 1000) || 1}s 后重试…（${e.message.split('\n')[0].slice(0, 80)}）`);
      }
      if (typeof _sleepAbortable === 'function') {
        await _sleepAbortable(wait, abortSignal);
      } else {
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw lastErr || new Error('未知错误');
}

// ============ 主流程 ============
// options:
//   - resumeFromMsgIdx: number  从该消息的 outline._snap 恢复执行
//   - userInjection: string     恢复时注入的用户留言

async function callAPIWithOutline(options = {}) {
  const requestedChatId = options && options.chatId;
  const c = requestedChatId ? chatById(requestedChatId) : currentChat();
  if (!c) return;
  const taskChatId = c.id;
  const s = state.settings;
  const taskUseTools = options.useTools !== undefined ? !!options.useTools : !!s.useTools;
  const suppressCompletionSound = !!options.suppressCompletionSound;
  
  let abortCtrl = new AbortController();
  const task = (typeof beginChatTask === 'function')
    ? beginChatTask(taskChatId, abortCtrl, { resetStop: true })
    : null;
  if (task && typeof setChatTaskMode === 'function') {
    setChatTaskMode(taskChatId, 'outline', { outlineForceFinish: false });
    if (typeof updateChatTaskController === 'function') updateChatTaskController(taskChatId, abortCtrl);
  } else {
    state.isGenerating = true;
    state.activeTaskChatId = taskChatId;
    state.abortCtrl = abortCtrl;
    state._outlineExecuting = true;
  }
  // ⭐ 清零软停止标志：本次任务是新的开始，不要被上次残留的停止意图误杀
  state.stopRequested = false;
  if (typeof updateSendBtn === 'function') updateSendBtn();
  if (typeof renderChatList === 'function') renderChatList();
  
  let aiMsg, msgIdx;
  let conversationMessages, finalAnswer, completedNaturally, taskProfile;
  let startLoop, model, systemPrompt, maxRounds, history;
  let stoppedByToolPolicy = false;
  
  if (options.resumeFromMsgIdx !== undefined) {
    // ===== 恢复模式 =====
    msgIdx = options.resumeFromMsgIdx;
    aiMsg = c.messages[msgIdx];
    if (!aiMsg || !aiMsg.outline || !aiMsg.outline._snap) {
      if (typeof clearChatTask === 'function') clearChatTask(taskChatId);
      else {
        state.isGenerating = false;
        state.abortCtrl = null;
        if (state.activeTaskChatId === taskChatId) state.activeTaskChatId = null;
        state._outlineExecuting = false;
      }
      if (typeof updateSendBtn === 'function') updateSendBtn();
      if (typeof toast === 'function') toast('❌ 该任务无法恢复（状态已丢失，请重新提问）', 4000);
      return;
    }
    const snap = aiMsg.outline._snap;
    conversationMessages = snap.conversationMessages.slice();
    finalAnswer = snap.finalAnswer || '';
    startLoop = snap.nextLoop || 0;
    model = snap.model;
    systemPrompt = snap.systemPrompt;
    maxRounds = snap.maxRounds;
    history = snap.history;
    taskProfile = snap.taskProfile || outlineFallbackTaskProfile(snap.history || history || [], '旧任务快照缺少 taskProfile，已回退关键词规则。');
    aiMsg.outline.taskProfile = taskProfile;
    completedNaturally = false;
    
    // 注入用户留言
    if (options.userInjection && options.userInjection.trim()) {
      const injectMsg = `【用户中途留言】${options.userInjection.trim()}\n\n请根据这条留言调整后续工作。`;
      conversationMessages.push({ role: 'user', content: injectMsg });
      if (!Array.isArray(aiMsg.outline.injections)) aiMsg.outline.injections = [];
      aiMsg.outline.injections.push({
        round: aiMsg.outline.rounds || 0,
        text: options.userInjection.trim(),
        ts: Date.now()
      });
    }
    
    // 切回 running 状态
    aiMsg.outline.status = 'running';
    aiMsg.outline.inProgress = true;
    aiMsg.outline.progressText = '🔄 恢复执行中...';
    aiMsg.outline.expanded = true;
    // 清掉之前 paused 时追加的 "[已停止]" 尾巴
    if (aiMsg.content && aiMsg.content.endsWith('*[已停止]*')) {
      aiMsg.content = aiMsg.content.replace(/\n*\*\[已停止\]\*$/, '');
    }
    if (typeof resumeMsgTimer === 'function') resumeMsgTimer(aiMsg);
    else delete aiMsg._endTime;
    if (typeof refreshMsgNode === 'function') refreshMsgNode(msgIdx, c);
    
  } else {
    // ===== 新建模式 =====
    aiMsg = {
      role: 'assistant',
      content: '',
      _startTime: Date.now(),
      outline: {
        status: 'running',
        items: [],
        globalToolCalls: [],
        rounds: 0,
        maxRounds: parseInt(s.outlineMaxRounds) || 30,
        inProgress: true,
        progressText: '🧠 思考中...',
        expanded: true,
        stalledRounds: 0,
        injections: [],
        _userQuestion: extractUserQuestion(c.messages)
      }
    };
    c.messages.push(aiMsg);
    msgIdx = c.messages.length - 1;
    
    if (typeof appendMsgNode === 'function') {
      appendMsgNode(msgIdx, c);
    } else if (typeof renderMessages === 'function') {
      if (isCurrentChat(c)) renderMessages();
    }
    
    history = c.messages.slice(0, -1);
    model = (s.outlineModel || '').trim() || s.currentModel;
    aiMsg.outline.progressText = '🧭 识别任务类型...';
    if (typeof refreshMsgNode === 'function') refreshMsgNode(msgIdx, c);
    try {
      taskProfile = await classifyOutlineTaskProfile(history, model, {
        chatId: taskChatId,
        chat: c,
        signal: abortCtrl.signal,
        isStopped: () => task ? !!task.stopRequested : !!state.stopRequested
      });
    } catch (e) {
      if (e && e.name === 'AbortError') {
        aiMsg.content = (aiMsg.content || '') + '\n\n*[任务分类已停止]*';
        aiMsg.outline.status = 'cancelled';
        aiMsg.outline.inProgress = false;
        delete aiMsg.outline.progressText;
        if (!aiMsg._endTime) aiMsg._endTime = Date.now();
        if (typeof clearChatTask === 'function') clearChatTask(taskChatId);
        if (typeof updateSendBtn === 'function') updateSendBtn();
        if (typeof renderChatList === 'function') renderChatList();
        if (typeof refreshMsgNode === 'function') refreshMsgNode(msgIdx, c);
        saveData();
        return;
      }
      taskProfile = outlineFallbackTaskProfile(history, `AI 分类调用失败，回退关键词规则：${e.message || e}`);
    }
    aiMsg.outline.taskProfile = taskProfile;
    systemPrompt = buildOutlineSystemPromptForProfile(s.outlineSystemPrompt || DEFAULT_OUTLINE_SYSTEM_PROMPT, history, taskProfile);
    maxRounds = aiMsg.outline.maxRounds;
    conversationMessages = [];
    finalAnswer = '';
    completedNaturally = false;
    startLoop = 0;
  }
  
  const onUpdate = () => {
    if (typeof updateOutlinePanel === 'function') updateOutlinePanel(msgIdx, c);
  };
  
  let abortSignal = abortCtrl.signal;
  const throwIfAborted = () => {
    // ⭐ 同时检查两种停止信号：
    //   - abortSignal.aborted：fetch / sleep 等异步操作的标准中断
    //   - state.stopRequested：跨 abortCtrl 重建边界的"软停止"，
    //     用户点暂停后即使本轮 fetch 已经结束，下一轮也能立刻退出
    const stopRequested = task ? task.stopRequested : state.stopRequested;
    if (abortSignal.aborted || stopRequested) {
      const err = new Error('用户中断');
      err.name = 'AbortError';
      throw err;
    }
  };
  
  // 实时把状态写入 outline._snap，方便暂停后恢复
  const saveSnap = (nextLoop) => {
    aiMsg.outline._snap = {
      conversationMessages: conversationMessages.slice(),
      finalAnswer,
      nextLoop,
      model,
      systemPrompt,
      maxRounds,
      history,
      taskProfile
    };
  };
  
  try {
    for (let loop = startLoop; loop < maxRounds; loop++) {
      throwIfAborted();
      
      aiMsg.outline.rounds = loop + 1;
      const remaining = maxRounds - loop;  // 包含本轮的剩余轮数
      aiMsg.outline.progressText = `🧠 第 ${loop + 1}/${maxRounds} 轮 · 思考中...`;
      onUpdate();
      
      // 🛡️ 第一层 + 第二层：根据剩余轮数注入分级提醒
      // 仅在剩余 ≤ 一半时开始提示，避免前期占用上下文
      // 注意：每轮只注入一次，且不重复历史提醒（用 _lastBudgetWarn 记录最后一次警告等级）
      const halfPoint = Math.ceil(maxRounds / 2);
      let warnLevel = 0;  // 0=无 1=温和 2=警告 3=紧急
      if (remaining <= 2) warnLevel = 3;
      else if (remaining <= 5) warnLevel = 2;
      else if (remaining <= halfPoint) warnLevel = 1;
      
      if (warnLevel > 0 && warnLevel !== aiMsg.outline._lastBudgetWarn) {
        let warnMsg = '';
        if (warnLevel === 1) {
          warnMsg = `【系统提示】执行预算已过半，当前剩余 ${remaining} 轮。请合理规划，对仍 pending 的条目评估优先级。`;
        } else if (warnLevel === 2) {
          warnMsg = `⚠️【系统警告】仅剩 ${remaining} 轮执行预算！请加快进度，对非关键的 pending 条目用 update_outline 标记为 skipped，集中完成核心内容。`;
        } else if (warnLevel === 3) {
          warnMsg = `🚨【系统紧急】只剩 ${remaining} 轮！请立即开始收尾：把所有未完成条目标记为 done 或 skipped，下一轮请不要再调用任何工具，直接给出完整的 Markdown 格式最终答案。`;
        }
        conversationMessages.push({ role: 'user', content: warnMsg });
        aiMsg.outline._lastBudgetWarn = warnLevel;
      }
      
      // 🛡️ 第二层加强：最后 1 轮强制禁用工具；代码验证门禁未满足时仍允许工具。
      const verificationGateOpen = outlineCodeGateNeedsVerification(aiMsg.outline, taskProfile);
      const forceNoTools = (remaining <= 1 && !verificationGateOpen);
      
      // ----- 构造请求 -----
      const tools = forceNoTools ? [] : buildOutlineTools({ useTools: taskUseTools });
      let body;
      
      if (s.apiFormat === 'anthropic') {
        const baseMsgs = (typeof buildAnthropicMessages === 'function') 
          ? buildAnthropicMessages(history) : [];
        const allMsgs = [...baseMsgs];
        
        for (const m of conversationMessages) {
          if (m.role === 'assistant') {
            const parts = [];
            if (m.content && m.content.trim()) parts.push({ type: 'text', text: m.content });
            if (m.tool_calls) {
              for (const tc of m.tool_calls) {
                let input = {};
                try { input = JSON.parse(tc.function?.arguments || '{}'); } catch (e) {}
                parts.push({ type: 'tool_use', id: tc.id, name: tc.function?.name || '', input });
              }
            }
            allMsgs.push({ role: 'assistant', content: parts });
          } else if (m.role === 'tool') {
            const part = {
              type: 'tool_result',
              tool_use_id: m.tool_call_id,
              content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
            };
            const last = allMsgs[allMsgs.length - 1];
            if (last && last.role === 'user' && Array.isArray(last.content)) {
              last.content.push(part);
            } else {
              allMsgs.push({ role: 'user', content: [part] });
            }
          } else if (m.role === 'user') {
            // 系统插入的提示 / 用户中途留言 / 附件注入（可能是字符串或数组）
            // Anthropic 要求 user/assistant 交替，若上一条也是 user 数组则合并
            const last = allMsgs[allMsgs.length - 1];
            const contentParts = Array.isArray(m.content) 
              ? m.content 
              : [{ type: 'text', text: String(m.content || '') }];
            if (last && last.role === 'user' && Array.isArray(last.content)) {
              last.content.push(...contentParts);
            } else if (last && last.role === 'user' && typeof last.content === 'string') {
              // 转成数组合并
              last.content = [{ type: 'text', text: last.content }, ...contentParts];
            } else {
              allMsgs.push({ role: 'user', content: contentParts });
            }
          }
        }
        
        body = {
          model,
          messages: allMsgs,
          max_tokens: parseInt(s.maxTokens),
          temperature: parseFloat(s.temperature),
          stream: false,
          system: (typeof withActiveSkillPrompt === 'function' ? withActiveSkillPrompt(systemPrompt) : systemPrompt)
        };
        if (tools.length) body.tools = tools;
      } else if (s.apiFormat === 'responses') {
        body = {
          model,
          input: outlineBuildResponsesInput(history, conversationMessages),
          instructions: (typeof withActiveSkillPrompt === 'function' ? withActiveSkillPrompt(systemPrompt) : systemPrompt),
          temperature: parseFloat(s.temperature),
          max_output_tokens: parseInt(s.maxTokens),
          stream: false
        };
        if (tools.length) body.tools = tools;
      } else {
        const baseMsgs = (typeof buildOpenAIMessages === 'function')
          ? buildOpenAIMessages(history).filter(m => m.role !== 'system') : [];
        const allMsgs = [
          { role: 'system', content: (typeof withActiveSkillPrompt === 'function' ? withActiveSkillPrompt(systemPrompt) : systemPrompt) },
          ...baseMsgs,
          ...conversationMessages
        ];
        body = {
          model,
          messages: allMsgs,
          temperature: parseFloat(s.temperature),
          max_tokens: parseInt(s.maxTokens),
          stream: false
        };
        if (tools.length) body.tools = tools;
      }
      
      if (typeof ensureContextBeforeAgentRun === 'function') {
        aiMsg.outline.progressText = `🗜️ 第 ${loop + 1}/${maxRounds} 轮 · 检查上下文...`;
        onUpdate();
        const ok = await ensureContextBeforeAgentRun(c, {
          label: '大纲模式',
          extraMessages: conversationMessages,
          mutableMessages: conversationMessages
        });
        if (!ok) throw new Error('自动压缩失败，已暂停大纲模式请求');
      }
      
      // ----- 限速 -----
      if (typeof applyRateLimit === 'function') {
        aiMsg.outline.progressText = `⏳ 第 ${loop + 1}/${maxRounds} 轮 · 等待 API 配额...`;
        onUpdate();
        await applyRateLimit(abortSignal);
      }
      
      throwIfAborted();
      
      aiMsg.outline.progressText = `🌐 第 ${loop + 1}/${maxRounds} 轮 · 等待响应...`;
      onUpdate();
      
      const url = buildFullUrl(s.baseUrl, s.apiPath);
      const { resp, rawText: _rawText, json: j } = await _outlineFetchJsonWithRetry(url, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify(body)
      }, abortSignal, (msg) => {
        aiMsg.outline.progressText = `第 ${loop + 1}/${maxRounds} 轮 · ${msg}`;
        onUpdate();
      });
      
      // ⭐ 记录原始响应（供 JSON 查看器使用）
      if (typeof recordRawResponse === 'function') {
        recordRawResponse({
          ts: Date.now(),
          isStream: false,
          contentType: resp.headers.get('content-type') || '',
          raw: _rawText,
          parsedJson: j,
          usage: j.usage || null,
          request: { url, method: 'POST', headers: buildHeaders(), body },
          _source: `大纲模式 · 第 ${loop + 1} 轮`
        });
      }
      
      // ⭐ 把大纲模式每轮 usage 计入当前对话统计（之前漏算）
      const usageForRecord = outlineNormalizeUsage(j.usage);
      if (usageForRecord && typeof recordUsageFromResponse === 'function') {
        recordUsageFromResponse(c, usageForRecord, { model });
      }
      
      // ----- 解析返回 -----
      let assistantMsg;
      let toolCalls = null;
      
      if (s.apiFormat === 'anthropic') {
        const contents = j.content || [];
        const text = contents.filter(p => p.type === 'text').map(p => p.text).join('');
        const toolUses = contents.filter(p => p.type === 'tool_use');
        assistantMsg = { role: 'assistant', content: text };
        if (toolUses.length) {
          toolCalls = toolUses.map(tu => ({
            id: tu.id, type: 'function',
            function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) }
          }));
          assistantMsg.tool_calls = toolCalls;
        }
      } else if (s.apiFormat === 'responses') {
        const text = (typeof extractResponsesText === 'function') ? extractResponsesText(j) : '';
        const responseToolCalls = (typeof extractResponsesToolCalls === 'function')
          ? extractResponsesToolCalls(j.output)
          : [];
        assistantMsg = { role: 'assistant', content: text };
        if (Array.isArray(j.output)) assistantMsg._responsesOutput = j.output;
        if (responseToolCalls.length) {
          toolCalls = responseToolCalls.map(tc => ({
            id: tc.id, type: 'function',
            function: { name: tc.name, arguments: tc.arguments || '{}' }
          }));
          assistantMsg.tool_calls = toolCalls;
        }
      } else {
        const msg = j.choices?.[0]?.message;
        if (msg) {
          assistantMsg = { role: 'assistant', content: msg.content || '' };
          if (msg.tool_calls?.length) {
            toolCalls = msg.tool_calls;
            assistantMsg.tool_calls = toolCalls;
          }
        } else {
          assistantMsg = { role: 'assistant', content: '(无响应)' };
        }
      }
      
      conversationMessages.push(assistantMsg);
      if (assistantMsg.content) finalAnswer = assistantMsg.content;
      
      // ----- 没工具调用：完成 -----
      if (!toolCalls || !toolCalls.length) {
        if (outlineCodeGateNeedsVerification(aiMsg.outline, taskProfile)) {
          conversationMessages.push({
            role: 'user',
            content: outlineCodeGateMessage(aiMsg.outline)
          });
          aiMsg.outline.status = 'running';
          aiMsg.outline.progressText = '🧪 代码任务需要执行验证命令...';
          onUpdate();
          saveSnap(loop + 1);
          saveData();
          continue;
        }
        completedNaturally = true;
        break;
      }
      
      // ----- 执行工具 -----
      let anyOutlineChanged = false;
      let anyExternalToolCalled = false;
      const executedToolCallIds = [];
      let userStoppedAll = false;
      
      for (const tc of toolCalls) {
        throwIfAborted();
        
        const fname = tc.function?.name || '';
        let args = {};
        try { args = JSON.parse(tc.function?.arguments || '{}'); } catch (e) {}
        
        const isOutlineTool = OUTLINE_TOOL_NAMES.has(fname);
        let result;
        let preparedExternalToolResult = null;
        
        if (isOutlineTool) {
          result = handleOutlineTool(fname, args, aiMsg.outline);
          anyOutlineChanged = true;
          onUpdate();
        } else {
          // 外部工具：实时插入"运行中"卡片
          const activeItem = aiMsg.outline.items.find(it => it.status === 'active');
          const liveEntry = {
            name: fname,
            args: args,
            result: '',
            ok: null,
            _running: true,
            _ts: Date.now()
          };
          
          if (activeItem) {
            if (!Array.isArray(activeItem.toolCalls)) activeItem.toolCalls = [];
            activeItem.toolCalls.push(liveEntry);
          } else {
            aiMsg.outline.globalToolCalls.push(liveEntry);
          }
          onUpdate();
          
          result = await executeTool(fname, args, { chatId: taskChatId, chat: c, outline: aiMsg.outline });
          anyExternalToolCalled = true;
          
          const rawContent = outlineToolResultText(result);
          const preparedToolResult = typeof prepareToolResultForContext === 'function'
            ? prepareToolResultForContext({
                content: rawContent,
                toolName: fname,
                toolCallId: tc.id,
                chatId: taskChatId,
                chat: c,
                status: result.ok ? 'success' : 'error',
                args
              })
            : { content: rawContent, archived: false };
          const content = preparedToolResult.content;
          const outcome = outlineToolResultOutcome(result, content);
          preparedExternalToolResult = preparedToolResult;
          liveEntry.result = content.slice(0, 500);
          liveEntry.ok = outcome.ok;
          liveEntry.artifactId = preparedToolResult.artifactId;
          liveEntry.rawResult = result.value && typeof result.value === 'object' ? result.value : null;
          if (liveEntry.rawResult && liveEntry.rawResult.checkpoint_id) {
            liveEntry.checkpointId = liveEntry.rawResult.checkpoint_id;
            if (!aiMsg.outline.checkpointId) aiMsg.outline.checkpointId = liveEntry.rawResult.checkpoint_id;
            if (liveEntry.rawResult.checkpoint) aiMsg.outline.checkpoint = liveEntry.rawResult.checkpoint;
          }
          if (fname === 'restore_checkpoint' && result.ok && liveEntry.rawResult && liveEntry.rawResult.checkpoint_id) {
            aiMsg.outline.restoreState = {
              restored: true,
              restoredAt: new Date().toISOString(),
              checkpointId: liveEntry.rawResult.checkpoint_id,
              restoredCount: Array.isArray(liveEntry.rawResult.restored) ? liveEntry.rawResult.restored.length : 0,
              deletedCount: Array.isArray(liveEntry.rawResult.deleted) ? liveEntry.rawResult.deleted.length : 0,
              skippedCount: Array.isArray(liveEntry.rawResult.skipped) ? liveEntry.rawResult.skipped.length : 0,
              safetyCheckpointId: liveEntry.rawResult.safetyCheckpoint && liveEntry.rawResult.safetyCheckpoint.id
            };
          }
          liveEntry._running = false;
          onUpdate();
        }
        
        let content = outlineToolResultText(result);
        let preparedToolResult = preparedExternalToolResult || { content, archived: false };
        if (preparedExternalToolResult) content = preparedExternalToolResult.content;
        const outcome = outlineToolResultOutcome(result, content);
        conversationMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: fname,
          content: content,
          status: outcome.ok ? 'success' : 'error',
          _artifactId: preparedToolResult.artifactId,
          _artifactMeta: preparedToolResult.artifactMeta
        });
        executedToolCallIds.push(tc.id);
        
        if (outcome.stopAll || outcome.userRejected) {
          if (outcome.stopAll) userStoppedAll = true;
          assistantMsg.tool_calls = assistantMsg.tool_calls.filter(t => executedToolCallIds.includes(t.id));
          toolCalls = assistantMsg.tool_calls;
          conversationMessages.push({
            role: 'user',
            content: outcome.stopAll
              ? '【系统提示】用户拒绝了该工具操作，并要求停止所有后续工具调用。请不要再调用工具，基于已完成内容直接给出简短说明。'
              : '【系统提示】用户拒绝了该工具操作。请不要重复同一操作；如任务还能继续，请改用无需该权限的路径，否则直接说明受限情况。'
          });
          break;
        }
      }
      
      if (userStoppedAll) {
        stoppedByToolPolicy = true;
        completedNaturally = false;
        break;
      }
      
      // ----- 检测卡住（连续 3 轮无任何变化）-----
      if (!anyOutlineChanged && !anyExternalToolCalled) {
        aiMsg.outline.stalledRounds++;
        if (aiMsg.outline.stalledRounds >= 3) {
          conversationMessages.push({
            role: 'user',
            content: '【系统提示】你似乎在原地踏步，请重新评估当前进展。如果信息已足够，请直接给出最终答案并停止调用工具；如果仍需推进，请明确下一步行动。'
          });
          aiMsg.outline.stalledRounds = 0;
        }
      } else {
        aiMsg.outline.stalledRounds = 0;
      }
      
      // ⭐ 消化由 attach_file 等工具产生的待处理附件
      // 把它们转成 user 消息注入到 conversationMessages，下一轮 LLM 就能直接"看到"
      // 否则 terminal.js 的 autoResend 会在大纲结束后另起一段新 AI 回复
      consumePendingAttachments(conversationMessages, aiMsg.outline, taskChatId);
      
      // 保存快照（方便暂停后恢复）
      saveSnap(loop + 1);
      
      saveData();
    }
    
    // ----- 循环结束 -----
    if (completedNaturally) {
      // ✅ 正常情况：AI 主动停止调用工具
      aiMsg.outline.status = 'completed';
      aiMsg.content = finalAnswer || '(任务已完成，但未生成文本回复)';
      aiMsg.outline.diffSummary = outlineBuildDiffSummary(aiMsg.outline);
    } else {
      // 🛡️ 第三层保护：达到轮数上限或用户拒绝继续工具 → 强制收尾调用
      aiMsg.outline.status = 'truncated';
      aiMsg.outline.progressText = stoppedByToolPolicy
        ? '🏁 用户拒绝继续工具调用，正在整理最终回答...'
        : '🏁 已达轮数上限，正在整理最终回答...';
      onUpdate();
      
      let fallbackAnswer = '';
      try {
        fallbackAnswer = await doFinalSummaryCall(
          conversationMessages, history, systemPrompt, model, aiMsg.outline, abortSignal, c
        );
      } catch (fe) {
        if (fe.name === 'AbortError') throw fe;
        console.warn('[outline] 保底收尾调用失败:', fe);
        fallbackAnswer = '';
      }
      
      const truncatedNote = stoppedByToolPolicy
        ? `\n\n---\n\n> 🛑 **用户拒绝继续工具调用，任务已基于当前信息收尾。**`
        : `\n\n---\n\n> ⚠️ **执行已达轮数上限（${maxRounds} 轮），任务被强制收尾。** 如需更深入的结果，请提高"最大执行轮数"设置后重试。`;
      
      if (fallbackAnswer) {
        aiMsg.content = fallbackAnswer + truncatedNote;
      } else if (finalAnswer) {
        aiMsg.content = finalAnswer + truncatedNote;
      } else {
        // 真的什么都没拿到，做一份摘要兜底
        const doneItems = aiMsg.outline.items.filter(it => it.status === 'done');
        const pendingItems = aiMsg.outline.items.filter(it => it.status === 'pending' || it.status === 'active');
        let summary = `任务执行已达 ${maxRounds} 轮上限但未能生成最终回答。\n\n`;
        if (doneItems.length) summary += `**已完成：**\n${doneItems.map(it => `- ${it.title}${it.note ? '：' + it.note : ''}`).join('\n')}\n\n`;
        if (pendingItems.length) summary += `**未完成：**\n${pendingItems.map(it => `- ${it.title}`).join('\n')}\n`;
        aiMsg.content = summary + truncatedNote;
      }
      aiMsg.outline.diffSummary = outlineBuildDiffSummary(aiMsg.outline);
    }
    
    aiMsg.outline.inProgress = false;
    delete aiMsg.outline.progressText;
    delete aiMsg.outline._snap;  // 完成后清除快照
    aiMsg.outline.expanded = false; // 完成后默认折叠大纲，突出最终答案
    aiMsg._endTime = Date.now();
    
    if (typeof refreshMsgNode === 'function') refreshMsgNode(msgIdx, c);
    else if (typeof renderMessages === 'function' && isCurrentChat(c)) renderMessages();
    saveData();
    if (typeof toast === 'function') {
      if (completedNaturally) toast('✅ 大纲任务完成', 3000);
      else toast('⚠️ 已达轮数上限，已强制收尾', 4000);
    }
    if (!suppressCompletionSound && typeof playCompletionSound === 'function') playCompletionSound();
    
  } catch (e) {
    // ⭐ TimeoutError 视同 AbortError 处理：把任务挂起为 paused 并保留 _snap，让用户能继续
    const isAbortLike = (e.name === 'AbortError' || e.name === 'TimeoutError');
    let completedByForceFinish = false;
    
    if (isAbortLike) {
      // 检查是否是"立即收尾"信号
      const forceFinish = task ? !!task.outlineForceFinish : !!state._outlineForceFinish;
        if (forceFinish) {
          completedByForceFinish = true;
          if (task) task.outlineForceFinish = false;
          state._outlineForceFinish = false;
          // 走保底收尾流程
          aiMsg.outline.status = 'truncated';
          aiMsg.outline.finishRequested = true;
          aiMsg.outline.progressText = '🏁 用户请求立即收尾，正在整理最终回答...';
          onUpdate();
        
        // 重建 abortCtrl（因为已经被 abort 了）
        abortCtrl = new AbortController();
        if (typeof updateChatTaskController === 'function') updateChatTaskController(taskChatId, abortCtrl);
        else state.abortCtrl = abortCtrl;
        const newSignal = abortCtrl.signal;
        
        let fallbackAnswer = '';
        try {
          fallbackAnswer = await doFinalSummaryCall(
            conversationMessages, history, systemPrompt, model, aiMsg.outline, newSignal, c
          );
        } catch (fe) {
          console.warn('[outline] 立即收尾失败:', fe);
        }
        
        const finishNote = `\n\n---\n\n> 🏁 **用户请求立即收尾，AI 基于已有信息给出本回答。**`;
        
        if (fallbackAnswer) {
          aiMsg.content = fallbackAnswer + finishNote;
        } else if (finalAnswer) {
          aiMsg.content = finalAnswer + finishNote;
        } else {
          const doneItems = aiMsg.outline.items.filter(it => it.status === 'done');
          let summary = `任务被用户提前收尾。\n\n`;
          if (doneItems.length) summary += `**已完成的部分：**\n${doneItems.map(it => `- ${it.title}${it.note ? '：' + it.note : ''}`).join('\n')}\n`;
          aiMsg.content = summary + finishNote;
        }
        aiMsg.outline.diffSummary = outlineBuildDiffSummary(aiMsg.outline);
        
        if (typeof toast === 'function') toast('🏁 已收尾', 3000);
        delete aiMsg.outline.finishRequested;
      } else {
        aiMsg.outline.status = 'paused';
        delete aiMsg.outline.finishRequested;
        // 保留 _snap，让"继续执行"可以恢复
        // ⭐ 超时情况：在 content 加一行提示，让用户知道原因
        if (e.name === 'TimeoutError') {
          aiMsg.content = (aiMsg.content || '') + 
            `\n\n> ⏱ **请求超时**：${e.message}。任务已暂停，可点击下方「继续执行」重试。`;
        }
      }
    } else {
      aiMsg.outline.status = 'error';
      delete aiMsg.outline.finishRequested;
      aiMsg.content = `❌ 出错：${e.message}` + (finalAnswer ? '\n\n**部分输出：**\n' + finalAnswer : '');
      delete aiMsg.outline._snap;
    }
    aiMsg.outline.inProgress = false;
    delete aiMsg.outline.progressText;
    aiMsg._endTime = Date.now();
    if (typeof refreshMsgNode === 'function') refreshMsgNode(msgIdx, c);
    else if (typeof renderMessages === 'function' && isCurrentChat(c)) renderMessages();
    saveData();
    if (completedByForceFinish && !suppressCompletionSound && typeof playCompletionSound === 'function') playCompletionSound();
  } finally {
    if (typeof clearChatTask === 'function') clearChatTask(taskChatId);
    else {
      state.isGenerating = false;
      state.abortCtrl = null;
      if (state.activeTaskChatId === taskChatId) state.activeTaskChatId = null;
      state._outlineExecuting = false;
      state._outlineForceFinish = false;
    }
    if (typeof updateSendBtn === 'function') updateSendBtn();
    if (typeof renderChatList === 'function') renderChatList();
  }
}

// ============ 🛡️ 第三层保护：保底收尾调用 ============
// 当达到轮数上限但 AI 还在调工具时，额外发一次"无工具"请求逼出最终文字答案
async function doFinalSummaryCall(conversationMessages, history, systemPrompt, model, outlineObj, abortSignal, recordChat) {
  const s = state.settings;
  
  const finalSystemPrompt = (typeof withActiveSkillPrompt === 'function' ? withActiveSkillPrompt(systemPrompt) : systemPrompt) + 
    '\n\n【最终阶段·强制收尾】你已达到执行轮数上限。请基于上面所有已收集的信息和工具结果，' +
    '直接给出完整的 Markdown 格式最终答案。不要再调用任何工具。' +
    '如有未完成的条目，可在答案末尾用"⚠️ 受限说明"小节简要说明。';
  
  // 给当前 outline 状态做个文字快照，便于模型理解进展
  let outlineSnapshot = '';
  if (outlineObj.items && outlineObj.items.length) {
    outlineSnapshot = '\n\n【当前工作大纲快照】\n' + outlineObj.items.map(it => {
      const icon = it.status === 'done' ? '✓' : it.status === 'skipped' ? '~' : it.status === 'active' ? '▶' : '○';
      return `${icon} [${it.id}] ${it.title}${it.note ? '：' + it.note : ''}`;
    }).join('\n');
  }
  
  const finalUserMsg = '请立即基于已有信息给出完整的最终回答（Markdown 格式）。不要再调用任何工具。' + outlineSnapshot;
  
  // ----- 构造请求（不带 tools 字段）-----
  let body;
  
  if (s.apiFormat === 'anthropic') {
    const baseMsgs = (typeof buildAnthropicMessages === 'function') ? buildAnthropicMessages(history) : [];
    const allMsgs = [...baseMsgs];
    
    for (const m of conversationMessages) {
      if (m.role === 'assistant') {
        const parts = [];
        if (m.content && m.content.trim()) parts.push({ type: 'text', text: m.content });
        if (m.tool_calls) {
          for (const tc of m.tool_calls) {
            let input = {};
            try { input = JSON.parse(tc.function?.arguments || '{}'); } catch (e) {}
            parts.push({ type: 'tool_use', id: tc.id, name: tc.function?.name || '', input });
          }
        }
        allMsgs.push({ role: 'assistant', content: parts });
      } else if (m.role === 'tool') {
        const part = {
          type: 'tool_result',
          tool_use_id: m.tool_call_id,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
        };
        const last = allMsgs[allMsgs.length - 1];
        if (last && last.role === 'user' && Array.isArray(last.content)) {
          last.content.push(part);
        } else {
          allMsgs.push({ role: 'user', content: [part] });
        }
      } else if (m.role === 'user') {
        // 系统插入的提示 / 用户中途留言 / 附件注入（可能是字符串或数组）
        const last = allMsgs[allMsgs.length - 1];
        const contentParts = Array.isArray(m.content) 
          ? m.content 
          : [{ type: 'text', text: String(m.content || '') }];
        if (last && last.role === 'user' && Array.isArray(last.content)) {
          last.content.push(...contentParts);
        } else if (last && last.role === 'user' && typeof last.content === 'string') {
          last.content = [{ type: 'text', text: last.content }, ...contentParts];
        } else {
          allMsgs.push({ role: 'user', content: contentParts });
        }
      }
    }
    
    // 追加最终强制收尾的 user 消息（同样要注意 user 合并）
    {
      const last = allMsgs[allMsgs.length - 1];
      const finalParts = [{ type: 'text', text: finalUserMsg }];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        last.content.push(...finalParts);
      } else if (last && last.role === 'user' && typeof last.content === 'string') {
        last.content = [{ type: 'text', text: last.content }, ...finalParts];
      } else {
        allMsgs.push({ role: 'user', content: finalParts });
      }
    }
    
    body = {
      model,
      messages: allMsgs,
      max_tokens: parseInt(s.maxTokens),
      temperature: parseFloat(s.temperature),
      stream: false,
      system: finalSystemPrompt
      // 🔑 关键：不传 tools 字段
    };
  } else if (s.apiFormat === 'responses') {
    const allMessages = [
      ...(history || []),
      ...(conversationMessages || []),
      { role: 'user', content: finalUserMsg }
    ];
    body = {
      model,
      input: outlineBuildResponsesInput(allMessages, []),
      instructions: finalSystemPrompt,
      temperature: parseFloat(s.temperature),
      max_output_tokens: parseInt(s.maxTokens),
      stream: false
      // 🔑 关键：不传 tools 字段
    };
  } else {
    const baseMsgs = (typeof buildOpenAIMessages === 'function')
      ? buildOpenAIMessages(history).filter(m => m.role !== 'system') : [];
    const allMsgs = [
      { role: 'system', content: finalSystemPrompt },
      ...baseMsgs,
      ...conversationMessages,
      { role: 'user', content: finalUserMsg }
    ];
    body = {
      model,
      messages: allMsgs,
      temperature: parseFloat(s.temperature),
      max_tokens: parseInt(s.maxTokens),
      stream: false
      // 🔑 关键：不传 tools 字段
    };
  }
  
  // ----- 限速 -----
  if (typeof applyRateLimit === 'function') await applyRateLimit(abortSignal);
  
  if (abortSignal && abortSignal.aborted) {
    const err = new Error('用户中断');
    err.name = 'AbortError';
    throw err;
  }
  
  // ----- 发送 -----
  const url = buildFullUrl(s.baseUrl, s.apiPath);
  const { resp, rawText: _rawText, json: j } = await _outlineFetchJsonWithRetry(url, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(body)
  }, abortSignal, null);
  
  // ⭐ 记录原始响应
  if (typeof recordRawResponse === 'function') {
    recordRawResponse({
      ts: Date.now(),
      isStream: false,
      contentType: resp.headers.get('content-type') || '',
      raw: _rawText,
      parsedJson: j,
      usage: j.usage || null,
      request: { url, method: 'POST', headers: buildHeaders(), body },
      _source: '大纲模式 · 保底收尾调用'
    });
  }
  
  // ⭐ 保底收尾调用的 usage 也计入统计
  const usageForRecord = outlineNormalizeUsage(j.usage);
  if (usageForRecord && typeof recordUsageFromResponse === 'function') {
    const _c = recordChat || (typeof activeTaskChat === 'function' ? activeTaskChat() : (typeof currentChat === 'function' ? currentChat() : null));
    if (_c) recordUsageFromResponse(_c, usageForRecord, { model });
  }
  
  // ----- 解析 -----
  if (s.apiFormat === 'anthropic') {
    const contents = j.content || [];
    return contents.filter(p => p.type === 'text').map(p => p.text).join('') || '';
  } else if (s.apiFormat === 'responses') {
    return (typeof extractResponsesText === 'function' ? extractResponsesText(j) : '') || '';
  } else {
    return j.choices?.[0]?.message?.content || '';
  }
}

// ============ 大纲工具处理（本地虚拟工具，不发请求）============

// ⭐ 消化由 attach_file 等工具产生的待处理附件
// 把 state.pendingAIAttachments 中的项目转换为 user 消息注入到对话上下文，
// 然后清空 pendingAIAttachments（防止 autoResend 在大纲结束后再触发新对话）
function consumePendingAttachments(conversationMessages, outlineObj, chatId) {
  const targetChatId = chatId || (typeof resolveToolChatId === 'function' ? resolveToolChatId() : state.currentId);
  const atts = typeof takePendingAIAttachments === 'function'
    ? takePendingAIAttachments(targetChatId)
    : ((state.pendingAIAttachments || []).splice(0));
  if (!atts.length) return;
  const s = state.settings;
  
  // 同时取消任何待执行的 autoResend 定时器（双重保险）
  if (typeof window !== 'undefined') {
    if (window._autoResendTimer) {
      try { clearTimeout(window._autoResendTimer); } catch (e) {}
    }
    if (typeof window.cancelAutoResend === 'function') {
      try { window.cancelAutoResend(targetChatId); } catch (e) {}
    }
  }
  
  // 分类
  const images = atts.filter(a => a.type === 'image' && a.data);
  const textFiles = atts.filter(a => a.type === 'file' && a.text);
  const otherFiles = atts.filter(a => 
    !(a.type === 'image' && a.data) && !(a.type === 'file' && a.text)
  );
  
  // 文本文件 → 拼到 textPart
  let textPart = '【系统：以下附件已加载到对话上下文】';
  if (atts.length) {
    textPart += '\n\n' + atts.map(a => `- ${a.name}（${formatSize(a.size || 0)}）`).join('\n');
  }
  for (const a of textFiles) {
    const content = (a.text || '').slice(0, 50000); // 单文件最多 50k 字符防爆 token
    const truncated = (a.text || '').length > 50000 ? '\n\n...（已截断）' : '';
    textPart += `\n\n--- 附件内容：${a.name} ---\n\`\`\`\n${content}${truncated}\n\`\`\``;
  }
  for (const a of otherFiles) {
    textPart += `\n\n--- 附件：${a.name} ---\n（二进制文件，请通过工具读取或描述）`;
  }
  textPart += '\n\n请基于以上内容继续推进任务。';
  
  // 构造消息：图片用 multimodal 格式
  if (images.length > 0) {
    if (s.apiFormat === 'anthropic') {
      // Anthropic 在 outline.js 的 anthropic 分支里会重新组装；这里用通用 OpenAI 兼容格式
      // 但 outline 主循环中 anthropic 分支把 m.content 是字符串/数组都接管了，所以这里用数组也行
      const parts = [{ type: 'text', text: textPart }];
      for (const img of images) {
        // Anthropic 格式：image 类型用 source.data
        const dataUrl = img.data || '';
        const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (m) {
          parts.push({
            type: 'image',
            source: { type: 'base64', media_type: m[1], data: m[2] }
          });
        }
      }
      conversationMessages.push({ role: 'user', content: parts, _hasMultimodal: true });
    } else {
      const parts = [{ type: 'text', text: textPart }];
      for (const img of images) {
        parts.push({ type: 'image_url', image_url: { url: img.data } });
      }
      conversationMessages.push({ role: 'user', content: parts, _hasMultimodal: true });
    }
  } else {
    conversationMessages.push({ role: 'user', content: textPart });
  }
  
  // 记录到 outline.injections 让 UI 可见
  if (!Array.isArray(outlineObj.injections)) outlineObj.injections = [];
  outlineObj.injections.push({
    round: outlineObj.rounds || 0,
    text: `📎 附件已注入：${atts.map(a => a.name).join('、')}`,
    ts: Date.now(),
    _isAttachment: true
  });
}

// ⚠️ formatBytes 已合并到 utils.js 的 formatSize（统一格式：带空格 + MB 用 .toFixed(2)）

// ============ 大纲工具处理（本地虚拟工具，不发请求）============

function handleOutlineTool(name, args, outline) {
  if (name === 'save_outline') {
    const items = Array.isArray(args.items) ? args.items : [];
    // 保留旧条目的 toolCalls（按 id 匹配）
    const oldMap = {};
    for (const it of (outline.items || [])) oldMap[it.id] = it;
    
    outline.items = items.map(it => {
      const id = String(it.id || ('a' + Math.random().toString(36).slice(2, 6)));
      const status = ['pending', 'active', 'done', 'skipped'].includes(it.status) ? it.status : 'pending';
      const old = oldMap[id];
      return {
        id,
        title: String(it.title || '未命名'),
        status,
        note: it.note ? String(it.note) : '',
        toolCalls: old ? (old.toolCalls || []) : []
      };
    });
    return { ok: true, value: `✓ 已保存大纲（${outline.items.length} 项）` };
  }
  
  if (name === 'append_outline') {
    const id = String(args.id || ('a' + Math.random().toString(36).slice(2, 6)));
    if (outline.items.some(it => it.id === id)) {
      return { ok: false, value: `条目 id "${id}" 已存在，请换一个 id 或用 update_outline` };
    }
    outline.items.push({
      id,
      title: String(args.title || '未命名'),
      status: 'pending',
      note: args.note ? String(args.note) : '',
      toolCalls: []
    });
    return { ok: true, value: `✓ 已追加条目 "${id}"（当前共 ${outline.items.length} 项）` };
  }
  
  if (name === 'update_outline') {
    const id = String(args.id || '');
    const item = outline.items.find(it => it.id === id);
    if (!item) {
      return { ok: false, value: `未找到条目 "${id}"。当前条目：${outline.items.map(it => it.id).join(', ') || '(空)'}` };
    }
    if (args.status && ['pending', 'active', 'done', 'skipped'].includes(args.status)) {
      // 若改为 active，自动把其他 active 改回 pending
      if (args.status === 'active') {
        outline.items.forEach(it => {
          if (it.id !== id && it.status === 'active') it.status = 'pending';
        });
      }
      item.status = args.status;
    }
    if (args.title) item.title = String(args.title);
    if (args.note !== undefined) item.note = String(args.note);
    return { ok: true, value: `✓ 已更新条目 "${id}"（${item.status}）` };
  }
  
  return { ok: false, value: '未知的大纲操作' };
}

// ============ 构建合并的 tools 数组（隐藏工具 + 用户工具）============

function buildOutlineTools(options = {}) {
  const s = state.settings;
  const useUserTools = options.useTools !== undefined ? !!options.useTools : !!s.useTools;
  
  // 用户工具按本次任务配置合并；大纲内置工具始终存在。
  const userToolsFinal = (useUserTools && typeof buildToolsArray === 'function')
    ? (buildToolsArray({ force: true }) || [])
    : [];
  
  // OUTLINE_TOOLS 转换为对应格式
  let outlineToolsConverted;
  if (s.apiFormat === 'anthropic') {
    outlineToolsConverted = OUTLINE_TOOLS.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters
    }));
  } else if (s.apiFormat === 'responses') {
    outlineToolsConverted = OUTLINE_TOOLS.map(t => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }));
  } else {
    outlineToolsConverted = OUTLINE_TOOLS.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }
    }));
  }
  
  return [...outlineToolsConverted, ...userToolsFinal];
}

