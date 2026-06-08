// ============ 工具管理 ============

function openTools() {
  document.getElementById('toolsModal').classList.add('show');
  renderToolList();
}

function closeTools() {
  document.getElementById('toolsModal').classList.remove('show');
  persistTools();
  updateSendBtn();
}

function renderToolList() {
  const el = document.getElementById('toolList');
  if (!state.tools.length) {
    el.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:20px;font-size:13px;">还没有工具<br><button class="btn btn-primary" style="margin-top:10px;" onclick="resetBuiltinTools()">🔄 加载内置工具</button></div>';
    updateLmsToggleBtn();
    updateGitToggleBtn();
    updatePaperToggleBtn();
    return;
  }
  
  const builtinNames = new Set((typeof BUILTIN_TOOLS !== 'undefined' ? BUILTIN_TOOLS : []).map(t => t.name));
  
  el.innerHTML = state.tools.map((t, i) => {
    const isBuiltin = builtinNames.has(t.name);
    const isLms = isLmsTool(t.name);
    const isGit = isGitTool(t.name);
    const isPaper = isPaperTool(t.name);
    const isMcp = (typeof isMcpTool === 'function') && isMcpTool(t);
    const badge = isLms
      ? '<span style="background:#9c27b0;color:white;padding:1px 6px;border-radius:8px;font-size:10px;margin-left:4px;">🎓 LMS</span>'
      : (isGit
        ? '<span style="background:#2e7d32;color:white;padding:1px 6px;border-radius:8px;font-size:10px;margin-left:4px;">💾 快照</span>'
        : (isPaper
          ? '<span style="background:#0277bd;color:white;padding:1px 6px;border-radius:8px;font-size:10px;margin-left:4px;">📚 论文</span>'
          : (isMcp
            ? '<span style="background:#455a64;color:white;padding:1px 6px;border-radius:8px;font-size:10px;margin-left:4px;">MCP</span>'
            : (isBuiltin ? '<span style="background:var(--primary);color:white;padding:1px 6px;border-radius:8px;font-size:10px;margin-left:4px;">内置</span>' : ''))));
    return `
    <div class="tool-item">
      <div class="tool-item-header" onclick="this.parentElement.classList.toggle('expanded')">
        <span style="font-size:18px;">🔧</span>
        <span class="tool-item-name">${escapeHtml(t.name)}${badge}</span>
        <span class="tool-item-desc">${escapeHtml(t.description || '')}</span>
        <button class="tool-toggle-btn" onclick="event.stopPropagation();editTool(${i})">✏️</button>
        <button class="tool-toggle-btn" onclick="event.stopPropagation();deleteTool(${i})">×</button>
      </div>
      <div class="tool-item-body">
        <pre style="background:var(--bg-input);padding:8px;border-radius:6px;font-size:12px;overflow-x:auto;">${escapeHtml(JSON.stringify(t.parameters, null, 2))}</pre>
      </div>
    </div>`;
  }).join('');
  updateLmsToggleBtn();
  updateGitToggleBtn();
  updatePaperToggleBtn();
}

// ============ 🎓 LMS 工具批量启停 ============
function isLmsTool(name) {
  return typeof name === 'string' && name.startsWith('lms_');
}

function lmsToolsEnabled() {
  return state.tools.some(t => isLmsTool(t.name));
}

function lmsToolCount() {
  // BUILTIN_TOOLS 中总共有多少个 LMS 工具
  if (typeof BUILTIN_TOOLS === 'undefined') return 0;
  return BUILTIN_TOOLS.filter(t => isLmsTool(t.name)).length;
}

function toggleLmsTools() {
  if (lmsToolsEnabled()) {
    // 禁用：从 state.tools 移除所有 lms_* 工具
    const removed = state.tools.filter(t => isLmsTool(t.name)).length;
    state.tools = state.tools.filter(t => !isLmsTool(t.name));
    persistTools();
    renderToolList();
    toast(`🔕 已禁用 ${removed} 个 LMS 工具`);
  } else {
    // 启用：从 BUILTIN_TOOLS 中把 lms_* 工具加回来
    if (typeof BUILTIN_TOOLS === 'undefined') {
      toast('未找到内置工具定义');
      return;
    }
    const lmsTools = BUILTIN_TOOLS.filter(t => isLmsTool(t.name));
    let added = 0;
    for (const tool of lmsTools) {
      if (!state.tools.some(t => t.name === tool.name)) {
        state.tools.push(JSON.parse(JSON.stringify(tool)));
        added++;
      }
    }
    persistTools();
    renderToolList();
    toast(`🎓 已启用 ${added} 个 LMS 工具`);
  }
}

