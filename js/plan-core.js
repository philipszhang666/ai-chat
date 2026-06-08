// ============ 📋 计划模式 - 核心执行逻辑 ============
// 【模块定位】计划模式主流程 + 步骤执行 + 规划辅助（无 DOM 操作）
// 依赖：state.js / api.js / tools.js / chat.js
// 加载顺序：在 plan-ui.js 之前

// ============ 计划模式（人在回路 + 完整 Agent 执行）============

const PLAN_STEP_STATUSES = new Set(['pending', 'running', 'done', 'failed', 'skipped']);

function normalizePlanStep(raw, idx) {
  const s = raw || {};
  const id = String(s.id || s.key || `t${idx + 1}`).trim() || `t${idx + 1}`;
  const status = PLAN_STEP_STATUSES.has(s.status) ? s.status : 'pending';
  const criteria = Array.isArray(s.successCriteria)
    ? s.successCriteria
    : (Array.isArray(s.criteria) ? s.criteria : []);
  const verificationRaw = s.verification && typeof s.verification === 'object' ? s.verification : {};
  const commands = Array.isArray(verificationRaw.commands)
    ? verificationRaw.commands
    : (Array.isArray(s.verificationCommands) ? s.verificationCommands : []);
  return {
    id,
    title: s.title || s.name || '未命名',
    description: s.description || s.desc || '',
    status,
    successCriteria: criteria.map(x => String(x || '').trim()).filter(Boolean),
    verification: {
      commands: commands.map(x => String(x || '').trim()).filter(Boolean),
      notes: verificationRaw.notes || verificationRaw.note || ''
    },
    attempts: Number.isFinite(Number(s.attempts)) ? Number(s.attempts) : 0,
    maxAttempts: Number.isFinite(Number(s.maxAttempts)) ? Number(s.maxAttempts) : 2,
    result: s.result || '',
    error: s.error || '',
    kind: s.kind || s.type || 'normal',
    sourceVerificationRound: s.sourceVerificationRound || null,
    toolCalls: Array.isArray(s.toolCalls) ? s.toolCalls : [],
    verificationRuns: Array.isArray(s.verificationRuns) ? s.verificationRuns : [],
    verificationResult: s.verificationResult || null,
    startedAt: s.startedAt || null,
    endedAt: s.endedAt || null
  };
}

function normalizePlanObject(plan, opts = {}) {
  if (!plan) return plan;
  plan.steps = Array.isArray(plan.steps)
    ? plan.steps.map((s, i) => {
        const normalized = normalizePlanStep(s, i);
        if (s && typeof s === 'object') {
          Object.assign(s, normalized);
          return s;
        }
        return normalized;
      })
    : [];
  const used = new Set();
  plan.steps.forEach((step, i) => {
    let base = step.id || `t${i + 1}`;
    let id = base;
    let n = 2;
    while (used.has(id)) id = `${base}_${n++}`;
    step.id = id;
    used.add(id);
    if (opts.resetRunning && step.status === 'running') step.status = 'pending';
    if (plan.status === 'completed' && step.status === 'running') {
      step.status = 'done';
      step.result = step.result || '（该步骤已完成，但旧状态未记录结果）';
      step.endedAt = step.endedAt || Date.now();
    }
  });
  const runningIdx = plan.steps.findIndex(step => step.status === 'running');
  if (runningIdx > 0) {
    for (let i = 0; i < runningIdx; i++) {
      const step = plan.steps[i];
      if (step.status === 'pending') {
        step.status = 'done';
        step.result = step.result || '（该步骤已完成，但旧状态未正确记录）';
        step.endedAt = step.endedAt || Date.now();
      }
    }
  }
  plan._executionResults = rebuildPlanExecutionResults(plan);
  normalizePlanFinalVerification(plan);
  return plan;
}

function countFinishedPlanSteps(plan) {
  return (plan.steps || []).filter(s => s.status === 'done' || s.status === 'skipped').length;
}

function rebuildPlanExecutionResults(plan) {
  return (plan.steps || [])
    .filter(s => s.status === 'done' || s.status === 'skipped')
    .map(s => ({
      id: s.id,
      title: s.title,
      status: s.status,
      result: s.result || (s.status === 'skipped' ? '（已跳过）' : '')
    }));
}

function nextPlanStepIndex(plan) {
  return (plan.steps || []).findIndex(s => s.status === 'pending' || s.status === 'failed');
}

function planHasRunnableSteps(plan) {
  return nextPlanStepIndex(plan) >= 0;
}

function planStepLabel(status) {
  return {
    pending: '待执行',
    running: '执行中',
    done: '已完成',
    failed: '失败',
    skipped: '已跳过'
  }[status] || '待执行';
}

function normalizePlanFinalVerificationTurn(raw, idx) {
  const v = raw || {};
  const score = Number.isFinite(Number(v.score)) ? Number(v.score) : 0;
  return {
    round: Number.isFinite(Number(v.round)) ? Number(v.round) : idx + 1,
    passed: !!v.passed,
    score,
    reason: v.reason || '',
    issues: Array.isArray(v.issues) ? v.issues.map(x => String(x || '').trim()).filter(Boolean) : [],
    suggestions: Array.isArray(v.suggestions) ? v.suggestions.map(x => String(x || '').trim()).filter(Boolean) : [],
    improvement: v.improvement && typeof v.improvement === 'object' ? {
      title: String(v.improvement.title || ''),
      description: String(v.improvement.description || ''),
      successCriteria: Array.isArray(v.improvement.successCriteria)
        ? v.improvement.successCriteria.map(x => String(x || '').trim()).filter(Boolean)
        : []
    } : { title: '', description: '', successCriteria: [] },
    toolCalls: Array.isArray(v.toolCalls) ? v.toolCalls : [],
    raw: v.raw || '',
    ts: v.ts || Date.now()
  };
}

function normalizePlanFinalVerification(plan) {
  if (!plan) return [];
  const turns = Array.isArray(plan.finalVerificationTurns)
    ? plan.finalVerificationTurns
    : (Array.isArray(plan.resultVerificationTurns) ? plan.resultVerificationTurns : []);
  plan.finalVerificationTurns = turns.map((t, i) => {
    const normalized = normalizePlanFinalVerificationTurn(t, i);
    if (t && typeof t === 'object') {
      Object.assign(t, normalized);
      return t;
    }
    return normalized;
  });
  return plan.finalVerificationTurns;
}

