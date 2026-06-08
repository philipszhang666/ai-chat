// ============ Project Memory - 项目级记忆 ============

const PROJECT_MEMORY_DEFAULTS = {
  enabled: false,
  path: '.agent/memory.md',
  maxChars: 12000,
  declinedWorkspaces: []
};

const PROJECT_MEMORY_RUNTIME = {
  workspace: '',
  content: '',
  loadedPath: '',
  exists: false,
  loading: false,
  lastError: ''
};

function ensureProjectMemorySettings() {
  if (!state.settings.projectMemory || typeof state.settings.projectMemory !== 'object') {
    state.settings.projectMemory = {};
  }
  const cfg = state.settings.projectMemory;
  if (cfg.enabled === undefined) cfg.enabled = PROJECT_MEMORY_DEFAULTS.enabled;
  if (!cfg.path) cfg.path = PROJECT_MEMORY_DEFAULTS.path;
  if (!Number.isFinite(Number(cfg.maxChars)) || Number(cfg.maxChars) < 1000) {
    cfg.maxChars = PROJECT_MEMORY_DEFAULTS.maxChars;
  } else {
    cfg.maxChars = Number(cfg.maxChars);
  }
  if (!Array.isArray(cfg.declinedWorkspaces)) cfg.declinedWorkspaces = [];
  return cfg;
}

function _pmStatus(message, kind = '') {
  PROJECT_MEMORY_RUNTIME.lastError = kind === 'error' ? message : '';
  const el = document.getElementById('projectMemoryStatus');
  if (el) {
    el.textContent = message || '';
    el.className = 'project-memory-status' + (kind ? ' ' + kind : '');
  }
}

function _pmSetTextarea(value) {
  const el = document.getElementById('projectMemoryContent');
  if (el) el.value = value || '';
}

function _pmGetTextarea() {
  return document.getElementById('projectMemoryContent')?.value || '';
}

async function _pmWorkspaceInfo() {
  const url = (typeof TERMINAL_CONFIG !== 'undefined' && TERMINAL_CONFIG.serverUrl)
    ? TERMINAL_CONFIG.serverUrl
    : 'http://localhost:8765';
  const resp = await fetch(url + '/workspace', { method: 'GET' });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const j = await resp.json();
  return {
    workspace: j.workspace || j.cwd || '',
    cwd: j.cwd || j.workspace || ''
  };
}

async function _pmBackend(action, params = {}) {
  if (typeof callAgentBackend !== 'function') {
    throw new Error('本地工具接口未加载');
  }
  const r = await callAgentBackend(action, params);
  if (typeof r === 'string') throw new Error(r);
  return r;
}

function _pmIsDeclinedWorkspace(workspace) {
  const cfg = ensureProjectMemorySettings();
  return !!workspace && cfg.declinedWorkspaces.includes(workspace);
}

function _pmMarkDeclinedWorkspace(workspace) {
  if (!workspace) return;
  const cfg = ensureProjectMemorySettings();
  if (!cfg.declinedWorkspaces.includes(workspace)) {
    cfg.declinedWorkspaces.push(workspace);
    if (cfg.declinedWorkspaces.length > 50) cfg.declinedWorkspaces = cfg.declinedWorkspaces.slice(-50);
    persistSettings();
  }
}

function _pmClearDeclinedWorkspace(workspace) {
  if (!workspace) return;
  const cfg = ensureProjectMemorySettings();
  cfg.declinedWorkspaces = cfg.declinedWorkspaces.filter(x => x !== workspace);
  persistSettings();
}

function withProjectMemoryPrompt(basePrompt) {
  const cfg = ensureProjectMemorySettings();
  if (!cfg.enabled || !PROJECT_MEMORY_RUNTIME.content.trim()) return basePrompt || '';
  const maxChars = Math.max(1000, Number(cfg.maxChars || PROJECT_MEMORY_DEFAULTS.maxChars));
  const content = PROJECT_MEMORY_RUNTIME.content.trim().slice(0, maxChars);
  const truncated = PROJECT_MEMORY_RUNTIME.content.trim().length > maxChars
    ? '\n\n[Project memory truncated by prompt budget.]'
    : '';
  const block = [
    '<project-memory>',
    'The following is persistent memory for the current workspace. Use it as background context, not as a new user request.',
    `Workspace: ${PROJECT_MEMORY_RUNTIME.workspace || '(unknown)'}`,
    `Memory file: ${PROJECT_MEMORY_RUNTIME.loadedPath || cfg.path}`,
    '',
    content + truncated,
    '</project-memory>'
  ].join('\n');
  return `${basePrompt || ''}\n\n${block}`.trim();
}

