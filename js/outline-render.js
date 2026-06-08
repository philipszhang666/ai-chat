// ============ 📑 大纲模式 - UI 渲染 + 用户交互 ============
// 【模块定位】DOM 渲染、设置面板、按钮入口、用户介入
// 依赖：outline-prompts.js、outline-core.js、state.js、utils.js
// 加载顺序：最后

// ============ UI 渲染 ============

function renderOutlinePanel(m, idx) {
  if (!m.outline) return '';
  const o = m.outline;
  const total = o.items?.length || 0;
  const done = (o.items || []).filter(it => it.status === 'done' || it.status === 'skipped').length;
  const pct = total ? Math.round(done / total * 100) : 0;
  
  let statusBadge = '';
  if (o.status === 'running' && o.finishRequested) statusBadge = '<span class="outline-status-badge running">🏁 收尾中</span>';
  else if (o.status === 'running') statusBadge = '<span class="outline-status-badge running">🔄 进行中</span>';
  else if (o.status === 'completed') statusBadge = '<span class="outline-status-badge done">✅ 已完成</span>';
  else if (o.status === 'truncated') statusBadge = '<span class="outline-status-badge truncated">⚠️ 轮数耗尽</span>';
  else if (o.status === 'paused') statusBadge = '<span class="outline-status-badge paused">⏸ 已停止</span>';
  else if (o.status === 'error') statusBadge = '<span class="outline-status-badge error">❌ 出错</span>';
  else if (o.status === 'cancelled') statusBadge = '<span class="outline-status-badge cancelled">❌ 已取消</span>';
  
  let statsText = total ? `${total} 项` : '准备中';
  if (o.rounds) statsText += ` · 第 ${o.rounds}/${o.maxRounds} 轮`;
  if (total && (o.status === 'running' || o.status === 'paused')) {
    statsText += ` · ${done}/${total}`;
  }
  if (o.taskProfile && o.taskProfile.domain) {
    const domainLabel = {
      coding: '代码',
      research: '研究',
      writing: '写作',
      file_ops: '文件',
      general: '通用'
    }[o.taskProfile.domain] || o.taskProfile.domain;
    statsText += ` · ${domainLabel}`;
  }
  
  // 条目列表
  let itemsHtml = '';
  if (o.items?.length) {
    itemsHtml = `<ol class="outline-item-list">${o.items.map(it => {
      const status = it.status || 'pending';
      let toolCallsHtml = '';
      if (it.toolCalls && it.toolCalls.length) {
        toolCallsHtml = renderOutlineToolCalls(it.toolCalls);
      }
      return `
        <li class="outline-item ${status}" data-item-id="${escapeHtml(it.id)}">
          <div class="outline-item-main">
            <div class="outline-item-header">
              <span class="outline-item-id">${escapeHtml(it.id)}</span>
              <span class="outline-item-title">${escapeHtml(it.title)}</span>
            </div>
            ${it.note ? `<div class="outline-item-note">${escapeHtml(it.note)}</div>` : ''}
            ${toolCallsHtml}
          </div>
        </li>`;
    }).join('')}</ol>`;
  } else if (o.status === 'running') {
    itemsHtml = '<div class="outline-empty">等待 AI 生成大纲...</div>';
  }
  
  // 全局工具调用（未归类的）
  let globalToolsHtml = '';
  if (o.globalToolCalls && o.globalToolCalls.length) {
    globalToolsHtml = `
      <div class="outline-section sub">
        <div class="outline-section-header">🔧 其他工具调用</div>
        <div class="outline-section-body">
          ${renderOutlineToolCalls(o.globalToolCalls)}
        </div>
      </div>`;
  }
  
  const progressHtml = o.inProgress
    ? `<div class="ref-progress"><span class="ref-spinner"></span><span>${escapeHtml(o.progressText || '处理中...')}</span></div>`
    : '';

  let taskProfileHtml = '';
  if (o.taskProfile) {
    const p = o.taskProfile;
    const verify = p.requiresVerification ? '需验证' : '不强制验证';
    const codeChange = p.requiresCodeChange ? '可能改代码' : '不预期改代码';
    taskProfileHtml = `
      <div class="outline-task-profile" title="${escapeHtml(p.reason || '')}">
        <span>${escapeHtml(p.domain || 'general')}</span>
        <span>${escapeHtml(p.intent || 'other')}</span>
        <span>${codeChange}</span>
        <span class="${p.requiresVerification ? 'verify' : ''}">${verify}</span>
      </div>`;
  }
  
  const mainSection = `
    <div class="outline-section main">
      <div class="outline-section-header">📑 工作大纲 ${statusBadge}</div>
      <div class="outline-section-body">
        ${total && (o.status === 'running' || o.status === 'completed' || o.status === 'paused') ? 
          `<div class="outline-progress-bar"><div class="outline-progress-fill" style="width:${pct}%;"></div></div>` : ''}
        ${itemsHtml}
      </div>
    </div>`;
  
  // 已注入的留言历史（紧凑显示）
  let injectionsHtml = '';
  if (o.injections && o.injections.length) {
    injectionsHtml = `
      <div class="outline-section sub outline-injections">
        <div class="outline-section-header">💬 用户留言 / 附件注入（${o.injections.length}）</div>
        <div class="outline-section-body">
          ${o.injections.map(inj => {
            const isAtt = inj._isAttachment;
            return `
              <div class="outline-injection-item ${isAtt ? 'is-attachment' : ''}">
                <span class="outline-injection-meta">${isAtt ? '📎' : '💬'} 第 ${inj.round || '?'} 轮后</span>
                <div class="outline-injection-text">${escapeHtml(inj.text)}</div>
              </div>
            `;
          }).join('')}
        </div>
      </div>`;
  }
  
  // 操作区
  let actionHtml = '';
  if (o.status === 'running') {
    // 执行中：第一次点收尾只发出收尾请求；请求后按钮切换为强制中断逃生口。
    if (o.finishRequested) {
      actionHtml = `
        <div class="outline-actions">
          <div class="outline-actions-hint">🏁 已收到收尾请求，正在停止当前轮并整理最终回答。</div>
          <div class="outline-actions-btns">
            <button class="outline-btn cancel" onclick="finishOutlineNow(${idx})" title="当前轮长时间无响应时强制中断">🛑 强制中断</button>
          </div>
        </div>`;
    } else {
      actionHtml = `
        <div class="outline-actions">
          <div class="outline-actions-hint">🔄 任务执行中。需要停止可点击右上角顶栏的「停止」按钮，或：</div>
          <div class="outline-actions-btns">
            <button class="outline-btn finish" onclick="finishOutlineNow(${idx})" title="立即停止当前轮并要求 AI 给最终回答；再次点击强制中断">🏁 立即收尾</button>
          </div>
        </div>`;
    }
  } else if (o.status === 'truncated' && o.inProgress) {
    // ⭐ 正在保底收尾中：万一这次 fetch 也卡了，给用户一个"强制中断"逃生通道
    actionHtml = `
      <div class="outline-actions">
        <div class="outline-actions-hint">🏁 正在整理最终回答。如果长时间无响应，可强制中断：</div>
        <div class="outline-actions-btns">
          <button class="outline-btn cancel" onclick="finishOutlineNow(${idx})" title="再点一次强制中断">🛑 强制中断</button>
        </div>
      </div>`;
  } else if (o.status === 'paused') {
    // 暂停中：留言框 + 继续 / 收尾 / 取消
    const hasSnap = !!o._snap;
    actionHtml = `
      <div class="outline-actions paused">
        <div class="outline-actions-hint">⏸ 已暂停${hasSnap ? '。可输入留言后继续，或一键收尾：' : '（任务状态已丢失，无法继续，仅能取消）'}</div>
        ${hasSnap ? `
          <textarea class="outline-inject-input" id="outlineInject_${idx}" rows="2" placeholder="💬 给 AI 留言（可选）：比如「跳过 a3」「重点看 a2」「直接总结吧」..."></textarea>
        ` : ''}
        <div class="outline-actions-btns">
          ${hasSnap ? `<button class="outline-btn resume" onclick="resumeOutline(${idx})">▶️ 继续执行</button>` : ''}
          ${hasSnap ? `<button class="outline-btn finish" onclick="finishOutlineNow(${idx})">🏁 立即收尾</button>` : ''}
          <button class="outline-btn cancel" onclick="cancelOutline(${idx})">❌ 放弃</button>
        </div>
      </div>`;
  }
  
  return `
    <div class="outline-panel ${o.expanded ? '' : 'collapsed'}" data-msg-idx="${idx}">
      <button class="outline-toggle" onclick="toggleOutlinePanel(${idx})">
        <span>📑 工作大纲</span>
        <span class="outline-stats">${statsText}</span>
      </button>
      <div class="outline-body">
        ${mainSection}
        ${taskProfileHtml}
        ${globalToolsHtml}
        ${injectionsHtml}
        ${actionHtml}
        ${progressHtml}
      </div>
    </div>`;
}

