// ============ MCP + Skill 集成 ============

const MCP_SKILL_DEFAULTS = {
  mcpServers: [],
  skillRoots: ['skill'],
  skills: [],
  useSkills: true
};

const LEGACY_SKILL_ROOTS = ['skills', '.skills', '.codex/skills'];

function isLegacySkillRoots(roots) {
  return Array.isArray(roots) &&
    roots.length === LEGACY_SKILL_ROOTS.length &&
    roots.every((root, i) => root === LEGACY_SKILL_ROOTS[i]);
}

let _editingMcpServerId = '';

function ensureMcpSkillSettings() {
  if (!state.settings.mcpSkill || typeof state.settings.mcpSkill !== 'object') {
    state.settings.mcpSkill = JSON.parse(JSON.stringify(MCP_SKILL_DEFAULTS));
  }
  const cfg = state.settings.mcpSkill;
  if (!Array.isArray(cfg.mcpServers)) cfg.mcpServers = [];
  const rootsWereLegacy = isLegacySkillRoots(cfg.skillRoots);
  if (!Array.isArray(cfg.skillRoots) || rootsWereLegacy) {
    cfg.skillRoots = ['skill'];
    if (rootsWereLegacy) cfg.skills = [];
  }
  if (!Array.isArray(cfg.skills)) cfg.skills = [];
  if (cfg.useSkills === undefined) cfg.useSkills = true;
  return cfg;
}

function openMcpSkillSettings() {
  ensureMcpSkillSettings();
  const modal = document.getElementById('mcpSkillModal');
  if (!modal) return;
  modal.classList.add('show');
  renderMcpServerList();
  renderSkillSettings();
  clearMcpServerForm();
}

function closeMcpSkillSettings() {
  const modal = document.getElementById('mcpSkillModal');
  if (modal) modal.classList.remove('show');
  persistSettings();
  if (typeof renderToolList === 'function') renderToolList();
  if (typeof updateTokenDisplay === 'function') updateTokenDisplay();
}

function switchMcpSkillTab(tab) {
  document.querySelectorAll('.mcp-skill-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.mcp-skill-pane').forEach(pane => {
    pane.style.display = pane.dataset.pane === tab ? 'block' : 'none';
  });
}

function normalizeMcpServer(raw) {
  const name = (raw.name || '').trim();
  const id = (raw.id || name || ('mcp_' + Date.now())).trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '') || ('mcp_' + Date.now());
  let args = raw.args || [];
  if (typeof args === 'string') {
    args = args.split('\n').map(x => x.trim()).filter(Boolean);
  }
  let env = raw.env || {};
  if (typeof env === 'string') {
    env = parseMcpEnv(env);
  }
  return {
    id,
    name: name || id,
    enabled: raw.enabled !== false,
    command: (raw.command || '').trim(),
    args,
    cwd: (raw.cwd || '').trim(),
    env
  };
}