function latestPlanFinalVerification(plan) {
  const turns = normalizePlanFinalVerification(plan);
  return turns.length ? turns[turns.length - 1] : null;
}

function planStepsForPrompt(plan) {
  return (plan.steps || []).map(s => ({
    id: s.id,
    title: s.title,
    description: s.description,
    successCriteria: s.successCriteria || []
  }));
}

async function callAPIWithPlan() {
  const c = currentChat();
  if (!c) return;
  const s = state.settings;
  const taskChatId = c.id;
  const renderIfVisible = () => { if (!taskChatId || isCurrentChat(taskChatId)) renderMessages(); };
  // ⭐ 创建 abortCtrl，让用户能中断规划/审批阶段
  const abortCtrl = new AbortController();
  const task = (typeof beginChatTask === 'function')
    ? beginChatTask(taskChatId, abortCtrl, { resetStop: true })
    : null;
  if (task && typeof setChatTaskMode === 'function') {
    setChatTaskMode(taskChatId, 'plan', { planPhase: 'planning' });
    if (typeof updateChatTaskController === 'function') updateChatTaskController(taskChatId, abortCtrl);
  } else {
    state.isGenerating = true;
    state.activeTaskChatId = taskChatId || null;
    state.abortCtrl = abortCtrl;
    state._planExecuting = true;
    state.stopRequested = false;
  }
  const planRunOptions = {
    chat: c,
    chatId: taskChatId,
    signal: abortCtrl.signal,
    isStopped: () => task ? !!task.stopRequested : !!state.stopRequested
  };
  updateSendBtn();
  if (typeof renderChatList === 'function') renderChatList();
  
  const aiMsg = {
    role: 'assistant',
    content: '',
    _startTime: Date.now(),
    plan: {
      stage: 'planning',
      status: 'pending_approval',
      analysis: '',
      steps: [],
      reviewTurns: [],
      plannerToolCalls: [],
      finalVerificationTurns: [],
      pendingImprovement: null,
      planScore: null,
      verifyScore: null,
      progressText: '📋 计划模式规划中...',
      expanded: true,
      inProgress: true,
      _userQuestion: '',
      _executionResults: []
    }
  };
  c.messages.push(aiMsg);
  renderIfVisible();
  
  const historyForUse = c.messages.slice(0, -1);
  const userQuestion = extractUserQuestion(historyForUse);
  aiMsg.plan._userQuestion = userQuestion;
  
  const plannerModel = s.planPlannerModel.trim() || s.currentModel;
  
  try {
    aiMsg.plan.stage = 'planning';
    aiMsg.plan.progressText = '📋 计划模式分析任务...';
    renderIfVisible();
    
    let plan = await generatePlan(historyForUse, plannerModel, s.planPlannerPrompt, s.planMaxSteps, aiMsg.plan, () => updatePlanPanel(c.messages.indexOf(aiMsg), c), planRunOptions);
    aiMsg.plan.analysis = plan.analysis;
    aiMsg.plan.steps = plan.steps.map((st, i) => normalizePlanStep({ ...st, status: 'pending' }, i));
    renderIfVisible();
    
    if (s.planReview) {
      aiMsg.plan.stage = 'reviewing';
      for (let r = 1; r <= s.planReviewRounds; r++) {
        aiMsg.plan.progressText = `🎭 审查计划（第 ${r} 轮）...`;
        renderIfVisible();
        const rr = await reviewPlan(userQuestion, plan, plannerModel, planRunOptions);
        aiMsg.plan.reviewTurns.push({ round: r, ...rr });
        aiMsg.plan.planScore = rr.score;
        renderIfVisible();
        if (rr.satisfied || rr.score >= 8) break;
        aiMsg.plan.progressText = `✏️ 规划者根据审查意见修改计划（第 ${r} 轮）...`;
        updatePlanPanel(c.messages.indexOf(aiMsg), c);
        plan = await revisePlanWithFeedback(
          userQuestion, plan, rr, plannerModel, s.planPlannerPrompt, s.planMaxSteps,
          aiMsg.plan, () => updatePlanPanel(c.messages.indexOf(aiMsg), c), planRunOptions
        );
        aiMsg.plan.analysis = plan.analysis;
        aiMsg.plan.steps = plan.steps.map((st, i) => normalizePlanStep({ ...st, status: 'pending' }, i));
        renderIfVisible();
        if (r === s.planReviewRounds) break;
      }
    }
    
    // 暂停，等待用户审批
    aiMsg.plan.stage = 'awaiting_approval';
    aiMsg.plan.status = 'pending_approval';
    aiMsg.plan.inProgress = false;
    aiMsg.plan.progressText = '⏸ 计划已生成，等待您审批';
    if (!aiMsg._endTime) aiMsg._endTime = Date.now();
    
    aiMsg.content = `📋 **计划模式已生成任务序列**（共 ${plan.steps.length} 步）${aiMsg.plan.planScore !== null ? `· 评分 ${aiMsg.plan.planScore}/10` : ''}\n\n` +
                    `请审查下方的执行计划。如果满意，点击「▶️ 执行计划」按钮开始；\n` +
                    `如果不满意，点击「🔄 重新规划」或「❌ 取消」。\n\n` +
                    `**分析**：${plan.analysis}\n\n` +
                    `**步骤概览**：\n` +
                    plan.steps.map((s, i) => `${i + 1}. ${s.title}`).join('\n');
    
    saveData();
    renderIfVisible();
    toast('📋 计划已生成，请审批后执行', 3000);
    
  } catch (e) {
    if (e.name === 'AbortError') {
      aiMsg.content = (aiMsg.content || '') + '\n\n*[规划已被用户停止]*';
      aiMsg.plan.status = 'cancelled';
    } else {
      aiMsg.content = `❌ 计划模式规划出错：${e.message}`;
      aiMsg.plan.status = 'error';
    }
    aiMsg.plan.inProgress = false;
    aiMsg.plan.stage = 'done';
    // ⭐ 规划阶段失败/取消，任务已终结，固定计时
    if (!aiMsg._endTime) aiMsg._endTime = Date.now();
    delete aiMsg.plan.progressText;
    renderIfVisible();
    saveData();
  } finally {
    if (typeof clearChatTask === 'function') clearChatTask(taskChatId);
    else {
      state.isGenerating = false;
      state.abortCtrl = null;
      if (state.activeTaskChatId === taskChatId) state.activeTaskChatId = null;
      state._planExecuting = false;
    }
    updateSendBtn();
    if (typeof renderChatList === 'function') renderChatList();
  }
}