function renderOutlineToolCalls(calls) {
  return `<div class="outline-tool-calls">${calls.map(tc => {
    const argsStr = JSON.stringify(tc.args || {});
    const argsShort = argsStr.length > 80 ? argsStr.slice(0, 80) + '…' : argsStr;
    let icon, cls;
    if (tc._running) { icon = '<span class="outline-tool-spin"></span>'; cls = 'running'; }
    else if (tc.ok === false) { icon = '❌'; cls = 'error'; }
    else { icon = '✅'; cls = 'success'; }
    return `
      <div class="outline-tool-call ${cls}">
        <div class="outline-tool-head">
          <span class="outline-tool-icon">${icon}</span>
          <span class="outline-tool-name">🔧 ${escapeHtml(tc.name)}</span>
          <span class="outline-tool-args" title="${escapeHtml(argsStr)}">${escapeHtml(argsShort)}</span>
        </div>
        ${tc.result && !tc._running ? `<div class="outline-tool-result">${escapeHtml(tc.result.slice(0, 300))}${tc.result.length > 300 ? '…' : ''}</div>` : ''}
      </div>`;
  }).join('')}</div>`;
}

function renderOutlineDiffSummary(m, idx) {
  const summary = m && m.outline && m.outline.diffSummary;
  const outline = m && m.outline;
  if ((!summary || !Array.isArray(summary.files) || !summary.files.length) && !(outline && outline.checkpointId)) return '';
  const verify = (typeof outlineVerificationState === 'function') ? outlineVerificationState(m.outline) : null;
  let verifyHtml = '';
  if (verify && verify.hasMutation) {
    if (verify.hasPassedVerificationAfterMutation) {
      const cmd = verify.lastVerificationAfterMutation && verify.lastVerificationAfterMutation.args ? verify.lastVerificationAfterMutation.args.command : '';
      verifyHtml = `<div class="outline-diff-verify pass">验证通过：${escapeHtml(cmd || 'execute_action')}</div>`;
    } else if (verify.hasVerificationAfterMutation) {
      const cmd = verify.lastVerificationAfterMutation && verify.lastVerificationAfterMutation.args ? verify.lastVerificationAfterMutation.args.command : '';
      verifyHtml = `<div class="outline-diff-verify fail">最新验证未通过：${escapeHtml(cmd || 'execute_action')}（退出码 ${escapeHtml(String(verify.lastVerificationReturncode ?? '?'))}）</div>`;
    } else {
      verifyHtml = `<div class="outline-diff-verify warn">代码修改后尚未通过验证命令</div>`;
    }
  }
  const expanded = !!(summary && summary.expanded);
  const files = summary && Array.isArray(summary.files) ? summary.files : [];
  const visible = expanded ? files : files.slice(0, 3);
  const hiddenCount = Math.max(0, files.length - visible.length);
  const totalAdded = parseInt(summary && summary.totalAdded) || 0;
  const totalRemoved = parseInt(summary && summary.totalRemoved) || 0;
  const rows = visible.map(f => {
    const added = parseInt(f.added) || 0;
    const removed = parseInt(f.removed) || 0;
    return `
      <div class="outline-diff-row">
        <span class="outline-diff-path" title="${escapeHtml(f.path || '')}">${escapeHtml(f.path || '(unknown)')}</span>
        <span class="outline-diff-stat">
          ${added ? `<span class="outline-diff-add">+${added}</span>` : ''}
          ${removed ? `<span class="outline-diff-del">-${removed}</span>` : ''}
          ${(!added && !removed) ? '<span class="outline-diff-unknown">已修改</span>' : ''}
        </span>
      </div>`;
  }).join('');
  const checkpointId = outline && outline.checkpointId;
  const restoreState = outline && outline.restoreState;
  const checkpointHtml = checkpointId ? `
      <div class="outline-diff-checkpoint">
        <div class="outline-diff-checkpoint-main">
          <span>checkpoint</span>
          <code>${escapeHtml(checkpointId)}</code>
        </div>
        ${restoreState && restoreState.restored ? `<div class="outline-diff-restore-ok">已恢复：${escapeHtml(restoreState.checkpointId || checkpointId)}（恢复 ${restoreState.restoredCount || 0}，删除 ${restoreState.deletedCount || 0}，跳过 ${restoreState.skippedCount || 0}）</div>` : `<button class="outline-diff-restore-btn" onclick="restoreOutlineCheckpoint(${idx})">回滚到修改前</button>`}
      </div>` : '';
  return `
    <div class="outline-diff-card">
      <div class="outline-diff-head">
        <span class="outline-diff-icon">⊞</span>
        <div class="outline-diff-title">
          <div>已编辑 ${(summary && summary.totalFiles) || files.length} 个文件</div>
          <div class="outline-diff-total">
            ${totalAdded ? `<span class="outline-diff-add">+${totalAdded}</span>` : '<span class="outline-diff-muted">+0</span>'}
            ${totalRemoved ? `<span class="outline-diff-del">-${totalRemoved}</span>` : '<span class="outline-diff-muted">-0</span>'}
          </div>
        </div>
      </div>
      ${verifyHtml}
      ${checkpointHtml}
      ${rows ? `<div class="outline-diff-list">${rows}</div>` : ''}
      ${hiddenCount ? `<button class="outline-diff-more" onclick="toggleOutlineDiffSummary(${idx})">再显示 ${hiddenCount} 个文件⌄</button>` : (files.length > 3 ? `<button class="outline-diff-more" onclick="toggleOutlineDiffSummary(${idx})">收起⌃</button>` : '')}
    </div>`;
}