function updateLmsToggleBtn() {
  const btn = document.getElementById('lmsToggleBtn');
  if (!btn) return;
  const enabled = lmsToolsEnabled();
  const total = lmsToolCount();
  if (enabled) {
    const cur = state.tools.filter(t => isLmsTool(t.name)).length;
    btn.textContent = `🔕 禁用 LMS 工具 (${cur})`;
    btn.classList.remove('btn-primary');
    btn.title = '当前 LMS 工具已启用，点击全部移除';
  } else {
    btn.textContent = `🎓 启用 LMS 工具 (${total})`;
    btn.classList.add('btn-primary');
    btn.title = '当前未启用，点击一键加入全部 LMS 工具';
  }
}

// ============ 💾 Git 快照工具批量启停 ============
// ⚠️ 注意：基础工具里有 read_note / save_note / append_note / edit_note / find_in_notes / list_notes / delete_note 
// 这些都是 note_ 或 _notes 但不是 Git 工具，所以必须用精确白名单识别
const GIT_TOOL_NAMES = ['note_status', 'note_history', 'note_diff', 'note_snapshot', 'note_restore'];

function isGitTool(name) {
  return typeof name === 'string' && GIT_TOOL_NAMES.includes(name);
}

function gitToolsEnabled() {
  return state.tools.some(t => isGitTool(t.name));
}

function gitToolCount() {
  if (typeof BUILTIN_TOOLS === 'undefined') return 0;
  return BUILTIN_TOOLS.filter(t => isGitTool(t.name)).length;
}

function toggleGitTools() {
  if (gitToolsEnabled()) {
    // 禁用：从 state.tools 移除所有 Git 工具
    const removed = state.tools.filter(t => isGitTool(t.name)).length;
    state.tools = state.tools.filter(t => !isGitTool(t.name));
    persistTools();
    renderToolList();
    toast(`🔕 已禁用 ${removed} 个版本快照工具`);
  } else {
    // 启用：从 BUILTIN_TOOLS 中把 Git 工具加回来
    if (typeof BUILTIN_TOOLS === 'undefined') {
      toast('未找到内置工具定义');
      return;
    }
    const gitTools = BUILTIN_TOOLS.filter(t => isGitTool(t.name));
    let added = 0;
    for (const tool of gitTools) {
      if (!state.tools.some(t => t.name === tool.name)) {
        state.tools.push(JSON.parse(JSON.stringify(tool)));
        added++;
      }
    }
    persistTools();
    renderToolList();
    toast(`💾 已启用 ${added} 个版本快照工具`);
  }
}

function updateGitToggleBtn() {
  const btn = document.getElementById('gitToggleBtn');
  if (!btn) return;
  const enabled = gitToolsEnabled();
  const total = gitToolCount();
  if (enabled) {
    const cur = state.tools.filter(t => isGitTool(t.name)).length;
    btn.textContent = `🔕 禁用快照工具 (${cur})`;
    btn.classList.remove('btn-primary');
    btn.title = '当前版本快照工具已启用，点击全部移除';
  } else {
    btn.textContent = `💾 启用快照工具 (${total})`;
    btn.classList.add('btn-primary');
    btn.title = '当前未启用，点击一键加入全部版本快照工具';
  }
}

// ============ 📚 论文工具批量启停 ============
const PAPER_TOOL_NAMES = ['arxiv_search', 'semantic_scholar_search', 'fetch_pdf_text'];

function isPaperTool(name) {
  return typeof name === 'string' && PAPER_TOOL_NAMES.includes(name);
}

function paperToolsEnabled() {
  return state.tools.some(t => isPaperTool(t.name));
}

