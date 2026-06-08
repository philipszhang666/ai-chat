// ============ 对话管理 + 消息渲染 + 发送 ============

// ⭐ 离开当前任务所在对话时，只有会破坏该对话内容的操作才主动中止任务。
// 网络层不卡的情况下，这能让旧任务的 catch 分支正常跑完（保留 _snap 等）
function _abortCurrentTaskIfAny(chatId) {
  const targetChatId = chatId || state.activeTaskChatId || state.currentId;
  const task = (typeof chatTaskById === 'function') ? chatTaskById(targetChatId) : null;
  const ctrl = task ? (task.abortCtrl || state.abortCtrl) : state.abortCtrl;
  if (typeof requestStopChatTask === 'function' && requestStopChatTask(targetChatId)) {
    // 已按对话中止
  } else {
    state.stopRequested = true;
    if (ctrl) {
      try { ctrl.abort(); } catch (e) {}
    }
  }
  if (typeof window !== 'undefined' && window._rateWaitAbort) {
    try { window._rateWaitAbort(ctrl && ctrl.signal); } catch (e) {}
  }
  // ⭐ 切断 attach_file 等工具的"自动重发"定时器
  //   删除/清空正在运行的对话时如果不清，旧对话挂起的 3 秒定时器会继续触发
  //   一次幽灵 callAPI（隐藏 user 消息 + 空 assistant 占位 + 计时器空转）
  if (typeof window !== 'undefined' && typeof window.cancelAutoResend === 'function') {
    try { window.cancelAutoResend(targetChatId); } catch (e) {}
  }
  // 其他运行态旗标不在这里硬清：让 catch/finally 分支自己收尾。
}

// ⭐ "一次性模式"消费：选定走哪条分支后立刻关闭对应开关 + 熄灭按钮
//   下次发送将默认走普通对话，除非用户重新点亮开关
//   返回值：'outline' | 'plan' | 'reflection' | 'normal'
//   注意：计划模式的"执行计划"按钮（approveAndExecutePlan）不走这里，
//        所以即便 usePlan 已熄灭，已生成的计划仍可正常执行
function _consumeOneShotMode() {
  const s = state.settings;
  let mode = 'normal';
  if (s.useOutline) {
    mode = 'outline';
    s.useOutline = false;
    const btn = document.getElementById('outlineBtn');
    if (btn) btn.classList.remove('outline-active');
  } else if (s.usePlan) {
    mode = 'plan';
    s.usePlan = false;
    const btn = document.getElementById('planBtn');
    if (btn) btn.classList.remove('plan-active');
  } else if (s.useReflection) {
    mode = 'reflection';
    s.useReflection = false;
    const btn = document.getElementById('reflectBtn');
    if (btn) btn.classList.remove('reflect-active');
  }
  if (mode !== 'normal') {
    if (typeof persistSettings === 'function') persistSettings();
    if (typeof updateSendBtn === 'function') updateSendBtn();
  }
  return mode;
}

function newChat() {
  const id = 'c_' + Date.now();
  state.chats.unshift({ id, title: '新对话', messages: [], createdAt: Date.now() });
  state.currentId = id;
  if (typeof syncGlobalTaskState === 'function') syncGlobalTaskState(id);
  saveData();
  renderChatList();
  renderMessages();
  if (typeof updateSendBtn === 'function') updateSendBtn();
  if (typeof updateTokenDisplay === 'function') updateTokenDisplay();
}

function switchChat(id) {
  state.currentId = id;
  if (typeof syncGlobalTaskState === 'function') syncGlobalTaskState(id);
  saveData();
  renderChatList();
  renderMessages();
  if (typeof updateSendBtn === 'function') updateSendBtn();
  if (typeof updateTokenDisplay === 'function') updateTokenDisplay();
}

function deleteChat(id, e) {
  e.stopPropagation();
  if (!confirm('删除这个对话？')) return;
  // ⭐ 若删除的是正在生成的对话，先中止后台任务，避免回调写回已删除对象
  if (typeof isChatGenerating === 'function' && isChatGenerating(id) && typeof _abortCurrentTaskIfAny === 'function') {
    _abortCurrentTaskIfAny(id);
  }
  state.chats = state.chats.filter(c => c.id !== id);
  if (state.currentId === id) state.currentId = state.chats[0]?.id || null;
  if (typeof syncGlobalTaskState === 'function') syncGlobalTaskState(state.currentId);
  saveData();
  renderChatList();
  renderMessages();
  if (typeof updateSendBtn === 'function') updateSendBtn();
  if (typeof updateTokenDisplay === 'function') updateTokenDisplay();
}

function clearCurrentChat() {
  const c = currentChat();
  if (!c) return;
  if (!confirm('清空当前对话？')) return;
  if (typeof isChatGenerating === 'function' && isChatGenerating(c.id) && typeof _abortCurrentTaskIfAny === 'function') {
    _abortCurrentTaskIfAny(c.id);
  }
  c.messages = [];
  c.title = '新对话';
  saveData();
  renderChatList();
  renderMessages();
  if (typeof syncGlobalTaskState === 'function') syncGlobalTaskState(c.id);
  if (typeof updateSendBtn === 'function') updateSendBtn();
  if (typeof updateTokenDisplay === 'function') updateTokenDisplay();
  const chatGenerating = (typeof isChatGenerating === 'function') ? isChatGenerating(c.id) : !!state.isGenerating;
  if (!chatGenerating && typeof resetTaskPermission === 'function') {
    resetTaskPermission(c.id);
  }
}