// ⭐ 用户审批后执行计划
async function approveAndExecutePlan(msgIdx) {
  const c = currentChat();
  if (!c || !c.messages[msgIdx] || !c.messages[msgIdx].plan) return;
  if (typeof ensureCompletionSoundReady === 'function') ensureCompletionSoundReady();
  const taskChatId = c.id;
  const renderIfVisible = () => { if (isCurrentChat(taskChatId)) renderMessages(); };
  
  const aiMsg = c.messages[msgIdx];
  const plan = aiMsg.plan;
  normalizePlanObject(plan, { resetRunning: true });
  
  if (plan.status !== 'pending_approval' && plan.status !== 'paused' && plan.status !== 'error') {
    toast('此计划不在可执行状态');
    return;
  }
  
  if ((typeof isChatGenerating === 'function') ? isChatGenerating(taskChatId) : state.isGenerating) {
    toast('此对话已有任务正在执行，请稍等');
    return;
  }
  
  // ⭐ 创建 abortCtrl，让用户能中断执行
  const abortCtrl = new AbortController();
  const task = (typeof beginChatTask === 'function')
    ? beginChatTask(taskChatId, abortCtrl, { resetStop: true })
    : null;
  if (task && typeof setChatTaskMode === 'function') {
    setChatTaskMode(taskChatId, 'plan', { planPhase: 'executing', planMsgIdx: msgIdx });
    if (typeof updateChatTaskController === 'function') updateChatTaskController(taskChatId, abortCtrl);
  } else {
    state.isGenerating = true;
    state.activeTaskChatId = taskChatId;
    // ⭐ 关键：标记计划模式正在执行，防止 onSend 触发新计划
    state._planExecuting = true;
    state.abortCtrl = abortCtrl;
    state.stopRequested = false;
  }
  const planRunOptions = {
    chat: c,
    chatId: taskChatId,
    signal: abortCtrl.signal,
    isStopped: () => task ? !!task.stopRequested : !!state.stopRequested
  };
  updateSendBtn();
  if (typeof renderChatList === 'function') renderChatList();
  
  // ⭐ 计时：保留暂停/审批前已用耗时，继续执行时从当前时间接着跑。
  if (typeof resumeMsgTimer === 'function') resumeMsgTimer(aiMsg);
  else {
    delete aiMsg._endTime;
    if (!aiMsg._startTime) aiMsg._startTime = Date.now();
  }
  
  plan.status = 'executing';
  plan.stage = 'executing';
  plan.inProgress = true;
  plan.progressText = '🚀 开始执行计划模式任务...';
  renderIfVisible();
  
  const s = state.settings;
  const executorModel = s.planExecutorModel.trim() || s.currentModel;
  const userQuestion = plan._userQuestion;
  
  let stepResults = rebuildPlanExecutionResults(plan);
  plan._executionResults = stepResults;
  let currentRunningIdx = -1;
  
  try {
    while (planHasRunnableSteps(plan)) {
      const i = nextPlanStepIndex(plan);
      const step = plan.steps[i];
      step.status = 'running';
      step.error = '';
      step.startedAt = Date.now();
      step.endedAt = null;
      step.attempts = (parseInt(step.attempts) || 0) + 1;
      currentRunningIdx = i;
      stepResults = rebuildPlanExecutionResults(plan);
      plan._executionResults = stepResults;
      plan.progressText = `🔨 执行第 ${i + 1}/${plan.steps.length} 步：${step.title}`;
      updatePlanPanel(c.messages.indexOf(aiMsg), c);
      saveData();

      try {
        const result = await executeStepWithTools(
          userQuestion, plan, i, stepResults, executorModel, s.planExecutorPrompt,
          { ...planRunOptions, msgIdx: c.messages.indexOf(aiMsg) }
        );

        step.result = result;
        step.endedAt = Date.now();
        step.status = 'done';
        currentRunningIdx = -1;
        stepResults = rebuildPlanExecutionResults(plan);
        plan._executionResults = stepResults;
        updatePlanPanel(c.messages.indexOf(aiMsg), c);
        saveData();
      } catch (stepErr) {
        if (stepErr.name === 'AbortError') throw stepErr;
        step.status = 'failed';
        step.error = stepErr.message || String(stepErr);
        step.endedAt = Date.now();
        currentRunningIdx = -1;
        plan.status = 'error';
        plan.stage = 'executing';
        plan.inProgress = false;
        aiMsg.content = `❌ 计划模式在第 ${i + 1} 步失败：${step.title}\n\n${step.error}\n\n已完成的步骤会保留，可在该步骤点击「重试」，或点击「继续执行」重新尝试。`;
        delete plan.progressText;
        updatePlanPanel(c.messages.indexOf(aiMsg), c);
        renderIfVisible();
        saveData();
        toast('❌ 当前步骤失败，可重试', 4000);
        return;
      }
    }
    
    plan.steps.forEach(step => {
      if (step.status === 'running') {
        step.status = 'done';
        step.result = step.result || '（该步骤已完成，但未记录文本结果）';
        step.endedAt = step.endedAt || Date.now();
      }
    });
    plan._executionResults = rebuildPlanExecutionResults(plan);

    // 整合输出
    let finalAnswer;
    if (s.planSynthesize) {
      plan.stage = 'synthesizing';
      plan.progressText = '✨ 整合结果...';
      renderIfVisible();
      finalAnswer = await synthesizeResults(userQuestion, plan, stepResults, executorModel, planRunOptions);
    } else {
      finalAnswer = stepResults.map((r, i) => `## ${i + 1}. ${r.title}\n\n${r.result}`).join('\n\n');
    }
    
    aiMsg.content = finalAnswer;
    const shouldVerify = s.planVerify !== false;
    const maxVerifyRounds = Math.max(1, parseInt(s.planVerifyRounds) || 1);
    const verifyTurns = normalizePlanFinalVerification(plan);
    if (shouldVerify && verifyTurns.length < maxVerifyRounds) {
      const verifyRound = verifyTurns.length + 1;
      const verifierModel = (s.planVerifierModel || '').trim() || s.currentModel;
      plan.stage = 'verifying';
      plan.status = 'verifying';
      plan.progressText = `🧑‍🏫 老师验证最终结果（第 ${verifyRound}/${maxVerifyRounds} 轮）...`;
      updatePlanPanel(c.messages.indexOf(aiMsg), c);
      renderIfVisible();
      saveData();

      const verification = await verifyFinalPlanResult(
        userQuestion,
        plan,
        finalAnswer,
        verifierModel,
        verifyRound,
        () => updatePlanPanel(c.messages.indexOf(aiMsg), c),
        planRunOptions
      );
      plan.finalVerificationTurns.push(verification);
      plan.verifyScore = verification.score;
      plan.pendingImprovement = verification.passed ? null : verification.improvement;

      if (!verification.passed) {
        const exhausted = plan.finalVerificationTurns.length >= maxVerifyRounds;
        plan.stage = 'awaiting_improvement';
        plan.status = exhausted ? 'verification_exhausted' : 'verification_failed';
        plan.inProgress = false;
        plan.expanded = true;
        if (!aiMsg._endTime) aiMsg._endTime = Date.now();
        delete plan.progressText;
        renderIfVisible();
        saveData();
        toast(exhausted ? '⚠️ 验证未通过，已达到验证轮数上限' : '⚠️ 验证未通过，可选择新增改进阶段', 5000);
        return;
      }
    }

    plan.stage = 'done';
    plan.status = 'completed';
    plan.inProgress = false;
    plan.expanded = false;
    if (!aiMsg._endTime) aiMsg._endTime = Date.now();
    delete plan.progressText;
    renderIfVisible();
    saveData();
    toast('✅ 计划执行完成并通过验证', 3000);
    if (typeof playCompletionSound === 'function') playCompletionSound();
    
  } catch (e) {
    if (currentRunningIdx >= 0 && plan.steps[currentRunningIdx]) {
      if (plan.steps[currentRunningIdx].status === 'running') {
        plan.steps[currentRunningIdx].status = 'failed';
        plan.steps[currentRunningIdx].error = e.name === 'AbortError' ? '用户中断' : (e.message || String(e));
        plan.steps[currentRunningIdx].endedAt = Date.now();
      }
    }
    if (e.name === 'AbortError') {
      aiMsg.content = (aiMsg.content || '') + '\n\n*[执行已停止，可以再次点击执行继续]*';
      plan.status = 'paused';
    } else {
      aiMsg.content = `❌ 计划模式执行出错：${e.message}\n\n（已完成的步骤会保留，您可以再次点击执行继续）`;
      plan.status = 'error';
    }
    plan.inProgress = false;
    // ⭐ 暂停/出错时固定计时；下次 approve 继续执行会清除 _endTime
    if (!aiMsg._endTime) aiMsg._endTime = Date.now();
    delete plan.progressText;
    renderIfVisible();
    saveData();
  } finally {
    if (typeof clearChatTask === 'function') clearChatTask(taskChatId);
    else {
      state.isGenerating = false;
      state.abortCtrl = null;
      if (state.activeTaskChatId === taskChatId) state.activeTaskChatId = null;
      // ⭐ 关键：无论成功失败都清除执行标记
      state._planExecuting = false;
    }
    updateSendBtn();
    if (typeof renderChatList === 'function') renderChatList();
  }
}