function paperToolCount() {
  if (typeof BUILTIN_TOOLS === 'undefined') return 0;
  return BUILTIN_TOOLS.filter(t => isPaperTool(t.name)).length;
}

function togglePaperTools() {
  if (paperToolsEnabled()) {
    // 禁用：从 state.tools 移除所有论文工具
    const removed = state.tools.filter(t => isPaperTool(t.name)).length;
    state.tools = state.tools.filter(t => !isPaperTool(t.name));
    persistTools();
    renderToolList();
    toast(`🔕 已禁用 ${removed} 个论文工具`);
  } else {
    // 启用：从 BUILTIN_TOOLS 中把论文工具加回来
    if (typeof BUILTIN_TOOLS === 'undefined') {
      toast('未找到内置工具定义');
      return;
    }
    const paperTools = BUILTIN_TOOLS.filter(t => isPaperTool(t.name));
    let added = 0;
    for (const tool of paperTools) {
      if (!state.tools.some(t => t.name === tool.name)) {
        state.tools.push(JSON.parse(JSON.stringify(tool)));
        added++;
      }
    }
    persistTools();
    renderToolList();
    toast(`📚 已启用 ${added} 个论文工具`);
  }
}

function updatePaperToggleBtn() {
  const btn = document.getElementById('paperToggleBtn');
  if (!btn) return;
  const enabled = paperToolsEnabled();
  const total = paperToolCount();
  if (enabled) {
    const cur = state.tools.filter(t => isPaperTool(t.name)).length;
    btn.textContent = `🔕 禁用论文工具 (${cur})`;
    btn.classList.remove('btn-primary');
    btn.title = '当前论文工具已启用，点击全部移除';
  } else {
    btn.textContent = `📚 启用论文工具 (${total})`;
    btn.classList.add('btn-primary');
    btn.title = '当前未启用，点击一键加入 arXiv + Semantic Scholar + PDF 全文工具';
  }
}

function addPresetTool(key) {
  const p = PRESET_TOOLS[key];
  if (!p) return;
  if (state.tools.some(t => t.name === p.name)) {
    toast('已存在');
    return;
  }
  state.tools.push(JSON.parse(JSON.stringify(p)));
  persistTools();
  renderToolList();
  toast('✓ 已添加');
}

function addCustomTool() {
  state.editingToolIdx = -1;
  document.getElementById('te_name').value = '';
  document.getElementById('te_desc').value = '';
  document.getElementById('te_params').value = JSON.stringify({ type: 'object', properties: { input: { type: 'string' } }, required: ['input'] }, null, 2);
  document.getElementById('te_code').value = `return '收到：' + args.input;`;
  document.getElementById('toolEditModal').classList.add('show');
}

function editTool(i) {
  state.editingToolIdx = i;
  const t = state.tools[i];
  document.getElementById('te_name').value = t.name;
  document.getElementById('te_desc').value = t.description;
  document.getElementById('te_params').value = JSON.stringify(t.parameters, null, 2);
  document.getElementById('te_code').value = t.code;
  document.getElementById('toolEditModal').classList.add('show');
}

function saveToolEdit() {
  const name = document.getElementById('te_name').value.trim();
  const desc = document.getElementById('te_desc').value.trim();
  let params;
  try {
    params = JSON.parse(document.getElementById('te_params').value);
  } catch (e) {
    alert('参数 JSON 错误：' + e.message);
    return;
  }
  const code = document.getElementById('te_code').value;
  if (!name || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    alert('名称需为合法英文标识符');
    return;
  }
  const tool = { name, description: desc, parameters: params, code };
  if (state.editingToolIdx >= 0) state.tools[state.editingToolIdx] = tool;
  else {
    if (state.tools.some(t => t.name === name)) {
      alert('已存在');
      return;
    }
    state.tools.push(tool);
  }
  persistTools();
  renderToolList();
  document.getElementById('toolEditModal').classList.remove('show');
  toast('✓ 已保存');
}

function deleteTool(i) {
  if (!confirm('删除？')) return;
  state.tools.splice(i, 1);
  persistTools();
  renderToolList();
}

