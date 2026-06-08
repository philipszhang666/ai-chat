// ============ 师生讨论模式（支持工具调用）============
// 【架构】
// - 学生：runAgentLoop 多轮工具调用 → 自己决定何时给最终答案
// - 老师：runAgentLoop 多轮工具验证 → 输出 JSON 评分
// - 老师只看学生最终答案，不看学生过程
// - 工具历史不进入主对话 c.messages，只存 reflection.turns

async function callAPIWithReflection(options = {}) {
  const requestedChatId = options && options.chatId;
  const c = requestedChatId ? chatById(requestedChatId) : currentChat();
  const s = state.settings;
  const taskChatId = c && c.id;
  const renderIfVisible = () => { if (!taskChatId || isCurrentChat(taskChatId)) renderMessages(); };
  const taskUseTools = options.useTools !== undefined ? !!options.useTools : !!s.useTools;
  const suppressCompletionSound = !!options.suppressCompletionSound;
  // ⭐ 创建 abortCtrl，让用户按"停止"按钮能中断学生答 / 老师评的任意一轮
  const abortCtrl = new AbortController();
  const task = (typeof beginChatTask === 'function')
    ? beginChatTask(taskChatId, abortCtrl, { resetStop: true })
    : null;
  if (task && typeof setChatTaskMode === 'function') {
    setChatTaskMode(taskChatId, 'reflection');
    if (typeof updateChatTaskController === 'function') updateChatTaskController(taskChatId, abortCtrl);
  } else if (!task) {
    state.isGenerating = true;
    state.activeTaskChatId = taskChatId || null;
    state.abortCtrl = abortCtrl;
  }
  // ⭐ 清零软停止标志：新任务开始
  state.stopRequested = false;
  updateSendBtn();
  if (typeof renderChatList === 'function') renderChatList();
  
  const aiMsg = {
    role: 'assistant',
    content: '',
    _startTime: Date.now(),
    reflection: {
      turns: [],
      finalScore: null,
      expanded: false,
      inProgress: true,
      progressText: '🎭 准备...'
    }
  };
  c.messages.push(aiMsg);
  renderIfVisible();
  
  const historyForUse = c.messages.slice(0, -1);
  const studentModel = s.refStudentModel.trim() || s.currentModel;
  const teacherModel = s.refTeacherModel.trim() || s.currentModel;
  const userQuestion = extractUserQuestion(historyForUse);
  
  // 工具调用开关与上限（向后兼容旧设置）
  const studentUseTools = s.refStudentUseTools !== false;     // 默认 true
  const teacherUseTools = s.refTeacherUseTools !== false;     // 默认 true
  const studentMaxRounds = parseInt(s.refStudentMaxToolRounds) || 15;
  const teacherMaxRounds = parseInt(s.refTeacherMaxToolRounds) || 5;
  
  const signal = abortCtrl.signal;
  const isStopped = () => task ? !!task.stopRequested : !!state.stopRequested;
  
  try {
    let currentAnswer = '';
    let teacherFeedback = null;
    
    for (let round = 1; round <= s.refRounds; round++) {
      // ===== 1. 学生回答（支持多轮工具调用 + 流式）=====
      aiMsg.reflection.progressText = `🎓 学生${round === 1 ? '思考' : '改进'}中（第 ${round} 轮）...`;
      
      // 构造学生的初始 messages（不含主对话里的 assistant/tool 历史，避免污染）
      // 仅保留 user 类的"原始问题"，加上前一轮的 refine 请求
      let studentInitial;
      if (round === 1) {
        // 把主对话的 user 消息当作输入（去掉所有 assistant/tool）
        studentInitial = historyForUse
          .filter(m => m.role === 'user')
          .map(m => ({ role: 'user', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content), attachments: m.attachments }));
        if (studentInitial.length === 0) {
          studentInitial = [{ role: 'user', content: userQuestion }];
        }
      } else {
        studentInitial = [
          { role: 'user', content: userQuestion },
          { role: 'assistant', content: currentAnswer },
          { role: 'user', content: buildRefineRequest(teacherFeedback) }
        ];
      }
      
      // 创建本轮学生 turn
      const studentTurn = {
        role: 'student',
        round,
        content: '',
        toolCalls: [],
        _running: true
      };
      aiMsg.reflection.turns.push(studentTurn);
      refreshReflectionLive(aiMsg, true, c);
      
      const studentSystemPrompt = s.refStudentPrompt + (studentUseTools ? STUDENT_TOOL_SUFFIX : '');
      
      const studentResult = await runAgentLoop({
        initialMessages: studentInitial,
        systemPrompt: studentSystemPrompt,
        model: studentModel,
        maxRounds: studentMaxRounds,
        signal,
        isStopped,
        chat: c,
        chatId: taskChatId,
        stream: true,
        useTools: studentUseTools && taskUseTools && state.tools.length > 0,
        onProgress: (ev) => onStudentProgress(ev, studentTurn, aiMsg, c)
      });
      
      currentAnswer = studentResult.finalText;
      studentTurn.content = currentAnswer;
      studentTurn._running = false;
      refreshReflectionLive(aiMsg, true, c);
      
      // ===== 2. 老师评审（只看最终答案，可调工具验证）=====
      aiMsg.reflection.progressText = `👨‍🏫 老师评审中（第 ${round} 轮）...`;
      
      const teacherInitial = [{
        role: 'user',
        content: `【原始问题】\n${userQuestion}\n\n【学生的最终答案】\n${currentAnswer}\n\n${teacherUseTools ? '你可以使用工具去独立验证学生的答案（例如读取学生提到的文件、执行命令等）。验证完成后，请按 JSON 格式输出评审结果。' : '请按 JSON 格式输出评审结果。'}`
      }];
      
      const teacherTurn = {
        role: 'teacher',
        round,
        score: null,
        issues: [],
        suggestions: [],
        satisfied: false,
        toolCalls: [],
        _running: true
      };
      aiMsg.reflection.turns.push(teacherTurn);
      refreshReflectionLive(aiMsg, true, c);
      
      const teacherSystemPrompt = s.refTeacherPrompt + (teacherUseTools ? TEACHER_TOOL_SUFFIX : '');
      
      const teacherResult = await runAgentLoop({
        initialMessages: teacherInitial,
        systemPrompt: teacherSystemPrompt,
        model: teacherModel,
        maxRounds: teacherMaxRounds,
        signal,
        isStopped,
        chat: c,
        chatId: taskChatId,
        stream: true,
        useTools: teacherUseTools && taskUseTools && state.tools.length > 0,
        onProgress: (ev) => onTeacherProgress(ev, teacherTurn, aiMsg, c)
      });
      
      const critique = parseCritique(teacherResult.finalText);
      Object.assign(teacherTurn, {
        score: critique.score,
        issues: critique.issues,
        suggestions: critique.suggestions,
        satisfied: critique.satisfied,
        _running: false
      });
      aiMsg.reflection.finalScore = critique.score;
      refreshReflectionLive(aiMsg, true, c);
      
      teacherFeedback = critique;
      
      // ===== 3. 终止条件 =====
      if (critique.score >= s.refMinScore) {
        aiMsg.reflection.progressText = `✅ 已达目标分 ${critique.score}/${s.refMinScore}`;
        break;
      }
      if (round === s.refRounds) {
        aiMsg.reflection.progressText = `⏱ 已达最大轮数`;
        break;
      }
    }
    
    aiMsg.content = currentAnswer;
    aiMsg.reflection.inProgress = false;
    // ⭐ 完成后自动折叠面板（用户看主要的"最终答案"，过程藏起来）
    aiMsg.reflection.expanded = false;
    if (!aiMsg._endTime) aiMsg._endTime = Date.now();
    delete aiMsg.reflection.progressText;
    // ⭐ 完成时做一次完整的局部刷新（重渲染整个消息节点，让最终答案 + 折叠态都生效）
    if (c) {
      const finalIdx = c.messages.indexOf(aiMsg);
      if (finalIdx >= 0 && typeof refreshMsgNode === 'function') refreshMsgNode(finalIdx, c);
      else renderIfVisible();
    }
    saveData();
    if (!suppressCompletionSound && typeof playCompletionSound === 'function') playCompletionSound();
  } catch (e) {
    if (e.name === 'AbortError') aiMsg.content = (aiMsg.content || '') + '\n\n*[已停止]*';
    else aiMsg.content = `❌ 师生模式出错：${e.message}`;
    // 把"运行中"的 turn 都标记为已结束（视觉上别一直转圈）
    if (aiMsg.reflection && aiMsg.reflection.turns) {
      for (const t of aiMsg.reflection.turns) {
        if (t._running) t._running = false;
        if (t.toolCalls) {
          for (const tc of t.toolCalls) if (tc._running) tc._running = false;
        }
      }
    }
    aiMsg.reflection.inProgress = false;
    aiMsg.reflection.expanded = false;
    if (!aiMsg._endTime) aiMsg._endTime = Date.now();
    delete aiMsg.reflection.progressText;
    if (c) {
      const errIdx = c.messages.indexOf(aiMsg);
      if (errIdx >= 0 && typeof refreshMsgNode === 'function') refreshMsgNode(errIdx, c);
      else renderIfVisible();
    }
    saveData();
  } finally {
    if (typeof clearChatTask === 'function') clearChatTask(taskChatId);
    else {
      state.isGenerating = false;
      state.abortCtrl = null;
      if (state.activeTaskChatId === taskChatId) state.activeTaskChatId = null;
    }
    updateSendBtn();
    if (typeof renderChatList === 'function') renderChatList();
  }
}

