// ============ 任务队列 ============
// 按手动序号分组执行：同一序号内并行，当前序号全部完成/跳过后才进入下一序号。
const TASK_QUEUE_KEY = 'aichat_task_queue_v1';

const TASK_QUEUE_DONE_STATUSES = new Set(['done', 'skipped']);
const TASK_QUEUE_BLOCKING_STATUSES = new Set(['pending', 'running', 'paused', 'stopped', 'error']);
const TASK_QUEUE_ITEM_STATUSES = ['pending', 'running', 'paused', 'stopped', 'skipped', 'done', 'error'];

function _taskQueueDefaults() {
  return {
    items: [],
    defaultMode: 'normal',
    defaultUseTools: false,
    running: false,
    paused: false,
    loaded: false,
    activeOrder: null,
    stopAllRequested: false
  };
}

function ensureTaskQueue() {
  if (!state.taskQueue || typeof state.taskQueue !== 'object') {
    state.taskQueue = _taskQueueDefaults();
  }
  const q = state.taskQueue;
  if (!Array.isArray(q.items)) q.items = [];
  if (!['normal', 'outline', 'reflection'].includes(q.defaultMode)) q.defaultMode = 'normal';
  q.defaultUseTools = !!q.defaultUseTools;
  q.running = !!q.running;
  q.paused = !!q.paused;
  q.loaded = !!q.loaded;
  q.stopAllRequested = !!q.stopAllRequested;
  q.activeOrder = _taskQueuePositiveInt(q.activeOrder, null);
  return q;
}

function _taskQueueNormalizeItem(raw) {
  const item = raw && typeof raw === 'object' ? raw : {};
  const mode = ['normal', 'outline', 'reflection'].includes(item.mode) ? item.mode : 'normal';
  let status = TASK_QUEUE_ITEM_STATUSES.includes(item.status) ? item.status : 'pending';
  if (status === 'running') status = 'pending';
  if (status === 'canceled') status = 'stopped';
  const dependsText = typeof item.dependsOnTasksText === 'string'
    ? item.dependsOnTasksText
    : (typeof item.dependsOnOrdersText === 'string'
      ? item.dependsOnOrdersText
      : _taskQueueFormatIndexList(item.dependsOnTaskIndexes || item.dependsOnOrders || item.dependsOn || []));
  return {
    id: item.id || _taskQueueNewId(),
    text: String(item.text || '').trim(),
    order: _taskQueuePositiveInt(item.order, 1),
    mode,
    useTools: !!item.useTools,
    exposeOutput: !!item.exposeOutput,
    dependsOnTaskIds: Array.isArray(item.dependsOnTaskIds) ? item.dependsOnTaskIds.filter(Boolean) : [],
    dependsOnTaskIndexes: [],
    dependsOnTasksText: dependsText,
    outputPackage: _taskQueueNormalizeOutputPackage(item.outputPackage),
    outputUpdatedAt: item.outputUpdatedAt || null,
    outputWarning: item.outputWarning || '',
    promptHash: item.promptHash || '',
    status,
    chatId: item.chatId || null,
    error: item.error || '',
    createdAt: item.createdAt || Date.now(),
    startedAt: item.startedAt || null,
    finishedAt: item.finishedAt || null,
    pausedAt: item.pausedAt || null,
    skippedAt: item.skippedAt || null
  };
}

function loadTaskQueue() {
  const q = ensureTaskQueue();
  try {
    const raw = storage.get(TASK_QUEUE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      q.items = Array.isArray(parsed.items) ? parsed.items.map(_taskQueueNormalizeItem).filter(it => it.text) : [];
      q.defaultMode = ['normal', 'outline', 'reflection'].includes(parsed.defaultMode) ? parsed.defaultMode : 'normal';
      q.defaultUseTools = !!parsed.defaultUseTools;
      _taskQueueNormalizeDependencyRefs(q);
    }
  } catch (e) {
    console.warn('[task-queue] 加载失败:', e);
  }
  q.running = false;
  q.paused = false;
  q.activeOrder = null;
  q.stopAllRequested = false;
  q.loaded = true;
  renderTaskQueueBadge();
}

function saveTaskQueue() {
  const q = ensureTaskQueue();
  try {
    storage.set(TASK_QUEUE_KEY, JSON.stringify({
      items: q.items.map(it => ({
        id: it.id,
        text: it.text,
        order: _taskQueuePositiveInt(it.order, 1),
        mode: it.mode,
        useTools: !!it.useTools,
        exposeOutput: !!it.exposeOutput,
        dependsOnTaskIds: Array.isArray(it.dependsOnTaskIds) ? it.dependsOnTaskIds.filter(Boolean) : [],
        dependsOnTaskIndexes: Array.isArray(it.dependsOnTaskIndexes) ? it.dependsOnTaskIndexes : [],
        dependsOnTasksText: typeof it.dependsOnTasksText === 'string'
          ? it.dependsOnTasksText
          : _taskQueueFormatIndexList(it.dependsOnTaskIndexes || []),
        outputPackage: _taskQueueNormalizeOutputPackage(it.outputPackage),
        outputUpdatedAt: it.outputUpdatedAt || null,
        outputWarning: it.outputWarning || '',
        promptHash: it.promptHash || '',
        status: it.status,
        chatId: it.chatId || null,
        error: it.error || '',
        createdAt: it.createdAt || Date.now(),
        startedAt: it.startedAt || null,
        finishedAt: it.finishedAt || null,
        pausedAt: it.pausedAt || null,
        skippedAt: it.skippedAt || null
      })),
      defaultMode: q.defaultMode,
      defaultUseTools: !!q.defaultUseTools
    }));
  } catch (e) {
    console.warn('[task-queue] 保存失败:', e);
  }
  renderTaskQueueBadge();
}

function _taskQueueNewId() {
  return 'q_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function openTaskQueue() {
  const q = ensureTaskQueue();
  if (!q.loaded) loadTaskQueue();
  const wrap = document.querySelector('.more-menu-wrap');
  if (wrap) wrap.classList.remove('open');
  _taskQueueEnsureModal();
  _taskQueueFillControls();
  renderTaskQueueModal();
  document.getElementById('taskQueueModal').classList.add('show');
}

function closeTaskQueue() {
  const modal = document.getElementById('taskQueueModal');
  if (modal) modal.classList.remove('show');
}

function _taskQueueEnsureModal() {
  if (document.getElementById('taskQueueModal')) return;
  const modal = document.createElement('div');
  modal.id = 'taskQueueModal';
  modal.className = 'modal-mask task-queue-modal';
  modal.innerHTML = `
    <div class="modal wide">
      <h2>🧾 任务队列 <button class="modal-close" onclick="closeTaskQueue()">×</button></h2>
      <div class="task-queue-compose">
        <div class="form-group" style="margin-bottom:0;">
          <label>输入任务</label>
          <textarea id="taskQueueInput" placeholder="每行一个任务。新增任务默认序号为 1。"></textarea>
        </div>
        <div class="task-queue-controls">
          <label class="task-queue-check">拆分
            <select id="taskQueueSplitMode">
              <option value="line">每行一个任务</option>
              <option value="blank">空行分隔任务</option>
            </select>
          </label>
          <label class="task-queue-check">执行方式
            <select id="taskQueueDefaultMode" onchange="taskQueueSaveDefaults()">
              <option value="normal">普通对话</option>
              <option value="outline">大纲模式</option>
              <option value="reflection">师生讨论</option>
            </select>
          </label>
          <label class="task-queue-check">
            <input type="checkbox" id="taskQueueDefaultTools" onchange="taskQueueSaveDefaults()"> 启用工具
          </label>
          <label class="task-queue-check">
            <input type="checkbox" id="taskQueueAutoStart"> 添加后按顺序开始
          </label>
          <button class="btn btn-primary" onclick="taskQueueAddTasks()">加入队列</button>
        </div>
      </div>
      <div class="task-queue-toolbar">
        <div class="task-queue-stats" id="taskQueueStats">暂无任务</div>
        <button class="btn btn-primary" id="taskQueueStartBtn" onclick="startTaskQueue()">按顺序开始执行</button>
        <button class="btn" id="taskQueuePauseAllBtn" onclick="taskQueueTogglePauseAll()">暂停所有任务</button>
        <button class="btn btn-warning" id="taskQueueStopAllBtn" onclick="taskQueueStopAll()">停止所有任务</button>
        <button class="btn" onclick="openTaskQueueTree()">生成树形图</button>
        <button class="btn" onclick="taskQueueClearSettled()">清除已结束</button>
        <button class="btn" onclick="taskQueueClearAll()">清空队列</button>
      </div>
      <div class="task-queue-list" id="taskQueueList"></div>
      <div class="form-hint" style="margin-top:12px;">
        执行规则：先执行全部序号 1，序号 1 全部完成或跳过后才执行序号 2。勾选“供后续引用”的任务会保存结构化输出包；后续任务可在“依赖任务”中填写 #1、#2 这类任务卡片编号读取输出。
      </div>
    </div>
  `;
  modal.addEventListener('click', e => {
    if (e.target === modal) closeTaskQueue();
  });
  document.body.appendChild(modal);
}