function clearAllTools() {
  if (!state.tools.length) return;
  if (!confirm('清空所有工具？')) return;
  state.tools = [];
  persistTools();
  renderToolList();
}

function toggleTools() {
  if (!state.tools.length) {
    toast('请先添加工具');
    openTools();
    return;
  }
  state.settings.useTools = !state.settings.useTools;
  const btn = document.getElementById('toolsBtn');
  if (state.settings.useTools) btn.classList.add('tool-active');
  else btn.classList.remove('tool-active');
  persistSettings();
  updateSendBtn();
}

function buildToolsArray(options = {}) {
  const force = !!(options && options.force);
  if ((!force && !state.settings.useTools) || !state.tools.length) return null;
  
  if (state.settings.apiFormat === 'anthropic') {
    return state.tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters
    }));
  } else if (state.settings.apiFormat === 'responses') {
    return state.tools.map(t => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }));
  } else {
    return state.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }
    }));
  }
}

// ============ 工具结果 Artifact（长输出归档）============
const TOOL_ARTIFACT_INDEX_KEY = 'aichat_tool_artifacts_index_v1';
const TOOL_ARTIFACT_ITEM_PREFIX = 'aichat_tool_artifact_v1_';
const TOOL_ARTIFACT_THRESHOLD_CHARS = 8000;
const TOOL_ARTIFACT_MAX_COUNT = 200;
const TOOL_ARTIFACT_MAX_TOTAL_CHARS = 50 * 1024 * 1024;

function _toolArtifactStore() {
  return (typeof storage !== 'undefined') ? storage : {
    get: k => localStorage.getItem(k),
    set: (k, v) => localStorage.setItem(k, v),
    remove: k => localStorage.removeItem(k)
  };
}

function _toolArtifactString(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try { return JSON.stringify(value); } catch (e) { return String(value); }
}