function cancelPlan(msgIdx) {
  const c = currentChat();
  if (!c || !c.messages[msgIdx]) return;
  if (!confirm('取消此计划？\n（消息会保留，但状态变为已取消）')) return;
  if ((typeof isChatGenerating === 'function') ? isChatGenerating(c.id) : state.isGenerating) {
    if (typeof requestStopChatTask === 'function') requestStopChatTask(c.id);
  }
  
  const aiMsg = c.messages[msgIdx];
  if (aiMsg.plan) {
    aiMsg.plan.status = 'cancelled';
    aiMsg.plan.stage = 'done';
    aiMsg.plan.inProgress = false;
    if (!aiMsg._endTime) aiMsg._endTime = Date.now();
    delete aiMsg.plan.progressText;
    aiMsg.content = '❌ 计划模式任务已被用户取消。';
  }
  renderMessages();
  saveData();
  toast('计划模式任务已取消');
}

async function regeneratePlan(msgIdx) {
  const c = currentChat();
  if (!c || !c.messages[msgIdx]) return;
  if ((typeof isChatGenerating === 'function') ? isChatGenerating(c.id) : state.isGenerating) { toast('请等此对话当前任务完成'); return; }
  
  c.messages = c.messages.slice(0, msgIdx);
  renderMessages();
  saveData();
  await callAPIWithPlan();
}

function editPlanStep(msgIdx, stepIdx) {
  const c = currentChat();
  if (!c || !c.messages[msgIdx] || !c.messages[msgIdx].plan) return;
  normalizePlanObject(c.messages[msgIdx].plan);
  const step = c.messages[msgIdx].plan.steps[stepIdx];
  if (!step) return;
  
  const newTitle = prompt('修改步骤标题：', step.title);
  if (newTitle === null) return;
  const newDesc = prompt('修改步骤描述：', step.description);
  if (newDesc === null) return;
  const newCriteria = prompt('成功标准（每行一条，可留空）：', (step.successCriteria || []).join('\n'));
  if (newCriteria === null) return;
  
  step.title = newTitle.trim() || step.title;
  step.description = newDesc.trim() || step.description;
  step.successCriteria = newCriteria.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  saveData();
  renderMessages();
  toast('✓ 步骤已修改');
}

function deletePlanStep(msgIdx, stepIdx) {
  const c = currentChat();
  if (!c || !c.messages[msgIdx] || !c.messages[msgIdx].plan) return;
  if (!confirm('删除这一步？')) return;
  c.messages[msgIdx].plan.steps.splice(stepIdx, 1);
  normalizePlanObject(c.messages[msgIdx].plan);
  saveData();
  renderMessages();
  toast('已删除步骤');
}

async function retryPlanStep(msgIdx, stepIdx) {
  const c = currentChat();
  if (!c || !c.messages[msgIdx] || !c.messages[msgIdx].plan) return;
  if ((typeof isChatGenerating === 'function') ? isChatGenerating(c.id) : state.isGenerating) { toast('请等此对话当前任务完成'); return; }
  const plan = c.messages[msgIdx].plan;
  normalizePlanObject(plan);
  const step = plan.steps[stepIdx];
  if (!step) return;
  step.status = 'pending';
  step.error = '';
  step.verificationResult = null;
  step.verificationRuns = [];
  step.toolCalls = [];
  plan.status = 'error';
  saveData();
  renderMessages();
  await approveAndExecutePlan(msgIdx);
}