function renderChatList() {
  document.getElementById('chatList').innerHTML = state.chats.map(c => `
    <div class="chat-item ${c.id === state.currentId ? 'active' : ''}" onclick="switchChat('${c.id}')">
      <span class="chat-item-title">${(typeof isChatGenerating === 'function' && isChatGenerating(c.id)) ? '⏳' : '💬'} ${escapeHtml(c.title)}</span>
      <button class="chat-item-del" onclick="deleteChat('${c.id}', event)">×</button>
    </div>`).join('');
}

function renderMessages() {
  const inner = document.getElementById('messagesInner');
  const c = currentChat();
  if (!c || c.messages.length === 0) {
    inner.innerHTML = `
      <div class="welcome">
        <h1>👋 你好，我是你的 AI 助手</h1>
        <p>📋 计划模式 · 🎭 师生 · 🛠 工具 · 🖼️ 图片 · 📎 文件 · 💾 备份 · 🗜️ 压缩</p>
        <div class="suggestions">
          <div class="suggestion" onclick="useSuggestion('请帮我写一篇 2000 字的科普文章介绍量子计算')"><strong>📋 计划模式</strong><span>复杂任务先规划再执行</span></div>
          <div class="suggestion" onclick="useSuggestion('用 Python 写一个二分查找')"><strong>💻 代码</strong><span>代码 + 公式渲染</span></div>
          <div class="suggestion" onclick="useSuggestion('用表格列出五种排序算法')"><strong>📊 表格</strong><span>Markdown 表格</span></div>
          <div class="suggestion" onclick="useSuggestion('帮我创建一个 hello.py 写个 Hello World')"><strong>🛠 工具</strong><span>让 AI 操作文件</span></div>
        </div>
      </div>`;
    if (typeof updateTokenDisplay === 'function') updateTokenDisplay();
    return;
  }
  
  // ⭐ 渲染前先记录滚动位置：用户在底部时才自动跟随
  const stickToBottom = isNearBottom();
  
  // 过滤掉标记为隐藏的消息
  const visibleIndices = [];
  c.messages.forEach((m, i) => {
    if (!m._hiddenFromUI) {
      visibleIndices.push(i);
    }
  });
  
  inner.innerHTML = visibleIndices.map(i => renderMsg(c.messages[i], i)).join('');
  postRender(inner);
  if (typeof groupToolFlows === 'function') groupToolFlows();
  if (stickToBottom) scrollBottom();
  if (typeof updateTokenDisplay === 'function') updateTokenDisplay();
}

// ⭐ 局部刷新：只重渲染某一条消息的整个节点，前后消息不动
// 用于工具循环 push 新消息 / 完成后做最终高亮渲染，避免全量 renderMessages 闪烁
function refreshMsgNode(idx, targetChat) {
  const c = targetChat || currentChat();
  if (targetChat && !isCurrentChat(targetChat)) return false;
  if (!c || !c.messages[idx]) return false;
  const m = c.messages[idx];
  if (m._hiddenFromUI) return false;
  
  const inner = document.getElementById('messagesInner');
  if (!inner) return false;
  
  const stickToBottom = isNearBottom();
  const existing = inner.querySelector(`.message[data-idx="${idx}"]`);
  
  const tmp = document.createElement('div');
  tmp.innerHTML = renderMsg(m, idx);
  const newNode = tmp.firstElementChild;
  if (!newNode) return false;
  
  if (existing) {
    existing.replaceWith(newNode);
  } else {
    // 节点不存在：找到合适的插入位置（按 data-idx 顺序）
    let inserted = false;
    const allNodes = inner.querySelectorAll('.message[data-idx]');
    for (const n of allNodes) {
      if (parseInt(n.dataset.idx) > idx) {
        inner.insertBefore(newNode, n);
        inserted = true;
        break;
      }
    }
    if (!inserted) inner.appendChild(newNode);
  }
  
  postRender(newNode);
  if (typeof groupToolFlows === 'function') groupToolFlows();
  if (stickToBottom) scrollBottom();
  return true;
}

// ⭐ 追加新消息到末尾（不动其它消息）
// 适用于刚 push 一条新消息（如 tool 结果、新的 assistant 占位）时
function appendMsgNode(idx, targetChat) {
  const c = targetChat || currentChat();
  if (targetChat && !isCurrentChat(targetChat)) return false;
  if (!c || !c.messages[idx]) return false;
  const m = c.messages[idx];
  if (m._hiddenFromUI) return false;
  
  const inner = document.getElementById('messagesInner');
  if (!inner) return false;
  
  // 已存在则走 refreshMsgNode
  const existing = inner.querySelector(`.message[data-idx="${idx}"]`);
  if (existing) return refreshMsgNode(idx, targetChat);
  
  // 如果之前是 welcome 状态，需要先清空
  if (inner.querySelector('.welcome')) {
    inner.innerHTML = '';
  }
  
  const stickToBottom = isNearBottom();
  const tmp = document.createElement('div');
  tmp.innerHTML = renderMsg(m, idx);
  const newNode = tmp.firstElementChild;
  if (!newNode) return false;
  
  inner.appendChild(newNode);
  postRender(newNode);
  if (typeof groupToolFlows === 'function') groupToolFlows();
  if (stickToBottom) scrollBottom();
  if (typeof updateTokenDisplay === 'function') updateTokenDisplay();
  return true;
}