function _loadToolArtifactIndex() {
  try {
    const raw = _toolArtifactStore().get(TOOL_ARTIFACT_INDEX_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.warn('[tool-artifact] index load failed:', e);
    return [];
  }
}

function _saveToolArtifactIndex(index) {
  try {
    _toolArtifactStore().set(TOOL_ARTIFACT_INDEX_KEY, JSON.stringify(index || []));
  } catch (e) {
    console.warn('[tool-artifact] index save failed:', e);
  }
}

function _formatArtifactSize(chars) {
  return typeof formatSize === 'function'
    ? formatSize(chars)
    : (chars >= 1024 * 1024 ? (chars / 1024 / 1024).toFixed(2) + ' MB' : (chars / 1024).toFixed(1) + ' KB');
}

function _toolArtifactLines(text) {
  return _toolArtifactString(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function _clipToolText(text, maxChars) {
  const s = _toolArtifactString(text);
  if (s.length <= maxChars) return s;
  const head = Math.floor(maxChars * 0.48);
  const tail = Math.floor(maxChars * 0.48);
  return `${s.slice(0, head)}\n\n[中间省略 ${s.length - head - tail} 字符]\n\n${s.slice(-tail)}`;
}

function _toolArtifactPreview(lines, start, count, maxChars) {
  if (!lines.length || count <= 0) return '';
  const slice = lines.slice(start, start + count);
  const numbered = slice.map((line, i) => `${start + i + 1}: ${line}`).join('\n');
  return _clipToolText(numbered, maxChars);
}

function _toolArtifactHints(content) {
  const text = _toolArtifactString(content);
  const hints = [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      hints.push(`- JSON 顶层类型: array，条目数: ${parsed.length}`);
    } else if (parsed && typeof parsed === 'object') {
      const keys = Object.keys(parsed).slice(0, 20);
      hints.push(`- JSON 顶层类型: object，字段: ${keys.join(', ') || '无'}`);
      for (const key of ['returncode', 'exitCode', 'status', 'ok', 'error', 'stderr', 'stdout', 'path', 'checkpoint_id']) {
        if (Object.prototype.hasOwnProperty.call(parsed, key)) {
          const val = typeof parsed[key] === 'string' ? _clipToolText(parsed[key], 240) : JSON.stringify(parsed[key]);
          hints.push(`- ${key}: ${val}`);
        }
      }
    }
  } catch (e) {}
  const important = [];
  const re = /(error|failed|failure|exception|traceback|fatal|warning|失败|错误|异常|returncode|exit code|exit_code)/i;
  for (const [idx, line] of _toolArtifactLines(text).entries()) {
    if (re.test(line)) {
      important.push(`- L${idx + 1}: ${_clipToolText(line.trim(), 220)}`);
      if (important.length >= 8) break;
    }
  }
  if (important.length) {
    hints.push('- 疑似关键行:');
    hints.push(...important);
  }
  return hints.join('\n');
}

function _pruneToolArtifacts(index, keepId = '') {
  let list = Array.isArray(index) ? index.slice() : [];
  let total = list.reduce((sum, item) => sum + (Number(item.sizeChars) || 0), 0);
  const store = _toolArtifactStore();
  while (list.length > TOOL_ARTIFACT_MAX_COUNT || total > TOOL_ARTIFACT_MAX_TOTAL_CHARS) {
    let removeIdx = list.length - 1;
    while (removeIdx >= 0 && list[removeIdx] && list[removeIdx].id === keepId) removeIdx--;
    if (removeIdx < 0) break;
    const old = list.splice(removeIdx, 1)[0];
    total -= Number(old.sizeChars) || 0;
    try { store.remove(TOOL_ARTIFACT_ITEM_PREFIX + old.id); } catch (e) {}
  }
  return list;
}

function saveToolArtifact({ chatId, toolCallId, toolName, args, status, content }) {
  const text = _toolArtifactString(content);
  const now = Date.now();
  const id = `tool_art_${now}_${Math.random().toString(36).slice(2, 8)}`;
  const lines = _toolArtifactLines(text);
  const meta = {
    id,
    chatId: chatId || '',
    toolCallId: toolCallId || '',
    toolName: toolName || 'tool',
    status: status || 'success',
    sizeChars: text.length,
    lineCount: lines.length,
    createdAt: now,
    argsPreview: _clipToolText(args, 1200)
  };
  const store = _toolArtifactStore();
  store.set(TOOL_ARTIFACT_ITEM_PREFIX + id, JSON.stringify({ ...meta, content: text }));
  const index = _pruneToolArtifacts([meta, ..._loadToolArtifactIndex().filter(item => item && item.id !== id)], id);
  _saveToolArtifactIndex(index);
  return meta;
}

function exportToolArtifactsForBackup() {
  const store = _toolArtifactStore();
  const index = _loadToolArtifactIndex();
  const items = [];
  let totalChars = 0;
  let missing = 0;
  
  for (const meta of index) {
    if (!meta || !meta.id) continue;
    try {
      const raw = store.get(TOOL_ARTIFACT_ITEM_PREFIX + meta.id);
      if (!raw) {
        missing++;
        continue;
      }
      const item = JSON.parse(raw);
      const content = _toolArtifactString(item.content);
      totalChars += content.length;
      items.push({ ...item, id: item.id || meta.id, content });
    } catch (e) {
      missing++;
    }
  }
  
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    totalChars,
    missing,
    index: items.map(item => _toolArtifactMetaFromStoredItem(item)),
    items
  };
}

function _toolArtifactMetaFromStoredItem(item) {
  const content = _toolArtifactString(item && item.content);
  const lines = _toolArtifactLines(content);
  return {
    id: item.id,
    chatId: item.chatId || '',
    toolCallId: item.toolCallId || '',
    toolName: item.toolName || 'tool',
    status: item.status || 'success',
    sizeChars: Number(item.sizeChars || content.length || 0),
    lineCount: Number(item.lineCount || lines.length || 0),
    createdAt: Number(item.createdAt || Date.now()),
    argsPreview: item.argsPreview || _clipToolText(item.args || '', 1200)
  };
}

function importToolArtifactsFromBackup(payload) {
  const items = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.items) ? payload.items : []);
  const store = _toolArtifactStore();
  let index = _loadToolArtifactIndex();
  const indexedIds = new Set(index.map(item => item && item.id).filter(Boolean));
  
  let imported = 0;
  let skipped = 0;
  let invalid = 0;
  let totalChars = 0;
  
  for (const rawItem of items) {
    const item = rawItem && rawItem.item ? rawItem.item : rawItem;
    const id = String(item?.id || '').trim();
    if (!id || item?.content === undefined || item.content === null) {
      invalid++;
      continue;
    }
    const key = TOOL_ARTIFACT_ITEM_PREFIX + id;
    if (indexedIds.has(id) || store.get(key)) {
      skipped++;
      indexedIds.add(id);
      continue;
    }
    
    const content = _toolArtifactString(item.content);
    const stored = { ...item, id, content };
    const meta = _toolArtifactMetaFromStoredItem(stored);
    store.set(key, JSON.stringify({ ...meta, content }));
    index = [meta, ...index.filter(x => x && x.id !== id)];
    indexedIds.add(id);
    imported++;
    totalChars += content.length;
  }
  
  index.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  _saveToolArtifactIndex(index);
  return { imported, skipped, invalid, totalChars, total: items.length };
}