function skipPlanStep(msgIdx, stepIdx) {
  const c = currentChat();
  if (!c || !c.messages[msgIdx] || !c.messages[msgIdx].plan) return;
  const plan = c.messages[msgIdx].plan;
  normalizePlanObject(plan);
  const step = plan.steps[stepIdx];
  if (!step) return;
  if (!confirm(`跳过步骤「${step.title}」？`)) return;
  step.status = 'skipped';
  step.error = '';
  step.result = step.result || '（用户标记为跳过）';
  step.endedAt = Date.now();
  plan._executionResults = rebuildPlanExecutionResults(plan);
  if (plan.status === 'completed') plan.status = 'paused';
  saveData();
  renderMessages();
  toast('已跳过该步骤');
}

function markPlanStepDone(msgIdx, stepIdx) {
  const c = currentChat();
  if (!c || !c.messages[msgIdx] || !c.messages[msgIdx].plan) return;
  const plan = c.messages[msgIdx].plan;
  normalizePlanObject(plan);
  const step = plan.steps[stepIdx];
  if (!step) return;
  if (!confirm(`将步骤「${step.title}」标记为已完成？`)) return;
  step.status = 'done';
  step.error = '';
  step.result = step.result || '（用户手动标记完成）';
  step.endedAt = Date.now();
  plan._executionResults = rebuildPlanExecutionResults(plan);
  if (plan.status === 'completed') plan.status = 'paused';
  saveData();
  renderMessages();
  toast('已标记完成');
}

async function continuePlanImprovement(msgIdx) {
  const c = currentChat();
  if (!c || !c.messages[msgIdx] || !c.messages[msgIdx].plan) return;
  if ((typeof isChatGenerating === 'function') ? isChatGenerating(c.id) : state.isGenerating) { toast('请等此对话当前任务完成'); return; }
  const plan = c.messages[msgIdx].plan;
  normalizePlanObject(plan);
  const latest = latestPlanFinalVerification(plan);
  if (!latest || latest.passed) {
    toast('当前没有需要执行的改进建议');
    return;
  }
  const maxVerifyRounds = Math.max(1, parseInt(state.settings.planVerifyRounds) || 1);
  if ((plan.finalVerificationTurns || []).length >= maxVerifyRounds) {
    toast('已达到最终验证轮数上限，不能继续追加验证改进');
    return;
  }
  const imp = latest.improvement || {};
  const title = (imp.title || `第 ${latest.round} 轮验证后的改进阶段`).trim();
  const description = (imp.description || [
    latest.reason,
    (latest.issues || []).length ? `未通过原因：${latest.issues.join('；')}` : '',
    (latest.suggestions || []).length ? `改进建议：${latest.suggestions.join('；')}` : ''
  ].filter(Boolean).join('\n')).trim() || '根据最终验证意见补齐未完成内容。';
  const step = normalizePlanStep({
    id: `improve_${latest.round}_${Date.now().toString(36)}`,
    title: title.startsWith('改进') ? title : `改进阶段：${title}`,
    description,
    successCriteria: (imp.successCriteria && imp.successCriteria.length)
      ? imp.successCriteria
      : ['修复最终验证指出的未完成或不可靠之处', '更新最终结果，使其能通过下一轮验证'],
    status: 'pending',
    kind: 'improvement',
    sourceVerificationRound: latest.round
  }, plan.steps.length);
  plan.steps.push(step);
  plan.pendingImprovement = null;
  plan.status = 'paused';
  plan.stage = 'executing';
  plan.expanded = true;
  if (typeof resumeMsgTimer === 'function') resumeMsgTimer(c.messages[msgIdx]);
  else if (c.messages[msgIdx]._endTime) delete c.messages[msgIdx]._endTime;
  saveData();
  renderMessages();
  toast('已新增改进阶段，开始继续执行', 2500);
  await approveAndExecutePlan(msgIdx);
}

function acceptPlanWithFailedVerification(msgIdx) {
  const c = currentChat();
  if (!c || !c.messages[msgIdx] || !c.messages[msgIdx].plan) return;
  const aiMsg = c.messages[msgIdx];
  const plan = aiMsg.plan;
  normalizePlanObject(plan);
  const latest = latestPlanFinalVerification(plan);
  const warning = latest && !latest.passed
    ? `最终验证未通过：${latest.reason || '老师认为结果仍需改进'}\n\n仍然接受当前结果并结束任务？`
    : '接受当前结果并结束任务？';
  if (!confirm(warning)) return;
  plan.status = 'completed';
  plan.stage = 'done';
  plan.inProgress = false;
  plan.expanded = false;
  plan.pendingImprovement = null;
  if (!aiMsg._endTime) aiMsg._endTime = Date.now();
  delete plan.progressText;
  saveData();
  renderMessages();
  toast('已接受当前结果');
  if (typeof playCompletionSound === 'function') playCompletionSound();
}

// ============ 规划辅助 ============

function parsePlanJson(raw, maxSteps, fallbackTitle, fallbackDescription) {
  try {
    let txt = String(raw || '').trim();
    txt = txt.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/, '');
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) throw new Error();
    const j = JSON.parse(m[0]);
    if (!j.steps || !Array.isArray(j.steps) || !j.steps.length) throw new Error();
    return {
      analysis: j.analysis || '',
      steps: j.steps.slice(0, maxSteps).map((s, i) => normalizePlanStep({ ...s, status: 'pending' }, i))
    };
  } catch (e) {
    return {
      analysis: '（计划解析失败，按单步执行）',
      steps: [normalizePlanStep({ title: fallbackTitle || '完成任务', description: fallbackDescription || '' }, 0)]
    };
  }
}

async function callPlannerAgentForJson(userPrompt, model, systemPrompt, planState, onUpdate, sourceLabel, options = {}) {
  const traceStep = { toolCalls: [] };
  if (planState) {
    if (!Array.isArray(planState.plannerToolCalls)) planState.plannerToolCalls = [];
    planState.plannerToolCalls.push({
      name: 'planner',
      args: { phase: sourceLabel || 'planning' },
      result: '规划阶段开始，可按需调用工具。',
      ok: true,
      _system: true
    });
    traceStep.toolCalls = planState.plannerToolCalls;
  }
  return await runMiniAgent(
    userPrompt,
    model,
    systemPrompt,
    traceStep,
    onUpdate,
    sourceLabel || '计划模式 · 规划阶段',
    options
  );
}