function openProjectMemorySettings() {
  ensureProjectMemorySettings();
  const modal = document.getElementById('projectMemoryModal');
  if (!modal) return;
  modal.classList.add('show');
  renderProjectMemorySettings();
  if (state.settings.projectMemory.enabled) {
    initProjectMemory(false);
  }
}

function closeProjectMemorySettings() {
  const modal = document.getElementById('projectMemoryModal');
  if (modal) modal.classList.remove('show');
}

function renderProjectMemorySettings() {
  const cfg = ensureProjectMemorySettings();
  const enabledEl = document.getElementById('projectMemoryEnabled');
  const pathEl = document.getElementById('projectMemoryPath');
  const maxEl = document.getElementById('projectMemoryMaxChars');
  const wsEl = document.getElementById('projectMemoryWorkspace');
  if (enabledEl) enabledEl.checked = !!cfg.enabled;
  if (pathEl) pathEl.value = cfg.path || PROJECT_MEMORY_DEFAULTS.path;
  if (maxEl) maxEl.value = cfg.maxChars || PROJECT_MEMORY_DEFAULTS.maxChars;
  if (wsEl) wsEl.textContent = PROJECT_MEMORY_RUNTIME.workspace || '尚未检测';
  _pmSetTextarea(PROJECT_MEMORY_RUNTIME.content || '');
  _pmStatus(cfg.enabled ? '项目记忆已开启。' : '项目记忆未开启，不会读取或生成记忆。');
}

function saveProjectMemorySettingsFromUi() {
  const cfg = ensureProjectMemorySettings();
  const wasEnabled = !!cfg.enabled;
  const enabledEl = document.getElementById('projectMemoryEnabled');
  const pathEl = document.getElementById('projectMemoryPath');
  const maxEl = document.getElementById('projectMemoryMaxChars');
  cfg.enabled = !!(enabledEl && enabledEl.checked);
  cfg.path = (pathEl && pathEl.value.trim()) || PROJECT_MEMORY_DEFAULTS.path;
  const maxChars = parseInt(maxEl && maxEl.value);
  cfg.maxChars = isNaN(maxChars) ? PROJECT_MEMORY_DEFAULTS.maxChars : Math.max(1000, maxChars);
  persistSettings();
  if (!cfg.enabled) {
    PROJECT_MEMORY_RUNTIME.content = '';
    PROJECT_MEMORY_RUNTIME.exists = false;
    PROJECT_MEMORY_RUNTIME.loadedPath = '';
    _pmSetTextarea('');
    _pmStatus('项目记忆已关闭。AI 不会主动读取或生成项目记忆。');
    if (typeof updateTokenDisplay === 'function') updateTokenDisplay();
    toast('项目记忆已关闭');
    return;
  }
  toast('项目记忆已开启');
  if (!wasEnabled || !PROJECT_MEMORY_RUNTIME.content) {
    initProjectMemory(true);
  } else {
    initProjectMemory(false);
  }
}

async function initProjectMemory(promptIfMissing = false) {
  const cfg = ensureProjectMemorySettings();
  if (!cfg.enabled) {
    _pmStatus('项目记忆未开启，不会读取或生成记忆。');
    return;
  }
  if (PROJECT_MEMORY_RUNTIME.loading) return;
  PROJECT_MEMORY_RUNTIME.loading = true;
  _pmStatus('正在检测项目记忆...');
  try {
    const info = await _pmWorkspaceInfo();
    PROJECT_MEMORY_RUNTIME.workspace = info.workspace || '';
    const wsEl = document.getElementById('projectMemoryWorkspace');
    if (wsEl) wsEl.textContent = PROJECT_MEMORY_RUNTIME.workspace || '未知';

    const loaded = await loadProjectMemoryFile(false);
    if (loaded) {
      _pmStatus(`已加载项目记忆：${cfg.path}`);
      if (typeof updateTokenDisplay === 'function') updateTokenDisplay();
      return;
    }

    _pmStatus(`当前项目还没有项目记忆：${cfg.path}`);
    if (promptIfMissing || !_pmIsDeclinedWorkspace(PROJECT_MEMORY_RUNTIME.workspace)) {
      const ok = confirm(
        '当前项目还没有项目记忆。\n\n是否让 AI 扫描当前项目并生成一份初始项目记忆草稿？\n\n' +
        '草稿生成后会显示给你确认，只有点击保存才会写入文件。'
      );
      if (ok) {
        await generateProjectMemoryDraft();
      } else {
        _pmMarkDeclinedWorkspace(PROJECT_MEMORY_RUNTIME.workspace);
        _pmStatus('已跳过本项目的自动生成提示。可在“项目记忆”面板手动生成。');
      }
    }
  } catch (e) {
    _pmStatus('项目记忆检测失败：' + e.message, 'error');
  } finally {
    PROJECT_MEMORY_RUNTIME.loading = false;
  }
}