function toggleOutlineDiffSummary(idx) {
  const c = currentChat();
  if (!c || !c.messages[idx] || !c.messages[idx].outline || !c.messages[idx].outline.diffSummary) return;
  c.messages[idx].outline.diffSummary.expanded = !c.messages[idx].outline.diffSummary.expanded;
  if (typeof refreshMsgNode === 'function') refreshMsgNode(idx, c);
  else if (typeof renderMessages === 'function') renderMessages();
  saveData();
}

async function restoreOutlineCheckpoint(idx) {
  const c = currentChat();
  const msg = c && c.messages[idx];
  const outline = msg && msg.outline;
  const checkpointId = outline && outline.checkpointId;
  if (!checkpointId || typeof restoreCheckpoint !== 'function') return;
  const result = await restoreCheckpoint(checkpointId, true, { chatId: c.id, chat: c, outline });
  if (typeof result === 'object' && result && result.ok) {
    outline.restoreState = {
      restored: true,
      restoredAt: new Date().toISOString(),
      checkpointId,
      restoredCount: Array.isArray(result.restored) ? result.restored.length : 0,
      deletedCount: Array.isArray(result.deleted) ? result.deleted.length : 0,
      skippedCount: Array.isArray(result.skipped) ? result.skipped.length : 0,
      safetyCheckpointId: result.safetyCheckpoint && result.safetyCheckpoint.id
    };
    if (typeof toast === 'function') toast('已恢复到修改前 checkpoint');
    if (typeof refreshMsgNode === 'function') refreshMsgNode(idx, c);
    else if (typeof renderMessages === 'function') renderMessages();
    saveData();
  } else if (typeof toast === 'function') {
    const text = typeof result === 'string' ? result : ((result && result.text) || '恢复 checkpoint 失败');
    toast(text.slice(0, 180), 5000);
  }
}