async function generatePlan(history, model, prompt, maxSteps, planState, onUpdate, options = {}) {
  const userQuestion = extractUserQuestion(history);
  const fullPrompt = prompt + `\n\n注意：步骤数量不超过 ${maxSteps} 个。

请严格输出 JSON（不要代码块、不要额外文字）：
{
  "analysis": "对任务的简要分析",
  "steps": [
    {
      "id": "t1",
      "title": "步骤标题",
      "description": "具体要做什么",
      "successCriteria": ["完成后应满足的可检查标准"]
    }
  ]
}

不要输出 verification、commands、测试命令或验证手段；验证由最终老师在执行完成后独立完成。`;
  const toolHint = (state.settings.useTools && state.tools.length)
    ? '当前规划阶段可以按需调用已启用工具。若需要先了解项目，请先调用目录、文件或搜索类工具，再输出最终 JSON 计划。'
    : '当前未启用工具调用。请仅基于用户问题输出计划。';
  const raw = await callPlannerAgentForJson(
    `请为以下任务生成执行计划。\n\n${toolHint}\n\n【任务】\n${userQuestion}`,
    model,
    fullPrompt,
    planState,
    onUpdate,
    '计划模式 · 规划阶段',
    options
  );
  return parsePlanJson(raw, maxSteps, '完成任务', userQuestion);
}

async function revisePlanWithFeedback(userQuestion, plan, review, model, plannerPrompt, maxSteps, planState, onUpdate, options = {}) {
  const planJson = JSON.stringify({ analysis: plan.analysis, steps: planStepsForPrompt(plan) }, null, 2);
  const reviewJson = JSON.stringify(review || {}, null, 2);
  const systemPrompt = plannerPrompt + `\n\n你现在是规划者，需要根据评审意见自主修改计划。
严格输出 JSON（不要代码块、不要额外文字）：
{
  "analysis": "修改后的任务分析",
  "steps": [
    {
      "id": "t1",
      "title": "步骤标题",
      "description": "具体要做什么",
      "successCriteria": ["完成后应满足的可检查标准"]
    }
  ]
}

要求：保留合理步骤，修复评审指出的问题；不要只复述意见。步骤数量不超过 ${maxSteps} 个。不要输出验证命令或验证手段。`;
  const toolHint = (state.settings.useTools && state.tools.length)
    ? '如评审意见需要更多项目信息，你可以先调用工具查看目录、文件或搜索内容，再输出最终 JSON。'
    : '当前未启用工具调用，请只基于已有计划和评审意见修改。';
  const raw = await callPlannerAgentForJson(
    `【原始任务】\n${userQuestion}\n\n【当前计划】\n${planJson}\n\n【老师评审意见】\n${reviewJson}\n\n${toolHint}\n\n请输出修改后的完整计划 JSON。`,
    model,
    systemPrompt,
    planState,
    onUpdate,
    '计划模式 · 根据评审修订',
    options
  );
  return parsePlanJson(raw, maxSteps, '完成任务', userQuestion);
}

async function reviewPlan(userQuestion, plan, model, options = {}) {
  const planJson = JSON.stringify({ analysis: plan.analysis, steps: planStepsForPrompt(plan) }, null, 2);
  const msgs = [{
    role: 'user',
    content: `【原始任务】\n${userQuestion}\n\n【待评审计划】\n${planJson}\n\n请按 JSON 格式输出评审结果。`
  }];
  const raw = await callOnceWithRole(msgs, model, PLAN_REVIEWER_PROMPT, {
    ...options,
    sourceLabel: '计划模式 · 老师评审计划'
  });
  try {
    let txt = raw.trim();
    txt = txt.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/, '');
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) throw new Error();
    const j = JSON.parse(m[0]);
    return {
      score: typeof j.score === 'number' ? j.score : 7,
      satisfied: !!j.satisfied,
      issues: Array.isArray(j.issues) ? j.issues : [],
      suggestions: Array.isArray(j.suggestions) ? j.suggestions : [],
      revised_steps: Array.isArray(j.revised_steps) && j.revised_steps.length
        ? j.revised_steps.map((s, i) => normalizePlanStep({ ...s, status: 'pending' }, i))
        : null
    };
  } catch (e) {
    return { score: 8, satisfied: true, issues: [], suggestions: [], revised_steps: null };
  }
}

function buildPlanVerifierSnapshot(plan, finalAnswer) {
  let txt = `【执行方案分析】\n${plan.analysis || '（无）'}\n\n【步骤与执行结果】\n`;
  (plan.steps || []).forEach((s, i) => {
    const criteria = (s.successCriteria || []).length
      ? s.successCriteria.map(x => `- ${x}`).join('\n')
      : '（无）';
    txt += `\n## ${i + 1}. ${s.title}\n`;
    txt += `类型：${s.kind === 'improvement' ? '改进阶段' : '原计划步骤'}\n`;
    txt += `状态：${planStepLabel(s.status)}\n`;
    txt += `做法：${s.description || '（无）'}\n`;
    txt += `完成标准：\n${criteria}\n`;
    txt += `执行结果：\n${s.result || s.error || '（无结果）'}\n`;
  });
  txt += `\n【最终整合回答】\n${finalAnswer || '（无）'}\n`;
  return txt;
}

function parseFinalVerificationJson(raw, round, toolCalls) {
  const fallback = {
    round,
    passed: false,
    score: 0,
    reason: '验证老师未返回可解析的 JSON，无法确认任务已经完成。',
    issues: ['验证结果格式不可解析'],
    suggestions: ['请追加改进阶段，让执行者补充可验证的结果说明。'],
    improvement: {
      title: '补充可验证结果',
      description: '根据原始任务和已有执行结果，补充缺失内容并给出更清晰、可核验的最终结果。',
      successCriteria: ['最终结果能直接对应原始任务要求', '关键结论、文件或操作结果有明确说明']
    },
    toolCalls: toolCalls || [],
    raw: String(raw || ''),
    ts: Date.now()
  };
  try {
    let txt = String(raw || '').trim();
    txt = txt.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/, '');
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('missing json');
    const j = JSON.parse(m[0]);
    const score = typeof j.score === 'number' ? j.score : 0;
    const explicitPassed = typeof j.passed === 'boolean'
      ? j.passed
      : (typeof j.satisfied === 'boolean' ? j.satisfied : null);
    const passed = explicitPassed !== null ? explicitPassed : score >= 8;
    const improvementRaw = j.improvement && typeof j.improvement === 'object' ? j.improvement : {};
    const suggestions = Array.isArray(j.suggestions) ? j.suggestions : [];
    const issues = Array.isArray(j.issues) ? j.issues : [];
    const improvementString = typeof j.improvement === 'string' ? j.improvement : '';
    const howToImprove = typeof j.how_to_improve === 'string' ? j.how_to_improve : '';
    const improvementText = improvementRaw.description
      || improvementString
      || howToImprove
      || suggestions.join('；')
      || issues.join('；')
      || '根据验证意见补齐未完成内容。';
    return normalizePlanFinalVerificationTurn({
      round,
      passed,
      score,
      reason: j.reason || (passed ? '验证通过。' : '验证未通过。'),
      issues,
      suggestions,
      improvement: {
        title: improvementRaw.title || (passed ? '' : '根据验证意见改进结果'),
        description: passed ? '' : improvementText,
        successCriteria: Array.isArray(improvementRaw.successCriteria)
          ? improvementRaw.successCriteria
          : (Array.isArray(improvementRaw.success_criteria) ? improvementRaw.success_criteria : [])
      },
      toolCalls: toolCalls || [],
      raw: String(raw || ''),
      ts: Date.now()
    }, round - 1);
  } catch (e) {
    return fallback;
  }
}