// 学生进度回调：把 runAgentLoop 的事件投影到 studentTurn
// ⭐ 所有事件都走 refreshReflectionLive（局部刷新），不调全量 renderMessages，避免闪烁
function onStudentProgress(ev, turn, aiMsg, targetChat) {
  if (ev.type === 'text_delta') {
    turn.content = (turn.content || '') + ev.text;
    refreshReflectionLive(aiMsg, false, targetChat);
  } else if (ev.type === 'tool_call') {
    turn.toolCalls.push({
      id: ev.id, name: ev.name, args: ev.args,
      result: '', ok: null, _running: true
    });
    refreshReflectionLive(aiMsg, true, targetChat);  // 工具卡片增减立刻刷
  } else if (ev.type === 'tool_result') {
    const card = turn.toolCalls.find(tc => tc.id === ev.id && tc._running);
    if (card) {
      card.result = (ev.content || '').slice(0, 1000);
      card.ok = ev.ok;
      card._running = false;
    }
    refreshReflectionLive(aiMsg, true, targetChat);
  } else if (ev.type === 'round_start') {
    if (turn._nextRoundClearText) {
      turn.content = '';
      turn._nextRoundClearText = false;
      refreshReflectionLive(aiMsg, false, targetChat);
    }
  } else if (ev.type === 'round_end') {
    if (ev.hasToolCalls) turn._nextRoundClearText = true;
  }
}

