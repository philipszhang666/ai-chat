// ============ 全局状态 ============
let state = {
  chats: [],
  currentId: null,
  tools: [],
  settings: {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiPath: '/chat/completions',
    apiFormat: 'openai',
    apiKey: '',
    modelName: 'gpt-4o-mini, gpt-4o',
    currentModel: 'gpt-4o-mini',
    systemPrompt: '你是一个友好的助手。回答时使用 Markdown 格式让内容更易读，代码用```语法块，数学公式用 $...$。请简洁、准确地回答用户的问题。',
    temperature: 0.7,
    maxTokens: 2048,
    stream: true,
    completionSoundEnabled: false,
    completionSoundVolume: 80,
    maxToolRounds: 15,
    theme: 'light',
    useTools: false,
    useReflection: false,
    refRounds: 3,
    refMinScore: 9,
    refStudentModel: '',
    refTeacherModel: '',
    refStudentPrompt: REFLECTION_PRESETS.general.student,
    refTeacherPrompt: REFLECTION_PRESETS.general.teacher,
    // 🔧 师生模式工具调用支持
    refStudentUseTools: true,           // 学生是否允许调用工具（多轮完成任务）
    refTeacherUseTools: true,           // 老师是否允许调用工具（独立验证答案）
    refStudentMaxToolRounds: 15,        // 学生单轮最多工具调用循环次数
    refTeacherMaxToolRounds: 5,         // 老师单轮最多工具调用循环次数
    usePlan: false,
    planReview: true,
    planSynthesize: true,
    planMaxSteps: 5,
    planReviewRounds: 2,
    planPlannerModel: '',
    planExecutorModel: '',
    planVerify: true,
    planVerifyRounds: 2,
    planVerifierModel: '',
    planPlannerPrompt: PLAN_PRESETS.general.planner,
    planExecutorPrompt: PLAN_PRESETS.general.executor,
    // 📑 大纲模式（动态规划）
    useOutline: false,
    outlineMaxRounds: 30,
    outlineModel: '',
    outlineSystemPrompt: '',  // 留空则使用 outline.js 中的 DEFAULT_OUTLINE_SYSTEM_PROMPT
    contextLimitMode: 'auto',
    contextLimitOverride: 0,
    compressAutoEnabled: false,
    compressAutoThreshold: 75,
    compressKeepLast: 4,
    rateMaxPerMinute: 20,
    rateMinIntervalMs: 0,
    rateRandomMinMs: 0,
    rateRandomMaxMs: 0,
    useCustomJson: false,
    jsonTemplate: '',
    jsonHeaders: '{}',
    // ⭐ 跨域代理：通过本地服务（local_terminal_server.py）转发 LLM 请求
    // 默认开启 —— 大部分用户用本地项目时都会遇到 CORS 问题
    useLocalProxy: true,
    // ⭐ 自动重试：网络抖动 / HTTP 5xx / 429 / 流中途断开时自动重发
    retryMaxAttempts: 3,        // 最多重试次数（首次失败后再试 N 次，总共 N+1 次尝试）
    retryBaseDelayMs: 1000,     // 退避基数（毫秒），实际等待 = base * 2^(n-1) + 抖动
    // 🧪 自动信标系统：每隔 N 条用户消息塞入一条隐藏的"记代号"消息，
    //    供"体检"功能测试 AI 是否还记得上下文（中段消息最易丢）
    beaconEnabled: false,       // 默认关闭，避免增加不必要 token
    beaconInterval: 5,          // 每 N 条用户消息埋一个（1 表示每条都埋，5 表示每 5 条）
    mcpSkill: {
      mcpServers: [],
      skillRoots: ['skill'],
      skills: [],
      useSkills: true
    },
    projectMemory: {
      enabled: false,
      path: '.agent/memory.md',
      maxChars: 12000,
      declinedWorkspaces: []
    }
  },
  pendingAttachments: [],
  abortCtrl: null,
  activeTaskChatId: null,
  isGenerating: false,
  chatTasks: {},
  editingToolIdx: -1
};

let pendingImportData = null;