function formatArchivedToolResult(meta, content) {
  const lines = _toolArtifactLines(content);
  const head = _toolArtifactPreview(lines, 0, 80, 3200);
  const tailStart = Math.max(0, lines.length - 60);
  const tail = tailStart > 80 ? _toolArtifactPreview(lines, tailStart, 60, 2600) : '';
  const hints = _toolArtifactHints(content);
  return `[工具结果已归档]
artifact_id: ${meta.id}
tool: ${meta.toolName}
status: ${meta.status}
size: ${_formatArtifactSize(meta.sizeChars)}
lines: ${meta.lineCount}
time: ${new Date(meta.createdAt).toISOString()}

摘要:
- 工具输出超过 ${_formatArtifactSize(TOOL_ARTIFACT_THRESHOLD_CHARS)}，完整内容已保存到本地 artifact。
- 当前上下文仅保留首尾片段和可验证线索，避免长输出污染后续对话。
- 如需全文、搜索或指定行范围，请调用 read_tool_artifact，参数 artifact_id="${meta.id}"。
${hints ? '\n' + hints : ''}

--- BEGIN HEAD ---
${head}
--- END HEAD ---
${tail ? `
--- BEGIN TAIL ---
${tail}
--- END TAIL ---` : ''}`;
}

function prepareToolResultForContext({ content, toolName, toolCallId, chatId, chat, status, args } = {}) {
  const text = _toolArtifactString(content);
  if (!text || text.length <= TOOL_ARTIFACT_THRESHOLD_CHARS || toolName === 'read_tool_artifact') {
    return { content: text, archived: false };
  }
  try {
    const meta = saveToolArtifact({
      chatId: chatId || (chat && chat.id) || '',
      toolCallId,
      toolName,
      args,
      status,
      content: text
    });
    return {
      content: formatArchivedToolResult(meta, text),
      archived: true,
      artifactId: meta.id,
      artifactMeta: meta
    };
  } catch (e) {
    console.warn('[tool-artifact] archive failed:', e);
    return { content: text, archived: false, error: e.message };
  }
}