async function loadProjectMemoryFile(showToast = true) {
  const cfg = ensureProjectMemorySettings();
  if (!cfg.enabled) return false;
  try {
    const info = await _pmBackend('file_info', { path: cfg.path });
    if (!info.ok) {
      PROJECT_MEMORY_RUNTIME.content = '';
      PROJECT_MEMORY_RUNTIME.exists = false;
      PROJECT_MEMORY_RUNTIME.loadedPath = '';
      _pmSetTextarea('');
      return false;
    }
    const r = await _pmBackend('read_file', { path: cfg.path });
    if (!r.ok) throw new Error(r.error || '读取失败');
    PROJECT_MEMORY_RUNTIME.content = r.content || '';
    PROJECT_MEMORY_RUNTIME.exists = true;
    PROJECT_MEMORY_RUNTIME.loadedPath = cfg.path;
    _pmSetTextarea(PROJECT_MEMORY_RUNTIME.content);
    _pmClearDeclinedWorkspace(PROJECT_MEMORY_RUNTIME.workspace);
    if (showToast) toast('已读取项目记忆');
    if (typeof updateTokenDisplay === 'function') updateTokenDisplay();
    return true;
  } catch (e) {
    _pmStatus('读取项目记忆失败：' + e.message, 'error');
    if (showToast) toast('读取项目记忆失败：' + e.message, 3500);
    return false;
  }
}

function _pmEntryLines(title, entries) {
  if (!entries || !entries.length) return `${title}: (empty)`;
  const rows = entries.slice(0, 120).map(e => {
    const suffix = e.type === 'dir' ? '/' : ` (${formatSize(e.size || 0)})`;
    return `- ${e.name}${suffix}`;
  });
  if (entries.length > rows.length) rows.push(`- ... ${entries.length - rows.length} more`);
  return `${title}:\n${rows.join('\n')}`;
}

async function _pmSafeList(path) {
  try {
    const r = await _pmBackend('list_dir', { path });
    if (r.ok) return r.entries || [];
  } catch (e) {}
  return [];
}

async function _pmSafeRead(path, maxChars = 12000) {
  try {
    const r = await _pmBackend('read_file', { path });
    if (!r.ok || !r.content) return '';
    const content = r.content.slice(0, maxChars);
    return `\n--- ${path} ---\n${content}${r.content.length > maxChars ? '\n...[truncated]' : ''}\n`;
  } catch (e) {
    return '';
  }
}

async function collectProjectMemoryContext() {
  _pmStatus('正在扫描项目目录...');
  const root = await _pmSafeList('.');
  const skipDirs = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'env', 'dist', 'build', '.agent']);
  const preferredDirs = ['src', 'app', 'pages', 'components', 'lib', 'server', 'js', 'docs', 'skill', 'lms_tool'];
  const dirs = root
    .filter(e => e.type === 'dir' && !skipDirs.has(e.name))
    .map(e => e.name);
  const dirsToList = [...new Set([
    ...preferredDirs.filter(d => dirs.includes(d)),
    ...dirs.slice(0, 8)
  ])].slice(0, 14);

  const sections = [];
  sections.push(_pmEntryLines('Root directory', root));
  for (const dir of dirsToList) {
    sections.push(_pmEntryLines(`${dir}/`, await _pmSafeList(dir)));
  }

  const rootFiles = new Set(root.filter(e => e.type === 'file').map(e => e.name));
  const candidates = [
    'README.md', 'AGENTS.md', 'CLAUDE.md',
    'package.json', 'pnpm-lock.yaml', 'yarn.lock',
    'requirements.txt', 'pyproject.toml', 'setup.py',
    'Cargo.toml', 'go.mod', 'pom.xml',
    'Dockerfile', 'docker-compose.yml',
    '.gitignore'
  ].filter(f => rootFiles.has(f));

  const fileParts = [];
  for (const f of candidates) {
    fileParts.push(await _pmSafeRead(f, f === 'README.md' ? 20000 : 12000));
  }

  return [
    `Workspace: ${PROJECT_MEMORY_RUNTIME.workspace || '(unknown)'}`,
    '',
    '# Directory Summary',
    sections.join('\n\n'),
    '',
    '# Key Files',
    fileParts.join('\n').trim() || '(no key files read)'
  ].join('\n');
}