// ⭐ 局部更新：只重渲染指定消息的 plan 面板，避免整个消息列表重建
// 解决：工具循环每秒数次 renderMessages 导致的卡顿、选中文本被清、滚动被踹的问题
function updatePlanPanel(msgIdx, targetChat) {
  const c = targetChat || currentChat();
  if (targetChat && !isCurrentChat(targetChat)) return false;
  if (!c || !c.messages[msgIdx] || !c.messages[msgIdx].plan) return false;
  
  const msgEl = document.querySelector(`.message[data-idx="${msgIdx}"]`);
  if (!msgEl) {
    // 消息节点不存在（如刚 push 完还没渲染），回退到全量渲染
    if (isCurrentChat(c)) renderMessages();
    return false;
  }
  
  const stickToBottom = isNearBottom();
  
  const oldPanel = msgEl.querySelector('.plan-panel');
  const newHtml = renderPlanPanel(c.messages[msgIdx], msgIdx);
  
  if (oldPanel) {
    // 用临时容器把 HTML 转 DOM，再替换旧 panel
    const tmp = document.createElement('div');
    tmp.innerHTML = newHtml;
    const newPanel = tmp.firstElementChild;
    if (newPanel) {
      oldPanel.replaceWith(newPanel);
      postRender(newPanel);
    }
    } else {
    // 旧节点不存在（比如第一次出现 plan），全量重渲一次
    if (isCurrentChat(c)) renderMessages();
    return false;
  }
  
  if (stickToBottom) scrollBottom();
  return true;
}

function renderMsg(m, idx) {
  if (m._isSummary) {
    const undoBtn = (m._compressionUndoId && typeof canUndoCompression === 'function' && canUndoCompression(m._compressionUndoId, currentChat()))
      ? `<button class="msg-action" onclick="undoCompressionSnapshot('${escapeHtml(m._compressionUndoId)}')">↩ 撤销压缩</button>`
      : '';
    return `
      <div class="message summary-msg" data-idx="${idx}">
        <div class="avatar" style="background:linear-gradient(135deg, var(--warning), #fbbf24);">🗜️</div>
        <div class="msg-body">
          <div class="msg-role">对话摘要 <span class="summary-badge">已压缩 ${m._originalCount} 条</span></div>
          <div class="msg-content">${renderMarkdown(m.content || '')}</div>
          <div class="msg-actions">
            <button class="msg-action" onclick="copyMsg(${idx})">📋 复制</button>
            ${undoBtn}
          </div>
        </div>
      </div>`;
  }
  
  if (m._isCompressing) {
    return `
      <div class="message" data-idx="${idx}">
        <div class="avatar assistant">🗜️</div>
        <div class="msg-body">
          <div class="msg-role">系统</div>
          <div class="msg-content"><span class="compressing-anim">${escapeHtml(m.content)}</span></div>
        </div>
      </div>`;
  }
  
  if (m.role === 'tool') {
    return `
      <div class="message" data-idx="${idx}">
        <div class="avatar tool">🛠</div>
        <div class="msg-body">
          <div class="msg-role">工具返回：${escapeHtml(m.name || '')}</div>
          <div class="tool-call">
            <div class="tool-call-header" onclick="this.parentElement.classList.toggle('collapsed')">
              <span>📤 ${escapeHtml(m.name || 'tool')} 执行结果</span>
              <span class="tool-status ${m.status || 'success'}">${m.status === 'error' ? '失败' : '成功'}</span>
            </div>
            <div class="tool-call-body">
              <pre>${escapeHtml(typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2))}</pre>
            </div>
          </div>
        </div>
      </div>`;
  }
  
  const isUser = m.role === 'user';
  
  // ⭐ 处理附件（包括被剥离的情况）
  let attsHtml = '';
  if (m.attachments && m.attachments.length) {
    attsHtml = '<div class="msg-attachments">' + m.attachments.map(a => {
      // 被剥离的附件
      if (a._stripped) {
        return `<div class="att-file" style="opacity:0.6;border-style:dashed;border-color:var(--warning);" title="${escapeHtml(a._strippedReason || '附件数据已丢失')}">
          <span class="att-file-icon">⚠️</span>
          <div class="att-file-info">
            <div class="att-file-name">${escapeHtml(a.name)} <span style="color:var(--warning);font-size:10px;">(数据已丢失)</span></div>
            <div class="att-file-size">${formatSize(a.size)} · ${escapeHtml(a.mime || '')}</div>
          </div>
        </div>`;
      }
      // 图片
      if (a.type === 'image' && a.data) {
        return `<img class="att-img" src="${a.data}" onclick="showImagePreview('${a.data}')" alt="">`;
      }
      // 普通文件
      return `<div class="att-file"><span class="att-file-icon">📄</span><div class="att-file-info"><div class="att-file-name">${escapeHtml(a.name)}</div><div class="att-file-size">${formatSize(a.size)} · ${escapeHtml(a.mime || '')}</div></div></div>`;
    }).join('') + '</div>';
  }
  
  let toolCallsHtml = '';
  if (m.tool_calls && m.tool_calls.length) {
    toolCallsHtml = m.tool_calls.map(tc => `
      <div class="tool-call">
        <div class="tool-call-header" onclick="this.parentElement.classList.toggle('collapsed')">
          <span>🔧 调用工具：${escapeHtml(tc.function?.name || '')}</span>
        </div>
        <div class="tool-call-body">
          <div class="tool-call-label">参数</div>
          <pre>${escapeHtml(tc.function?.arguments || '{}')}</pre>
        </div>
      </div>`).join('');
  }
  
  let reflectionHtml = '';
  if (m.reflection && m.reflection.turns && m.reflection.turns.length) {
    const ref = m.reflection;
    const turnsHtml = ref.turns.map(t => renderReflectionTurn(t)).join('');
    const progressHtml = ref.inProgress
      ? `<div class="ref-progress"><span class="ref-spinner"></span><span>${escapeHtml(ref.progressText || '思考中...')}</span></div>`
      : '';
    reflectionHtml = `
      <div class="reflection-panel ${ref.expanded ? '' : 'collapsed'}" data-msg-idx="${idx}">
        <button class="reflection-toggle" onclick="toggleReflectionPanel(${idx})">
          <span>🎭 师生讨论过程</span>
          <span class="reflection-stats">${ref.turns.filter(t => t.role === 'student').length} 轮 · 最终评分 ${ref.finalScore ?? '?'}/10</span>
        </button>
        <div class="reflection-body">${turnsHtml}${progressHtml}</div>
      </div>`;
  }
  
  let planHtml = '';
  if (m.plan) planHtml = renderPlanPanel(m, idx);
  
  let outlineHtml = '';
  if (m.outline && typeof renderOutlinePanel === 'function') outlineHtml = renderOutlinePanel(m, idx);
  let outlineDiffHtml = '';
  if (m.outline && typeof renderOutlineDiffSummary === 'function') outlineDiffHtml = renderOutlineDiffSummary(m, idx);
  
  const hasRefBadge = m.reflection && m.reflection.turns && m.reflection.turns.length > 0;
  const hasPlanBadge = m.plan && m.plan.steps && m.plan.steps.length > 0;
  const hasOutlineBadge = m.outline && m.outline.items && m.outline.items.length > 0;
  
  return `
    <div class="message" data-idx="${idx}">
      <div class="avatar ${isUser ? 'user' : 'assistant'}">${isUser ? '我' : 'AI'}</div>
      <div class="msg-body">
        <div class="msg-role">${isUser ? '你' : 'AI 助手'}
          ${hasPlanBadge ? '<span class="msg-badge" style="background:linear-gradient(135deg,var(--primary),var(--success));">📋 计划</span>' : ''}
          ${hasOutlineBadge ? '<span class="msg-badge" style="background:linear-gradient(135deg,#0ea5e9,#8b5cf6);">📑 大纲</span>' : ''}
          ${hasRefBadge ? '<span class="msg-badge">🎭 师生</span>' : ''}
          ${!isUser ? `<span class="msg-timer" data-msg-idx="${idx}">${formatMsgTimer(m)}</span>` : ''}
        </div>
        ${attsHtml}
        ${toolCallsHtml}
        ${(m.plan || m.outline || m.reflection) ? '' : `<div class="msg-content">${renderMarkdown(m.content || '')}</div>`}
        ${planHtml}
        ${outlineHtml}
        ${reflectionHtml}
        ${m.plan ? `<div class="msg-content plan-final-answer">${renderMarkdown(m.content || '')}</div>` : ''}
        ${m.outline ? `<div class="msg-content plan-final-answer">${renderMarkdown(m.content || '')}</div>` : ''}
        ${outlineDiffHtml}
        ${m.reflection ? `<div class="msg-content plan-final-answer">${renderMarkdown(m.content || '')}</div>` : ''}
        <div class="msg-actions">
          <button class="msg-action" onclick="copyMsg(${idx})">📋 复制</button>
          ${!isUser && m.role !== 'tool' ? `<button class="msg-action" onclick="regenerate(${idx})">🔄 重新生成</button>` : ''}
        </div>
      </div>
    </div>`;
}