function _taskQueueEnsureTreeModal() {
  if (document.getElementById('taskQueueTreeModal')) return;
  const modal = document.createElement('div');
  modal.id = 'taskQueueTreeModal';
  modal.className = 'modal-mask task-queue-tree-modal';
  modal.innerHTML = `
    <div class="modal wide">
      <h2>任务树形图 <button class="modal-close" onclick="closeTaskQueueTree()">×</button></h2>
      <div class="task-queue-tree-toolbar">
        <div class="task-queue-tree-hint">从左到右按序号展开；同一列内为并行任务。</div>
        <button class="btn" onclick="renderTaskQueueTree()">刷新</button>
      </div>
      <div class="task-queue-tree-wrap" id="taskQueueTreeWrap"></div>
    </div>
  `;
  modal.addEventListener('click', e => {
    if (e.target === modal) closeTaskQueueTree();
  });
  document.body.appendChild(modal);
  const wrap = modal.querySelector('#taskQueueTreeWrap');
  if (wrap) wrap.addEventListener('scroll', () => _taskQueueDrawTreeEdges(wrap), { passive: true });
  if (typeof window !== 'undefined' && !window._taskQueueTreeResizeBound) {
    window._taskQueueTreeResizeBound = true;
    window.addEventListener('resize', () => {
      const currentWrap = document.getElementById('taskQueueTreeWrap');
      const treeModal = document.getElementById('taskQueueTreeModal');
      if (currentWrap && treeModal && treeModal.classList.contains('show')) _taskQueueDrawTreeEdges(currentWrap);
    });
  }
}

function openTaskQueueTree() {
  const q = ensureTaskQueue();
  if (!q.loaded) loadTaskQueue();
  _taskQueueEnsureTreeModal();
  renderTaskQueueTree();
  document.getElementById('taskQueueTreeModal').classList.add('show');
}

function closeTaskQueueTree() {
  const modal = document.getElementById('taskQueueTreeModal');
  if (modal) modal.classList.remove('show');
}

function _taskQueueFillControls() {
  const q = ensureTaskQueue();
  const modeEl = document.getElementById('taskQueueDefaultMode');
  const toolsEl = document.getElementById('taskQueueDefaultTools');
  if (modeEl) modeEl.value = q.defaultMode;
  if (toolsEl) toolsEl.checked = !!q.defaultUseTools;
}

function taskQueueSaveDefaults() {
  const q = ensureTaskQueue();
  const modeEl = document.getElementById('taskQueueDefaultMode');
  const toolsEl = document.getElementById('taskQueueDefaultTools');
  if (modeEl && ['normal', 'outline', 'reflection'].includes(modeEl.value)) q.defaultMode = modeEl.value;
  if (toolsEl) q.defaultUseTools = !!toolsEl.checked;
  saveTaskQueue();
}

function renderTaskQueueBadge() {
  const badge = document.getElementById('taskQueueMenuBadge');
  if (!badge || !state.taskQueue) return;
  const q = ensureTaskQueue();
  const pendingLike = q.items.filter(it => it.status === 'pending' || it.status === 'paused').length;
  const running = q.running || q.items.some(it => it.status === 'running');
  if (running) {
    badge.textContent = '跑';
    badge.style.display = 'inline-block';
  } else if (pendingLike) {
    badge.textContent = String(pendingLike);
    badge.style.display = 'inline-block';
  } else {
    badge.textContent = '';
    badge.style.display = 'none';
  }
}

function renderTaskQueueModal() {
  const q = ensureTaskQueue();
  _taskQueueNormalizeDependencyRefs(q);
  renderTaskQueueBadge();
  const statsEl = document.getElementById('taskQueueStats');
  const listEl = document.getElementById('taskQueueList');
  if (!statsEl || !listEl) return;

  const counts = q.items.reduce((acc, it) => {
    acc[it.status] = (acc[it.status] || 0) + 1;
    return acc;
  }, {});
  const outputCount = q.items.filter(it => it.outputPackage).length;
  const activeText = q.activeOrder ? ` · 当前序号 ${q.activeOrder}` : '';
  const pausedText = q.paused ? ' · 已暂停' : '';
  statsEl.textContent = `共 ${q.items.length} 条 · 待运行 ${counts.pending || 0} · 运行中 ${counts.running || 0} · 暂停 ${counts.paused || 0} · 停止 ${counts.stopped || 0} · 跳过 ${counts.skipped || 0} · 完成 ${counts.done || 0} · 失败 ${counts.error || 0} · 输出包 ${outputCount}${activeText}${pausedText}`;

  const startBtn = document.getElementById('taskQueueStartBtn');
  const pauseAllBtn = document.getElementById('taskQueuePauseAllBtn');
  const stopAllBtn = document.getElementById('taskQueueStopAllBtn');
  const hasRunnable = q.items.some(it => it.status === 'pending' || it.status === 'paused');
  const hasRunning = q.items.some(it => it.status === 'running');
  const hasPending = q.items.some(it => it.status === 'pending');
  const hasStoppable = q.items.some(it => it.status === 'pending' || it.status === 'running' || it.status === 'paused');
  if (startBtn) {
    startBtn.disabled = q.running || !hasRunnable;
    startBtn.textContent = '按顺序开始执行';
  }
  if (pauseAllBtn) {
    pauseAllBtn.disabled = !q.running && !q.paused && !hasRunning && !hasPending;
    pauseAllBtn.textContent = q.paused ? '继续所有任务' : '暂停所有任务';
  }
  if (stopAllBtn) stopAllBtn.disabled = !hasStoppable;

  if (!q.items.length) {
    listEl.innerHTML = '<div class="task-queue-empty">还没有任务。新增任务默认序号为 1，可在任务卡片中手动修改序号。</div>';
    return;
  }

  const ordered = q.items
    .map((item, idx) => ({ item, idx }))
    .sort((a, b) => (a.item.order - b.item.order) || (a.item.createdAt - b.item.createdAt) || (a.idx - b.idx));
  listEl.innerHTML = ordered.map(({ item, idx }) => _taskQueueRenderItem(item, idx)).join('');
}