// 老师进度回调：同上
function onTeacherProgress(ev, turn, aiMsg, targetChat) {
  if (ev.type === 'text_delta') {
    turn._streamingText = (turn._streamingText || '') + ev.text;
    refreshReflectionLive(aiMsg, false, targetChat);
  } else if (ev.type === 'tool_call') {
    turn.toolCalls.push({
      id: ev.id, name: ev.name, args: ev.args,
      result: '', ok: null, _running: true
    });
    refreshReflectionLive(aiMsg, true, targetChat);
  } else if (ev.type === 'tool_result') {
    const card = turn.toolCalls.find(tc => tc.id === ev.id && tc._running);
    if (card) {
      card.result = (ev.content || '').slice(0, 1000);
      card.ok = ev.ok;
      card._running = false;
    }
    refreshReflectionLive(aiMsg, true, targetChat);
  } else if (ev.type === 'round_start') {
    if (turn._nextRoundClearText) {
      turn._streamingText = '';
      turn._nextRoundClearText = false;
      refreshReflectionLive(aiMsg, false, targetChat);
    }
  } else if (ev.type === 'round_end') {
    if (ev.hasToolCalls) turn._nextRoundClearText = true;
  }
}

// 增量刷新 reflection 面板（用于流式文本 / 工具卡片变化）
// ⭐ 只替换 .reflection-body 的内部 HTML，不动外层节点，不动其它消息
// immediate=true 时绕过节流（用于工具卡片增删，确保不丢事件）
function refreshReflectionLive(aiMsg, immediate, targetChat) {
  const c = targetChat || currentChat();
  if (!c || (targetChat && !isCurrentChat(targetChat))) return;
  const idx = c.messages.indexOf(aiMsg);
  if (idx < 0) return;
  
  const doUpdate = () => {
    refreshReflectionLive._t = null;
    if (!isCurrentChat(c)) return;
    const panel = document.querySelector(`.reflection-panel[data-msg-idx="${idx}"]`);
    if (!panel) {
      // 面板还没创建（首次出现）：局部刷新这一条消息
      if (typeof refreshMsgNode === 'function') refreshMsgNode(idx, c);
      return;
    }
    const ref = aiMsg.reflection || {};
    // 1) 更新轮次内容（body 内部）
    const body = panel.querySelector('.reflection-body');
    if (body) {
      const turnsHtml = (ref.turns || []).map(renderReflectionTurn).join('');
      const progressHtml = ref.inProgress
        ? `<div class="ref-progress"><span class="ref-spinner"></span><span>${escapeHtml(ref.progressText || '思考中...')}</span></div>`
        : '';
      body.innerHTML = turnsHtml + progressHtml;
    }
    // 2) 更新顶部统计（轮数 / 评分）
    const stats = panel.querySelector('.reflection-stats');
    if (stats) {
      const studentCount = (ref.turns || []).filter(t => t.role === 'student').length;
      stats.textContent = `${studentCount} 轮 · 最终评分 ${ref.finalScore ?? '?'}/10`;
    }
  };
  
  if (immediate) {
    if (refreshReflectionLive._t) {
      clearTimeout(refreshReflectionLive._t);
      refreshReflectionLive._t = null;
    }
    doUpdate();
    return;
  }
  
  // 节流：100ms 内最多一次（流式文本用）
  if (refreshReflectionLive._t) return;
  refreshReflectionLive._t = setTimeout(doUpdate, 100);
}