// ⭐ 格式化消息计时器
//  - 等待首 token：⏱ 等待 Xs（橙色脉冲）
//  - 流式生成中：⏱ Xs（蓝色脉冲）
//  - 已完成：⏱ X.Xs（灰色静态）
function formatMsgTimer(m) {
  if (!m || m.role === 'user') return '';
  const startTime = m._startTime;
  if (!startTime) return '';
  
  const now = Date.now();
  const firstAt = m._firstTokenAt;
  const endAt = m._endTime;
  
  if (endAt) {
    const total = (endAt - startTime) / 1000;
    const ttft = firstAt ? ((firstAt - startTime) / 1000).toFixed(1) : null;
    const title = ttft ? `首字 ${ttft}s · 总计 ${total.toFixed(2)}s` : `总耗时 ${total.toFixed(2)}s`;
    return `<span class="timer-done" title="${title}">⏱ ${total.toFixed(1)}s</span>`;
  }
  
  if (!firstAt) {
    // 还在等待首 token
    const waited = ((now - startTime) / 1000).toFixed(1);
    return `<span class="timer-waiting" title="等待模型首个 token">⏳ 等待 ${waited}s</span>`;
  }
  
  // 流式中
  const elapsed = ((now - startTime) / 1000).toFixed(1);
  const ttft = ((firstAt - startTime) / 1000).toFixed(1);
  return `<span class="timer-streaming" title="首字 ${ttft}s · 持续接收">⏱ ${elapsed}s</span>`;
}