function toggleOutlinePanel(idx) {
  const c = currentChat();
  if (!c || !c.messages[idx] || !c.messages[idx].outline) return;
  c.messages[idx].outline.expanded = !c.messages[idx].outline.expanded;
  const panel = document.querySelector(`.outline-panel[data-msg-idx="${idx}"]`);
  if (panel) panel.classList.toggle('collapsed');
  saveData();
}

// 局部刷新（避免整页重渲）
function updateOutlinePanel(msgIdx, targetChat) {
  const c = targetChat || currentChat();
  if (targetChat && !isCurrentChat(targetChat)) return false;
  if (!c || !c.messages[msgIdx] || !c.messages[msgIdx].outline) return false;
  
  const msgEl = document.querySelector(`.message[data-idx="${msgIdx}"]`);
  if (!msgEl) {
    if (typeof renderMessages === 'function' && isCurrentChat(c)) renderMessages();
    return false;
  }
  
  const stickToBottom = (typeof isNearBottom === 'function') ? isNearBottom() : false;
  const oldPanel = msgEl.querySelector('.outline-panel');
  
  // 保留用户在留言框中已输入但未提交的内容
  let preservedInjection = null;
  if (oldPanel) {
    const ta = oldPanel.querySelector(`#outlineInject_${msgIdx}`);
    if (ta) preservedInjection = ta.value;
  }
  
  const newHtml = renderOutlinePanel(c.messages[msgIdx], msgIdx);
  
  if (oldPanel) {
    const tmp = document.createElement('div');
    tmp.innerHTML = newHtml;
    const newPanel = tmp.firstElementChild;
    if (newPanel) {
      oldPanel.replaceWith(newPanel);
      if (typeof postRender === 'function') postRender(newPanel);
      
      // 还原留言框输入
      if (preservedInjection !== null) {
        const newTa = newPanel.querySelector(`#outlineInject_${msgIdx}`);
        if (newTa) newTa.value = preservedInjection;
      }
    }
  } else {
    if (typeof renderMessages === 'function' && isCurrentChat(c)) renderMessages();
    return false;
  }
  
  if (stickToBottom && typeof scrollBottom === 'function') scrollBottom();
  return true;
}