// ============ Prompt 后缀 ============
// 学生 / 老师在工具模式下，给系统提示追加的说明
const STUDENT_TOOL_SUFFIX = `

【工具使用说明】
- 你可以多次调用工具来完成任务（如读取文件、运行命令、搜索资料等）
- 完成所有必要的工作后，**输出你的最终答案**（不要再调用工具）
- 你给出的"不带工具调用的纯文本"会被视为最终答案，提交给老师评判
- 不要在中途询问用户，直接基于已有信息和工具调用结果完成任务`;

const TEACHER_TOOL_SUFFIX = `

【评审工具使用说明】
- 你可以独立调用工具去验证学生的答案是否正确（如读取学生提到的文件、运行测试、检查事实等）
- 验证完成后，**只输出 JSON 格式的评审结果**（不要再调用工具，不要代码块，不要额外文字）
- JSON 必须包含字段：score(0-10数字), issues(数组), suggestions(数组), satisfied(布尔)
- 例如：{"score": 8, "issues": ["..."], "suggestions": ["..."], "satisfied": false}`;

// ============ 辅助函数 ============

function buildRefineRequest(c) {
  const issues = (c.issues || []).map((x, i) => `${i + 1}. ${x}`).join('\n') || '（无）';
  const suggestions = (c.suggestions || []).map((x, i) => `${i + 1}. ${x}`).join('\n') || '（无）';
  return `老师评分 ${c.score}/10。\n\n【问题】\n${issues}\n\n【建议】\n${suggestions}\n\n请根据反馈重新完成任务并给出更好的回答。`;
}

function parseCritique(raw) {
  try {
    let txt = (raw || '').trim();
    txt = txt.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/, '');
    const m = txt.match(/\{[\s\S]*\}/);
    if (m) {
      const j = JSON.parse(m[0]);
      return {
        score: typeof j.score === 'number' ? j.score : parseInt(j.score) || 5,
        issues: Array.isArray(j.issues) ? j.issues : [],
        suggestions: Array.isArray(j.suggestions) ? j.suggestions : [],
        satisfied: !!j.satisfied
      };
    }
  } catch (e) {}
  return { score: 6, issues: ['解析失败：' + (raw || '').slice(0, 100)], suggestions: [], satisfied: false };
}

// ============ 渲染师生讨论面板 ============