function _taskQueueRenderItem(item, idx) {
  const editable = ['pending', 'paused', 'stopped', 'error'].includes(item.status);
  const configEditable = item.status !== 'running';
  const canPause = item.status === 'running' || item.status === 'pending';
  const canStop = item.status === 'running' || item.status === 'pending' || item.status === 'paused';
  const canSkip = !TASK_QUEUE_DONE_STATUSES.has(item.status);
  const exposeChecked = item.exposeOutput ? 'checked' : '';
  const dependsValue = _taskQueueDisplayDependencyIndexes(item);
  const outputBadge = item.outputPackage
    ? `<span class="task-queue-output-badge" title="已保存结构化输出包">输出包</span>`
    : (item.outputBuilding ? `<span class="task-queue-output-badge building" title="正在生成结构化输出包">生成输出包...</span>` : '');
  const chatBtn = item.chatId
    ? `<button class="btn" onclick="taskQueueOpenChat('${item.id}')">打开对话</button>`
    : '';
  const retryBtn = (item.status === 'error' || item.status === 'stopped')
    ? `<button class="btn" onclick="taskQueueRetryItem('${item.id}')">重跑</button>`
    : '';
  const removeBtn = item.status === 'running'
    ? ''
    : `<button class="btn" onclick="taskQueueRemoveItem('${item.id}')">删除</button>`;
  return `
    <div class="task-queue-item ${escapeHtml(item.status)}" data-task-id="${escapeHtml(item.id)}">
      <div class="task-queue-item-head">
        <span class="task-queue-status ${escapeHtml(item.status)}">${_taskQueueStatusText(item.status)}</span>
        <label class="task-queue-order">序号
          <input type="number" min="1" step="1" value="${_taskQueuePositiveInt(item.order, 1)}" ${item.status === 'running' ? 'disabled' : ''} onchange="taskQueueUpdateItemOrder('${item.id}', this.value)">
        </label>
        <label class="task-queue-check task-queue-expose" title="完成后保存结构化输出包，供后续任务按 #编号 引用">
          <input type="checkbox" ${exposeChecked} ${configEditable ? '' : 'disabled'} onchange="taskQueueUpdateItemExpose('${item.id}', this.checked)"> 供后续引用
        </label>
        <span class="task-queue-title">#${idx + 1} ${escapeHtml(_taskQueueItemTitle(item))}</span>
        <span class="task-queue-meta">${_taskQueueModeText(item)}${item.chatId ? ' · 已建对话' : ''}${dependsValue ? ` · 依赖 #${escapeHtml(dependsValue.replace(/,/g, ',#'))}` : ''}</span>
      </div>
      <textarea ${editable ? '' : 'disabled'} oninput="taskQueueUpdateItemText('${item.id}', this.value)">${escapeHtml(item.text)}</textarea>
      <div class="task-queue-item-options">
        <label class="task-queue-check">执行方式
          <select ${editable ? '' : 'disabled'} onchange="taskQueueUpdateItemMode('${item.id}', this.value)">
            <option value="normal" ${item.mode === 'normal' ? 'selected' : ''}>普通对话</option>
            <option value="outline" ${item.mode === 'outline' ? 'selected' : ''}>大纲模式</option>
            <option value="reflection" ${item.mode === 'reflection' ? 'selected' : ''}>师生讨论</option>
          </select>
        </label>
        <label class="task-queue-check">
          <input type="checkbox" ${item.useTools ? 'checked' : ''} ${editable ? '' : 'disabled'} onchange="taskQueueUpdateItemTools('${item.id}', this.checked)"> 启用工具
        </label>
        <label class="task-queue-depends">依赖任务
          <input type="text" value="${escapeHtml(dependsValue)}" placeholder="如 1,2" ${configEditable ? '' : 'disabled'} onchange="taskQueueUpdateItemDepends('${item.id}', this.value)">
        </label>
        ${outputBadge}
        <button class="btn" ${canPause ? '' : 'disabled'} onclick="taskQueuePauseItem('${item.id}')">暂停</button>
        <button class="btn btn-warning" ${canStop ? '' : 'disabled'} onclick="taskQueueStopItem('${item.id}')">停止</button>
        <button class="btn" ${canSkip ? '' : 'disabled'} onclick="taskQueueSkipItem('${item.id}')">跳过</button>
        ${chatBtn}${retryBtn}${removeBtn}
      </div>
      ${item.error ? `<div class="task-queue-error">${escapeHtml(item.error)}</div>` : ''}
      ${item.outputWarning ? `<div class="task-queue-output-warning">${escapeHtml(item.outputWarning)}</div>` : ''}
    </div>
  `;
}

function renderTaskQueueTree() {
  const q = ensureTaskQueue();
  const wrap = document.getElementById('taskQueueTreeWrap');
  if (!wrap) return;
  const validation = _taskQueueValidateOrders(q);
  if (!validation.ok) {
    wrap.innerHTML = `<div class="task-queue-tree-empty">${escapeHtml(validation.error)}</div>`;
    return;
  }
  if (!q.items.length) {
    wrap.innerHTML = '<div class="task-queue-tree-empty">还没有任务。</div>';
    return;
  }
  wrap.innerHTML = _taskQueueBuildTreeHtml(q);
  requestAnimationFrame(() => _taskQueueDrawTreeEdges(wrap));
}

function _taskQueueBuildTreeHtml(q) {
  const items = q.items
    .map((item, idx) => ({ item, idx }))
    .sort((a, b) => (_taskQueuePositiveInt(a.item.order, 1) - _taskQueuePositiveInt(b.item.order, 1))
      || ((a.item.createdAt || 0) - (b.item.createdAt || 0))
      || (a.idx - b.idx));
  const orders = Array.from(new Set(items.map(({ item }) => _taskQueuePositiveInt(item.order, 1)))).sort((a, b) => a - b);
  const columns = orders.map(order => {
    const nodes = items.filter(({ item }) => _taskQueuePositiveInt(item.order, 1) === order);
    return `
      <div class="task-queue-tree-col" data-order="${order}">
        <div class="task-queue-tree-col-title">序号 ${order}</div>
        <div class="task-queue-tree-nodes">
          ${nodes.map(({ item, idx }) => _taskQueueRenderTreeNode(item, idx)).join('')}
        </div>
      </div>
    `;
  }).join('');
  return `
    <div class="task-queue-tree-canvas" id="taskQueueTreeCanvas">
      <svg class="task-queue-tree-edges" id="taskQueueTreeEdges" aria-hidden="true"></svg>
      <div class="task-queue-tree-cols">${columns}</div>
    </div>
  `;
}

function _taskQueueRenderTreeNode(item, idx) {
  const depText = _taskQueueDisplayDependencyIndexes(item);
  const expose = item.exposeOutput ? '<span class="task-queue-tree-chip output">输出</span>' : '';
  const blocked = ['paused', 'stopped', 'error'].includes(item.status) ? '<span class="task-queue-tree-chip blocked">阻塞</span>' : '';
  return `
    <div class="task-queue-tree-node ${escapeHtml(item.status)}" data-task-id="${escapeHtml(item.id)}" data-order="${_taskQueuePositiveInt(item.order, 1)}">
      <div class="task-queue-tree-node-head">
        <span class="task-queue-tree-status">${_taskQueueStatusText(item.status)}</span>
        <span class="task-queue-tree-order">序号 ${_taskQueuePositiveInt(item.order, 1)}</span>
      </div>
      <div class="task-queue-tree-text">${escapeHtml(_taskQueueTreeNodeText(item, idx))}</div>
      <div class="task-queue-tree-foot">
        ${expose}${blocked}${depText ? `<span class="task-queue-tree-chip">依赖 #${escapeHtml(depText.replace(/,/g, ',#'))}</span>` : ''}
      </div>
    </div>
  `;
}

function _taskQueueTreeNodeText(item, idx) {
  const text = String(item.text || '').replace(/\s+/g, ' ').trim();
  const prefix = `#${idx + 1} `;
  const max = 120;
  return prefix + (text.length > max ? text.slice(0, max) + '...' : text || '空任务');
}

