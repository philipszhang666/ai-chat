// ============ 🔌 API - 流式渲染节流 + 停止/发送按钮 ============
// 【模块定位】updateLastMsg 的 RAF 节流 + stopGenerate + updateSendBtn
// 依赖：state.js / chat.js（renderMessages / scrollToBottom）
// 加载顺序：随便，但建议放 api-core.js 之后保持习惯

function updateLastMsg(targetChat, targetIdx) {
  if (targetChat && !isCurrentChat(targetChat)) return;
  // ⭐ 节流：连续 chunk 一帧只渲染一次，避免每个 chunk 都重做 markdown 解析 + DOM 重建
  if (_updateLastMsgScheduled) return;
  _updateLastMsgTarget = targetChat ? { chat: targetChat, idx: targetIdx } : null;
  _updateLastMsgScheduled = true;
  _updateLastMsgRafId = requestAnimationFrame(() => {
    _updateLastMsgScheduled = false;
    _updateLastMsgRafId = null;
    const target = _updateLastMsgTarget;
    _updateLastMsgTarget = null;
    _flushLastMsg(target && target.chat, target && target.idx);
  });
}

let _updateLastMsgScheduled = false;
let _updateLastMsgRafId = null;
let _updateLastMsgTarget = null;

// ⭐ 取消任何待执行的流式刷新，并清除残留光标
// 必须在流式结束、错误、abort、refreshMsgNode 之前调用
function cancelPendingStreamFlush() {
  if (_updateLastMsgRafId != null) {
    cancelAnimationFrame(_updateLastMsgRafId);
    _updateLastMsgRafId = null;
  }
  _updateLastMsgScheduled = false;
  _updateLastMsgTarget = null;
  // 清掉 DOM 里任何残留的 .cursor 节点（保险措施）
  document.querySelectorAll('.msg-content .cursor').forEach(el => el.remove());
}

function _flushLastMsg(targetChat, targetIdx) {
  if (targetChat && !isCurrentChat(targetChat)) return;
  const c = targetChat || currentChat();
  if (!c) return;
  const lastIdx = (typeof targetIdx === 'number') ? targetIdx : c.messages.length - 1;
  const m = c.messages[lastIdx];
  if (!m) return;
  
  // ⭐ 如果消息已结束（_endTime 已被设置），不再追加光标
  // 避免 rAF 延迟触发与"流式完成"的时序竞争导致光标残留
  if (m._endTime) return;
  
  // 兜底：若 content 已存在但 _firstTokenAt 未设置（非流式分支），补上
  if (!m._firstTokenAt && (m.content || (m.tool_calls && m.tool_calls.length))) {
    m._firstTokenAt = Date.now();
  }
  if (typeof markMsgTimerActivity === 'function') markMsgTimerActivity(m);
  
  const wrap = document.querySelector(`.message[data-idx="${lastIdx}"] .msg-content`);
  if (wrap) {
    // ⭐ 关键：必须在改 innerHTML 之前判断是否处于底部
    // 否则新内容把 scrollHeight 推高，diff 立刻变大，isNearBottom 会误判
    const shouldFollow = (typeof isNearBottom !== 'function' || isNearBottom());
    
    // ⭐ 用流式版渲染函数：自动补全未闭合的 ``` / $$ / ` 围栏
    // 解决"代码块断成两截"的问题
    const renderFn = (typeof renderMarkdownStreaming === 'function')
      ? renderMarkdownStreaming
      : renderMarkdown;
    wrap.innerHTML = renderFn(m.content || '') + '<span class="cursor"></span>';
    // ⭐ 流式过程中跳过 KaTeX（公式可能写一半），完成后再统一渲染
    // 只在当前消息节点范围内做 hljs
    const msgNode = wrap.closest('.message');
    if (msgNode) postRender(msgNode, { skipMath: true });
    
    // ⭐ 跟随底部：每次都贴底（scrollBottom 本身很轻，innerHTML 已经触发过 reflow 了）
    if (shouldFollow) scrollBottom();
  }
}