// ============ 设置面板 ============

function openOutlineSettings() {
  const modal = document.getElementById('outlineModal');
  if (!modal) return;
  modal.classList.add('show');
  const s = state.settings;
  const e = id => document.getElementById(id);
  if (e('outline_enabled')) e('outline_enabled').checked = !!s.useOutline;
  if (e('outline_maxRounds')) {
    e('outline_maxRounds').value = Math.max(1, parseInt(s.outlineMaxRounds) || 30);
  }
  if (e('outline_model')) e('outline_model').value = s.outlineModel || '';
  if (e('outline_systemPrompt')) e('outline_systemPrompt').value = s.outlineSystemPrompt || DEFAULT_OUTLINE_SYSTEM_PROMPT;
}

function closeOutlineSettings() {
  const modal = document.getElementById('outlineModal');
  if (modal) modal.classList.remove('show');
}

function saveOutlineSettings() {
  const s = state.settings;
  const e = id => document.getElementById(id);
  if (e('outline_enabled')) s.useOutline = e('outline_enabled').checked;
  if (e('outline_maxRounds')) {
    const rounds = parseInt(e('outline_maxRounds').value);
    s.outlineMaxRounds = (isNaN(rounds) || rounds < 1) ? 30 : rounds;
  }
  if (e('outline_model')) s.outlineModel = e('outline_model').value.trim();
  if (e('outline_systemPrompt')) s.outlineSystemPrompt = e('outline_systemPrompt').value;
  
  // 互斥：开启大纲模式时关闭 plan / reflection
  if (s.useOutline) {
    s.usePlan = false;
    s.useReflection = false;
    const planBtn = document.getElementById('planBtn');
    const reflectBtn = document.getElementById('reflectBtn');
    if (planBtn) planBtn.classList.remove('plan-active');
    if (reflectBtn) reflectBtn.classList.remove('reflect-active');
  }
  
  if (typeof persistSettings === 'function') persistSettings();
  
  const btn = document.getElementById('outlineBtn');
  if (btn) {
    if (s.useOutline) btn.classList.add('outline-active');
    else btn.classList.remove('outline-active');
  }
  
  if (typeof updateSendBtn === 'function') updateSendBtn();
  closeOutlineSettings();
  if (typeof toast === 'function') toast('✓ 已保存');
}

function resetOutlinePrompt() {
  const el = document.getElementById('outline_systemPrompt');
  if (el) {
    el.value = DEFAULT_OUTLINE_SYSTEM_PROMPT;
    if (typeof toast === 'function') toast('✓ 已恢复默认提示词');
  }
}