async function verifyFinalPlanResult(userQuestion, plan, finalAnswer, model, round, onUpdate, options = {}) {
  const traceStep = { toolCalls: [] };
  const snapshot = buildPlanVerifierSnapshot(plan, finalAnswer);
  const ctx = `【原始任务】\n${userQuestion}\n\n${snapshot}\n\n` +
    `你现在需要验证最终结果是否已经完成原始任务。你看不到执行者的工具调用过程，只能基于上面的执行方案和结果判断；如需进一步核验，可以调用可用工具。\n` +
    `请在必要的工具调用结束后，严格输出最终验证 JSON。`;
  const raw = await runMiniAgent(
    ctx,
    model,
    PLAN_RESULT_VERIFIER_PROMPT,
    traceStep,
    onUpdate,
    `计划模式 · 最终验证第 ${round} 轮`,
    options
  );
  return parseFinalVerificationJson(raw, round, traceStep.toolCalls);
}

// ⭐ 执行单步：带工具循环（mini Agent）
async function executeStepWithTools(userQuestion, plan, stepIdx, prevResults, model, executorPrompt, options = {}) {
  const step = plan.steps[stepIdx];
  // ⭐ 每次开始执行此步骤前清空该步骤的工具调用日志（避免上次中断的残留）
  step.toolCalls = [];
  
  let ctx = `【整体任务】\n${userQuestion}\n\n【完整计划】\n`;
  plan.steps.forEach((s, i) => {
    const marker = i === stepIdx ? '[当前]' : `[${planStepLabel(s.status)}]`;
    ctx += `${i + 1}. ${marker} ${s.title}：${s.description}\n`;
  });
  
  if (prevResults.length) {
    ctx += '\n【前面步骤的执行结果】\n';
    prevResults.forEach((r, i) => {
      const t = r.result.length > 2000 ? r.result.slice(0, 2000) + '\n...(已截断)' : r.result;
      ctx += `\n--- 步骤 ${i + 1}: ${r.title} ---\n${t}\n`;
    });
  }
  
  const criteria = (step.successCriteria || []).length
    ? step.successCriteria.map(x => `- ${x}`).join('\n')
    : '（未配置，按步骤描述判断）';
  const retryHint = step.error
    ? `\n【上次失败信息】\n${step.error}\n\n`
    : '';

  ctx += `\n【当前需要执行的步骤】\n第 ${stepIdx + 1} 步：${step.title}\n${step.description}\n\n` +
         `【成功标准】\n${criteria}\n\n` +
         retryHint +
         `请使用可用的工具真正完成这一步骤。如果需要调用工具，请直接调用；不需要工具则直接回答。\n` +
         `完成后简洁汇报本步骤的结果、满足了哪些成功标准，以及仍需注意的问题。`;
  
  // ⭐ 把 step 传进去，runMiniAgent 实时写入 step.toolCalls
  // ⭐ 同时传入 onUpdate 回调，触发"只更新当前 plan 面板"的局部渲染
  const c = options.chat
    || (options.chatId && typeof chatById === 'function' ? chatById(options.chatId) : null)
    || (typeof activeTaskChat === 'function' ? activeTaskChat() : currentChat());
  const msgIdx = typeof options.msgIdx === 'number'
    ? options.msgIdx
    : (c ? c.messages.findIndex(m => m.plan === plan) : -1);
  const onUpdate = () => {
    if (msgIdx >= 0) updatePlanPanel(msgIdx, c);
  };
  return await runMiniAgent(ctx, model, executorPrompt, step, onUpdate, '计划模式 · 执行步骤', options);
}