// 渲染工具调用卡片列表（学生 / 老师共用）
function renderRefToolCalls(toolCalls) {
  if (!toolCalls || !toolCalls.length) return '';
  const cards = toolCalls.map(tc => {
    const stateClass = tc._running ? 'running' : (tc.ok ? 'success' : 'error');
    const icon = tc._running ? '<span class="plan-tool-spin"></span>' : (tc.ok ? '✓' : '✗');
    const argStr = (() => {
      try { return JSON.stringify(tc.args || {}); } catch (e) { return String(tc.args); }
    })().slice(0, 120);
    const resultPreview = tc._running ? '调用中…' : escapeHtml((tc.result || '').slice(0, 300));
    return `
      <div class="plan-tool-call ${stateClass}">
        <div class="plan-tool-head">
          <span class="plan-tool-icon">${icon}</span>
          <span class="plan-tool-name">${escapeHtml(tc.name || '?')}</span>
          <span class="plan-tool-args" title="${escapeHtml(argStr)}">${escapeHtml(argStr)}</span>
        </div>
        ${tc._running ? '' : `<div class="plan-tool-result">${resultPreview}</div>`}
      </div>`;
  }).join('');
  return `<div class="ref-tool-section">
    <div class="ref-section-title">🔧 工具调用（${toolCalls.length}）</div>
    <div class="plan-tool-calls">${cards}</div>
  </div>`;
}

function renderReflectionTurn(t) {
  if (t.role === 'student') {
    const toolsHtml = renderRefToolCalls(t.toolCalls);
    const runningTag = t._running ? '<span class="ref-running-tag">⏳ 进行中…</span>' : '';
    return `
      <div class="ref-turn student">
        <div class="ref-turn-header">
          <span class="ref-avatar">学</span>
          <span>学生 · 第 ${t.round} 轮回答</span>
          ${runningTag}
        </div>
        <div class="ref-turn-body">
          ${toolsHtml}
          ${t.content ? `<div class="ref-final-answer"><div class="ref-section-title">📝 最终答案</div>${renderMarkdown(t.content || '')}</div>` : (t._running ? '<div class="ref-waiting">思考中…</div>' : '')}
        </div>
      </div>`;
  } else {
    const sc = t.score ?? 0;
    const scClass = sc >= 8 ? 'good' : sc >= 5 ? 'mid' : 'bad';
    const issues = (t.issues || []).map(x => `<li>${escapeHtml(x)}</li>`).join('');
    const suggestions = (t.suggestions || []).map(x => `<li>${escapeHtml(x)}</li>`).join('');
    const toolsHtml = renderRefToolCalls(t.toolCalls);
    const runningTag = t._running ? '<span class="ref-running-tag">⏳ 评审中…</span>' : '';
    const scoreTag = (t.score !== null && t.score !== undefined) ? `<span class="ref-score ${scClass}">评分 ${sc}/10</span>` : '';
    return `
      <div class="ref-turn teacher">
        <div class="ref-turn-header">
          <span class="ref-avatar">师</span>
          <span>老师 · 第 ${t.round} 轮评审</span>
          ${scoreTag}
          ${runningTag}
        </div>
        <div class="ref-turn-body">
          ${toolsHtml}
          ${t.satisfied ? '<div class="ref-pass">✅ 评审通过</div>' : ''}
          ${issues ? `<div class="ref-section-title">❌ 问题</div><ul class="ref-list">${issues}</ul>` : ''}
          ${suggestions ? `<div class="ref-section-title">💡 建议</div><ul class="ref-list">${suggestions}</ul>` : ''}
          ${(!issues && !suggestions && t._running) ? '<div class="ref-waiting">评审中…</div>' : ''}
        </div>
      </div>`;
  }
}

function toggleReflectionPanel(idx) {
  const c = currentChat();
  if (!c || !c.messages[idx] || !c.messages[idx].reflection) return;
  c.messages[idx].reflection.expanded = !c.messages[idx].reflection.expanded;
  const panel = document.querySelector(`.reflection-panel[data-msg-idx="${idx}"]`);
  if (panel) panel.classList.toggle('collapsed');
  saveData();
}

// ============ 设置面板 ============