// ============ 用户介入操作 ============

// ▶️ 恢复执行（带可选用户留言）
async function resumeOutline(msgIdx) {
  const c = currentChat();
  if (!c || !c.messages[msgIdx] || !c.messages[msgIdx].outline) return;
  if (typeof ensureCompletionSoundReady === 'function') ensureCompletionSoundReady();
  
  if ((typeof isChatGenerating === 'function' ? isChatGenerating(c.id) : state.isGenerating)) {
    if (typeof toast === 'function') toast('⏳ 已有任务在执行中', 3000);
    return;
  }
  
  const aiMsg = c.messages[msgIdx];
  if (aiMsg.outline.status !== 'paused') {
    if (typeof toast === 'function') toast('该任务不处于暂停状态', 2500);
    return;
  }
  
  if (!aiMsg.outline._snap) {
    if (typeof toast === 'function') toast('❌ 任务状态已丢失（可能因刷新页面），无法继续', 4000);
    return;
  }
  
  // 读取留言输入框
  const ta = document.getElementById(`outlineInject_${msgIdx}`);
  const injection = ta ? ta.value : '';
  
  await callAPIWithOutline({
    resumeFromMsgIdx: msgIdx,
    userInjection: injection
  });
}

// 🏁 立即收尾（执行中 / 暂停中 都可用）
// ⭐ 第一次点击发出收尾请求；请求后再次点击会触发"硬中断"，不再等 fetch 响应 abort。