// ⭐ 全局心跳：每 250ms 刷新所有进行中消息的 timer 文案
// 只更新 textContent，不重渲染整条消息，零卡顿
//
// 同时承担"_endTime 兜底补盖"职责：
//   各模式（callAPI / plan / outline / reflection）虽然都在自己的 try/catch 里写了
//   _endTime，但仍可能存在罕见路径漏盖（异常分支、上游断流、用户中止时序竞争等）。
//   一旦漏盖，timer 就会永远按 Date.now()-_startTime 涨，并连带阻止工具流程折叠。
//   这里做最后一道防线：任何"事实上已结束"的消息都强制盖章。
function tickMsgTimers() {
  const c = currentChat();
  if (!c) return;
  const timers = document.querySelectorAll('.msg-timer[data-msg-idx]');
  const total = c.messages.length;
  let frozenJustNow = false;  // ⭐ 本次刷新是否新冻结了某条消息

  timers.forEach(el => {
    const idx = parseInt(el.dataset.msgIdx);
    const m = c.messages[idx];
    if (!m) return;

    // ⭐ 兜底补盖 ①：assistant 已被后续消息"接力"，但 _endTime 漏盖
    //   场景：plan/outline/reflection 等模式中某条 await 抛错被吞，未走到盖章那行
    if (!m._endTime && m.role === 'assistant' && idx < total - 1) {
      // 用后一条非隐藏消息的 _startTime 作为本条结束时间近似（流程上的"接力"时刻）
      let next = null;
      for (let k = idx + 1; k < total; k++) {
        if (!c.messages[k]._hiddenFromUI) { next = c.messages[k]; break; }
      }
      m._endTime = (next && next._startTime) ? next._startTime : Date.now();
    }

    // ⭐ 兜底补盖 ②：本条是最后一条 assistant，但全局已无生成任务
    //   且不在"等待用户介入"状态（如 plan 待审批、outline 暂停）→ 强制封冻
    if (!m._endTime && m.role === 'assistant' && idx === total - 1
        && typeof state !== 'undefined' && !state.isGenerating) {
      const planWaiting    = m.plan    && ['pending_approval', 'paused', 'error', 'verifying', 'verification_failed', 'verification_exhausted'].includes(m.plan.status);
      const outlinePending = m.outline && ['paused', 'error'].includes(m.outline.status);
      if (!planWaiting && !outlinePending) {
        m._endTime = Date.now();
      }
    }

    // 已结束的不再刷新（节省 DOM 写入）
    if (m._endTime && el.dataset.frozen === '1') return;
    el.innerHTML = formatMsgTimer(m);
    if (m._endTime) {
      el.dataset.frozen = '1';
      frozenJustNow = true;
    }
  });

  // ⭐ 有消息刚刚被冻结 → 可能解锁工具流程折叠：触发一次重新分组
  //   注意只在"发生状态切换"的那一帧触发，避免 250ms/次的高频 DOM 重排
  if (frozenJustNow && typeof groupToolFlows === 'function') {
    try { groupToolFlows(); } catch (e) { /* 静默 */ }
  }
  if (frozenJustNow && typeof saveData === 'function') saveData();
}

function onPickImages(e) {
  for (const f of e.target.files) addAttachment(f, 'image');
  e.target.value = '';
}

function onPickFiles(e) {
  for (const f of e.target.files) addAttachment(f, f.type.startsWith('image/') ? 'image' : 'file');
  e.target.value = '';
}

function addAttachment(file, type) {
  if (file.size > 20 * 1024 * 1024) {
    alert(`文件 ${file.name} 超过 20MB`);
    return;
  }
  const att = {
    id: 'a_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    name: file.name,
    mime: file.type,
    size: file.size,
    type: type
  };
  if (type === 'image') {
    const r = new FileReader();
    r.onload = e => {
      att.data = e.target.result;
      state.pendingAttachments.push(att);
      renderPendingAtts();
    };
    r.readAsDataURL(file);
  } else if (isTextLike(file)) {
    const r = new FileReader();
    r.onload = e => {
      att.text = e.target.result;
      state.pendingAttachments.push(att);
      renderPendingAtts();
    };
    r.readAsText(file);
  } else {
    const r = new FileReader();
    r.onload = e => {
      att.data = e.target.result;
      state.pendingAttachments.push(att);
      renderPendingAtts();
    };
    r.readAsDataURL(file);
  }
}

function isTextLike(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  const textExts = ['txt', 'md', 'json', 'csv', 'log', 'xml', 'html', 'css', 'js', 'ts', 'py', 'java', 'c', 'cpp', 'h', 'go', 'rs', 'rb', 'php', 'sh', 'yaml', 'yml', 'toml', 'ini', 'sql', 'tex', 'srt', 'vtt'];
  return file.type.startsWith('text/') || textExts.includes(ext);
}

function removeAttachment(id) {
  state.pendingAttachments = state.pendingAttachments.filter(a => a.id !== id);
  if (state.pendingAIAttachments) {
    state.pendingAIAttachments = state.pendingAIAttachments.filter(a => a.id !== id);
  }
  if (state.pendingAIAttachmentsByChat && state.currentId && state.pendingAIAttachmentsByChat[state.currentId]) {
    state.pendingAIAttachmentsByChat[state.currentId] = state.pendingAIAttachmentsByChat[state.currentId].filter(a => a.id !== id);
  }
  renderPendingAtts();
}