// ⭐ Mini Agent：单步骤的工具循环（独立于主对话）
async function runMiniAgent(userPrompt, model, systemPrompt, step, onUpdate, sourceLabel = '计划模式 · 执行步骤', options = {}) {
  const s = state.settings;
  const tools = buildToolsArray();
  const effectiveSystemPrompt = typeof withActiveSkillPrompt === 'function'
    ? withActiveSkillPrompt(systemPrompt || '')
    : (systemPrompt || '');
  // ⭐ 读用户设置，与主对话共用同一个上限
  const cfgRounds = parseInt(s.maxToolRounds);
  const MAX_LOOPS = (isNaN(cfgRounds) || cfgRounds < 1) ? 15 : cfgRounds;
  
  // ⭐ 优先使用任务级 signal；旧路径才回退到全局 abortCtrl。
  const abortSignal = options.signal || (state.abortCtrl ? state.abortCtrl.signal : null);
  const isStopped = typeof options.isStopped === 'function' ? options.isStopped : () => !!state.stopRequested;
  const isAborted = () => (abortSignal && abortSignal.aborted) || isStopped();
  const throwIfAborted = () => {
    if (isAborted()) {
      const err = new Error('用户中断');
      err.name = 'AbortError';
      throw err;
    }
  };
  
  let conversationMessages = [];
  let collectedTexts = [];
  let toolLogs = [];
  
  for (let loop = 0; loop < MAX_LOOPS; loop++) {
    // ⭐ 循环开始前主动检查中止信号
    throwIfAborted();
    if (typeof ensureContextBeforeAgentRun === 'function') {
      const guardChat = options.chat || (options.chatId && typeof chatById === 'function' ? chatById(options.chatId) : null);
      const ok = await ensureContextBeforeAgentRun(guardChat, {
        label: '计划模式',
        extraMessages: [{ role: 'user', content: userPrompt }, ...conversationMessages],
        mutableMessages: conversationMessages
      });
      if (!ok) throw new Error('自动压缩失败，已停止计划步骤请求');
    }
    
    let body;
    if (s.apiFormat === 'anthropic') {
      const anthMsgs = [{ role: 'user', content: userPrompt }];
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
          anthMsgs.push({ role: 'assistant', content: parts });
        } else if (m.role === 'tool') {
          const part = {
            type: 'tool_result',
            tool_use_id: m.tool_call_id,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
          };
          const last = anthMsgs[anthMsgs.length - 1];
          if (last && last.role === 'user' && Array.isArray(last.content)) {
            last.content.push(part);
          } else {
            anthMsgs.push({ role: 'user', content: [part] });
          }
        }
      }
      
      body = {
        model, messages: anthMsgs,
        max_tokens: parseInt(s.maxTokens),
        temperature: parseFloat(s.temperature),
        stream: false,
        system: effectiveSystemPrompt
      };
      if (tools) body.tools = tools;
    } else {
      const oaiMsgs = [
        { role: 'system', content: effectiveSystemPrompt },
        { role: 'user', content: userPrompt },
        ...conversationMessages
      ];
      body = {
        model, messages: oaiMsgs,
        temperature: parseFloat(s.temperature),
        max_tokens: parseInt(s.maxTokens),
        stream: false
      };
      if (tools) body.tools = tools;
    }
    
    // 应用频率限制（超限自动等待，等待期间可被 abortCtrl 中断）
    if (typeof applyRateLimit === 'function') {
      await applyRateLimit(abortSignal);
    }
    
    const url = buildFullUrl(s.baseUrl, s.apiPath);
    // ⭐ 用带超时的 fetch（api-core.js 中定义），防止网络层卡死时无法 abort
    const resp = await (typeof _apiFetchWithTimeout === 'function'
      ? _apiFetchWithTimeout(url, {
          method: 'POST',
          headers: buildHeaders(),
          body: JSON.stringify(body)
        }, abortSignal, 5 * 60 * 1000)
      : fetch(url, {
          method: 'POST',
          headers: buildHeaders(),
          body: JSON.stringify(body),
          signal: abortSignal || undefined
        })
    );
    
    if (typeof recordRequest === 'function') {
      recordRequest();
    }
    
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${t.slice(0, 300)}`);
    }
    
    const _rawText = await resp.text();
    let j;
    try { j = JSON.parse(_rawText); } catch (e) { throw new Error('JSON 解析失败：' + _rawText.slice(0, 300)); }
    if (j.error) throw new Error(`API 错误：${j.error.message || JSON.stringify(j.error)}`);
    
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
        _source: sourceLabel
      });
    }
    
    // ⭐ 把计划模式执行步骤的 usage 计入当前对话统计
    if (j.usage && typeof recordUsageFromResponse === 'function') {
      const _c = options.chat
        || (options.chatId && typeof chatById === 'function' ? chatById(options.chatId) : null)
        || (typeof activeTaskChat === 'function' ? activeTaskChat() : (typeof currentChat === 'function' ? currentChat() : null));
      if (_c) recordUsageFromResponse(_c, j.usage, { model });
    }
    
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
    if (assistantMsg.content) collectedTexts.push(assistantMsg.content);
    
    // 没工具调用 → 完成
    if (!toolCalls || !toolCalls.length) break;
    
    // 执行工具
    for (const tc of toolCalls) {
      // ⭐ 每个工具执行前检查中止
      throwIfAborted();
      
      const fname = tc.function?.name || '';
      let args = {};
      try { args = JSON.parse(tc.function?.arguments || '{}'); } catch (e) {}
      
      // ⭐ 实时插入"调用中"占位卡片
      let liveEntry = null;
      if (step) {
        liveEntry = { name: fname, args: args, result: '', ok: null, _running: true };
        step.toolCalls.push(liveEntry);
        if (onUpdate) onUpdate(); else renderMessages();
      }
      
      const result = await executeTool(fname, args, {
        chatId: options.chatId,
        chat: options.chat || (options.chatId && typeof chatById === 'function' ? chatById(options.chatId) : null)
      });
      const rawContent = typeof result.value === 'string' ? result.value : JSON.stringify(result.value);
      const preparedToolResult = typeof prepareToolResultForContext === 'function'
        ? prepareToolResultForContext({
            content: rawContent,
            toolName: fname,
            toolCallId: tc.id,
            chatId: options.chatId,
            chat: options.chat || (options.chatId && typeof chatById === 'function' ? chatById(options.chatId) : null),
            status: result.ok ? 'success' : 'error',
            args
          })
        : { content: rawContent, archived: false };
      const content = preparedToolResult.content;
      
      // ⭐ 更新该卡片为完成状态
      if (liveEntry) {
        liveEntry.result = content.slice(0, 500);
        liveEntry.ok = result.ok;
        liveEntry._running = false;
        if (onUpdate) onUpdate(); else renderMessages();
        saveData();
      }
      
      conversationMessages.push({
        role: 'tool',
        tool_call_id: tc.id,
        name: fname,
        content: content,
        status: result.ok ? 'success' : 'error',
        _artifactId: preparedToolResult.artifactId,
        _artifactMeta: preparedToolResult.artifactMeta
      });
      toolLogs.push({
        name: fname,
        args: args,
        result: content.slice(0, 500),
        ok: result.ok
      });
    }
  }
  
  // ⭐ 汇总：只把"文本输出"留作 step.result（工具调用已经实时显示在 step.toolCalls 里，不再重复）
  const summary = collectedTexts.join('\n\n').trim();
  return summary || '(本步骤无文本输出)';
}

async function synthesizeResults(userQuestion, plan, stepResults, model, options = {}) {
  let summary = `【原始任务】\n${userQuestion}\n\n【执行计划】\n${plan.analysis}\n\n【各步骤结果】\n`;
  (plan.steps || []).forEach((s, i) => {
    summary += `\n## 步骤 ${i + 1}：${s.title}\n状态：${planStepLabel(s.status)}\n${s.result || s.error || ''}\n`;
  });
  summary += `\n请基于上面所有结果，整合成一个连贯、完整、流畅的最终答案。要求：1.不要简单堆砌 2.保留所有重要信息 3.结构清晰用 Markdown 4.直接输出最终答案。`;
  return await callOnceWithRole(
    [{ role: 'user', content: summary }],
    model,
    '你是擅长归纳整合的专家。请把多个片段融合成连贯的整体答案。',
    {
      ...options,
      sourceLabel: '计划模式 · 整合结果'
    }
  );
}

