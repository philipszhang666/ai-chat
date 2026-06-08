// ============ 📋 计划模式 - UI 渲染 + 设置面板 ============
// 【模块定位】DOM 渲染、设置/预设、按钮入口
// 依赖：plan-core.js、state.js、config.js（PLAN_PRESETS）、utils.js
// 加载顺序：在 plan-core.js 之后

// ============ 渲染计划面板 ============

function renderPlanToolCalls(calls) {
  if (!calls || !calls.length) return '';
  return `<div class="plan-tool-calls">${calls.map(tc => {
    const argsStr = JSON.stringify(tc.args || {});
    const argsShort = argsStr.length > 80 ? argsStr.slice(0, 80) + '…' : argsStr;
    let statusIcon, statusClass;
    if (tc._running) { statusIcon = '<span class="plan-tool-spin"></span>'; statusClass = 'running'; }
    else if (tc.ok === false) { statusIcon = '❌'; statusClass = 'error'; }
    else { statusIcon = '✅'; statusClass = 'success'; }
    return `
      <div class="plan-tool-call ${statusClass}">
        <div class="plan-tool-head">
          <span class="plan-tool-icon">${statusIcon}</span>
          <span class="plan-tool-name">🔧 ${escapeHtml(tc.name)}</span>
          <span class="plan-tool-args" title="${escapeHtml(argsStr)}">${escapeHtml(argsShort)}</span>
        </div>
        ${tc.result && !tc._running ? `<div class="plan-tool-result">${escapeHtml(tc.result.slice(0, 300))}${tc.result.length > 300 ? '…' : ''}</div>` : ''}
      </div>`;
  }).join('')}</div>`;
}