function renderPendingAtts() {
  const wrap = document.getElementById('pendingAtts');
  if (!state.pendingAttachments.length) {
    wrap.classList.remove('show');
    wrap.innerHTML = '';
    return;
  }
  wrap.classList.add('show');
  wrap.innerHTML = state.pendingAttachments.map(a => {
    const fromAI = a._fromAI;
    const aiBadge = fromAI 
      ? '<span style="background:var(--tool);color:white;padding:1px 5px;border-radius:8px;font-size:9px;margin-left:4px;font-weight:600;">AI</span>' 
      : '';
    const borderStyle = fromAI ? 'border-color:var(--tool);box-shadow:0 0 0 1px var(--tool);' : '';
    return `
      <div class="pending-att" style="${borderStyle}">
        ${a.type === 'image' ? `<img src="${a.data}">` : `<span style="font-size:18px;">📄</span>`}
        <span class="name">${escapeHtml(a.name)}${aiBadge}</span>
        <button class="remove" onclick="removeAttachment('${a.id}')">×</button>
      </div>`;
  }).join('');
}

function setupDrag() {
  const wrap = document.getElementById('inputInner');
  ['dragenter', 'dragover'].forEach(ev => wrap.addEventListener(ev, e => {
    e.preventDefault();
    wrap.classList.add('drag-over');
  }));
  ['dragleave', 'drop'].forEach(ev => wrap.addEventListener(ev, e => {
    e.preventDefault();
    if (ev === 'dragleave' && e.target !== wrap) return;
    wrap.classList.remove('drag-over');
  }));
  wrap.addEventListener('drop', e => {
    e.preventDefault();
    for (const f of e.dataTransfer.files) addAttachment(f, f.type.startsWith('image/') ? 'image' : 'file');
  });
}

function setupPaste() {
  document.getElementById('input').addEventListener('paste', e => {
    for (const item of e.clipboardData.items) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) addAttachment(f, f.type.startsWith('image/') ? 'image' : 'file');
      }
    }
  });
}

async function onSend() {
  // 状态保护
  const currentId = state.currentId;
  const currentGenerating = (typeof isChatGenerating === 'function') ? isChatGenerating(currentId) : !!state.isGenerating;
  if (currentGenerating) {
    console.log('[onSend] 当前对话正在生成，先停止...');
    stopGenerate();
    await new Promise(r => setTimeout(r, 200));
    if (typeof syncGlobalTaskState === 'function') syncGlobalTaskState(currentId);
    if (typeof updateSendBtn === 'function') updateSendBtn();
    return;
  }
  const input = document.getElementById('input');
  const text = input.value.trim();
  if (!text && !state.pendingAttachments.length) return;
  if (!state.settings.apiKey) {
    alert('请先在「设置」中填写 API Key');
    openSettings();
    return;
  }
  if (typeof ensureCompletionSoundReady === 'function') ensureCompletionSoundReady();
  if (!currentChat()) newChat();
  
  if (typeof resetTaskPermission === 'function') resetTaskPermission();
  
  const c = currentChat();
  
  // ⭐ 检查是否有未完成的计划模式任务（待审批、已暂停、出错状态）
  //   注意：始终检查，不依赖 state.settings.usePlan
  //   因为模式开关现在是"一次性"的，上次开启计划模式留下的悬挂任务必须先处理
  {
    const hasActivePlan = c.messages.some(m => 
      m.plan && (
        m.plan.status === 'pending_approval' || 
        m.plan.status === 'paused' || 
        m.plan.status === 'error' ||
        m.plan.status === 'executing' ||
        m.plan.status === 'verifying' ||
        m.plan.status === 'verification_failed' ||
        m.plan.status === 'verification_exhausted'
      )
    );
    
    if (hasActivePlan) {
      toast('⚠️ 有未完成的计划模式任务，请先在上方计划区点击「执行计划」或「取消」', 4000);
      return;
    }
  }
  
  // ⭐ 检查是否有未完成的大纲任务（暂停、出错状态）
  //   同上：始终检查，与 usePlan 一致
  {
    const hasPausedOutline = c.messages.some(m => 
      m.outline && (m.outline.status === 'paused' || m.outline.status === 'error')
    );
    if (hasPausedOutline) {
      toast('⚠️ 有未完成的大纲任务，请在大纲面板中点击「继续执行」「立即收尾」或「放弃」', 5000);
      return;
    }
  }
  
  const userMsg = { role: 'user', content: text };
  
  const allAttachments = [...state.pendingAttachments];
  const pendingAIForChat = (typeof takePendingAIAttachments === 'function')
    ? takePendingAIAttachments(c.id)
    : (state.pendingAIAttachments || []).splice(0);
  if (pendingAIForChat && pendingAIForChat.length) {
    for (const a of pendingAIForChat) {
      if (!allAttachments.some(ex => ex.id === a.id)) {
        allAttachments.push(a);
      }
    }
  }
  if (allAttachments.length) userMsg.attachments = allAttachments.map(a => ({ ...a }));
  
  c.messages.push(userMsg);
  if (c.messages.length === 1) c.title = (text || '附件对话').slice(0, 30);
  
  // ⭐ Trace: 记录一条用户消息（仅本地）
  if (typeof traceUserMessage === 'function') traceUserMessage(text);
  
  // 🧪 自动信标：在最新 user 消息之前可能插入一条隐藏的"记代号"消息
  //    判定逻辑在 beacon.js：按用户消息计数 + 间隔
  if (typeof maybeInsertBeacon === 'function') {
    try { maybeInsertBeacon(c); } catch (e) { console.warn('[beacon] 插入失败:', e); }
  }
  
  input.value = '';
  input.style.height = 'auto';
  state.pendingAttachments = [];
  renderPendingAtts();
  renderChatList();
  renderMessages();
  saveData();
  
  // ⭐ 发送消息后强制滚到底：无论用户之前是否在翻看历史，
  // 都把视图带回新消息处，符合主流 chat 应用的体验。
  // 用 rAF 等 DOM/布局完成后再滚，确保 scrollHeight 已更新到包含新消息。
  if (typeof scrollBottom === 'function') {
    requestAnimationFrame(() => scrollBottom());
  }
  
  // ⭐ 压缩检查必须放在新 user 消息/附件/信标入队之后。
  // 否则旧上下文还没到阈值，但本轮新输入一加入就可能超过窗口。
  if (typeof autoCompressCheck === 'function') {
    const compressResult = await autoCompressCheck(c);
    if (compressResult === 'failed') {
      toast('自动压缩失败，本轮请求已取消，避免发送超长上下文', 4000);
      return;
    }
  }
  
  try {
    // ⭐ 双保险：每次发送/重发都清零软停止标志
    //   各 callAPIWithXxx 内部也清，但放这里更直观，避免任何遗漏路径
    state.stopRequested = false;
    // ⭐ "一次性模式"：选定本轮走哪条分支，并立刻熄灭按钮
    //   下次发送默认走普通对话，除非用户重新开启
    const mode = (typeof _consumeOneShotMode === 'function') ? _consumeOneShotMode() : 'normal';
    if (mode === 'outline') await callAPIWithOutline();
    else if (mode === 'plan') await callAPIWithPlan();
    else if (mode === 'reflection') await callAPIWithReflection();
    else await callAPI(undefined, { contextChecked: true });
  } catch (e) {
    console.error('[onSend] 错误:', e);
    toast('❌ 发送失败：' + e.message, 3000);
  } finally {
    if (typeof syncGlobalTaskState === 'function') syncGlobalTaskState(state.currentId);
    else {
      state.isGenerating = false;
      state.abortCtrl = null;
    }
    if (typeof updateSendBtn === 'function') updateSendBtn();
  }
}