function _taskQueueDrawTreeEdges(wrap) {
  const canvas = wrap.querySelector('#taskQueueTreeCanvas');
  const svg = wrap.querySelector('#taskQueueTreeEdges');
  if (!canvas || !svg) return;
  const q = ensureTaskQueue();
  const canvasRect = canvas.getBoundingClientRect();
  const width = Math.max(canvas.scrollWidth, canvasRect.width);
  const height = Math.max(canvas.scrollHeight, canvasRect.height);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.innerHTML = '';
  const edges = _taskQueueTreeEdges(q);
  const frag = document.createDocumentFragment();
  for (const edge of edges) {
    const from = canvas.querySelector(`[data-task-id="${_taskQueueCssEscape(edge.from)}"]`);
    const to = canvas.querySelector(`[data-task-id="${_taskQueueCssEscape(edge.to)}"]`);
    if (!from || !to) continue;
    const a = from.getBoundingClientRect();
    const b = to.getBoundingClientRect();
    const x1 = a.right - canvasRect.left + canvas.scrollLeft;
    const y1 = a.top - canvasRect.top + canvas.scrollTop + a.height / 2;
    const x2 = b.left - canvasRect.left + canvas.scrollLeft;
    const y2 = b.top - canvasRect.top + canvas.scrollTop + b.height / 2;
    const dx = Math.max(48, (x2 - x1) / 2);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`);
    path.setAttribute('class', edge.type === 'dependency' ? 'dependency' : 'sequence');
    frag.appendChild(path);
  }
  svg.appendChild(frag);
}

function _taskQueueTreeEdges(q) {
  const items = (q.items || []).filter(Boolean);
  _taskQueueNormalizeDependencyRefs(q);
  const byOrder = new Map();
  for (const item of items) {
    const order = _taskQueuePositiveInt(item.order, 1);
    if (!byOrder.has(order)) byOrder.set(order, []);
    byOrder.get(order).push(item);
  }
  const orders = Array.from(byOrder.keys()).sort((a, b) => a - b);
  const edges = [];
  const seen = new Set();
  const addEdge = (from, to, type) => {
    if (!from || !to || from.id === to.id) return;
    const key = `${from.id}->${to.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from: from.id, to: to.id, type });
  };
  for (const item of items) {
    const deps = item.dependsOnTaskIds || [];
    if (deps.length) {
      for (const depId of deps) {
        const source = items.find(it => it.id === depId);
        if (source) addEdge(source, item, 'dependency');
      }
    }
  }
  for (let i = 1; i < orders.length; i++) {
    const prev = byOrder.get(orders[i - 1]) || [];
    const curr = byOrder.get(orders[i]) || [];
    for (const target of curr) {
      if (target.dependsOnTaskIds && target.dependsOnTaskIds.length) continue;
      for (const source of prev) addEdge(source, target, 'sequence');
    }
  }
  return edges;
}