function stopGenerate() {
  // ⭐ 一次性"软停止"标志：用于跨越 abortCtrl 重建的边界
  //   - 普通对话工具循环、Plan/Outline/Reflection 的多轮循环
  //   - 这些场景会在某些时刻把 abortCtrl 重建甚至清空，单靠 signal.aborted 检查会漏
  //   - 各模式在工具循环、递归 callAPI 之前都应主动检查这个标志，及时退出
  //   - 由 callAPI / Plan / Outline / Reflection 的"首次进入"分支负责清零
  const c = typeof currentChat === 'function' ? currentChat() : null;
  const chatId = (c && c.id) || state.activeTaskChatId;
  const task = (typeof chatTaskById === 'function' && chatId) ? chatTaskById(chatId) : null;
  if (typeof requestStopChatTask === 'function' && requestStopChatTask(chatId)) {
    // requestStopChatTask 已经标记 stopRequested 并 abort 对应 controller
  } else {
    state.stopRequested = true;
  }
  const ctrl = task ? (task.abortCtrl || state.abortCtrl) : state.abortCtrl;
  if (ctrl) {
    try {
      ctrl.abort();
    } catch (e) {
      console.error('[stopGenerate] 错误:', e);
    }
  }
  // ⭐ 同时打断"频率限制等待"，避免点了停止但仍卡在 rate-limiter 的 sleep 里
  if (typeof window !== 'undefined' && window._rateWaitAbort) {
    try { window._rateWaitAbort(ctrl && ctrl.signal); } catch (e) {}
  }
  // ⭐ 切断 attach_file 等工具留下的"自动重发"定时器链路
  //   否则点了暂停后 3 秒，tryAutoResend 仍会用隐藏 user 消息触发一次 callAPI，
  //   表现为"莫名其妙又开一轮对话、AI 不回答、计时器空转"（幽灵对话 bug）
  if (typeof window !== 'undefined' && typeof window.cancelAutoResend === 'function') {
    try { window.cancelAutoResend(chatId); } catch (e) {}
  }
  // ⭐ 清掉流式刷新与残留光标
  if (typeof cancelPendingStreamFlush === 'function') cancelPendingStreamFlush();
  if (typeof syncGlobalTaskState === 'function') syncGlobalTaskState(chatId);
  if (typeof updateSendBtn === 'function') updateSendBtn();
}

function updateSendBtn() {
  const btn = document.getElementById('sendBtn');
  if (!btn) return;
  if (typeof syncGlobalTaskState === 'function') syncGlobalTaskState(state.currentId);
  const currentGenerating = (typeof isCurrentChatGenerating === 'function') ? isCurrentChatGenerating() : !!state.isGenerating;
  if (currentGenerating) {
    btn.textContent = '■';
    btn.classList.add('stop');
    document.getElementById('inputInfo').textContent = '生成中...';
  } else {
    btn.textContent = '↑';
    btn.classList.remove('stop');
    let info = `${state.settings.apiFormat === 'anthropic' ? '🟠 Anthropic' : '🟢 OpenAI'}`;
    if (state.settings.usePlan) info += ` · 📋 计划模式(${state.settings.planMaxSteps}步)`;
    if (state.settings.useReflection) info += ` · 🎭 师生(${state.settings.refRounds}轮)`;
    if (state.settings.useOutline) info += ` · 📑 大纲(${state.settings.outlineMaxRounds || 30}轮)`;
    if (state.settings.useTools && state.tools.length) info += ` · 🛠 ${state.tools.length}工具`;
    if (state.settings.compressAutoEnabled) info += ` · 🗜️ 自动压缩`;
    if (typeof isAnyChatGenerating === 'function' && isAnyChatGenerating()) info += ' · 后台生成中';
    document.getElementById('inputInfo').textContent = info;
  }
}