function copyMsg(idx) {
  const c = currentChat();
  navigator.clipboard.writeText(c.messages[idx].content || '').then(() => toast('✓ 已复制'));
}

async function regenerate(idx) {
  const c = currentChat();
  if (!c) return;
  if (typeof ensureCompletionSoundReady === 'function') ensureCompletionSoundReady();
  
  // ⭐ 关键修复：必须先中止任何正在跑的旧请求，否则会出现：
  //   1) 旧 SSE 流继续往新插入的占位消息写字符 → 内容错乱
  //   2) 同时两条 API 流并发 → 用户被双倍计费
  //   3) 两个 Promise 互相覆盖 saveData → 可能丢消息
  // 与 onSend 的处理保持一致：abort → 等一拍让 catch finally 跑完 → 再继续
  const sameChatGenerating = (typeof isChatGenerating === 'function') ? isChatGenerating(c.id) : !!state.isGenerating;
  if (sameChatGenerating || (typeof chatTaskById === 'function' && chatTaskById(c.id)?.abortCtrl)) {
    if (typeof _abortCurrentTaskIfAny === 'function') _abortCurrentTaskIfAny(c.id);
    else if (state.abortCtrl) { try { state.abortCtrl.abort(); } catch (_) {} }
    await new Promise(r => setTimeout(r, 200));
    if (typeof syncGlobalTaskState === 'function') syncGlobalTaskState(c.id);
    else {
      state.isGenerating = false;
      state.abortCtrl = null;
    }
    if (typeof updateSendBtn === 'function') updateSendBtn();
  }
  
  c.messages = c.messages.slice(0, idx);
  while (c.messages.length && c.messages[c.messages.length - 1].role === 'tool') c.messages.pop();
  // ⭐ 重新生成等价于"重新开始一个 AI 回合"，必须清理上次残留状态：
  // 1. 任务级临时授权 + 自动重发定时器（与 newChat/onSend 行为一致）
  // 2. 计划模式 / 大纲的执行中标志（防止旧标志卡住 onSend）
  if (typeof resetTaskPermission === 'function') resetTaskPermission();
  if (typeof refreshLegacyModeFlags === 'function') {
    refreshLegacyModeFlags();
  } else {
    state._planExecuting = false;
    state._outlineExecuting = false;
    state._outlineForceFinish = false;
  }
  renderMessages();
  saveData();
  // ⭐ 与 onSend 行为一致：消费"一次性模式"
  const mode = (typeof _consumeOneShotMode === 'function') ? _consumeOneShotMode() : 'normal';
  if (mode === 'outline') await callAPIWithOutline();
  else if (mode === 'plan') await callAPIWithPlan();
  else if (mode === 'reflection') await callAPIWithReflection();
  else await callAPI(undefined, { contextChecked: true });
}