function openReflectionSettings() {
  document.getElementById('reflectionModal').classList.add('show');
  const s = state.settings;
  document.getElementById('ref_enabled').checked = s.useReflection;
  document.getElementById('ref_rounds').value = s.refRounds;
  document.getElementById('refRoundsVal').textContent = s.refRounds;
  document.getElementById('ref_minScore').value = s.refMinScore;
  document.getElementById('refScoreVal').textContent = s.refMinScore;
  document.getElementById('ref_studentModel').value = s.refStudentModel;
  document.getElementById('ref_teacherModel').value = s.refTeacherModel;
  document.getElementById('ref_studentPrompt').value = s.refStudentPrompt;
  document.getElementById('ref_teacherPrompt').value = s.refTeacherPrompt;
  // 工具相关（向后兼容）
  const refStudentTools = document.getElementById('ref_studentUseTools');
  const refTeacherTools = document.getElementById('ref_teacherUseTools');
  const refStudentMaxR = document.getElementById('ref_studentMaxToolRounds');
  const refTeacherMaxR = document.getElementById('ref_teacherMaxToolRounds');
  if (refStudentTools) refStudentTools.checked = s.refStudentUseTools !== false;
  if (refTeacherTools) refTeacherTools.checked = s.refTeacherUseTools !== false;
  if (refStudentMaxR) refStudentMaxR.value = s.refStudentMaxToolRounds || 15;
  if (refTeacherMaxR) refTeacherMaxR.value = s.refTeacherMaxToolRounds || 5;
}

function closeReflectionSettings() {
  document.getElementById('reflectionModal').classList.remove('show');
}

function applyPreset(key) {
  const p = REFLECTION_PRESETS[key];
  if (!p) return;
  document.getElementById('ref_studentPrompt').value = p.student;
  document.getElementById('ref_teacherPrompt').value = p.teacher;
  toast('✓ 已应用预设');
}

function saveReflectionSettings() {
  const s = state.settings;
  s.useReflection = document.getElementById('ref_enabled').checked;
  s.refRounds = parseInt(document.getElementById('ref_rounds').value);
  s.refMinScore = parseInt(document.getElementById('ref_minScore').value);
  s.refStudentModel = document.getElementById('ref_studentModel').value.trim();
  s.refTeacherModel = document.getElementById('ref_teacherModel').value.trim();
  s.refStudentPrompt = document.getElementById('ref_studentPrompt').value;
  s.refTeacherPrompt = document.getElementById('ref_teacherPrompt').value;
  // 工具相关
  const refStudentTools = document.getElementById('ref_studentUseTools');
  const refTeacherTools = document.getElementById('ref_teacherUseTools');
  const refStudentMaxR = document.getElementById('ref_studentMaxToolRounds');
  const refTeacherMaxR = document.getElementById('ref_teacherMaxToolRounds');
  if (refStudentTools) s.refStudentUseTools = refStudentTools.checked;
  if (refTeacherTools) s.refTeacherUseTools = refTeacherTools.checked;
  if (refStudentMaxR) s.refStudentMaxToolRounds = parseInt(refStudentMaxR.value) || 15;
  if (refTeacherMaxR) s.refTeacherMaxToolRounds = parseInt(refTeacherMaxR.value) || 5;
  // 互斥：保存时若启用师生，关闭 Plan / 大纲
  if (s.useReflection) {
    s.usePlan = false;
    s.useOutline = false;
    const planBtn = document.getElementById('planBtn');
    const outlineBtn = document.getElementById('outlineBtn');
    if (planBtn) planBtn.classList.remove('plan-active');
    if (outlineBtn) outlineBtn.classList.remove('outline-active');
  }
  persistSettings();
  // 师生模式没有独立的工具栏按钮（通过"更多菜单"打开），不需要切换按钮态
  // 旧代码里访问不存在的 reflectBtn 会抛 TypeError，导致后面的 close + updateSendBtn 都不执行
  const btn = document.getElementById('reflectBtn');
  if (btn) {
    if (s.useReflection) btn.classList.add('reflect-active');
    else btn.classList.remove('reflect-active');
  }
  updateSendBtn();
  closeReflectionSettings();
  toast('✓ 已保存');
}

function toggleReflection() {
  const s = state.settings;
  s.useReflection = !s.useReflection;
  // 互斥：开启师生时关闭 Plan / 大纲
  if (s.useReflection) {
    s.usePlan = false;
    s.useOutline = false;
    const planBtn = document.getElementById('planBtn');
    const outlineBtn = document.getElementById('outlineBtn');
    if (planBtn) planBtn.classList.remove('plan-active');
    if (outlineBtn) outlineBtn.classList.remove('outline-active');
  }
  const btn = document.getElementById('reflectBtn');
  if (btn) {
    if (s.useReflection) btn.classList.add('reflect-active');
    else btn.classList.remove('reflect-active');
  }
  persistSettings();
  updateSendBtn();
  toast(s.useReflection ? '✓ 已启用师生' : '✓ 已关闭师生');
}