function readToolArtifact(artifactId, query, startLine, endLine, headLines, tailLines, maxChars, context = {}) {
  const id = String(artifactId || '').trim();
  if (!id) return { ok: false, error: '缺少 artifact_id' };
  let artifact;
  try {
    const raw = _toolArtifactStore().get(TOOL_ARTIFACT_ITEM_PREFIX + id);
    if (!raw) return { ok: false, error: `未找到 artifact: ${id}` };
    artifact = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `读取 artifact 失败: ${e.message}` };
  }
  const content = _toolArtifactString(artifact.content);
  const lines = _toolArtifactLines(content);
  const limit = Math.max(1000, Math.min(50000, parseInt(maxChars) || 12000));
  const header = [
    `[tool artifact] ${artifact.id}`,
    `tool: ${artifact.toolName || 'tool'}`,
    `status: ${artifact.status || 'unknown'}`,
    `size: ${_formatArtifactSize(content.length)}`,
    `lines: ${lines.length}`,
    `created_at: ${artifact.createdAt ? new Date(artifact.createdAt).toISOString() : 'unknown'}`
  ].join('\n');
  
  if (query && String(query).trim()) {
    const q = String(query).toLowerCase();
    const matches = [];
    const contextLines = 2;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].toLowerCase().includes(q)) continue;
      const from = Math.max(0, i - contextLines);
      const to = Math.min(lines.length, i + contextLines + 1);
      matches.push(lines.slice(from, to).map((line, j) => `${from + j + 1}: ${line}`).join('\n'));
      if (matches.join('\n\n').length > limit) break;
    }
    return `${header}
mode: query
query: ${query}
matches: ${matches.length}

${matches.length ? _clipToolText(matches.join('\n\n---\n\n'), limit) : '(无匹配)'}`;
  }
  
  const start = parseInt(startLine);
  const end = parseInt(endLine);
  if (!isNaN(start) || !isNaN(end)) {
    const from = Math.max(1, isNaN(start) ? 1 : start);
    const to = Math.min(lines.length, isNaN(end) ? from + 199 : end);
    const body = lines.slice(from - 1, to).map((line, i) => `${from + i}: ${line}`).join('\n');
    return `${header}
mode: line_range
range: ${from}-${to}

${_clipToolText(body, limit)}`;
  }
  
  if (content.length <= limit) {
    return `${header}
mode: full

${content}`;
  }
  
  const h = Math.max(1, Math.min(300, parseInt(headLines) || 100));
  const t = Math.max(0, Math.min(300, parseInt(tailLines) || 80));
  const head = _toolArtifactPreview(lines, 0, h, Math.floor(limit * 0.55));
  const tail = t ? _toolArtifactPreview(lines, Math.max(0, lines.length - t), t, Math.floor(limit * 0.35)) : '';
  return `${header}
mode: preview
note: 内容超过 max_chars，仅返回首尾。需要定位请传 query 或 start_line/end_line。

--- BEGIN HEAD ---
${head}
--- END HEAD ---
${tail ? `
--- BEGIN TAIL ---
${tail}
--- END TAIL ---` : ''}`;
}

function _toolContextChatId(context = {}) {
  if (typeof context === 'string') return context;
  if (context && context.chatId) return context.chatId;
  if (context && context.chat && context.chat.id) return context.chat.id;
  return (state && (state.activeTaskChatId || state.currentId)) || '';
}

function _ctxToolFn(name, context) {
  return (...fnArgs) => {
    const root = typeof window !== 'undefined' ? window : globalThis;
    const fn = root && root[name];
    if (typeof fn !== 'function') throw new Error(`tool function not loaded: ${name}`);
    return fn(...fnArgs, context);
  };
}

async function executeTool(name, args, context = {}) {
  const tool = state.tools.find(t => t.name === name);
  if (!tool) return { ok: false, value: `未找到工具：${name}` };
  try {
    const toolContext = {
      ...(context && typeof context === 'object' ? context : {}),
      chatId: _toolContextChatId(context)
    };
    if (typeof window !== 'undefined') window.__currentToolContext = toolContext;
    const scopedNames = [
      'callAgentBackend',
      'executeTerminalCommand', 'readFile', 'writeFile', 'appendFile', 'editFile', 'applyPatch', 'deleteFile',
      'readToolArtifact',
      'listCheckpoints', 'restoreCheckpoint',
      'listDir', 'searchInFiles', 'webSearch', 'fetchUrl', 'aiScreenshot', 'attachFileForAI',
      'callGit', 'aiGitStatus', 'aiGitHistory', 'aiGitDiff', 'aiGitSnapshot', 'aiGitRestore'
    ];
    const scopedFns = scopedNames.map(n => _ctxToolFn(n, toolContext));
    const fn = new Function('args', 'toolContext', ...scopedNames, `return (async () => { ${tool.code} })();`);
    const value = await fn(args, toolContext, ...scopedFns);
    if (typeof window !== 'undefined' && window.__currentToolContext === toolContext) delete window.__currentToolContext;
    return { ok: true, value };
  } catch (e) {
    if (typeof window !== 'undefined') delete window.__currentToolContext;
    return { ok: false, value: `工具出错：${e.message}` };
  }
}