async function finishOutlineNow(msgIdx) {
  const c = currentChat();
  if (!c || !c.messages[msgIdx] || !c.messages[msgIdx].outline) return;
  const taskChatId = c.id;
  const aiMsg = c.messages[msgIdx];
  const status = aiMsg.outline.status;
  
  // ⭐ 硬中断逃生通道：已请求收尾后再次点击 = 强制脱困
  // 用于网络层卡死、abort 信号被忽略等极端情况
  const outlineRunning = (typeof isChatTaskMode === 'function') ? isChatTaskMode(taskChatId, 'outline') : !!state._outlineExecuting;
  if (aiMsg.outline.finishRequested && outlineRunning) {
    if (confirm('⚠️ 检测到任务似乎卡住了。\n\n是否强制中断？\n（将丢弃当前轮的回复，但保留已完成的大纲条目）')) {
      return _hardAbortOutline(msgIdx);
    }
    return;
  }
  
  if (status === 'running' || status === 'truncated') {
    // ⭐ 执行中 / 正在收尾：都允许触发"再来一次收尾"
    // truncated 状态下如果保底收尾 fetch 卡住，也走这里
    if (status === 'running') {
      if (!confirm('立即停止当前轮并要求 AI 直接给出最终回答？\n\n（请求后再次点击此按钮，将强制中断）')) {
        return;
      }
    }
    const task = (typeof chatTaskById === 'function') ? chatTaskById(taskChatId) : null;
    if (task) {
      task.outlineForceFinish = true;
      if (typeof refreshLegacyModeFlags === 'function') refreshLegacyModeFlags();
    } else {
      state._outlineForceFinish = true;
    }
    aiMsg.outline.finishRequested = true;
    aiMsg.outline.inProgress = true;
    aiMsg.outline.progressText = '🏁 已请求立即收尾，正在停止当前轮...';
    aiMsg.outline.expanded = true;
    if (typeof refreshMsgNode === 'function') refreshMsgNode(msgIdx, c);
    else if (typeof renderMessages === 'function' && isCurrentChat(c)) renderMessages();
    saveData();
    if (typeof toast === 'function') toast('🏁 已请求收尾，正在停止当前轮并整理最终回答', 3000);
    if (typeof requestStopChatTask === 'function' && requestStopChatTask(taskChatId)) {
      // 已按对话中止当前轮，catch 分支会进入收尾
    } else if (state.abortCtrl) {
      try { state.abortCtrl.abort(); } catch (e) {}
    }
    // 同时通知 rate-limiter 取消等待
    if (typeof window !== 'undefined' && window._rateWaitAbort) {
      const ctrl = task ? task.abortCtrl : state.abortCtrl;
      try { window._rateWaitAbort(ctrl && ctrl.signal); } catch (e) {}
    }
    return;
  }
  
  if (status === 'paused') {
    // 暂停中：直接发起一次保底收尾调用
    if (!confirm('要求 AI 基于已有信息直接给出最终回答？')) {
      return;
    }
    if (!aiMsg.outline._snap) {
      if (typeof toast === 'function') toast('❌ 任务状态已丢失，无法收尾', 4000);
      return;
    }
    
    const abortCtrl = new AbortController();
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
    if (typeof updateSendBtn === 'function') updateSendBtn();
    if (typeof renderChatList === 'function') renderChatList();
    
    aiMsg.outline.status = 'truncated';
    aiMsg.outline.inProgress = true;
    aiMsg.outline.finishRequested = true;
    aiMsg.outline.progressText = '🏁 正在整理最终回答...';
    aiMsg.outline.expanded = true;
    if (typeof refreshMsgNode === 'function') refreshMsgNode(msgIdx, c);
    
    const snap = aiMsg.outline._snap;
    
    try {
      const fallbackAnswer = await doFinalSummaryCall(
        snap.conversationMessages,
        snap.history,
        snap.systemPrompt,
        snap.model,
        aiMsg.outline,
        abortCtrl.signal,
        c
      );
      
      const finishNote = `\n\n---\n\n> 🏁 **用户请求立即收尾，AI 基于已有信息给出本回答。**`;
      
      if (fallbackAnswer) {
        aiMsg.content = fallbackAnswer + finishNote;
      } else if (snap.finalAnswer) {
        aiMsg.content = snap.finalAnswer + finishNote;
      } else {
        const doneItems = aiMsg.outline.items.filter(it => it.status === 'done');
        let summary = `任务被用户提前收尾。\n\n`;
        if (doneItems.length) summary += `**已完成的部分：**\n${doneItems.map(it => `- ${it.title}${it.note ? '：' + it.note : ''}`).join('\n')}\n`;
        aiMsg.content = summary + finishNote;
      }
      if (typeof outlineBuildDiffSummary === 'function') {
        aiMsg.outline.diffSummary = outlineBuildDiffSummary(aiMsg.outline);
      }
      
      aiMsg.outline.expanded = false;
      delete aiMsg.outline.finishRequested;
      if (typeof toast === 'function') toast('🏁 已收尾', 3000);
    } catch (e) {
      if (e.name === 'AbortError') {
        aiMsg.outline.status = 'paused';  // 收尾过程被中断 → 回退到暂停
        delete aiMsg.outline.finishRequested;
        if (typeof toast === 'function') toast('⏹ 收尾被中断', 3000);
      } else {
        aiMsg.outline.status = 'error';
        delete aiMsg.outline.finishRequested;
        aiMsg.content = `❌ 收尾失败：${e.message}` + (aiMsg.content ? '\n\n' + aiMsg.content : '');
      }
    } finally {
      aiMsg.outline.inProgress = false;
      delete aiMsg.outline.progressText;
      delete aiMsg.outline._snap;
      aiMsg._endTime = Date.now();
      if (typeof clearChatTask === 'function') clearChatTask(taskChatId);
      else {
        state.isGenerating = false;
        state.abortCtrl = null;
        if (state.activeTaskChatId === taskChatId) state.activeTaskChatId = null;
        state._outlineExecuting = false;
      }
      if (typeof updateSendBtn === 'function') updateSendBtn();
      if (typeof renderChatList === 'function') renderChatList();
      if (typeof refreshMsgNode === 'function') refreshMsgNode(msgIdx, c);
      else if (typeof renderMessages === 'function' && isCurrentChat(c)) renderMessages();
      saveData();
    }
    return;
  }
  
  if (typeof toast === 'function') toast('当前任务状态不支持收尾操作', 2500);
}