// ============ 🆕 工具调用流程折叠 ============
// 思路：渲染完后扫描 DOM，把"工具调用过程"消息（assistant(tool_calls) + tool 反复）
// 包装到一个可折叠的容器内。仅当流程已结束（即流程后面已存在一条"无 tool_calls 的最终
// assistant"且其 _endTime 已被设置）才折叠；进行中则保持平铺，方便用户实时看进度。
//
// 在 renderMessages / refreshMsgNode / appendMsgNode 末尾调用即可。
function groupToolFlows() {
  const inner = document.getElementById('messagesInner');
  if (!inner) return;
  const c = currentChat();
  if (!c) return;
  
  // ⭐ 1) 先把现有 group 解包，恢复扁平结构（同时记录展开状态以便后续恢复）
  const expandedKeys = new Set();
  inner.querySelectorAll('.tool-flow-group').forEach(g => {
    if (!g.classList.contains('collapsed')) {
      const key = g.dataset.flowKey;
      if (key) expandedKeys.add(key);
    }
    const body = g.querySelector('.tool-flow-body');
    if (body) {
      // 把消息节点提到 group 前面
      while (body.firstChild) g.parentNode.insertBefore(body.firstChild, g);
    }
    g.remove();
  });
  
  // ⭐ 2) 重新查询所有消息节点，按 data-idx 顺序处理
  const msgNodes = Array.from(inner.querySelectorAll(':scope > .message[data-idx]'));
  let i = 0;
  while (i < msgNodes.length) {
    const node = msgNodes[i];
    const idx = parseInt(node.dataset.idx);
    const m = c.messages[idx];
    
    // 工具流程的"起点"：一条带 tool_calls 的 assistant 消息
    if (m && m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
      // 向后扫描，找到这段流程的终点：第一条 assistant 且无 tool_calls（即最终回答）
      let endExclusive = msgNodes.length;   // 流程结束于 msgNodes 中的索引（不含 final）
      let finalMsg = null;
      let toolResultCount = 0;
      let assistantStepCount = 1; // 当前这条 tool_calls assistant 算 1 步
      
      for (let j = i + 1; j < msgNodes.length; j++) {
        const jdx = parseInt(msgNodes[j].dataset.idx);
        const mj = c.messages[jdx];
        if (!mj) break;
        if (mj.role === 'user') { endExclusive = j; break; }
        if (mj.role === 'tool') { toolResultCount++; continue; }
        if (mj.role === 'assistant') {
          if (mj.tool_calls && mj.tool_calls.length) {
            assistantStepCount++;
            continue;
          }
          // 找到了最终回答
          finalMsg = mj;
          endExclusive = j;
          break;
        }
      }
      
      // 仅当：找到了最终回答 && 最终回答已完成（_endTime 存在）&& 内容非空 时才折叠
      const isComplete = finalMsg
        && finalMsg._endTime
        && ((finalMsg.content || '').trim() || (finalMsg.tool_calls && finalMsg.tool_calls.length === 0));

      // ⭐ 兜底折叠条件：流程后面已被 user 消息接力（说明流程一定结束了），
      //   即便没找到"无 tool_calls 的 assistant"作为最终回答，也允许折叠。
      //   场景：用户中止、上游断流、最后一轮还在等 tool 结果就被打断等。
      const interruptedByUser = !finalMsg
        && endExclusive < msgNodes.length
        && (() => {
          const nxtIdx = parseInt(msgNodes[endExclusive].dataset.idx);
          return c.messages[nxtIdx] && c.messages[nxtIdx].role === 'user';
        })();

      // ⭐ 兜底折叠条件：找到了 final 且 _endTime 已盖，但内容为空。
      //   typeof tool_calls 不一定有，所以原表达式恒 false，这里独立放过。
      const completeButEmpty = finalMsg && finalMsg._endTime && !(finalMsg.content || '').trim();

      const canCollapse = isComplete || interruptedByUser || completeButEmpty;

      if (canCollapse && endExclusive > i) {
        const groupNodes = msgNodes.slice(i, endExclusive);
        
        // 用第一条消息的 idx 作为流程唯一 key
        const flowKey = 'flow_' + idx;
        const wasExpanded = expandedKeys.has(flowKey);
        
        // 统计总耗时：从起点 _startTime 到最后一条 tool/assistant _endTime
        let startT = null, endT = null;
        for (const gn of groupNodes) {
          const gIdx = parseInt(gn.dataset.idx);
          const gm = c.messages[gIdx];
          if (!gm) continue;
          if (gm._startTime && (startT == null || gm._startTime < startT)) startT = gm._startTime;
          if (gm._endTime && (endT == null || gm._endTime > endT)) endT = gm._endTime;
        }
        const elapsed = (startT && endT) ? ((endT - startT) / 1000).toFixed(1) + 's' : '';
        
        const group = document.createElement('div');
        group.className = 'tool-flow-group' + (wasExpanded ? '' : ' collapsed');
        group.dataset.flowKey = flowKey;
        group.innerHTML = `
          <button class="tool-flow-toggle" type="button">
            <span class="tool-flow-icon">🛠</span>
            <span class="tool-flow-title">工具调用过程</span>
            <span class="tool-flow-meta">
              <span class="tool-flow-chip">${toolResultCount} 次调用</span>
              ${elapsed ? `<span class="tool-flow-chip tool-flow-chip-time">⏱ ${elapsed}</span>` : ''}
            </span>
            <span class="tool-flow-arrow">▼</span>
          </button>
          <div class="tool-flow-body"></div>
        `;
        const toggleBtn = group.querySelector('.tool-flow-toggle');
        toggleBtn.addEventListener('click', () => {
          group.classList.toggle('collapsed');
        });
        
        const body = group.querySelector('.tool-flow-body');
        // 把第一条节点的位置作为 group 插入点
        groupNodes[0].parentNode.insertBefore(group, groupNodes[0]);
        for (const gn of groupNodes) body.appendChild(gn);
        
        i = endExclusive;
        continue;
      }
      // 不满足折叠条件：跳过整段，避免重复进入
      i = endExclusive;
      continue;
    }
    i++;
  }
}