function renderPlanPanel(m, idx) {
  if (!m.plan) return '';
  const p = m.plan;
  if (typeof normalizePlanObject === 'function') normalizePlanObject(p);
  const totalSteps = p.steps?.length || 0;
  const doneSteps = (typeof countFinishedPlanSteps === 'function')
    ? countFinishedPlanSteps(p)
    : (p.steps || []).filter(s => s.status === 'done' || s.status === 'skipped').length;
  const progressPct = totalSteps ? Math.round(doneSteps / totalSteps * 100) : 0;
  
  let statusBadge = '';
  if (p.status === 'pending_approval') {
    statusBadge = '<span class="plan-status-badge pending">⏸ 待审批</span>';
  } else if (p.status === 'executing') {
    statusBadge = '<span class="plan-status-badge running">🔄 执行中</span>';
  } else if (p.status === 'verifying') {
    statusBadge = '<span class="plan-status-badge running">🧑‍🏫 验证中</span>';
  } else if (p.status === 'completed') {
    statusBadge = '<span class="plan-status-badge done">✅ 已完成</span>';
  } else if (p.status === 'verification_failed') {
    statusBadge = '<span class="plan-status-badge error">⚠️ 验证未通过</span>';
  } else if (p.status === 'verification_exhausted') {
    statusBadge = '<span class="plan-status-badge error">⛔ 验证结束</span>';
  } else if (p.status === 'cancelled') {
    statusBadge = '<span class="plan-status-badge cancelled">❌ 已取消</span>';
  } else if (p.status === 'paused') {
    statusBadge = '<span class="plan-status-badge paused">⏸ 已暂停</span>';
  } else if (p.status === 'error') {
    statusBadge = '<span class="plan-status-badge error">❌ 出错</span>';
  }
  
  let statsText = totalSteps + ' 步';
  if (p.planScore !== null && p.planScore !== undefined) statsText += ` · 评分 ${p.planScore}/10`;
  if (p.verifyScore !== null && p.verifyScore !== undefined) statsText += ` · 验证 ${p.verifyScore}/10`;
  if (p.status === 'executing' || p.status === 'verifying' || p.status === 'paused' || p.status === 'error' || p.status === 'verification_failed' || p.status === 'verification_exhausted') statsText += ` · ${doneSteps}/${totalSteps}`;
  
  let stepsHtml = '';
  if (p.steps?.length) {
    stepsHtml = `<ol class="plan-step-list">${(p.steps || []).map((s, si) => {
      const canEdit = p.status === 'pending_approval' || p.status === 'paused' || p.status === 'error' || p.status === 'verification_failed';
      const canStepAction = !p.inProgress && (p.status === 'paused' || p.status === 'error');
      const editBtns = canEdit ? `
        <div class="plan-step-actions">
          <button class="plan-step-edit-btn" onclick="event.stopPropagation();editPlanStep(${idx}, ${si})" title="编辑">✏️</button>
          ${canStepAction && s.status === 'failed' ? `<button class="plan-step-edit-btn" onclick="event.stopPropagation();retryPlanStep(${idx}, ${si})" title="重试">↻</button>` : ''}
          ${canStepAction && s.status !== 'done' && s.status !== 'skipped' ? `<button class="plan-step-edit-btn" onclick="event.stopPropagation();skipPlanStep(${idx}, ${si})" title="跳过">~</button>` : ''}
          ${canStepAction && s.status !== 'done' && s.status !== 'skipped' ? `<button class="plan-step-edit-btn" onclick="event.stopPropagation();markPlanStepDone(${idx}, ${si})" title="标记完成">✓</button>` : ''}
          <button class="plan-step-edit-btn" onclick="event.stopPropagation();deletePlanStep(${idx}, ${si})" title="删除">×</button>
        </div>
      ` : '';
      const statusLabel = typeof planStepLabel === 'function' ? planStepLabel(s.status) : (s.status || 'pending');
      const criteriaHtml = (s.successCriteria && s.successCriteria.length)
        ? `<div class="plan-step-meta"><div class="plan-step-meta-title">成功标准</div><ul>${s.successCriteria.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>`
        : '';
      const improvementHtml = s.kind === 'improvement'
        ? `<div class="plan-step-meta"><div class="plan-step-meta-title">改进来源</div><div class="plan-step-note">第 ${escapeHtml(String(s.sourceVerificationRound || '?'))} 轮最终验证未通过后追加</div></div>`
        : '';
      const errorHtml = s.error
        ? `<div class="plan-step-error"><strong>失败原因：</strong>${escapeHtml(s.error)}</div>`
        : '';
      
      // ⭐ 工具调用实时列表
      let toolCallsHtml = '';
      if (s.toolCalls && s.toolCalls.length) {
        toolCallsHtml = renderPlanToolCalls(s.toolCalls);
      }
      
      return `
        <li class="plan-step-item ${s.status || 'pending'}">
          <div class="plan-step-main">
            <div class="plan-step-title">
              <span>${escapeHtml(s.title)}</span>
              <span class="plan-step-status ${s.status || 'pending'}">${escapeHtml(statusLabel)}</span>
              ${s.attempts ? `<span class="plan-step-attempts">尝试 ${s.attempts}/${s.maxAttempts || 2}</span>` : ''}
            </div>
            <div class="plan-step-desc">${escapeHtml(s.description)}</div>
            ${criteriaHtml}
            ${improvementHtml}
            ${toolCallsHtml}
            ${errorHtml}
            ${s.result ? `<div class="plan-step-result"><div class="plan-step-result-label">✓ 执行结果</div><div>${renderMarkdown(s.result)}</div></div>` : ''}
          </div>
          ${editBtns}
        </li>`;
    }).join('')}</ol>`;
  }
  
  let planningHtml = '';
  if (p.analysis || p.steps?.length) {
    const plannerToolsHtml = p.plannerToolCalls && p.plannerToolCalls.length
      ? `<div class="plan-step-meta"><div class="plan-step-meta-title">规划阶段工具调用</div>${renderPlanToolCalls(p.plannerToolCalls)}</div>`
      : '';
    planningHtml = `
      <div class="plan-section planning">
        <div class="plan-section-header">📋 计划模式 ${statusBadge}</div>
        <div class="plan-section-body">
          ${p.analysis ? `<div style="margin-bottom:10px;font-size:13px;color:var(--text-secondary);"><strong>分析：</strong>${escapeHtml(p.analysis)}</div>` : ''}
          ${plannerToolsHtml}
          ${totalSteps && (p.status === 'executing' || p.status === 'verifying' || p.status === 'completed' || p.status === 'paused' || p.status === 'error' || p.status === 'verification_failed' || p.status === 'verification_exhausted') ? `<div class="plan-progress-bar"><div class="plan-progress-fill" style="width:${progressPct}%;"></div></div>` : ''}
          ${stepsHtml}
        </div>
      </div>`;
  }
  
  let reviewHtml = '';
  if (p.reviewTurns && p.reviewTurns.length) {
    reviewHtml = `
      <div class="plan-section reviewing">
        <div class="plan-section-header">🎭 计划评审</div>
        <div class="plan-section-body">
          ${p.reviewTurns.map(t => {
            const sc = t.score ?? 0;
            const scClass = sc >= 8 ? 'good' : sc >= 5 ? 'mid' : 'bad';
            return `
              <div style="padding:8px;background:var(--bg-input);border-radius:6px;margin:6px 0;font-size:13px;">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                  <strong>第 ${t.round} 轮</strong>
                  <span class="ref-score ${scClass}">评分 ${sc}/10</span>
                  ${t.satisfied ? '<span style="color:var(--success);font-size:12px;">✅</span>' : '<span style="color:var(--warning);font-size:12px;">⚠️</span>'}
                </div>
                ${(t.issues || []).length ? `<div style="font-size:12px;color:var(--text-secondary);"><strong>问题：</strong>${(t.issues || []).map(escapeHtml).join('；')}</div>` : ''}
                ${(t.suggestions || []).length ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:4px;"><strong>建议：</strong>${(t.suggestions || []).map(escapeHtml).join('；')}</div>` : ''}
                ${!t.satisfied ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">✏️ 规划者已根据本轮意见重新生成方案</div>` : ''}
              </div>`;
          }).join('')}
        </div>
      </div>`;
  }

  let finalVerificationHtml = '';
  const finalTurns = (typeof normalizePlanFinalVerification === 'function')
    ? normalizePlanFinalVerification(p)
    : (p.finalVerificationTurns || []);
  if (finalTurns && finalTurns.length) {
    finalVerificationHtml = `
      <div class="plan-section reviewing">
        <div class="plan-section-header">🧑‍🏫 最终结果验证</div>
        <div class="plan-section-body">
          ${finalTurns.map(t => {
            const sc = t.score ?? 0;
            const scClass = sc >= 8 ? 'good' : sc >= 5 ? 'mid' : 'bad';
            const toolsHtml = t.toolCalls && t.toolCalls.length
              ? `<div class="plan-step-meta"><div class="plan-step-meta-title">验证老师工具调用</div>${renderPlanToolCalls(t.toolCalls)}</div>`
              : '';
            const improvement = t.improvement || {};
            return `
              <div style="padding:8px;background:var(--bg-input);border-radius:6px;margin:6px 0;font-size:13px;">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                  <strong>第 ${t.round} 轮</strong>
                  <span class="ref-score ${scClass}">评分 ${sc}/10</span>
                  ${t.passed ? '<span style="color:var(--success);font-size:12px;">✅ 通过</span>' : '<span style="color:var(--warning);font-size:12px;">⚠️ 未通过</span>'}
                </div>
                ${t.reason ? `<div style="font-size:12px;color:var(--text-secondary);"><strong>理由：</strong>${escapeHtml(t.reason)}</div>` : ''}
                ${(t.issues || []).length ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:4px;"><strong>问题：</strong>${(t.issues || []).map(escapeHtml).join('；')}</div>` : ''}
                ${(t.suggestions || []).length ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:4px;"><strong>建议：</strong>${(t.suggestions || []).map(escapeHtml).join('；')}</div>` : ''}
                ${!t.passed && improvement.description ? `<div class="plan-step-meta"><div class="plan-step-meta-title">建议追加的改进阶段</div><div class="plan-step-note"><strong>${escapeHtml(improvement.title || '改进阶段')}</strong><br>${escapeHtml(improvement.description)}</div>${(improvement.successCriteria || []).length ? `<ul>${improvement.successCriteria.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : ''}</div>` : ''}
                ${toolsHtml}
              </div>`;
          }).join('')}
        </div>
      </div>`;
  }
  
  let approvalHtml = '';
  if (p.status === 'pending_approval') {
    approvalHtml = `
      <div class="plan-approval">
        <div class="plan-approval-hint">⏸ 请审查上方计划，确认无误后执行：</div>
        <div class="plan-approval-btns">
          <button class="plan-btn approve" onclick="approveAndExecutePlan(${idx})">▶️ 执行计划</button>
          <button class="plan-btn regenerate" onclick="regeneratePlan(${idx})">🔄 重新规划</button>
          <button class="plan-btn cancel" onclick="cancelPlan(${idx})">❌ 取消</button>
        </div>
      </div>`;
  } else if (p.status === 'paused' || p.status === 'error') {
    approvalHtml = `
      <div class="plan-approval">
        <div class="plan-approval-hint">${p.status === 'paused' ? '⏸ 执行已暂停' : '❌ 执行中断'}，可以从未完成或失败的步骤继续：</div>
        <div class="plan-approval-btns">
          <button class="plan-btn approve" onclick="approveAndExecutePlan(${idx})">▶️ 继续执行</button>
          <button class="plan-btn cancel" onclick="cancelPlan(${idx})">❌ 放弃</button>
        </div>
      </div>`;
  } else if (p.status === 'verification_failed') {
    approvalHtml = `
      <div class="plan-approval">
        <div class="plan-approval-hint">⚠️ 最终结果验证未通过。可以根据老师建议追加一个改进阶段；原步骤不会重新执行。</div>
        <div class="plan-approval-btns">
          <button class="plan-btn approve" onclick="continuePlanImprovement(${idx})">➕ 新增改进阶段并继续</button>
          <button class="plan-btn regenerate" onclick="acceptPlanWithFailedVerification(${idx})">✓ 接受当前结果</button>
          <button class="plan-btn cancel" onclick="cancelPlan(${idx})">❌ 放弃</button>
        </div>
      </div>`;
  } else if (p.status === 'verification_exhausted') {
    approvalHtml = `
      <div class="plan-approval">
        <div class="plan-approval-hint">⛔ 最终验证未通过，且已达到验证轮数上限。可以接受当前结果或放弃。</div>
        <div class="plan-approval-btns">
          <button class="plan-btn regenerate" onclick="acceptPlanWithFailedVerification(${idx})">✓ 接受当前结果</button>
          <button class="plan-btn cancel" onclick="cancelPlan(${idx})">❌ 放弃</button>
        </div>
      </div>`;
  }
  
  const progressHtml = p.inProgress
    ? `<div class="ref-progress"><span class="ref-spinner"></span><span>${escapeHtml(p.progressText || '处理中...')}</span></div>`
    : '';
  
  return `
    <div class="plan-panel ${p.expanded ? '' : 'collapsed'}" data-msg-idx="${idx}">
      <button class="plan-toggle" onclick="togglePlanPanel(${idx})">
        <span>📋 计划模式</span>
        <span class="plan-stats">${statsText}</span>
      </button>
      <div class="plan-body">
        ${planningHtml}
        ${reviewHtml}
        ${finalVerificationHtml}
        ${approvalHtml}
        ${progressHtml}
      </div>
    </div>`;
}

function togglePlanPanel(idx) {
  const c = currentChat();
  if (!c || !c.messages[idx] || !c.messages[idx].plan) return;
  c.messages[idx].plan.expanded = !c.messages[idx].plan.expanded;
  const panel = document.querySelector(`.plan-panel[data-msg-idx="${idx}"]`);
  if (panel) panel.classList.toggle('collapsed');
  saveData();
}

function openPlanSettings() {
  document.getElementById('planModal').classList.add('show');
  const s = state.settings;
  document.getElementById('plan_enabled').checked = s.usePlan;
  document.getElementById('plan_review').checked = s.planReview;
  document.getElementById('plan_synthesize').checked = s.planSynthesize;
  document.getElementById('plan_verify').checked = s.planVerify !== false;
  document.getElementById('plan_maxSteps').value = s.planMaxSteps;
  document.getElementById('planMaxStepsVal').textContent = s.planMaxSteps;
  document.getElementById('plan_reviewRounds').value = s.planReviewRounds;
  document.getElementById('planReviewRoundsVal').textContent = s.planReviewRounds;
  document.getElementById('plan_verifyRounds').value = s.planVerifyRounds || 2;
  document.getElementById('planVerifyRoundsVal').textContent = s.planVerifyRounds || 2;
  document.getElementById('plan_plannerModel').value = s.planPlannerModel;
  document.getElementById('plan_executorModel').value = s.planExecutorModel;
  document.getElementById('plan_verifierModel').value = s.planVerifierModel || '';
  document.getElementById('plan_plannerPrompt').value = s.planPlannerPrompt;
  document.getElementById('plan_executorPrompt').value = s.planExecutorPrompt;
}

function closePlanSettings() {
  document.getElementById('planModal').classList.remove('show');
}

function applyPlanPreset(key) {
  const p = PLAN_PRESETS[key];
  if (!p) return;
  document.getElementById('plan_plannerPrompt').value = p.planner;
  document.getElementById('plan_executorPrompt').value = p.executor;
  toast('✓ 已应用预设');
}

function savePlanSettings() {
  const s = state.settings;
  s.usePlan = document.getElementById('plan_enabled').checked;
  s.planReview = document.getElementById('plan_review').checked;
  s.planSynthesize = document.getElementById('plan_synthesize').checked;
  s.planVerify = document.getElementById('plan_verify').checked;
  s.planMaxSteps = parseInt(document.getElementById('plan_maxSteps').value);
  s.planReviewRounds = parseInt(document.getElementById('plan_reviewRounds').value);
  s.planVerifyRounds = parseInt(document.getElementById('plan_verifyRounds').value);
  s.planPlannerModel = document.getElementById('plan_plannerModel').value.trim();
  s.planExecutorModel = document.getElementById('plan_executorModel').value.trim();
  s.planVerifierModel = document.getElementById('plan_verifierModel').value.trim();
  s.planPlannerPrompt = document.getElementById('plan_plannerPrompt').value;
  s.planExecutorPrompt = document.getElementById('plan_executorPrompt').value;
  // 互斥：保存时若启用计划模式，关闭师生 / 大纲
  if (s.usePlan) {
    s.useReflection = false;
    s.useOutline = false;
    const reflectBtn = document.getElementById('reflectBtn');
    const outlineBtn = document.getElementById('outlineBtn');
    if (reflectBtn) reflectBtn.classList.remove('reflect-active');
    if (outlineBtn) outlineBtn.classList.remove('outline-active');
  }
  persistSettings();
  const btn = document.getElementById('planBtn');
  if (s.usePlan) btn.classList.add('plan-active');
  else btn.classList.remove('plan-active');
  updateSendBtn();
  closePlanSettings();
  toast('✓ 已保存');
}

function togglePlan() {
  const s = state.settings;
  s.usePlan = !s.usePlan;
  // 互斥：开启计划模式时关闭师生 / 大纲
  if (s.usePlan) {
    s.useReflection = false;
    s.useOutline = false;
    const reflectBtn = document.getElementById('reflectBtn');
    const outlineBtn = document.getElementById('outlineBtn');
    if (reflectBtn) reflectBtn.classList.remove('reflect-active');
    if (outlineBtn) outlineBtn.classList.remove('outline-active');
  }
  const btn = document.getElementById('planBtn');
  if (s.usePlan) btn.classList.add('plan-active');
  else btn.classList.remove('plan-active');
  persistSettings();
  updateSendBtn();
  toast(s.usePlan ? '✓ 已启用计划模式' : '✓ 已关闭计划模式');
}