function _taskQueueCssEscape(value) {
  const s = String(value || '');
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
  return s.replace(/["\\]/g, '\\$&');
}

function _taskQueueStatusText(status) {
  return {
    pending: '待运行',
    running: '运行中',
    paused: '已暂停',
    stopped: '已停止',
    skipped: '已跳过',
    done: '已完成',
    error: '失败'
  }[status] || '待运行';
}

function _taskQueueModeText(item) {
  const mode = {
    normal: '普通',
    outline: '大纲',
    reflection: '师生'
  }[item.mode] || '普通';
  return item.useTools ? `${mode} + 工具` : mode;
}

function _taskQueueItemTitle(item) {
  const text = (item.text || '').replace(/\s+/g, ' ').trim();
  return text.length > 48 ? text.slice(0, 48) + '...' : text || '空任务';
}

function _taskQueueParseIndexList(value) {
  if (Array.isArray(value)) {
    const indexes = [];
    for (const raw of value) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        return { ok: false, indexes: [], error: '依赖任务编号必须是正整数' };
      }
      indexes.push(n);
    }
    return { ok: true, indexes: Array.from(new Set(indexes)).sort((a, b) => a - b), error: '' };
  }
  const text = String(value || '').trim();
  if (!text) return { ok: true, indexes: [], error: '' };
  const parts = text.split(/[,，;；、\s]+/).map(s => s.trim()).filter(Boolean);
  const indexes = [];
  for (const part of parts) {
    const clean = part.replace(/^#/g, '');
    if (!/^\d+$/.test(clean)) {
      return { ok: false, indexes: [], error: `无法识别依赖任务编号「${part}」` };
    }
    const n = Number(clean);
    if (!Number.isInteger(n) || n < 1) {
      return { ok: false, indexes: [], error: '依赖任务编号必须是正整数' };
    }
    indexes.push(n);
  }
  return { ok: true, indexes: Array.from(new Set(indexes)).sort((a, b) => a - b), error: '' };
}

function _taskQueueFormatIndexList(value) {
  const parsed = _taskQueueParseIndexList(value);
  return parsed.ok ? parsed.indexes.join(',') : String(value || '');
}

function _taskQueuePruneMissingDepends(q) {
  const existing = new Set((q.items || []).map(it => it.id));
  for (const item of q.items || []) {
    item.dependsOnTaskIds = (item.dependsOnTaskIds || []).filter(id => existing.has(id));
    item.dependsOnTaskIndexes = _taskQueueTaskIdsToIndexes(q, item.dependsOnTaskIds);
    item.dependsOnTasksText = _taskQueueFormatIndexList(item.dependsOnTaskIndexes);
  }
}

function _taskQueueOrderedItems(q = ensureTaskQueue()) {
  return (q.items || [])
    .map((item, idx) => ({ item, idx }))
    .sort((a, b) => (_taskQueuePositiveInt(a.item.order, 1) - _taskQueuePositiveInt(b.item.order, 1))
      || ((a.item.createdAt || 0) - (b.item.createdAt || 0))
      || (a.idx - b.idx));
}

function _taskQueueTaskIndexMap(q = ensureTaskQueue()) {
  const map = new Map();
  _taskQueueOrderedItems(q).forEach(({ item }, idx) => map.set(item.id, idx + 1));
  return map;
}

function _taskQueueTaskAtIndex(q, index) {
  const entry = _taskQueueOrderedItems(q)[index - 1];
  return entry ? entry.item : null;
}

function _taskQueueTaskIdsToIndexes(q, ids) {
  const map = _taskQueueTaskIndexMap(q);
  return (ids || []).map(id => map.get(id)).filter(n => Number.isInteger(n));
}

function _taskQueueDisplayDependencyIndexes(item) {
  const q = ensureTaskQueue();
  if (!Array.isArray(item.dependsOnTaskIds) || !item.dependsOnTaskIds.length) return '';
  return _taskQueueFormatIndexList(_taskQueueTaskIdsToIndexes(q, item.dependsOnTaskIds));
}

function _taskQueueNormalizeDependencyRefs(q) {
  const items = q.items || [];
  const existingIds = new Set(items.map(it => it.id));
  for (const item of items) {
    const ids = Array.isArray(item.dependsOnTaskIds) ? item.dependsOnTaskIds.filter(id => existingIds.has(id)) : [];
    if (!ids.length && item.dependsOnTasksText) {
      const parsed = _taskQueueParseIndexList(item.dependsOnTasksText);
      if (parsed.ok) {
        for (const index of parsed.indexes) {
          const dep = _taskQueueTaskAtIndex(q, index);
          if (dep && dep.id !== item.id) ids.push(dep.id);
        }
      }
    }
    item.dependsOnTaskIds = Array.from(new Set(ids));
    item.dependsOnTaskIndexes = _taskQueueTaskIdsToIndexes(q, item.dependsOnTaskIds);
    if (item.dependsOnTaskIds.length || !item.dependsOnTasksText) {
      item.dependsOnTasksText = _taskQueueFormatIndexList(item.dependsOnTaskIndexes);
    } else {
      const parsed = _taskQueueParseIndexList(item.dependsOnTasksText);
      item.dependsOnTaskIndexes = parsed.ok ? parsed.indexes : [];
    }
  }
}

function taskQueueAddTasks() {
  const q = ensureTaskQueue();
  taskQueueSaveDefaults();
  const input = document.getElementById('taskQueueInput');
  const splitEl = document.getElementById('taskQueueSplitMode');
  const autoStartEl = document.getElementById('taskQueueAutoStart');
  const raw = input ? input.value : '';
  const splitMode = splitEl ? splitEl.value : 'line';
  const tasks = _taskQueueParseInput(raw, splitMode);
  if (!tasks.length) {
    if (typeof toast === 'function') toast('请输入至少一个任务');
    return;
  }

  for (const text of tasks) {
    q.items.push({
      id: _taskQueueNewId(),
      text,
      order: 1,
      mode: q.defaultMode,
      useTools: !!q.defaultUseTools,
      exposeOutput: false,
      dependsOnTaskIds: [],
      dependsOnTaskIndexes: [],
      dependsOnTasksText: '',
      outputPackage: null,
      outputUpdatedAt: null,
      outputWarning: '',
      promptHash: '',
      status: 'pending',
      chatId: null,
      error: '',
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      pausedAt: null,
      skippedAt: null
    });
  }
  if (input) input.value = '';
  saveTaskQueue();
  renderTaskQueueModal();
  if (typeof toast === 'function') toast(`已加入 ${tasks.length} 个任务`);
  if (autoStartEl && autoStartEl.checked && !q.running) {
    setTimeout(() => startTaskQueue(), 0);
  }
}

function _taskQueueParseInput(raw, splitMode) {
  const text = String(raw || '').trim();
  if (!text) return [];
  const parts = splitMode === 'blank'
    ? text.split(/\n\s*\n/g)
    : text.split(/\r?\n/g);
  return parts.map(s => s.trim()).filter(Boolean);
}

function taskQueueUpdateItemText(id, value) {
  const item = _taskQueueFindItem(id);
  if (!item || !['pending', 'paused', 'stopped', 'error'].includes(item.status)) return;
  item.text = String(value || '').trim();
  item.promptHash = '';
  saveTaskQueue();
  renderTaskQueueBadge();
}

async function taskQueueUpdateItemOrder(id, value) {
  const item = _taskQueueFindItem(id);
  if (!item || item.status === 'running') return;
  item.order = _taskQueuePositiveInt(value, 1);
  if (item.exposeOutput && item.status === 'done' && item.chatId) {
    item.outputPackage = null;
    item.outputUpdatedAt = null;
    item.outputWarning = '';
    _taskQueueNormalizeDependencyRefs(ensureTaskQueue());
    saveTaskQueue();
    renderTaskQueueModal();
    await _taskQueueRefreshOutputPackage(item);
  } else {
    item.outputPackage = null;
    item.outputUpdatedAt = null;
    item.outputWarning = '';
  }
  _taskQueueNormalizeDependencyRefs(ensureTaskQueue());
  saveTaskQueue();
  renderTaskQueueModal();
}

function taskQueueUpdateItemMode(id, value) {
  const item = _taskQueueFindItem(id);
  if (!item || !['pending', 'paused', 'stopped', 'error'].includes(item.status)) return;
  if (['normal', 'outline', 'reflection'].includes(value)) item.mode = value;
  saveTaskQueue();
  renderTaskQueueModal();
}

function taskQueueUpdateItemTools(id, checked) {
  const item = _taskQueueFindItem(id);
  if (!item || !['pending', 'paused', 'stopped', 'error'].includes(item.status)) return;
  item.useTools = !!checked;
  saveTaskQueue();
  renderTaskQueueModal();
}

async function taskQueueUpdateItemExpose(id, checked) {
  const item = _taskQueueFindItem(id);
  if (!item || item.status === 'running') return;
  item.exposeOutput = !!checked;
  if (!item.exposeOutput) {
    item.outputPackage = null;
    item.outputUpdatedAt = null;
    item.outputWarning = '';
  } else if (item.status === 'done' && item.chatId) {
    saveTaskQueue();
    renderTaskQueueModal();
    await _taskQueueRefreshOutputPackage(item);
  }
  saveTaskQueue();
  renderTaskQueueModal();
}

function taskQueueUpdateItemDepends(id, value) {
  const item = _taskQueueFindItem(id);
  if (!item || item.status === 'running') return;
  const raw = String(value || '').trim();
  item.dependsOnTasksText = raw;
  const parsed = _taskQueueParseIndexList(raw);
  if (parsed.ok) {
    const q = ensureTaskQueue();
    const ids = [];
    for (const index of parsed.indexes) {
      const dep = _taskQueueTaskAtIndex(q, index);
      if (dep && dep.id !== item.id) ids.push(dep.id);
    }
    if (ids.length === parsed.indexes.length) {
      item.dependsOnTaskIds = Array.from(new Set(ids));
      item.dependsOnTaskIndexes = _taskQueueTaskIdsToIndexes(q, item.dependsOnTaskIds);
      item.dependsOnTasksText = _taskQueueFormatIndexList(item.dependsOnTaskIndexes);
    } else {
      item.dependsOnTaskIds = [];
      item.dependsOnTaskIndexes = parsed.indexes;
    }
  } else {
    item.dependsOnTaskIds = [];
    item.dependsOnTaskIndexes = [];
  }
  item.promptHash = '';
  saveTaskQueue();
  renderTaskQueueModal();
  if (!parsed.ok && typeof toast === 'function') toast(parsed.error, 3000);
}

function taskQueueRemoveItem(id) {
  const q = ensureTaskQueue();
  const item = _taskQueueFindItem(id);
  if (!item || item.status === 'running') return;
  q.items = q.items.filter(it => it.id !== id);
  _taskQueuePruneMissingDepends(q);
  saveTaskQueue();
  renderTaskQueueModal();
}

function taskQueueRetryItem(id) {
  const item = _taskQueueFindItem(id);
  if (!item || item.status === 'running') return;
  item.status = 'pending';
  item.error = '';
  item.outputPackage = null;
  item.outputUpdatedAt = null;
  item.outputWarning = '';
  item.promptHash = '';
  item.startedAt = null;
  item.finishedAt = null;
  item.pausedAt = null;
  item.skippedAt = null;
  saveTaskQueue();
  renderTaskQueueModal();
}

function taskQueueOpenChat(id) {
  const item = _taskQueueFindItem(id);
  if (!item || !item.chatId) return;
  if (typeof switchChat === 'function') switchChat(item.chatId);
  closeTaskQueue();
}

function taskQueueClearSettled() {
  const q = ensureTaskQueue();
  q.items = q.items.filter(it => !TASK_QUEUE_DONE_STATUSES.has(it.status) && it.status !== 'error' && it.status !== 'stopped');
  _taskQueuePruneMissingDepends(q);
  saveTaskQueue();
  renderTaskQueueModal();
}

function taskQueueClearAll() {
  const q = ensureTaskQueue();
  if (q.items.some(it => it.status === 'running')) {
    if (typeof toast === 'function') toast('存在运行中任务，请先停止所有任务');
    return;
  }
  if (q.items.length && !confirm('清空整个任务队列？')) return;
  q.items = [];
  q.running = false;
  q.paused = false;
  q.activeOrder = null;
  q.stopAllRequested = false;
  saveTaskQueue();
  renderTaskQueueModal();
}

async function startTaskQueue() {
  const q = ensureTaskQueue();
  if (q.running) return;
  const validation = _taskQueueValidateOrders(q);
  if (!validation.ok) {
    if (typeof toast === 'function') toast(validation.error, 5000);
    renderTaskQueueModal();
    return;
  }
  if (!q.items.some(it => it.status === 'pending' || it.status === 'paused')) {
    if (typeof toast === 'function') toast('没有可执行任务');
    renderTaskQueueModal();
    return;
  }
  if (!state.settings.apiKey) {
    if (typeof toast === 'function') toast('请先配置 API Key');
    if (typeof openSettings === 'function') openSettings();
    return;
  }

  q.running = true;
  q.paused = false;
  q.stopAllRequested = false;
  q.items.forEach(it => {
    if (it.status === 'paused') {
      it.status = 'pending';
      it.error = '';
    }
  });
  saveTaskQueue();
  renderTaskQueueModal();

  try {
    while (q.running && !q.stopAllRequested) {
      if (q.paused) {
        await _taskQueueSleep(500);
        continue;
      }
      const nextOrder = _taskQueueNextRunnableOrder(q);
      if (!nextOrder) break;
      q.activeOrder = nextOrder;
      const group = q.items.filter(it => it.order === nextOrder);
      const blockers = group.filter(it => TASK_QUEUE_BLOCKING_STATUSES.has(it.status) && it.status !== 'pending' && it.status !== 'running');
      if (blockers.length) break;
      const runnable = group.filter(it => it.status === 'pending');
      if (!runnable.length) {
        if (group.every(it => TASK_QUEUE_DONE_STATUSES.has(it.status))) continue;
        break;
      }
      saveTaskQueue();
      renderTaskQueueModal();
      await Promise.allSettled(runnable.map(item => _taskQueueRunItem(item)));
      saveTaskQueue();
      renderTaskQueueModal();
      if (group.some(it => !TASK_QUEUE_DONE_STATUSES.has(it.status))) break;
    }
  } finally {
    const keepPaused = q.paused && q.items.some(it => it.status === 'paused');
    q.running = false;
    q.paused = keepPaused;
    q.activeOrder = null;
    q.stopAllRequested = false;
    saveTaskQueue();
    renderTaskQueueModal();
    if (typeof toast === 'function') {
      const next = _taskQueueNextRunnableOrder(q);
      const blocked = _taskQueueFirstBlockedOrder(q);
      if (next) toast(blocked ? `任务队列停在序号 ${blocked}` : '任务队列已暂停');
      else toast('任务队列已完成可执行部分');
    }
  }
}

function taskQueueTogglePauseAll() {
  const q = ensureTaskQueue();
  if (q.paused) {
    q.paused = false;
    saveTaskQueue();
    renderTaskQueueModal();
    if (!q.running) setTimeout(() => startTaskQueue(), 0);
    if (typeof toast === 'function') toast('已继续所有任务');
    return;
  }
  q.paused = true;
  const running = q.items.filter(it => it.status === 'running');
  running.forEach(it => _taskQueueAbortItem(it, 'paused'));
  q.items.filter(it => it.status === 'pending').forEach(it => {
    it.status = 'paused';
    it.error = '已暂停';
    it.pausedAt = Date.now();
  });
  saveTaskQueue();
  renderTaskQueueModal();
  if (typeof toast === 'function') toast(running.length ? '已请求暂停所有任务' : '队列已暂停');
}

function taskQueueStopAll() {
  const q = ensureTaskQueue();
  if (!q.items.length) return;
  if (!confirm('停止所有未完成任务？')) return;
  q.stopAllRequested = true;
  q.running = false;
  q.paused = false;
  for (const item of q.items) {
    if (item.status === 'running') _taskQueueAbortItem(item, 'stopped');
    else if (item.status === 'pending' || item.status === 'paused') {
      item.status = 'stopped';
      item.error = '已停止';
      item.finishedAt = Date.now();
    }
  }
  saveTaskQueue();
  renderTaskQueueModal();
  if (typeof toast === 'function') toast('已停止所有未完成任务');
}

function taskQueuePauseItem(id) {
  const item = _taskQueueFindItem(id);
  if (!item || (item.status !== 'running' && item.status !== 'pending')) return;
  if (item.status === 'running') _taskQueueAbortItem(item, 'paused');
  else {
    item.status = 'paused';
    item.error = '已暂停';
    item.pausedAt = Date.now();
  }
  saveTaskQueue();
  renderTaskQueueModal();
  if (typeof toast === 'function') toast('已请求暂停该任务');
}

function taskQueueStopItem(id) {
  const item = _taskQueueFindItem(id);
  if (!item || TASK_QUEUE_DONE_STATUSES.has(item.status)) return;
  if (item.status === 'running') _taskQueueAbortItem(item, 'stopped');
  else {
    item.status = 'stopped';
    item.error = '已停止';
    item.finishedAt = Date.now();
  }
  saveTaskQueue();
  renderTaskQueueModal();
}

function taskQueueSkipItem(id) {
  const item = _taskQueueFindItem(id);
  if (!item || TASK_QUEUE_DONE_STATUSES.has(item.status)) return;
  if (item.status === 'running') _taskQueueAbortItem(item, 'skipped');
  else _taskQueueMarkSkipped(item);
  saveTaskQueue();
  renderTaskQueueModal();
  if (ensureTaskQueue().running === false) {
    const q = ensureTaskQueue();
    if (q.items.some(it => it.status === 'pending')) renderTaskQueueModal();
  }
}

async function _taskQueueRunItem(item) {
  item.text = String(item.text || '').trim();
  if (!item.text) {
    item.status = 'error';
    item.error = '任务内容为空';
    item.finishedAt = Date.now();
    return;
  }

  if (item.status !== 'pending') return;
  item.status = 'running';
  item.error = '';
  item.outputPackage = null;
  item.outputUpdatedAt = null;
  item.outputWarning = '';
  item.startedAt = Date.now();
  item.finishedAt = null;
  item.pausedAt = null;
  item.skippedAt = null;
  saveTaskQueue();
  renderTaskQueueModal();

  try {
    if (typeof callAPI !== 'function') throw new Error('API 函数尚未加载');
    const dependencyContext = await _taskQueueBuildDependencyContext(item);
    const c = _taskQueueEnsureChatForItem(item, dependencyContext);
    item.chatId = c.id;
    saveTaskQueue();
    renderTaskQueueModal();

    if (typeof clearPendingAIAttachments === 'function') clearPendingAIAttachments(c.id);
    if (typeof ensureContextBeforeAgentRun === 'function') {
      const ok = await ensureContextBeforeAgentRun(c, { label: '任务队列' });
      if (!ok) throw new Error('自动压缩失败，任务队列已暂停该任务请求');
    }
    if (item.mode === 'outline') {
      await callAPIWithOutline({ chatId: c.id, useTools: item.useTools, suppressCompletionSound: true });
    } else if (item.mode === 'reflection') {
      await callAPIWithReflection({ chatId: c.id, useTools: item.useTools, suppressCompletionSound: true });
    } else {
      await callAPI(undefined, { chatId: c.id, useTools: item.useTools, suppressCompletionSound: true });
    }

    if (item.status === 'running') {
      const result = _taskQueueInspectResult(item.chatId);
      _taskQueueApplyRequestedOrResult(item, result);
      item.finishedAt = Date.now();
      await _taskQueueRefreshOutputPackage(item);
    }
  } catch (e) {
    if (item._requestedStatus) {
      _taskQueueApplyRequestedOrResult(item, null);
      return;
    }
    if (item.status === 'paused' || item.status === 'stopped' || item.status === 'skipped') return;
    if (e && e.name === 'AbortError') {
      item.status = 'stopped';
      item.error = '已停止';
    } else {
      item.status = 'error';
      item.error = e && e.message ? e.message : String(e);
    }
    item.outputPackage = null;
    item.outputUpdatedAt = null;
    item.finishedAt = Date.now();
  } finally {
    if (item.status === 'running') {
      const result = _taskQueueInspectResult(item.chatId);
      _taskQueueApplyRequestedOrResult(item, result);
      item.finishedAt = Date.now();
      await _taskQueueRefreshOutputPackage(item);
    }
    saveTaskQueue();
    renderTaskQueueModal();
  }
}

function _taskQueueEnsureChatForItem(item, dependencyContext = '') {
  let c = item.chatId && typeof chatById === 'function' ? chatById(item.chatId) : null;
  const userContent = _taskQueueComposeTaskPrompt(item, dependencyContext);
  const promptHash = _taskQueueStringHash(userContent);
  if (c) {
    const lastUser = (Array.isArray(c.messages) ? c.messages.slice().reverse().find(m => m.role === 'user') : null);
    const lastUserSame = lastUser && String(lastUser.content || '') === userContent;
    if (item.promptHash !== promptHash && !lastUserSame) {
      c.messages.push({ role: 'user', content: userContent });
      saveData();
    }
    item.promptHash = promptHash;
    return c;
  }
  c = {
    id: 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    title: _taskQueueItemTitle(item).slice(0, 30) || '队列任务',
    messages: [{ role: 'user', content: userContent }],
    createdAt: Date.now()
  };
  state.chats.unshift(c);
  item.chatId = c.id;
  item.promptHash = promptHash;
  saveData();
  if (typeof renderChatList === 'function') renderChatList();
  return c;
}

function _taskQueueInspectResult(chatId) {
  const c = typeof chatById === 'function' ? chatById(chatId) : null;
  if (!c || !Array.isArray(c.messages)) return { status: 'error', error: '找不到任务对话' };
  const assistant = c.messages.slice().reverse().find(m => m.role === 'assistant');
  const content = assistant ? String(assistant.content || '') : '';
  if (content.includes('[已停止]')) return { status: 'stopped', error: '已停止' };
  if (content.trim().startsWith('❌')) {
    return { status: 'error', error: content.trim().split('\n')[0].slice(0, 220) };
  }
  return { status: 'done', error: '' };
}

function _taskQueueNormalizeOutputPackage(pkg) {
  if (!pkg || typeof pkg !== 'object') return null;
  return {
    taskId: pkg.taskId || '',
    taskNo: pkg.taskNo || '',
    title: String(pkg.title || '').slice(0, 120),
    status: pkg.status || '',
    summary: _taskQueueClipText(pkg.summary || '', 1200),
    result: _taskQueueClipText(pkg.result || '', 3000),
    evidence: Array.isArray(pkg.evidence) ? pkg.evidence.slice(0, 5).map(x => _taskQueueClipText(x, 500)) : [],
    warnings: Array.isArray(pkg.warnings) ? pkg.warnings.slice(0, 5).map(x => _taskQueueClipText(x, 500)) : []
  };
}

async function _taskQueueRefreshOutputPackage(item) {
  if (!item.exposeOutput) {
    item.outputPackage = null;
    item.outputUpdatedAt = null;
    item.outputBuilding = false;
    return;
  }
  if (item.status !== 'done') {
    item.outputPackage = null;
    item.outputUpdatedAt = null;
    item.outputBuilding = false;
    return;
  }
  try {
    item.outputBuilding = true;
    saveTaskQueue();
    renderTaskQueueModal();
    item.outputPackage = await _taskQueueGenerateOutputPackage(item);
    item.outputWarning = '';
  } catch (e) {
    console.warn('[task-queue] 输出包生成失败，使用 fallback:', e);
    item.outputPackage = _taskQueueBuildFallbackOutputPackage(item, e);
    item.outputWarning = '输出包生成失败，已使用简化输出包';
  } finally {
    item.outputBuilding = false;
  }
  item.outputUpdatedAt = Date.now();
}

async function _taskQueueGenerateOutputPackage(item) {
  if (typeof callOnceWithRole !== 'function') throw new Error('辅助 API 函数尚未加载');
  const c = item.chatId && typeof chatById === 'function' ? chatById(item.chatId) : null;
  if (!c || !Array.isArray(c.messages)) throw new Error('找不到任务对话');
  const finalAnswer = _taskQueueFinalAssistantText(c);
  if (!finalAnswer) throw new Error('没有可用于生成输出包的最终回答');
  const q = ensureTaskQueue();
  const taskNo = '#' + (_taskQueueTaskIndexMap(q).get(item.id) || '?');
  const rolePrompt = [
    '你是任务队列的结果打包器。你只负责把一个已完成 Agent 任务的结果压缩成固定 JSON。',
    '必须只输出合法 JSON，不要输出 Markdown、解释、代码块或额外文本。',
    'JSON schema:',
    '{',
    '  "taskNo": "string，任务卡片编号，例如 #1",',
    '  "taskId": "string",',
    '  "title": "string，任务内容短标题",',
    '  "status": "done",',
    '  "summary": "string，核心结果摘要，尽量 200-500 字",',
    '  "result": "string，最终可复用结论/答案，尽量 300-1200 字",',
    '  "evidence": ["string，关键依据，最多 5 条"],',
    '  "warnings": ["string，失败、限制、未完成事项，最多 5 条"]',
    '}',
    '字段必须完整存在。evidence 或 warnings 没有内容时返回空数组。'
  ].join('\n');
  const history = [{
    role: 'user',
    content: [
      `任务编号: ${taskNo}`,
      `taskId: ${item.id}`,
      `任务标题: ${_taskQueueItemTitle(item)}`,
      `任务状态: ${item.status}`,
      '',
      '任务最终回答:',
      _taskQueueClipText(finalAnswer, 20000)
    ].join('\n')
  }];
  const raw = await callOnceWithRole(history, state.settings.currentModel, rolePrompt, {
    chatId: item.chatId,
    sourceLabel: '任务队列输出包生成',
    isStopped: () => {
      const task = typeof chatTaskById === 'function' ? chatTaskById(item.chatId) : null;
      return !!(task && task.stopRequested) || item.status === 'paused' || item.status === 'stopped';
    }
  });
  const parsed = _taskQueueParseOutputPackageJson(raw);
  parsed.taskNo = taskNo;
  parsed.taskId = item.id;
  parsed.title = parsed.title || _taskQueueItemTitle(item);
  parsed.status = parsed.status || item.status;
  return _taskQueueNormalizeOutputPackage(parsed);
}

function _taskQueueBuildFallbackOutputPackage(item, cause) {
  const c = item.chatId && typeof chatById === 'function' ? chatById(item.chatId) : null;
  const finalAnswer = c ? _taskQueueFinalAssistantText(c) : '';
  const q = ensureTaskQueue();
  const taskNo = '#' + (_taskQueueTaskIndexMap(q).get(item.id) || '?');
  const warning = cause && cause.message ? `模型输出包生成失败：${cause.message}` : '模型输出包生成失败，使用简化输出包';
  return _taskQueueNormalizeOutputPackage({
    taskId: item.id,
    taskNo,
    title: _taskQueueItemTitle(item),
    status: item.status,
    summary: _taskQueueMakeSummary(finalAnswer),
    result: _taskQueueClipText(finalAnswer, 3000),
    evidence: _taskQueueExtractKeyFindings(finalAnswer).slice(0, 5),
    warnings: [warning]
  });
}

function _taskQueueFinalAssistantText(chat) {
  const messages = chat && Array.isArray(chat.messages) ? chat.messages : [];
  const finalMsg = messages.slice().reverse().find(m =>
    m.role === 'assistant' &&
    !m._hiddenFromUI &&
    String(m.content || '').trim() &&
    !String(m.content || '').includes('[已停止]')
  );
  return finalMsg ? String(finalMsg.content || '').trim() : '';
}

function _taskQueueParseOutputPackageJson(raw) {
  const text = String(raw || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(text);
    return _taskQueueCoerceOutputPackage(parsed);
  } catch (e) {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return _taskQueueCoerceOutputPackage(JSON.parse(match[0]));
    throw new Error('输出包不是合法 JSON');
  }
}

function _taskQueueCoerceOutputPackage(value) {
  const obj = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    taskNo: String(obj.taskNo || ''),
    taskId: String(obj.taskId || ''),
    title: String(obj.title || ''),
    status: String(obj.status || ''),
    summary: String(obj.summary || ''),
    result: String(obj.result || ''),
    evidence: Array.isArray(obj.evidence) ? obj.evidence.map(String) : [],
    warnings: Array.isArray(obj.warnings) ? obj.warnings.map(String) : []
  };
}