function loadData() {
  try { const d = storage.get(STORE_KEY); if (d) { const p = JSON.parse(d); state.chats = p.chats || []; state.currentId = p.currentId; state._lastSavedAt = p.savedAt || null; } } catch (e) {}
  try { const s = storage.get(SETTINGS_KEY); if (s) state.settings = { ...state.settings, ...JSON.parse(s) }; } catch (e) {}
  try { const t = storage.get(TOOLS_KEY); if (t) state.tools = JSON.parse(t); } catch (e) {}
  injectBuiltinTools();
}

const MSG_TIMER_ORPHAN_FALLBACK_MS = 10 * 60 * 1000;
let _msgTimerExitRecoveryRegistered = false;

function _timerMs(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function markMsgTimerActivity(msg, at = Date.now()) {
  if (!msg || msg.role === 'user') return;
  msg._lastActivityAt = at;
}

function pauseMsgTimer(msg, endAt = Date.now()) {
  if (!msg || msg.role === 'user') return false;
  const start = _timerMs(msg._startTime);
  if (!start || msg._endTime) return false;
  const safeEnd = Math.max(start, _timerMs(endAt) || Date.now());
  msg._endTime = safeEnd;
  msg._lastActivityAt = safeEnd;
  return true;
}

function resumeMsgTimer(msg) {
  if (!msg || msg.role === 'user') return;
  const now = Date.now();
  const start = _timerMs(msg._startTime) || now;
  const end = _timerMs(msg._endTime);
  if (end) {
    const elapsed = Math.max(0, end - start);
    const firstOffset = msg._firstTokenAt ? Math.max(0, _timerMs(msg._firstTokenAt) - start) : 0;
    msg._startTime = now - elapsed;
    if (msg._firstTokenAt) msg._firstTokenAt = Math.min(now, msg._startTime + firstOffset);
    delete msg._endTime;
  } else if (!msg._startTime) {
    msg._startTime = now;
  }
  msg._lastActivityAt = now;
}

function _fallbackTimerEndForRestore(msg, now) {
  const start = _timerMs(msg && msg._startTime);
  if (!start) return now;
  const savedAt = _timerMs(state._lastSavedAt);
  const candidates = [
    _timerMs(msg._lastActivityAt),
    savedAt && savedAt >= start ? savedAt : 0,
    _timerMs(msg._firstTokenAt)
  ].filter(t => t && t >= start && t <= now);
  if (candidates.length) return Math.max(...candidates);
  return Math.min(now, start + MSG_TIMER_ORPHAN_FALLBACK_MS);
}

function _cleanupRecoveredMessageProgress(msg) {
  if (!msg || msg.role !== 'assistant') return;
  let changed = false;
  if (msg.plan && msg.plan.inProgress) {
    msg.plan.inProgress = false;
    changed = true;
    if (['planning', 'reviewing', 'executing', 'verifying'].includes(msg.plan.stage)) {
      msg.plan.status = msg.plan.status === 'completed' ? msg.plan.status : 'paused';
    }
    if (Array.isArray(msg.plan.steps)) {
      msg.plan.steps.forEach(step => {
        if (step && step.status === 'running') {
          step.status = 'failed';
          step.error = step.error || '页面关闭，任务已中断';
          step.endedAt = step.endedAt || msg._endTime || Date.now();
        }
      });
    }
    delete msg.plan.progressText;
  }
  if (msg.outline && msg.outline.inProgress) {
    msg.outline.inProgress = false;
    changed = true;
    if (msg.outline.status === 'running') msg.outline.status = 'paused';
    delete msg.outline.progressText;
  }
  if (msg.reflection && msg.reflection.inProgress) {
    msg.reflection.inProgress = false;
    changed = true;
    if (Array.isArray(msg.reflection.turns)) {
      msg.reflection.turns.forEach(turn => {
        if (turn) turn._running = false;
        if (turn && Array.isArray(turn.toolCalls)) {
          turn.toolCalls.forEach(tc => { if (tc) tc._running = false; });
        }
      });
    }
    delete msg.reflection.progressText;
  }
  return changed;
}

function recoverInterruptedMsgTimers() {
  const now = Date.now();
  let changed = false;
  for (const chat of state.chats || []) {
    for (const msg of chat.messages || []) {
      if (!msg || msg.role !== 'assistant') continue;
      if (msg._startTime && !msg._endTime) {
        pauseMsgTimer(msg, _fallbackTimerEndForRestore(msg, now));
        msg._timerRecovered = true;
        changed = true;
      }
      if (_cleanupRecoveredMessageProgress(msg)) changed = true;
    }
  }
  return changed;
}

function sealOpenMsgTimersForPageExit() {
  let changed = false;
  for (const chat of state.chats || []) {
    for (const msg of chat.messages || []) {
      if (pauseMsgTimer(msg, Date.now())) changed = true;
      if (_cleanupRecoveredMessageProgress(msg)) changed = true;
    }
  }
  if (changed && typeof saveData === 'function') {
    saveData();
    if (typeof storage !== 'undefined' && typeof storage.flush === 'function') {
      try { storage.flush(); } catch (e) {}
    }
  }
}

function registerMsgTimerExitRecovery() {
  if (_msgTimerExitRecoveryRegistered || typeof window === 'undefined') return;
  _msgTimerExitRecoveryRegistered = true;
  window.addEventListener('pagehide', event => {
    if (event && event.persisted) return;
    sealOpenMsgTimersForPageExit();
  });
  window.addEventListener('beforeunload', sealOpenMsgTimersForPageExit);
}

function injectBuiltinTools() {
  if (typeof BUILTIN_TOOLS === 'undefined' || !Array.isArray(BUILTIN_TOOLS)) return;
  let loadedSignatures = [];
  try {
    const raw = storage.get(BUILTIN_TOOLS_LOADED_KEY);
    if (raw) loadedSignatures = JSON.parse(raw);
  } catch (e) {}
  const existingNames = new Set(state.tools.map(t => t.name));
  const currentSignatures = BUILTIN_TOOLS.map(t => t.name);
  
  // ⭐ 可选工具组：首次安装默认不注入（用户在工具面板手动一键启用）
  // 既减少给模型的工具数量，也降低对外暴露的工具特征
  const OPTIONAL_TOOL_PREFIXES = ['lms_'];
  const OPTIONAL_TOOL_NAMES = new Set([
    // 💾 Git 快照工具（5 个）
    'note_status', 'note_history', 'note_diff', 'note_snapshot', 'note_restore',
    'restore_checkpoint',
    // 📚 论文工具（3 个）
    'arxiv_search', 'semantic_scholar_search', 'fetch_pdf_text'
  ]);
  const isOptional = (name) => 
    OPTIONAL_TOOL_NAMES.has(name) || OPTIONAL_TOOL_PREFIXES.some(p => name.startsWith(p));
  
  let added = 0;
  for (const tool of BUILTIN_TOOLS) {
    if (!existingNames.has(tool.name)) {
      if (!loadedSignatures.includes(tool.name)) {
        // 可选工具组：首次见到时跳过自动注入
        if (isOptional(tool.name)) continue;
        state.tools.push(JSON.parse(JSON.stringify(tool)));
        added++;
      }
    }
  }
  if (added > 0) {
    persistTools();
    console.log(`[内置工具] 自动加载了 ${added} 个工具`);
  }
  storage.set(BUILTIN_TOOLS_LOADED_KEY, JSON.stringify(currentSignatures));
}

// ⭐ 完整修复版 saveData：迁移 IndexedDB 后基本不会再爆容量，
//     仍保留剥离 + quota 兜底逻辑，以防极端情况下 IDB 配额也满
//
// 【quota 兜底链路】因为 IDB 写入是异步的，QuotaExceededError 不会在 storage.set
// 当场抛出。所以我们在 idb-store.js 注册了 onQuotaError 回调，由它在异步落盘失败
// 时反向触发 handleStorageQuotaExceeded()。这样旧逻辑（清请求历史 → 删旧对话
// → 剥附件 → 放弃保存）保持有效。
function saveData() {
  try {
    // 深拷贝并剥离大附件的 data 字段
    const chatsForSave = state.chats.map(chat => ({
      ...chat,
      messages: chat.messages.map(msg => {
        if (!msg.attachments || msg.attachments.length === 0) return msg;
        
        const cleanAttachments = msg.attachments.map(att => {
          // 文本附件（小）保留全部
          if (att.text && !att.data) return att;
          
          // 计算 data 大小（base64 编码后的字节数）
          const dataSize = att.data ? att.data.length : 0;
          
          // ⭐ IndexedDB 容量充裕，把阈值从 100KB 提到 5MB：
          //    大多数对话图片都能完整保留，刷新后不会丢
          if (dataSize < 5 * 1024 * 1024) return att;
          
          // 超大附件（> 5MB）仍剥离，避免单次写入卡顿
          return {
            id: att.id,
            name: att.name,
            mime: att.mime,
            size: att.size,
            type: att.type,
            _fromAI: att._fromAI,
            _hidden: att._hidden,
            _aiDescription: att._aiDescription,
            _stripped: true,
            _strippedReason: `附件超大（${(dataSize / 1024 / 1024).toFixed(1)}MB），刷新后将丢失。要保留请重新加载。`
          };
        });
        
        return { ...msg, attachments: cleanAttachments };
      })
    }));
    
    const savedAt = Date.now();
    state._lastSavedAt = savedAt;
    const payload = JSON.stringify({ chats: chatsForSave, currentId: state.currentId, savedAt });
    
    try {
      storage.set(STORE_KEY, payload);
      // ⭐ 注：storage.set 是同步写内存 + 异步落盘，这里不会抛 quota 错误。
      //    真正的配额错误在 idb-store 的 flushNow 中捕获，并通过
      //    storage.onQuotaError 回调反向调用 handleStorageQuotaExceeded()。
    } catch (storageErr) {
      // 极端：IDB 未就绪走 localStorage 回退路径才可能在此同步抛错
      console.warn('[saveData] 存储仍超限，开始紧急清理:', storageErr.message);
      handleStorageQuotaExceeded();
    }
  } catch (e) {
    console.error('[saveData] 严重错误:', e);
    if (typeof toast === 'function') {
      toast('⚠️ 保存失败：' + e.message, 5000);
    }
  }
}

// ⭐ 注册 IDB 异步配额错误回调（在模块加载即注册一次）
//   注意：storage 对象在 idb-store.js 中已经创建，但 idbInit 可能还没跑完。
//   这里同步注册即可，回调只在真正发生 quota 错误时被调用。
if (typeof storage !== 'undefined' && typeof storage.onQuotaError === 'function') {
  storage.onQuotaError(() => {
    try {
      console.warn('[state] IDB 配额超限回调被触发，执行 handleStorageQuotaExceeded');
      handleStorageQuotaExceeded();
    } catch (e) {
      console.error('[state] quota 回调执行失败:', e);
    }
  });
}

// ⭐ 处理存储超限的多级回退（IndexedDB 配额极端满时才会触发）
function handleStorageQuotaExceeded() {
  // 策略 1：清理 request_history（请求历史一般不重要）
  try {
    storage.remove('aichat_request_history_v1');
    console.log('[紧急清理] 已删除请求历史');
  } catch (e) {}
  
  // 策略 2：删除旧对话（保留最新 10 个）
  if (state.chats.length > 10) {
    const oldCount = state.chats.length;
    state.chats = state.chats.slice(0, 10);
    console.log(`[紧急清理] 删除 ${oldCount - 10} 个旧对话`);
    
    try {
      const payload = serializeChatsWithStrippedAttachments();
      storage.set(STORE_KEY, payload);
      if (typeof toast === 'function') {
        toast(`⚠️ 存储已满，已自动删除 ${oldCount - 10} 个旧对话`, 5000);
      }
      return;
    } catch (e) {
      console.warn('[紧急清理] 删除旧对话后仍超限');
    }
  }
  
  // 策略 3：清空当前对话的所有附件元数据
  console.log('[紧急清理] 移除所有附件元数据');
  for (const chat of state.chats) {
    for (const msg of chat.messages) {
      if (msg.attachments) {
        msg.attachments = msg.attachments.map(a => ({
          id: a.id,
          name: a.name,
          mime: a.mime,
          size: a.size,
          type: a.type,
          _stripped: true,
          _strippedReason: '存储空间不足，附件已被自动清理'
        }));
      }
    }
  }
  
  try {
    const payload = JSON.stringify({ chats: state.chats, currentId: state.currentId });
    storage.set(STORE_KEY, payload);
    if (typeof toast === 'function') {
      toast('⚠️ 存储空间不足，已清理所有附件', 5000);
    }
  } catch (e) {
    // 策略 4：放弃保存对话历史，但保证设置不丢
    console.error('[紧急清理] 完全无法保存对话:', e);
    if (typeof toast === 'function') {
      toast('❌ 存储已满，本次对话无法保存。建议清空旧对话。', 8000);
    }
  }
}

// 辅助：序列化对话（带附件剥离）
function serializeChatsWithStrippedAttachments() {
  const chatsForSave = state.chats.map(chat => ({
    ...chat,
    messages: chat.messages.map(msg => {
      if (!msg.attachments || msg.attachments.length === 0) return msg;
      const cleanAttachments = msg.attachments.map(att => {
        if (att.text && !att.data) return att;
        const dataSize = att.data ? att.data.length : 0;
        if (dataSize < 5 * 1024 * 1024) return att;
        return {
          id: att.id, name: att.name, mime: att.mime, size: att.size, type: att.type,
          _fromAI: att._fromAI, _hidden: att._hidden, _aiDescription: att._aiDescription,
          _stripped: true,
          _strippedReason: `附件超大（${(dataSize / 1024 / 1024).toFixed(1)}MB）`
        };
      });
      return { ...msg, attachments: cleanAttachments };
    })
  }));
  return JSON.stringify({ chats: chatsForSave, currentId: state.currentId });
}

function persistSettings() {
  try {
    storage.set(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch (e) {
    console.warn('[persistSettings] 失败:', e.message);
  }
}

function persistTools() {
  try {
    storage.set(TOOLS_KEY, JSON.stringify(state.tools));
  } catch (e) {
    console.warn('[persistTools] 失败:', e.message);
  }
}

function chatById(id) { return state.chats.find(c => c && c.id === id); }

function currentChat() { return chatById(state.currentId); }

function isCurrentChat(chatOrId) {
  const id = typeof chatOrId === 'string' ? chatOrId : (chatOrId && chatOrId.id);
  return !!id && id === state.currentId;
}

function ensureChatTasks() {
  if (!state.chatTasks || typeof state.chatTasks !== 'object') state.chatTasks = {};
  return state.chatTasks;
}

function chatTaskById(chatId) {
  if (!chatId) return null;
  return ensureChatTasks()[chatId] || null;
}

function isChatGenerating(chatOrId) {
  const id = typeof chatOrId === 'string' ? chatOrId : (chatOrId && chatOrId.id);
  const task = chatTaskById(id);
  return !!(task && task.isGenerating);
}

function isCurrentChatGenerating() {
  return isChatGenerating(state.currentId);
}

function isAnyChatGenerating() {
  return Object.values(ensureChatTasks()).some(t => t && t.isGenerating);
}

function beginChatTask(chatId, abortCtrl, opts = {}) {
  if (!chatId) return null;
  const tasks = ensureChatTasks();
  const existing = tasks[chatId] || {};
  const task = {
    chatId,
    isGenerating: true,
    abortCtrl: abortCtrl || existing.abortCtrl || null,
    stopRequested: opts.resetStop ? false : !!existing.stopRequested,
    startedAt: existing.startedAt || Date.now()
  };
  tasks[chatId] = task;
  syncGlobalTaskState(chatId);
  return task;
}

function updateChatTaskController(chatId, abortCtrl) {
  if (!chatId) return null;
  const tasks = ensureChatTasks();
  const task = tasks[chatId] || beginChatTask(chatId, null);
  if (!task) return null;
  task.isGenerating = true;
  task.abortCtrl = abortCtrl || null;
  tasks[chatId] = task;
  syncGlobalTaskState(chatId);
  return task;
}

function requestStopChatTask(chatId) {
  const task = chatTaskById(chatId);
  if (!task) return false;
  task.stopRequested = true;
  if (task.abortCtrl) {
    try { task.abortCtrl.abort(); } catch (e) {}
  }
  syncGlobalTaskState(chatId);
  return true;
}

function clearChatTask(chatId) {
  if (!chatId) return;
  const tasks = ensureChatTasks();
  delete tasks[chatId];
  syncGlobalTaskState();
}

function setChatTaskMode(chatId, mode, props = {}) {
  const task = chatTaskById(chatId);
  if (!task) return null;
  task.mode = mode || task.mode || 'chat';
  Object.assign(task, props);
  syncGlobalTaskState(chatId);
  refreshLegacyModeFlags();
  return task;
}

function isChatTaskMode(chatId, mode) {
  const task = chatTaskById(chatId);
  return !!(task && task.isGenerating && task.mode === mode);
}

function isAnyChatTaskMode(mode) {
  return Object.values(ensureChatTasks()).some(t => t && t.isGenerating && t.mode === mode);
}

function refreshLegacyModeFlags() {
  state._outlineExecuting = isAnyChatTaskMode('outline');
  state._planExecuting = isAnyChatTaskMode('plan');
  state._outlineForceFinish = Object.values(ensureChatTasks()).some(t => t && t.isGenerating && t.mode === 'outline' && t.outlineForceFinish);
}

function syncGlobalTaskState(preferredChatId) {
  const tasks = ensureChatTasks();
  const currentTask = tasks[state.currentId] || null;
  const preferredTask = preferredChatId ? (tasks[preferredChatId] || null) : null;
  const fallbackTask = preferredTask || currentTask || Object.values(tasks).find(t => t && t.isGenerating) || null;

  // 兼容旧模块：全局字段镜像当前对话任务；当前对话空闲时镜像任意后台任务。
  const mirrorTask = currentTask || fallbackTask;
  state.isGenerating = !!(currentTask && currentTask.isGenerating);
  state.activeTaskChatId = mirrorTask ? mirrorTask.chatId : null;
  state.abortCtrl = mirrorTask ? mirrorTask.abortCtrl : null;
  state.stopRequested = mirrorTask ? !!mirrorTask.stopRequested : false;
  refreshLegacyModeFlags();
}

function activeTaskChat() {
  return (state.activeTaskChatId && chatById(state.activeTaskChatId)) || currentChat();
}

function resetBuiltinTools() {
  if (!confirm('重新加载所有内置工具？\n已有同名工具不会被覆盖，已被删除的内置工具会被重新加回。\n\n注意：LMS、版本快照、论文工具不会自动加回，需要在工具面板里点专用按钮启用。')) return;
  storage.remove(BUILTIN_TOOLS_LOADED_KEY);
  
  // ⭐ 与 injectBuiltinTools 保持一致：可选工具组（LMS / Git 快照 / 论文）不自动恢复
  const OPTIONAL_TOOL_NAMES = new Set([
    'note_status', 'note_history', 'note_diff', 'note_snapshot', 'note_restore',
    'restore_checkpoint',
    'arxiv_search', 'semantic_scholar_search', 'fetch_pdf_text'
  ]);
  const isOptional = (name) => 
    OPTIONAL_TOOL_NAMES.has(name) || name.startsWith('lms_');
  
  for (const tool of BUILTIN_TOOLS) {
    if (isOptional(tool.name)) continue;
    if (!state.tools.some(t => t.name === tool.name)) {
      state.tools.push(JSON.parse(JSON.stringify(tool)));
    }
  }
  persistTools();
  storage.set(BUILTIN_TOOLS_LOADED_KEY, JSON.stringify(BUILTIN_TOOLS.map(t => t.name)));
  if (typeof renderToolList === 'function') renderToolList();
  if (typeof toast === 'function') toast('✓ 内置工具已重置');
}

// ⭐ 工具：手动清理大附件（控制台可调用）
function cleanupStorage() {
  if (!confirm('清理对话历史中的所有大附件？\n（文字保留，附件 data 会被清空）')) return;
  
  let cleared = 0;
  let savedMB = 0;
  for (const chat of state.chats) {
    for (const msg of chat.messages) {
      if (msg.attachments) {
        msg.attachments.forEach(att => {
          if (att.data && att.data.length > 100 * 1024) {
            savedMB += att.data.length / 1024 / 1024;
            att._stripped = true;
            att._strippedReason = '已被手动清理';
            delete att.data;
            delete att.text;
            cleared++;
          }
        });
      }
    }
  }
  
  saveData();
  if (typeof toast === 'function') {
    toast(`✓ 已清理 ${cleared} 个附件，释放 ${savedMB.toFixed(1)} MB`, 4000);
  }
  console.log(`[清理] 共清理 ${cleared} 个附件，约 ${savedMB.toFixed(1)} MB`);
}

// 暴露到全局
window.cleanupStorage = cleanupStorage;