function parseMcpEnv(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    const out = {};
    trimmed.split('\n').forEach(line => {
      const m = line.match(/^\s*([^=#]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1].trim()] = m[2].trim();
    });
    return out;
  }
}

function renderMcpServerList() {
  const cfg = ensureMcpSkillSettings();
  const el = document.getElementById('mcpServerList');
  if (!el) return;
  if (!cfg.mcpServers.length) {
    el.innerHTML = '<div style="color:var(--text-secondary);font-size:13px;padding:12px;">还没有 MCP 服务器。添加一个 stdio MCP server 后点击“同步工具”。</div>';
    return;
  }
  el.innerHTML = cfg.mcpServers.map(server => {
    const args = (server.args || []).join(' ');
    return `
      <div class="tool-item">
        <div class="tool-item-header" onclick="this.parentElement.classList.toggle('expanded')">
          <span style="font-size:18px;">🔌</span>
          <span class="tool-item-name">${escapeHtml(server.name)}</span>
          <span class="tool-item-desc">${server.enabled ? '启用' : '禁用'} · ${escapeHtml(server.command)} ${escapeHtml(args)}</span>
          <button class="tool-toggle-btn" onclick="event.stopPropagation();toggleMcpServer('${escapeHtml(server.id)}')">${server.enabled ? '停用' : '启用'}</button>
          <button class="tool-toggle-btn" onclick="event.stopPropagation();editMcpServer('${escapeHtml(server.id)}')">编辑</button>
          <button class="tool-toggle-btn" onclick="event.stopPropagation();deleteMcpServer('${escapeHtml(server.id)}')">×</button>
        </div>
        <div class="tool-item-body">
          <pre style="background:var(--bg-input);padding:8px;border-radius:6px;font-size:12px;overflow-x:auto;">${escapeHtml(JSON.stringify(server, null, 2))}</pre>
          <button class="btn" onclick="discoverMcpServer('${escapeHtml(server.id)}')">🔍 测试并列出工具</button>
        </div>
      </div>`;
  }).join('');
}

function readMcpServerForm() {
  const envText = document.getElementById('mcpServerEnv')?.value || '';
  return normalizeMcpServer({
    id: _editingMcpServerId || document.getElementById('mcpServerId')?.value || '',
    name: document.getElementById('mcpServerName')?.value || '',
    command: document.getElementById('mcpServerCommand')?.value || '',
    args: document.getElementById('mcpServerArgs')?.value || '',
    cwd: document.getElementById('mcpServerCwd')?.value || '',
    env: envText,
    enabled: document.getElementById('mcpServerEnabled')?.checked !== false
  });
}

function fillMcpServerForm(server) {
  document.getElementById('mcpServerId').value = server.id || '';
  document.getElementById('mcpServerName').value = server.name || '';
  document.getElementById('mcpServerCommand').value = server.command || '';
  document.getElementById('mcpServerArgs').value = (server.args || []).join('\n');
  document.getElementById('mcpServerCwd').value = server.cwd || '';
  document.getElementById('mcpServerEnv').value = JSON.stringify(server.env || {}, null, 2);
  document.getElementById('mcpServerEnabled').checked = server.enabled !== false;
}

function clearMcpServerForm() {
  _editingMcpServerId = '';
  const ids = ['mcpServerId', 'mcpServerName', 'mcpServerCommand', 'mcpServerArgs', 'mcpServerCwd', 'mcpServerEnv'];
  ids.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const enabled = document.getElementById('mcpServerEnabled');
  if (enabled) enabled.checked = true;
  const title = document.getElementById('mcpServerFormTitle');
  if (title) title.textContent = '添加 MCP 服务器';
}

function saveMcpServer() {
  const cfg = ensureMcpSkillSettings();
  const server = readMcpServerForm();
  if (!server.command) {
    toast('请填写 MCP server command');
    return;
  }
  const idx = cfg.mcpServers.findIndex(s => s.id === (_editingMcpServerId || server.id));
  if (idx >= 0) cfg.mcpServers[idx] = server;
  else cfg.mcpServers.push(server);
  persistSettings();
  clearMcpServerForm();
  renderMcpServerList();
  toast('已保存 MCP 服务器');
}

function editMcpServer(id) {
  const cfg = ensureMcpSkillSettings();
  const server = cfg.mcpServers.find(s => s.id === id);
  if (!server) return;
  _editingMcpServerId = id;
  fillMcpServerForm(server);
  const title = document.getElementById('mcpServerFormTitle');
  if (title) title.textContent = '编辑 MCP 服务器';
}

function deleteMcpServer(id) {
  if (!confirm('删除这个 MCP 服务器配置？已同步的工具也会移除。')) return;
  const cfg = ensureMcpSkillSettings();
  cfg.mcpServers = cfg.mcpServers.filter(s => s.id !== id);
  state.tools = state.tools.filter(t => !(t._mcp && t._mcp.serverId === id));
  persistSettings();
  persistTools();
  renderMcpServerList();
  if (typeof renderToolList === 'function') renderToolList();
}

function toggleMcpServer(id) {
  const cfg = ensureMcpSkillSettings();
  const server = cfg.mcpServers.find(s => s.id === id);
  if (!server) return;
  server.enabled = !server.enabled;
  if (server.enabled === false) {
    state.tools = state.tools.filter(t => !(t._mcp && t._mcp.serverId === id));
    persistTools();
    if (typeof renderToolList === 'function') renderToolList();
  }
  persistSettings();
  renderMcpServerList();
}

async function discoverMcpServer(id) {
  const cfg = ensureMcpSkillSettings();
  const server = cfg.mcpServers.find(s => s.id === id);
  if (!server) return;
  const box = document.getElementById('mcpSyncResult');
  if (box) box.textContent = `正在连接 ${server.name}...`;
  const r = await callAgentBackend(
    'mcp_list_tools',
    { server },
    'AI 想连接 MCP 服务器',
    `[MCP list_tools]\n${server.command} ${(server.args || []).join(' ')}`
  );
  if (typeof r === 'string') {
    if (box) box.textContent = r;
    toast(r, 4000);
    return;
  }
  if (!r.ok) {
    if (box) box.textContent = `失败：${r.error}`;
    toast('MCP 连接失败：' + r.error, 4000);
    return;
  }
  const lines = (r.tools || []).map(t => `- ${t.name}: ${t.description || ''}`).join('\n');
  if (box) box.textContent = lines || '连接成功，但没有工具。';
}

function isMcpTool(nameOrTool) {
  const tool = typeof nameOrTool === 'object' ? nameOrTool : state.tools.find(t => t.name === nameOrTool);
  return !!(tool && tool._mcp);
}

function sanitizeToolNamePart(value) {
  return String(value || 'tool')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[0-9]/, '_$&')
    .slice(0, 48) || 'tool';
}

function uniqueToolName(base, used) {
  let name = base.slice(0, 90);
  let i = 2;
  while (used.has(name)) {
    const suffix = '_' + i++;
    name = base.slice(0, 90 - suffix.length) + suffix;
  }
  used.add(name);
  return name;
}

async function syncMcpTools() {
  const cfg = ensureMcpSkillSettings();
  const enabled = cfg.mcpServers.filter(s => s.enabled !== false);
  if (!enabled.length) {
    toast('没有启用的 MCP 服务器');
    return;
  }
  const box = document.getElementById('mcpSyncResult');
  if (box) box.textContent = '正在同步 MCP 工具...';

  const used = new Set(state.tools.filter(t => !t._mcp).map(t => t.name));
  const nextTools = state.tools.filter(t => !t._mcp);
  let added = 0;
  const errors = [];

  for (const server of enabled) {
    const r = await callAgentBackend(
      'mcp_list_tools',
      { server },
      'AI 想连接 MCP 服务器',
      `[MCP list_tools]\n${server.command} ${(server.args || []).join(' ')}`
    );
    if (typeof r === 'string') {
      errors.push(`${server.name}: ${r}`);
      continue;
    }
    if (!r.ok) {
      errors.push(`${server.name}: ${r.error}`);
      continue;
    }
    for (const mt of (r.tools || [])) {
      const originalName = mt.name || 'tool';
      const name = uniqueToolName(
        `mcp_${sanitizeToolNamePart(server.id)}_${sanitizeToolNamePart(originalName)}`,
        used
      );
      nextTools.push({
        name,
        description: `[MCP:${server.name}] ${mt.description || originalName}`,
        parameters: mt.inputSchema || mt.input_schema || { type: 'object', properties: {} },
        code: `return await callMcpTool(${JSON.stringify(server.id)}, ${JSON.stringify(originalName)}, args);`,
        _mcp: {
          serverId: server.id,
          serverName: server.name,
          toolName: originalName
        }
      });
      added++;
    }
  }

  state.tools = nextTools;
  persistTools();
  if (typeof renderToolList === 'function') renderToolList();
  if (box) {
    box.textContent = `已同步 ${added} 个 MCP 工具${errors.length ? '\n\n失败：\n' + errors.join('\n') : ''}`;
  }
  toast(`已同步 ${added} 个 MCP 工具`);
}

async function callMcpTool(serverId, toolName, args) {
  const cfg = ensureMcpSkillSettings();
  const server = cfg.mcpServers.find(s => s.id === serverId);
  if (!server) return `MCP 服务器不存在：${serverId}`;
  if (server.enabled === false) return `MCP server disabled: ${server.name || serverId}`;
  const r = await callAgentBackend(
    'mcp_call_tool',
    { server, tool_name: toolName, arguments: args || {} },
    'AI 想调用 MCP 工具',
    `[MCP tool]\n服务器：${server.name}\n工具：${toolName}`
  );
  if (typeof r === 'string') return r;
  if (!r.ok) return `MCP 工具失败：${r.error || r.text || '(unknown error)'}`;
  return r.text || JSON.stringify(r.result, null, 2);
}

async function readSkill(path) {
  const r = await callAgentBackend(
    'skill_read',
    { path },
    'AI wants to read a local Skill',
    `[Skill read]\n${path || ''}`
  );
  if (typeof r === 'string') return r;
  if (!r.ok) return `Skill read failed: ${r.error || '(unknown error)'}`;
  const skill = r.skill || {};
  const content = skill.content || '';
  const truncated = skill.truncated ? '\n\n[Skill content truncated by local server]' : '';
  return `<skill name="${skill.name || skill.path || path}" path="${skill.path || path}">\n${content}${truncated}\n</skill>`;
}

function renderSkillSettings() {
  const cfg = ensureMcpSkillSettings();
  const rootsEl = document.getElementById('skillRootsText');
  if (rootsEl) rootsEl.value = (cfg.skillRoots || []).join('\n');
  const useEl = document.getElementById('skillUseEnabled');
  if (useEl) useEl.checked = !!cfg.useSkills;
  renderSkillList();
}

function saveSkillRootsFromUi() {
  const cfg = ensureMcpSkillSettings();
  const roots = (document.getElementById('skillRootsText')?.value || '')
    .split(/[\n,;]+/)
    .map(x => x.trim())
    .filter(Boolean);
  cfg.skillRoots = roots.length ? roots : ['skill'];
  const useEl = document.getElementById('skillUseEnabled');
  if (useEl) cfg.useSkills = useEl.checked;
  persistSettings();
}

async function scanSkills() {
  saveSkillRootsFromUi();
  const cfg = ensureMcpSkillSettings();
  const previous = new Map((cfg.skills || []).map(s => [s.path, !!s.enabled]));
  const box = document.getElementById('skillScanResult');
  if (box) box.textContent = '正在扫描 Skill...';
  const r = await callAgentBackend('skill_list', { roots: cfg.skillRoots });
  if (typeof r === 'string') {
    if (box) box.textContent = r;
    return;
  }
  if (!r.ok) {
    if (box) box.textContent = `扫描失败：${r.error}`;
    return;
  }
  cfg.skills = (r.skills || []).map(skill => {
    const content = skill.content || '';
    const { content: _content, ...meta } = skill;
    return {
      ...meta,
      contentPreview: content.slice(0, 4000),
      contentLength: content.length,
      enabled: previous.has(skill.path) ? previous.get(skill.path) : false
    };
  });
  persistSettings();
  renderSkillList();
  const errText = (r.errors || []).map(e => `${e.root}: ${e.error}`).join('\n');
  if (box) box.textContent = `找到 ${cfg.skills.length} 个 Skill${errText ? '\n\n部分路径跳过：\n' + errText : ''}`;
}

function renderSkillList() {
  const cfg = ensureMcpSkillSettings();
  const el = document.getElementById('skillList');
  if (!el) return;
  if (!cfg.skills.length) {
    el.innerHTML = '<div style="color:var(--text-secondary);font-size:13px;padding:12px;">还没有扫描到 Skill。Skill 目录中每个技能需要包含 SKILL.md。</div>';
    return;
  }
  el.innerHTML = cfg.skills.map(skill => {
    const pathArg = JSON.stringify(skill.path).replace(/"/g, '&quot;');
    return `
    <label class="tool-item" style="display:block;cursor:pointer;">
      <div class="tool-item-header">
        <input type="checkbox" ${skill.enabled ? 'checked' : ''} onchange="toggleSkill(${pathArg}, this.checked)">
        <span style="font-size:18px;">📚</span>
        <span class="tool-item-name">${escapeHtml(skill.name || skill.path)}</span>
        <span class="tool-item-desc">${escapeHtml(skill.description || skill.path)}</span>
      </div>
      <div class="tool-item-body">
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px;">${escapeHtml(skill.path)}${skill.truncated ? ' · 已截断' : ''}</div>
        <pre style="max-height:160px;overflow:auto;background:var(--bg-input);padding:8px;border-radius:6px;font-size:12px;">${escapeHtml(skill.contentPreview || '')}</pre>
      </div>
    </label>
  `;
  }).join('');
}

function toggleSkill(path, enabled) {
  const cfg = ensureMcpSkillSettings();
  const skill = cfg.skills.find(s => s.path === path);
  if (!skill) return;
  skill.enabled = !!enabled;
  persistSettings();
  if (typeof updateTokenDisplay === 'function') updateTokenDisplay();
}

function getActiveSkillPrompt() {
  const cfg = ensureMcpSkillSettings();
  if (!cfg.useSkills) return '';
  const active = (cfg.skills || []).filter(s => s.enabled);
  if (!active.length) return '';

  const parts = [
    'The following local Skills are enabled as a catalog. Use them only when they are relevant to the user task.',
    'Do not assume the full skill instructions are loaded. When a task matches a skill, call the read_skill tool with that skill path before applying the skill workflow.'
  ];
  let total = parts.join('\n').length;
  for (const skill of active) {
    const desc = skill.description || '';
    const len = Number.isFinite(skill.contentLength) ? ` content_chars="${skill.contentLength}"` : '';
    const truncated = skill.truncated ? ' truncated="true"' : '';
    const block = `\n<skill-ref name="${skill.name || skill.path}" path="${skill.path}"${len}${truncated}>${desc}</skill-ref>`;
    if (total + block.length > 40000) {
      parts.push('\n[Additional enabled skills omitted because the prompt budget limit was reached.]');
      break;
    }
    parts.push(block);
    total += block.length;
  }
  return parts.join('\n');
}

function withActiveSkillPrompt(basePrompt) {
  let out = basePrompt || '';
  if (typeof withProjectMemoryPrompt === 'function') {
    out = withProjectMemoryPrompt(out);
  }
  const skillPrompt = getActiveSkillPrompt();
  if (!skillPrompt) return out;
  return `${out}\n\n${skillPrompt}`.trim();
}

function getEffectiveSystemPrompt() {
  return withActiveSkillPrompt(state.settings.systemPrompt || '');
}

window.openMcpSkillSettings = openMcpSkillSettings;
window.closeMcpSkillSettings = closeMcpSkillSettings;
window.switchMcpSkillTab = switchMcpSkillTab;
window.saveMcpServer = saveMcpServer;
window.clearMcpServerForm = clearMcpServerForm;
window.editMcpServer = editMcpServer;
window.deleteMcpServer = deleteMcpServer;
window.toggleMcpServer = toggleMcpServer;
window.discoverMcpServer = discoverMcpServer;
window.syncMcpTools = syncMcpTools;
window.callMcpTool = callMcpTool;
window.readSkill = readSkill;
window.scanSkills = scanSkills;
window.saveSkillRootsFromUi = saveSkillRootsFromUi;
window.toggleSkill = toggleSkill;
window.getActiveSkillPrompt = getActiveSkillPrompt;
window.getEffectiveSystemPrompt = getEffectiveSystemPrompt;
window.withActiveSkillPrompt = withActiveSkillPrompt;
window.isMcpTool = isMcpTool;