function _taskQueueMakeSummary(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return _taskQueueClipText(clean, 900);
}

function _taskQueueExtractKeyFindings(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(s => s.replace(/^[-*+•\d.、\s]+/, '').trim())
    .filter(s => s.length >= 8 && s.length <= 260);
  const picked = [];
  for (const line of lines) {
    if (picked.includes(line)) continue;
    if (/^(#{1,6}|```|---)$/.test(line)) continue;
    picked.push(line);
    if (picked.length >= 8) break;
  }
  return picked;
}

async function _taskQueueBuildDependencyContext(item) {
  const depIds = item.dependsOnTaskIds || [];
  if (!depIds.length) return '';
  const q = ensureTaskQueue();
  _taskQueueNormalizeDependencyRefs(q);
  const packages = [];
  const indexMap = _taskQueueTaskIndexMap(q);
  for (const depId of depIds) {
    const dep = q.items.find(it => it.id === depId);
    const index = indexMap.get(depId) || '?';
    if (!dep) throw new Error(`依赖任务 #${index} 不存在`);
    if (!dep.exposeOutput) throw new Error(`依赖任务 #${index}「${_taskQueueItemTitle(dep)}」没有勾选“供后续引用”`);
    if (dep.status === 'skipped') throw new Error(`依赖任务 #${index}「${_taskQueueItemTitle(dep)}」已跳过，没有输出包`);
    if (dep.status !== 'done') throw new Error(`依赖任务 #${index}「${_taskQueueItemTitle(dep)}」还没有完成输出包`);
    if (!dep.outputPackage && dep.chatId) {
      try {
        dep.outputPackage = await _taskQueueGenerateOutputPackage(dep);
        dep.outputWarning = '';
      } catch (e) {
        dep.outputPackage = _taskQueueBuildFallbackOutputPackage(dep, e);
        dep.outputWarning = '输出包生成失败，已使用简化输出包';
      }
      dep.outputUpdatedAt = Date.now();
    }
    if (!dep.outputPackage) throw new Error(`依赖任务 #${index}「${_taskQueueItemTitle(dep)}」缺少输出包`);
    packages.push(dep.outputPackage);
  }
  if (!packages.length) return '';
  return _taskQueueFormatDependencyContext(packages);
}

function _taskQueueFormatDependencyContext(packages) {
  const blocks = packages.map((pkg, idx) => {
    const evidence = pkg.evidence && pkg.evidence.length
      ? `\n依据:\n${pkg.evidence.map(x => `- ${x}`).join('\n')}`
      : '';
    const warnings = pkg.warnings && pkg.warnings.length
      ? `\n注意:\n${pkg.warnings.map(x => `- ${x}`).join('\n')}`
      : '';
    return [
      `## 依赖输出 ${idx + 1}: ${pkg.taskNo || '#' + (idx + 1)} / ${pkg.title || pkg.taskId}`,
      `状态: ${pkg.status || 'done'}`,
      pkg.summary ? `摘要:\n${pkg.summary}` : '',
      pkg.result ? `结果:\n${pkg.result}` : '',
      evidence,
      warnings
    ].filter(Boolean).join('\n');
  });
  return [
    '以下是任务队列中前序 Agent 的结构化输出包。它们只作为当前任务的背景资料；不要继承前序任务的工具权限、暂停状态、大纲状态或运行状态。',
    '',
    blocks.join('\n\n')
  ].join('\n');
}

function _taskQueueComposeTaskPrompt(item, dependencyContext) {
  const taskText = String(item.text || '').trim();
  if (!dependencyContext) return taskText;
  return `${dependencyContext}\n\n---\n\n当前任务：\n${taskText}`;
}

function _taskQueueClipText(value, maxLen) {
  const text = String(value || '').trim();
  if (!maxLen || text.length <= maxLen) return text;
  return text.slice(0, maxLen) + `\n\n...[已截断，原长度 ${text.length} 字符]`;
}

function _taskQueueStringHash(value) {
  const s = String(value || '');
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return `${s.length}:${hash}`;
}

function _taskQueueAbortItem(item, nextStatus) {
  item._requestedStatus = nextStatus;
  if (item.chatId && typeof requestStopChatTask === 'function') requestStopChatTask(item.chatId);
  if (typeof window !== 'undefined' && typeof window.cancelAutoResend === 'function') {
    try { window.cancelAutoResend(item.chatId); } catch (e) {}
  }
  if (nextStatus === 'paused') {
    item.status = 'paused';
    item.error = '已暂停';
    item.pausedAt = Date.now();
  } else if (nextStatus === 'skipped') {
    _taskQueueMarkSkipped(item);
  } else {
    item.status = 'stopped';
    item.error = '已停止';
    item.outputPackage = null;
    item.outputUpdatedAt = null;
    item.outputWarning = '';
    item.finishedAt = Date.now();
  }
}

function _taskQueueApplyRequestedOrResult(item, result) {
  if (item._requestedStatus === 'paused') {
    item.status = 'paused';
    item.error = '已暂停';
    item.pausedAt = item.pausedAt || Date.now();
  } else if (item._requestedStatus === 'skipped') {
    _taskQueueMarkSkipped(item);
  } else if (item._requestedStatus === 'stopped') {
    item.status = 'stopped';
    item.error = '已停止';
    item.outputPackage = null;
    item.outputUpdatedAt = null;
    item.outputWarning = '';
    item.finishedAt = item.finishedAt || Date.now();
  } else if (result) {
    item.status = result.status;
    item.error = result.error || '';
    if (result.status !== 'done') {
      item.outputPackage = null;
      item.outputUpdatedAt = null;
      item.outputWarning = '';
    }
  }
  delete item._requestedStatus;
}

function _taskQueueMarkSkipped(item) {
  item.status = 'skipped';
  item.error = '';
  item.outputPackage = null;
  item.outputUpdatedAt = null;
  item.outputWarning = '';
  item.skippedAt = Date.now();
  item.finishedAt = Date.now();
}

function _taskQueueValidateOrders(q) {
  _taskQueueNormalizeDependencyRefs(q);
  for (const item of q.items) {
    const order = Number(item.order);
    if (!Number.isInteger(order) || order < 1) {
      return { ok: false, error: '任务序号必须是从 1 开始的正整数' };
    }
  }
  if (!q.items.length) return { ok: true };
  const orders = Array.from(new Set(q.items.map(it => _taskQueuePositiveInt(it.order, 1)))).sort((a, b) => a - b);
  for (let i = 0; i < orders.length; i++) {
    const expected = i + 1;
    if (orders[i] !== expected) {
      return { ok: false, error: `任务序号不连续：缺少序号 ${expected}` };
    }
  }
  for (const item of q.items) {
    const parsed = _taskQueueParseIndexList(item.dependsOnTasksText || item.dependsOnTaskIndexes || []);
    if (!parsed.ok) return { ok: false, error: `任务「${_taskQueueItemTitle(item)}」依赖任务错误：${parsed.error}` };
    const ids = [];
    for (const index of parsed.indexes) {
      const dep = _taskQueueTaskAtIndex(q, index);
      if (!dep) return { ok: false, error: `任务「${_taskQueueItemTitle(item)}」依赖了不存在的任务 #${index}` };
      if (dep.id === item.id) return { ok: false, error: `任务「${_taskQueueItemTitle(item)}」不能依赖自己 #${index}` };
      if (_taskQueuePositiveInt(dep.order, 1) >= _taskQueuePositiveInt(item.order, 1)) {
        return { ok: false, error: `任务「${_taskQueueItemTitle(item)}」只能依赖更早执行顺序里的任务，不能依赖 #${index}` };
      }
      if (!dep.exposeOutput) {
        return { ok: false, error: `任务「${_taskQueueItemTitle(item)}」依赖 #${index}，但该任务没有勾选“供后续引用”` };
      }
      ids.push(dep.id);
    }
    item.dependsOnTaskIds = Array.from(new Set(ids));
    item.dependsOnTaskIndexes = _taskQueueTaskIdsToIndexes(q, item.dependsOnTaskIds);
    item.dependsOnTasksText = _taskQueueFormatIndexList(item.dependsOnTaskIndexes);
  }
  return { ok: true };
}

function _taskQueueNextRunnableOrder(q) {
  const orders = Array.from(new Set(q.items.map(it => _taskQueuePositiveInt(it.order, 1)))).sort((a, b) => a - b);
  for (const order of orders) {
    const group = q.items.filter(it => it.order === order);
    if (group.every(it => TASK_QUEUE_DONE_STATUSES.has(it.status))) continue;
    if (group.some(it => it.status === 'pending')) return order;
    return null;
  }
  return null;
}

function _taskQueueFirstBlockedOrder(q) {
  const orders = Array.from(new Set(q.items.map(it => _taskQueuePositiveInt(it.order, 1)))).sort((a, b) => a - b);
  for (const order of orders) {
    const group = q.items.filter(it => it.order === order);
    if (group.every(it => TASK_QUEUE_DONE_STATUSES.has(it.status))) continue;
    if (group.some(it => TASK_QUEUE_BLOCKING_STATUSES.has(it.status))) return order;
  }
  return null;
}

function _taskQueuePositiveInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function _taskQueueSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function _taskQueueFindItem(id) {
  const q = ensureTaskQueue();
  return q.items.find(it => it.id === id) || null;
}

// 兼容旧按钮名；新 UI 不再使用。
function pauseTaskQueue() {
  taskQueueTogglePauseAll();
}

function stopCurrentTaskAndPauseQueue() {
  taskQueueStopAll();
}