// ⭐ 硬中断：当 fetch 卡死、abort 信号失效时的逃生通道
// 强行把所有任务状态归零，标记当前任务为 error，让用户能开新对话
function _hardAbortOutline(msgIdx) {
  const c = currentChat();
  if (!c || !c.messages[msgIdx]) return;
  const aiMsg = c.messages[msgIdx];
  
  // 1) 触发 abort（即使没用也试一次）
  if (typeof requestStopChatTask === 'function' && requestStopChatTask(c.id)) {
    // 已按对话中止
  } else if (state.abortCtrl) {
    try { state.abortCtrl.abort(); } catch (e) {}
  }
  if (typeof window !== 'undefined' && window._rateWaitAbort) {
    const task = (typeof chatTaskById === 'function') ? chatTaskById(c.id) : null;
    const ctrl = task ? task.abortCtrl : state.abortCtrl;
    try { window._rateWaitAbort(ctrl && ctrl.signal); } catch (e) {}
  }
  
  // 2) 强制清掉当前对话的"任务进行中"标志
  if (typeof clearChatTask === 'function') clearChatTask(c.id);
  else {
    state.isGenerating = false;
    state.abortCtrl = null;
    state.activeTaskChatId = null;
    state._outlineExecuting = false;
    state._outlineForceFinish = false;
  }
  
  // 3) 标记此条消息为 error 状态，保留 _snap 让用户还能"继续执行"重试
  if (aiMsg.outline) {
    aiMsg.outline.status = 'error';
    aiMsg.outline.inProgress = false;
    delete aiMsg.outline.finishRequested;
    delete aiMsg.outline.progressText;
    const note = '\n\n---\n\n> ⚠️ **任务被强制中断**（网络挂死或 abort 信号失效）。可点击「继续执行」重试，或开始新对话。';
    aiMsg.content = (aiMsg.content || '(任务被中断)') + note;
  }
  if (!aiMsg._endTime) aiMsg._endTime = Date.now();
  
  if (typeof updateSendBtn === 'function') updateSendBtn();
  if (typeof refreshMsgNode === 'function') refreshMsgNode(msgIdx);
  else if (typeof renderMessages === 'function') renderMessages();
  saveData();
  if (typeof toast === 'function') toast('🛑 已强制中断', 3000);
}

// ❌ 取消（彻底放弃）
function cancelOutline(msgIdx) {
  const c = currentChat();
  if (!c || !c.messages[msgIdx] || !c.messages[msgIdx].outline) return;
  if (!confirm('放弃此任务？已完成的部分会保留，但无法继续执行。')) return;
  
  const aiMsg = c.messages[msgIdx];
  aiMsg.outline.status = 'cancelled';
  aiMsg.outline.inProgress = false;
  aiMsg.outline.expanded = false;
  delete aiMsg.outline.progressText;
  delete aiMsg.outline._snap;
  
  if (!aiMsg.content || !aiMsg.content.trim()) {
    const doneItems = aiMsg.outline.items.filter(it => it.status === 'done');
    if (doneItems.length) {
      aiMsg.content = `❌ 任务已取消。\n\n**已完成的部分：**\n${doneItems.map(it => `- ${it.title}${it.note ? '：' + it.note : ''}`).join('\n')}`;
    } else {
      aiMsg.content = '❌ 任务已取消。';
    }
  } else {
    aiMsg.content += '\n\n---\n\n> ❌ 用户取消了后续执行。';
  }
  
  if (!aiMsg._endTime) aiMsg._endTime = Date.now();
  if (typeof refreshMsgNode === 'function') refreshMsgNode(msgIdx);
  else if (typeof renderMessages === 'function') renderMessages();
  saveData();
  if (typeof toast === 'function') toast('任务已取消', 2000);
}

function toggleOutline() {
  const s = state.settings;
  s.useOutline = !s.useOutline;
  
  // 互斥
  if (s.useOutline) {
    s.usePlan = false;
    s.useReflection = false;
    const planBtn = document.getElementById('planBtn');
    const reflectBtn = document.getElementById('reflectBtn');
    if (planBtn) planBtn.classList.remove('plan-active');
    if (reflectBtn) reflectBtn.classList.remove('reflect-active');
  }
  
  const btn = document.getElementById('outlineBtn');
  if (btn) {
    if (s.useOutline) btn.classList.add('outline-active');
    else btn.classList.remove('outline-active');
  }
  if (typeof persistSettings === 'function') persistSettings();
  if (typeof updateSendBtn === 'function') updateSendBtn();
  if (typeof toast === 'function') toast(s.useOutline ? '✓ 已启用大纲模式' : '✓ 已关闭大纲模式');
}