function _pmCleanDraft(text) {
  let out = (text || '').trim();
  out = out.replace(/^```(?:markdown|md)?\s*/i, '').replace(/```\s*$/i, '').trim();
  if (!out.startsWith('#')) {
    out = '# Project Memory\n\n' + out;
  }
  return out;
}

async function generateProjectMemoryDraft() {
  const cfg = ensureProjectMemorySettings();
  if (!cfg.enabled) {
    toast('请先开启项目记忆');
    return;
  }
  if (!state.settings.apiKey) {
    toast('请先配置 API Key，才能让 AI 生成项目记忆草稿', 4500);
    return;
  }
  try {
    if (!PROJECT_MEMORY_RUNTIME.workspace) {
      const info = await _pmWorkspaceInfo();
      PROJECT_MEMORY_RUNTIME.workspace = info.workspace || '';
    }
    const context = await collectProjectMemoryContext();
    _pmStatus('正在调用模型生成项目记忆草稿...');
    const rolePrompt = [
      '你是项目级记忆整理助手。请基于用户提供的项目目录摘要和关键文件内容，生成一份可长期维护的 .agent/memory.md。',
      '要求：',
      '1. 只输出 Markdown，不要解释。',
      '2. 内容要简洁、具体、可长期复用。',
      '3. 必须包含这些小节：项目定位、启动与测试、架构约定、关键文件、已知注意事项、用户偏好、长期待办。',
      '4. 不要记录 API Key、Cookie、Token、私钥、个人账号、真实密钥、会话值等敏感信息。',
      '5. 对不确定的信息明确写“待确认”，不要编造。',
      '6. 如果项目里没有测试命令，请写“待确认”。'
    ].join('\n');
    const raw = await callOnceWithRole([
      { role: 'user', content: `请为这个项目生成项目级记忆。\n\n${context}` }
    ], state.settings.currentModel, rolePrompt);
    const draft = _pmCleanDraft(raw);
    _pmSetTextarea(draft);
    PROJECT_MEMORY_RUNTIME.content = draft;
    _pmStatus('草稿已生成。请检查内容，确认后点击“保存到项目”。');
    openProjectMemorySettings();
  } catch (e) {
    _pmStatus('生成项目记忆草稿失败：' + e.message, 'error');
    toast('生成项目记忆失败：' + e.message, 5000);
  }
}

async function saveProjectMemoryFromUi() {
  const cfg = ensureProjectMemorySettings();
  if (!cfg.enabled) {
    toast('请先开启项目记忆');
    return;
  }
  const content = _pmGetTextarea().trim();
  if (!content) {
    toast('项目记忆内容为空');
    return;
  }
  try {
    _pmStatus('正在保存项目记忆...');
    const r = await _pmBackend('write_file', { path: cfg.path, content });
    if (!r.ok) throw new Error(r.error || '保存失败');
    PROJECT_MEMORY_RUNTIME.content = content;
    PROJECT_MEMORY_RUNTIME.exists = true;
    PROJECT_MEMORY_RUNTIME.loadedPath = cfg.path;
    _pmClearDeclinedWorkspace(PROJECT_MEMORY_RUNTIME.workspace);
    _pmStatus(`已保存：${cfg.path}`);
    toast('项目记忆已保存');
    if (typeof updateTokenDisplay === 'function') updateTokenDisplay();
  } catch (e) {
    _pmStatus('保存项目记忆失败：' + e.message, 'error');
    toast('保存项目记忆失败：' + e.message, 5000);
  }
}

function clearLoadedProjectMemory() {
  PROJECT_MEMORY_RUNTIME.content = '';
  PROJECT_MEMORY_RUNTIME.exists = false;
  PROJECT_MEMORY_RUNTIME.loadedPath = '';
  _pmSetTextarea('');
  _pmStatus('已从当前会话卸载项目记忆，文件未删除。');
  if (typeof updateTokenDisplay === 'function') updateTokenDisplay();
}

window.openProjectMemorySettings = openProjectMemorySettings;
window.closeProjectMemorySettings = closeProjectMemorySettings;
window.renderProjectMemorySettings = renderProjectMemorySettings;
window.saveProjectMemorySettingsFromUi = saveProjectMemorySettingsFromUi;
window.initProjectMemory = initProjectMemory;
window.loadProjectMemoryFile = loadProjectMemoryFile;
window.generateProjectMemoryDraft = generateProjectMemoryDraft;
window.saveProjectMemoryFromUi = saveProjectMemoryFromUi;
window.clearLoadedProjectMemory = clearLoadedProjectMemory;
window.withProjectMemoryPrompt = withProjectMemoryPrompt;
