// ============ 🌿 Git 可视化管理面板（Phase 1） ============
// 【模块定位】侧边栏"⋯ 更多 → 📜 Git 管理"入口
//   功能：查看仓库状态 / 提交历史 / 文件 diff / 暂存 / 提交 / 撤销文件 / 初始化向导
// 依赖：terminal.js (callGit) / utils.js (escapeHtml/toast)
// 加载顺序：在 terminal.js 之后即可

// 当前面板状态（每次打开重新刷新）
const GIT_STATE = {
  status: null,        // {branch, ahead, behind, staged[], unstaged[], untracked[]}
  commits: [],         // 提交历史
  selectedFile: null,  // 当前选中的文件（看 diff 用）
  selectedFileSource: null, // 'unstaged' | 'staged' | 'untracked'
  selectedCommit: null, // 当前选中的提交
  loading: false,
};

// ============ 入口 / 关闭 ============
async function openGitPanel() {
  let modal = document.getElementById('gitModal');
  if (!modal) {
    modal = _buildGitModal();
    document.body.appendChild(modal);
  }
  if (!window.__SETTINGS_PAGE_DOCKING__) {
    modal.classList.add('show');
  }
  await _refreshGitPanel();
}

function closeGitPanel() {
  const m = document.getElementById('gitModal');
  if (m) m.classList.remove('show');
}

// ============ 主面板骨架 ============
function _buildGitModal() {
  const wrap = document.createElement('div');
  wrap.className = 'modal-mask git-modal';
  wrap.id = 'gitModal';
  wrap.innerHTML = `
    <div class="modal git-modal-box">
      <h2>
        <span>📜 Git 管理</span>
        <span class="git-branch-badge" id="gitBranchBadge" title="点击切换/管理分支" onclick="_toggleBranchMenu(event)"></span>
        <button class="git-btn git-btn-small" id="gitRemoteBtn" onclick="_openRemotePanel()" title="远程仓库 / 推送拉取 / 用户配置">⚙ 配置</button>
        <button class="modal-close" onclick="closeGitPanel()" style="margin-left:auto;">×</button>
      </h2>
      <div id="gitBranchMenu" class="git-branch-menu" hidden></div>
      <div id="gitBody"></div>
    </div>
  `;
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) closeGitPanel();
    // 点 menu 外关闭分支菜单
    const menu = document.getElementById('gitBranchMenu');
    const badge = document.getElementById('gitBranchBadge');
    if (menu && !menu.hidden && !menu.contains(e.target) && e.target !== badge && !badge.contains(e.target)) {
      menu.hidden = true;
    }
  });
  return wrap;
}

// ============ 主流程：先 check，再渲染对应视图 ============
async function _refreshGitPanel() {
  const body = document.getElementById('gitBody');
  if (!body) return;
  body.innerHTML = `<div class="git-loading">🔄 正在检查 Git 状态…</div>`;

  const check = await callGit('check');
  if (!check.gitInstalled) {
    body.innerHTML = `
      <div class="git-empty-state">
        <div class="git-empty-icon">⚠️</div>
        <h3>系统未安装 Git</h3>
        <p>请前往 <a href="https://git-scm.com/" target="_blank">git-scm.com</a> 下载安装。</p>
        <p class="git-hint">安装后请重启本地服务以让 PATH 生效。</p>
      </div>
    `;
    return;
  }

  // 未初始化 → 显示初始化向导
  if (!check.inRepo) {
    _renderInitWizard(check);
    return;
  }

  // 已在仓库内 → 主视图
  _setBranchBadge(check.branch || '(unknown)');
  // 提示用户名邮箱缺失
  const missingUser = !check.userName || !check.userEmail;
  body.innerHTML = `
    ${missingUser ? `
      <div class="git-warning-bar">
        ⚠️ 当前仓库未配置 user.name 或 user.email，提交时可能报错。
        <button class="git-btn-link" onclick="_showGitConfigInline()">立即配置 →</button>
      </div>
      <div id="gitConfigInline" hidden></div>
    ` : ''}
    <div class="git-main-grid">
      <div class="git-left-col">
        <div class="git-section-title">📂 工作区改动</div>
        <div id="gitChanges" class="git-changes-list"><div class="git-loading">加载中…</div></div>
        <div class="git-commit-box">
          <textarea id="gitCommitMsg" placeholder="输入提交信息..." rows="2"></textarea>
          <div class="git-commit-actions">
            <label class="git-checkbox">
              <input type="checkbox" id="gitCommitAll" checked>
              <span>包含所有未暂存改动</span>
            </label>
            <button class="git-btn git-btn-primary" onclick="_onCommit()">💬 提交</button>
          </div>
        </div>
      </div>
      <div class="git-right-col">
        <div class="git-section-title">📜 提交历史</div>
        <div id="gitHistory" class="git-history-list"><div class="git-loading">加载中…</div></div>
      </div>
      <div class="git-detail-col">
        <div class="git-section-title" id="gitDetailTitle">📄 详情</div>
        <div id="gitDetail" class="git-detail-pane">
          <div class="git-empty-state-small">
            <p>👈 选择左侧的文件或右侧的提交来查看详情</p>
          </div>
        </div>
      </div>
    </div>
  `;

  // 并行加载状态 + 历史
  await Promise.all([_loadStatus(), _loadHistory()]);
}

function _setBranchBadge(name) {
  const el = document.getElementById('gitBranchBadge');
  if (el) el.innerHTML = `🌿 ${escapeHtml(name)} ▾`;
}

// ============ 初始化向导 ============
function _renderInitWizard(checkResult) {
  const body = document.getElementById('gitBody');
  body.innerHTML = `
    <div class="git-init-wizard">
      <div class="git-init-header">
        <div class="git-empty-icon">🌱</div>
        <h3>初始化 Git 仓库</h3>
        <p>当前工作区还不是 Git 仓库。下面的设置将一次性完成初始化。</p>
      </div>
      <div class="git-init-form">
        <div class="git-form-row">
          <label>Git 用户名</label>
          <input type="text" id="initUserName" placeholder="你的名字（如 alice）" />
        </div>
        <div class="git-form-row">
          <label>Git 邮箱</label>
          <input type="email" id="initUserEmail" placeholder="me@example.com" />
        </div>
        <label class="git-form-check">
          <input type="checkbox" id="initCreateGitignore" checked>
          <span>创建 <code>.gitignore</code>（自动忽略 <code>node_modules</code> / <code>__pycache__</code> / <code>.env</code> 等）</span>
        </label>
        <label class="git-form-check">
          <input type="checkbox" id="initCreateCommit" checked>
          <span>创建初始提交（包含当前所有文件）</span>
        </label>
        <div class="git-form-row">
          <label>初始提交信息</label>
          <input type="text" id="initCommitMsg" value="Initial commit" />
        </div>
      </div>
      <div class="git-init-actions">
        <button class="git-btn git-btn-primary" onclick="_doInit()">✓ 初始化 Git 仓库</button>
      </div>
    </div>
  `;
}

async function _doInit() {
  const userName = document.getElementById('initUserName').value.trim();
  const userEmail = document.getElementById('initUserEmail').value.trim();
  const createGitignore = document.getElementById('initCreateGitignore').checked;
  const createInitialCommit = document.getElementById('initCreateCommit').checked;
  const initialCommitMessage = document.getElementById('initCommitMsg').value.trim() || 'Initial commit';
  if (!userName || !userEmail) {
    toast('⚠️ 请填写用户名和邮箱');
    return;
  }
  toast('🌱 正在初始化…');
  const r = await callGit('init', { userName, userEmail, createGitignore, createInitialCommit, initialCommitMessage });
  if (!r.ok) {
    toast('❌ 初始化失败：' + (r.error || '未知错误'), 5000);
    return;
  }
  toast('✅ Git 仓库已就绪');
  await _refreshGitPanel();
}

// ============ 状态加载与渲染 ============
async function _loadStatus() {
  const r = await callGit('status');
  const box = document.getElementById('gitChanges');
  if (!box) return;
  if (!r.ok) {
    box.innerHTML = `<div class="git-error">❌ ${escapeHtml(r.error || '加载失败')}</div>`;
    return;
  }
  GIT_STATE.status = r;
  if (r.clean) {
    box.innerHTML = `<div class="git-empty-state-small">✨ 工作区干净，没有改动</div>`;
    return;
  }
  let html = '';
  if (r.staged.length) {
    html += `<div class="git-group-header">已暂存 (${r.staged.length}) <button class="git-btn-tiny" onclick="_unstageAll()">全部取消</button></div>`;
    html += r.staged.map(f => _renderFileRow(f, 'staged')).join('');
  }
  if (r.unstaged.length) {
    html += `<div class="git-group-header">未暂存 (${r.unstaged.length}) <button class="git-btn-tiny" onclick="_stageAll()">全部暂存</button></div>`;
    html += r.unstaged.map(f => _renderFileRow(f, 'unstaged')).join('');
  }
  if (r.untracked.length) {
    html += `<div class="git-group-header">未跟踪 (${r.untracked.length}) <button class="git-btn-tiny" onclick="_stageUntracked()">全部添加</button></div>`;
    html += r.untracked.map(f => _renderFileRow(f, 'untracked')).join('');
  }
  box.innerHTML = html;
}

function _renderFileRow(f, source) {
  const statusChar = (f.status || '?').trim();
  const statusClass = ({ M: 'm', A: 'a', D: 'd', R: 'r', '?': 'u', 'U': 'c' })[statusChar] || 'm';
  const statusLabel = ({ M: '修改', A: '新增', D: '删除', R: '重命名', '?': '新文件', 'U': '冲突' })[statusChar] || statusChar;
  const isSelected = GIT_STATE.selectedFile === f.path && GIT_STATE.selectedFileSource === source;
  return `
    <div class="git-file-row ${isSelected ? 'active' : ''}" onclick="_selectFile(${JSON.stringify(f.path).replace(/"/g, '&quot;')}, '${source}')">
      <span class="git-file-status git-status-${statusClass}" title="${statusLabel}">${statusChar}</span>
      <span class="git-file-path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</span>
      <span class="git-file-actions" onclick="event.stopPropagation()">
        ${source !== 'staged' ? `<button class="git-btn-icon" title="暂存此文件" onclick="_stageOne(${JSON.stringify(f.path).replace(/"/g, '&quot;')})">+</button>` : ''}
        ${source === 'staged' ? `<button class="git-btn-icon" title="取消暂存" onclick="_unstageOne(${JSON.stringify(f.path).replace(/"/g, '&quot;')})">−</button>` : ''}
        ${source !== 'untracked' ? `<button class="git-btn-icon git-btn-danger" title="放弃此文件改动（恢复到 HEAD）" onclick="_checkoutOne(${JSON.stringify(f.path).replace(/"/g, '&quot;')})">↩</button>` : ''}
      </span>
    </div>
  `;
}

// ============ 历史加载 ============
async function _loadHistory() {
  const r = await callGit('log', { limit: 100 });
  const box = document.getElementById('gitHistory');
  if (!box) return;
  if (!r.ok) {
    box.innerHTML = `<div class="git-error">❌ ${escapeHtml(r.error || '加载失败')}</div>`;
    return;
  }
  GIT_STATE.commits = r.commits;
  if (!r.commits.length) {
    box.innerHTML = `<div class="git-empty-state-small">还没有任何提交。<br>先在左侧添加文件并提交吧～</div>`;
    return;
  }
  box.innerHTML = r.commits.map(c => _renderCommitRow(c)).join('');
}

function _renderCommitRow(c) {
  const dt = new Date(c.ts * 1000);
  const isSelected = GIT_STATE.selectedCommit === c.hash;
  return `
    <div class="git-commit-row ${isSelected ? 'active' : ''}" onclick="_selectCommit('${c.hash}')">
      <div class="git-commit-dot"></div>
      <div class="git-commit-content">
        <div class="git-commit-subject">${escapeHtml(c.subject)}</div>
        <div class="git-commit-meta">
          <code>${escapeHtml(c.shortHash)}</code>
          · ${escapeHtml(c.author)}
          · ${_relTime(dt)}
        </div>
      </div>
    </div>
  `;
}

function _relTime(d) {
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  if (diff < 86400 * 7) return Math.floor(diff / 86400) + ' 天前';
  return d.toLocaleString('zh-CN', { hour12: false });
}

// ============ 详情面板 ============
async function _selectFile(path, source) {
  GIT_STATE.selectedFile = path;
  GIT_STATE.selectedFileSource = source;
  GIT_STATE.selectedCommit = null;
  // 重渲染左侧高亮
  await _loadStatus();
  // 加载 diff
  const titleEl = document.getElementById('gitDetailTitle');
  const pane = document.getElementById('gitDetail');
  if (titleEl) titleEl.innerHTML = `📄 ${escapeHtml(path)} <span class="git-detail-sub">${source === 'staged' ? '(已暂存改动)' : source === 'untracked' ? '(未跟踪新文件)' : '(未暂存改动)'}</span>`;
  if (!pane) return;
  if (source === 'untracked') {
    pane.innerHTML = `<div class="git-diff-info">📄 未跟踪的新文件。<br><br>点击文件右侧 <code>+</code> 添加到暂存区即可。</div>`;
    return;
  }
  pane.innerHTML = `<div class="git-loading">加载 diff…</div>`;
  const mode = source === 'staged' ? 'staged' : 'working';
  const r = await callGit('diff', { mode, file: path });
  if (!r.ok) {
    pane.innerHTML = `<div class="git-error">❌ ${escapeHtml(r.error || '加载失败')}</div>`;
    return;
  }
  pane.innerHTML = `<div class="git-diff-content">${_renderDiff(r.diff || '（无 diff 输出）')}</div>`;
}

async function _selectCommit(hash) {
  GIT_STATE.selectedCommit = hash;
  GIT_STATE.selectedFile = null;
  GIT_STATE.selectedFileSource = null;
  await _loadStatus();
  await _loadHistory();
  const titleEl = document.getElementById('gitDetailTitle');
  const pane = document.getElementById('gitDetail');
  const c = GIT_STATE.commits.find(x => x.hash === hash);
  if (titleEl) titleEl.innerHTML = `📜 提交 <code>${escapeHtml((c && c.shortHash) || hash.slice(0, 8))}</code>`;
  if (!pane) return;
  pane.innerHTML = `<div class="git-loading">加载提交详情…</div>`;
  const r = await callGit('diff', { mode: 'commit', commit: hash });
  if (!r.ok) {
    pane.innerHTML = `<div class="git-error">❌ ${escapeHtml(r.error || '加载失败')}</div>`;
    return;
  }
  // 计算"如果回退到此提交会丢失几个 commit"
  const idx = GIT_STATE.commits.findIndex(x => x.hash === hash);
  const lostCount = idx > 0 ? idx : 0;  // 这之前的（更新的）commits 会被丢
  const shortHash = (c && c.shortHash) || hash.slice(0, 8);
  pane.innerHTML = `
    <div class="git-commit-actions-bar">
      <div class="git-commit-actions-title">⚠️ 版本回退操作（针对 <code>${escapeHtml(shortHash)}</code>）</div>
      <div class="git-commit-actions-row">
        <button class="git-btn git-btn-warn" onclick="_doRevert('${hash}')" title="创建一个反向提交以撤销此次改动，原历史保留">
          🔄 撤销此提交
        </button>
        <button class="git-btn git-btn-warn" onclick="_doResetMixed('${hash}', ${lostCount})" title="HEAD 移到此提交，后续 commit 丢失但改动保留在工作区">
          ⏮ 回退至此 <span class="git-act-sub">(保留改动)</span>
        </button>
        <button class="git-btn git-btn-danger" onclick="_doResetHard('${hash}', ${lostCount})" title="HEAD 移到此提交，后续 commit 和工作区改动全部丢弃">
          💥 强制重置 <span class="git-act-sub">(不可恢复)</span>
        </button>
      </div>
    </div>
    <div class="git-diff-content">${_renderDiff(r.diff || '（无内容）')}</div>
  `;
}

// 简易 diff 渲染（行级着色）
function _renderDiff(text) {
  if (!text) return '<div class="git-diff-info">（无内容）</div>';
  const lines = text.split('\n');
  const out = [];
  for (const ln of lines) {
    let cls = 'git-diff-line';
    if (ln.startsWith('diff ') || ln.startsWith('index ')) cls += ' git-diff-meta';
    else if (ln.startsWith('+++') || ln.startsWith('---')) cls += ' git-diff-file';
    else if (ln.startsWith('@@')) cls += ' git-diff-hunk';
    else if (ln.startsWith('+')) cls += ' git-diff-add';
    else if (ln.startsWith('-')) cls += ' git-diff-del';
    else if (ln.startsWith('commit ')) cls += ' git-diff-commit';
    else if (ln.startsWith('Author:') || ln.startsWith('AuthorDate:') || ln.startsWith('Commit:') || ln.startsWith('CommitDate:') || ln.startsWith('Date:')) cls += ' git-diff-author';
    out.push(`<div class="${cls}">${escapeHtml(ln) || '&nbsp;'}</div>`);
  }
  return out.join('');
}

// ============ 操作：暂存 / 取消 / 撤销 / 提交 ============
async function _stageOne(path) {
  const r = await callGit('add', { files: [path] });
  if (!r.ok) return toast('❌ ' + (r.error || ''));
  toast('✓ 已暂存');
  await _loadStatus();
}
async function _unstageOne(path) {
  const r = await callGit('unstage', { files: [path] });
  if (!r.ok) return toast('❌ ' + (r.error || ''));
  toast('✓ 已取消暂存');
  await _loadStatus();
}
async function _checkoutOne(path) {
  if (!confirm(`确定放弃文件 "${path}" 的所有改动？\n\n该文件会恢复到 HEAD 时的状态，未保存的修改将丢失。`)) return;
  const r = await callGit('checkout_file', { files: [path] });
  if (!r.ok) return toast('❌ ' + (r.error || ''));
  toast('✓ 已恢复');
  GIT_STATE.selectedFile = null;
  document.getElementById('gitDetail').innerHTML = `<div class="git-empty-state-small">已撤销，请选择其他文件</div>`;
  await _loadStatus();
}
async function _stageAll() {
  const all = (GIT_STATE.status.unstaged || []).map(f => f.path);
  if (!all.length) return;
  const r = await callGit('add', { files: all });
  if (!r.ok) return toast('❌ ' + (r.error || ''));
  toast(`✓ 已暂存 ${all.length} 个文件`);
  await _loadStatus();
}
async function _unstageAll() {
  const all = (GIT_STATE.status.staged || []).map(f => f.path);
  if (!all.length) return;
  const r = await callGit('unstage', { files: all });
  if (!r.ok) return toast('❌ ' + (r.error || ''));
  toast(`✓ 已取消 ${all.length} 个文件`);
  await _loadStatus();
}
async function _stageUntracked() {
  const all = (GIT_STATE.status.untracked || []).map(f => f.path);
  if (!all.length) return;
  const r = await callGit('add', { files: all });
  if (!r.ok) return toast('❌ ' + (r.error || ''));
  toast(`✓ 已添加 ${all.length} 个新文件`);
  await _loadStatus();
}

async function _onCommit() {
  const msgEl = document.getElementById('gitCommitMsg');
  const msg = (msgEl.value || '').trim();
  if (!msg) {
    toast('⚠️ 请输入提交信息');
    msgEl.focus();
    return;
  }
  const all = document.getElementById('gitCommitAll').checked;
  const r = await callGit('commit', { message: msg, all });
  if (!r.ok) {
    toast('❌ 提交失败：' + (r.error || ''), 5000);
    return;
  }
  toast('✅ 已提交');
  msgEl.value = '';
  await Promise.all([_loadStatus(), _loadHistory()]);
}

// ============ 内联配置（user.name / user.email）============
function _showGitConfigInline() {
  const box = document.getElementById('gitConfigInline');
  if (!box) return;
  box.hidden = false;
  box.innerHTML = `
    <div class="git-inline-config">
      <div class="git-form-row">
        <label>Git 用户名</label>
        <input type="text" id="cfgUserName" placeholder="alice" />
      </div>
      <div class="git-form-row">
        <label>Git 邮箱</label>
        <input type="email" id="cfgUserEmail" placeholder="me@example.com" />
      </div>
      <div class="git-form-actions">
        <button class="git-btn git-btn-primary" onclick="_saveGitConfig()">保存</button>
        <button class="git-btn" onclick="document.getElementById('gitConfigInline').hidden=true">取消</button>
      </div>
    </div>
  `;
  // 预填当前值
  callGit('config_get', { key: 'user.name' }).then(r => {
    if (r.ok && r.value) document.getElementById('cfgUserName').value = r.value;
  });
  callGit('config_get', { key: 'user.email' }).then(r => {
    if (r.ok && r.value) document.getElementById('cfgUserEmail').value = r.value;
  });
}

async function _saveGitConfig() {
  const name = document.getElementById('cfgUserName').value.trim();
  const email = document.getElementById('cfgUserEmail').value.trim();
  if (!name || !email) return toast('⚠️ 请填写完整');
  const r1 = await callGit('config_set', { key: 'user.name', value: name });
  const r2 = await callGit('config_set', { key: 'user.email', value: email });
  if (!r1.ok || !r2.ok) return toast('❌ 保存失败');
  toast('✓ 已保存');
  await _refreshGitPanel();
}

// ============ 全局导出（Phase 1）============
window.openGitPanel = openGitPanel;
window.closeGitPanel = closeGitPanel;
window._selectFile = _selectFile;
window._selectCommit = _selectCommit;
window._stageOne = _stageOne;
window._unstageOne = _unstageOne;
window._checkoutOne = _checkoutOne;
window._stageAll = _stageAll;
window._unstageAll = _unstageAll;
window._stageUntracked = _stageUntracked;
window._onCommit = _onCommit;
window._doInit = _doInit;
window._showGitConfigInline = _showGitConfigInline;
window._saveGitConfig = _saveGitConfig;

// ============================================================
// ============ 🆕 Phase 2：版本回退 / 分支 / 远程 / 推送 ============
// ============================================================

// ---------- 通用：危险操作确认弹窗（要求输入"我确定"）----------
// opts = { title, intro, lossList[], extraHtml, confirmWord='我确定', danger=true }
// 返回 Promise<boolean>
function _confirmDangerous(opts) {
  return new Promise((resolve) => {
    const word = opts.confirmWord || '我确定';
    const id = 'gitDangerModal_' + Date.now();
    const lossHtml = (opts.lossList && opts.lossList.length)
      ? `<div class="git-danger-loss">
           <div class="git-danger-loss-title">将丢失：</div>
           <ul>${opts.lossList.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>
         </div>`
      : '';
    const dlg = document.createElement('div');
    dlg.className = 'modal-mask git-modal git-danger-mask';
    dlg.id = id;
    dlg.innerHTML = `
      <div class="modal git-danger-box ${opts.danger ? 'danger' : 'warn'}">
        <h3>${opts.danger ? '⚠️ 危险操作确认' : '🟡 操作确认'}</h3>
        <div class="git-danger-title">${escapeHtml(opts.title || '')}</div>
        ${opts.intro ? `<div class="git-danger-intro">${escapeHtml(opts.intro)}</div>` : ''}
        ${lossHtml}
        ${opts.extraHtml || ''}
        ${opts.danger ? `<div class="git-danger-warn">❗ 此操作不可撤销！</div>` : ''}
        <div class="git-danger-input-label">请输入 <code>${escapeHtml(word)}</code> 以继续：</div>
        <input type="text" class="git-danger-input" autocomplete="off" placeholder="${escapeHtml(word)}" />
        <div class="git-danger-actions">
          <button class="git-btn" data-act="cancel">取消</button>
          <button class="git-btn git-btn-confirm-danger" data-act="ok" disabled>继续</button>
        </div>
      </div>
    `;
    document.body.appendChild(dlg);
    requestAnimationFrame(() => dlg.classList.add('show'));
    const input = dlg.querySelector('.git-danger-input');
    const okBtn = dlg.querySelector('[data-act="ok"]');
    const cancelBtn = dlg.querySelector('[data-act="cancel"]');
    const close = (ok) => {
      dlg.classList.remove('show');
      setTimeout(() => dlg.remove(), 200);
      document.removeEventListener('keydown', onKey);
      resolve(ok);
    };
    input.addEventListener('input', () => {
      okBtn.disabled = input.value.trim() !== word;
    });
    okBtn.addEventListener('click', () => { if (!okBtn.disabled) close(true); });
    cancelBtn.addEventListener('click', () => close(false));
    dlg.addEventListener('click', (e) => { if (e.target === dlg) close(false); });
    const onKey = (e) => {
      if (e.key === 'Escape') close(false);
      if (e.key === 'Enter' && !okBtn.disabled) close(true);
    };
    document.addEventListener('keydown', onKey);
    setTimeout(() => input.focus(), 50);
  });
}

// ---------- 版本回退三连 ----------
async function _doRevert(hash) {
  const shortHash = hash.slice(0, 8);
  const ok = await _confirmDangerous({
    title: `撤销提交 ${shortHash}`,
    intro: '将创建一个新的反向提交以抵消此次改动。原有 commit 历史保留。',
    danger: false,
  });
  if (!ok) return;
  toast('🔄 正在撤销…');
  const r = await callGit('revert', { commit: hash });
  if (!r.ok) {
    toast('❌ 撤销失败：' + (r.error || ''), 6000);
    return;
  }
  toast('✅ 已生成反向提交');
  await _refreshGitPanel();
}

async function _doResetMixed(hash, lostCount) {
  const shortHash = hash.slice(0, 8);
  const losses = [];
  for (let i = 0; i < Math.min(lostCount, 5); i++) {
    const c = GIT_STATE.commits[i];
    if (!c) break;
    losses.push(`${c.shortHash}  ${c.subject}`);
  }
  if (lostCount > 5) losses.push(`...还有 ${lostCount - 5} 个`);
  const ok = await _confirmDangerous({
    title: `回退到 ${shortHash}（保留改动）`,
    intro: `HEAD 将移到此提交，之后的 ${lostCount} 个 commit 会消失，但改动会保留在工作区，可重新提交。`,
    lossList: losses.length ? losses : [`无 commit 会被丢失（HEAD 已在此处）`],
    danger: lostCount > 0,
  });
  if (!ok) return;
  toast('⏮ 正在回退…');
  const r = await callGit('reset_mixed', { commit: hash, confirm: '我确定' });
  if (!r.ok) {
    toast('❌ 回退失败：' + (r.error || ''), 6000);
    return;
  }
  toast('✅ 已回退（改动保留在工作区）');
  await _refreshGitPanel();
}

async function _doResetHard(hash, lostCount) {
  const shortHash = hash.slice(0, 8);
  const losses = [];
  for (let i = 0; i < Math.min(lostCount, 5); i++) {
    const c = GIT_STATE.commits[i];
    if (!c) break;
    losses.push(`commit ${c.shortHash}  ${c.subject}`);
  }
  if (lostCount > 5) losses.push(`...还有 ${lostCount - 5} 个 commit`);
  // 工作区改动也会丢
  if (GIT_STATE.status) {
    const dirty = (GIT_STATE.status.staged || []).length
                + (GIT_STATE.status.unstaged || []).length
                + (GIT_STATE.status.untracked || []).length;
    if (dirty > 0) losses.push(`${dirty} 个工作区改动文件`);
  }
  const ok = await _confirmDangerous({
    title: `强制重置到 ${shortHash}`,
    intro: '所有列出的内容将永久丢失！',
    lossList: losses.length ? losses : ['（无明显损失，但仍是危险操作）'],
    danger: true,
  });
  if (!ok) return;
  toast('💥 正在强制重置…');
  const r = await callGit('reset_hard', { commit: hash, confirm: '我确定' });
  if (!r.ok) {
    toast('❌ 重置失败：' + (r.error || ''), 6000);
    return;
  }
  toast('✅ 已重置');
  await _refreshGitPanel();
}

// ---------- 分支下拉菜单 ----------
async function _toggleBranchMenu(evt) {
  if (evt) evt.stopPropagation();
  const menu = document.getElementById('gitBranchMenu');
  if (!menu) return;
  if (!menu.hidden) { menu.hidden = true; return; }
  menu.innerHTML = `<div class="git-loading" style="padding:12px;">加载分支…</div>`;
  menu.hidden = false;
  const r = await callGit('branch_list');
  if (!r.ok) {
    menu.innerHTML = `<div class="git-error">❌ ${escapeHtml(r.error || '')}</div>`;
    return;
  }
  const branches = r.branches || [];
  const itemsHtml = branches.map(b => `
    <div class="git-branch-item ${b.current ? 'current' : ''}" data-name="${escapeHtml(b.name)}">
      <span class="git-branch-mark">${b.current ? '◉' : '○'}</span>
      <span class="git-branch-name">${escapeHtml(b.name)}</span>
      ${b.upstream ? `<span class="git-branch-upstream">→ ${escapeHtml(b.upstream)}</span>` : ''}
      ${b.current ? `<span class="git-branch-tag">当前</span>` : `
        <span class="git-branch-row-actions">
          <button class="git-btn-tiny git-branch-switch-btn" type="button">切换</button>
          <button class="git-btn-tiny git-btn-danger git-branch-delete-btn" type="button">删除</button>
        </span>
      `}
    </div>
  `).join('');
  menu.innerHTML = `
    ${itemsHtml || '<div class="git-empty-state-small" style="padding:12px;">（无分支）</div>'}
    <div class="git-branch-divider"></div>
    <div class="git-branch-item action" onclick="_doBranchCreate()"><span>➕</span><span>新建分支…</span></div>
    <div class="git-branch-item action" onclick="_doBranchRename()"><span>✏️</span><span>重命名当前分支…</span></div>
  `;
  // 点条目本身（不在按钮上）= 切换
  menu.querySelectorAll('.git-branch-item[data-name]').forEach(el => {
    el.addEventListener('click', (e) => {
      // 已是当前分支不做事
      if (el.classList.contains('current')) return;
      // 按钮事件已 stopPropagation，这里走切换
      if (e.target.tagName === 'BUTTON') return;
      _doBranchSwitch(el.getAttribute('data-name'));
    });
  });
  menu.querySelectorAll('.git-branch-switch-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = e.currentTarget.closest('.git-branch-item[data-name]');
      if (item) _doBranchSwitch(item.getAttribute('data-name'));
    });
  });
  menu.querySelectorAll('.git-branch-delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = e.currentTarget.closest('.git-branch-item[data-name]');
      if (item) _doBranchDelete(item.getAttribute('data-name'), false);
    });
  });
}

async function _doBranchSwitch(name) {
  document.getElementById('gitBranchMenu').hidden = true;
  // 检查工作区是否脏
  const st = GIT_STATE.status;
  const dirty = st && ((st.staged||[]).length || (st.unstaged||[]).length || (st.untracked||[]).length);
  if (dirty) {
    const ok = await _confirmDangerous({
      title: `切换到分支 ${name}`,
      intro: '当前工作区有未提交的改动。如果新分支会修改相同文件，git 会拒绝切换。\n继续将由 git 决定是否能切换，必要时请先提交或还原。',
      danger: false,
      confirmWord: '我确定',
    });
    if (!ok) return;
  }
  toast('🌿 切换分支…');
  const r = await callGit('branch_switch', { name });
  if (!r.ok) {
    toast('❌ 切换失败：' + (r.error || ''), 6000);
    return;
  }
  toast(`✅ 已切换到 ${name}`);
  await _refreshGitPanel();
}

async function _doBranchCreate() {
  document.getElementById('gitBranchMenu').hidden = true;
  const name = (prompt('新分支名（字母数字 _ - . /）：') || '').trim();
  if (!name) return;
  if (!/^[A-Za-z0-9_\-./]+$/.test(name)) {
    toast('❌ 分支名格式不合法');
    return;
  }
  toast('🌱 创建并切换…');
  const r = await callGit('branch_create', { name });
  if (!r.ok) {
    toast('❌ 创建失败：' + (r.error || ''), 6000);
    return;
  }
  toast(`✅ 已切换到新分支 ${name}`);
  await _refreshGitPanel();
}

async function _doBranchRename() {
  document.getElementById('gitBranchMenu').hidden = true;
  const cur = GIT_STATE.status && GIT_STATE.status.branch || '';
  const next = (prompt(`重命名当前分支「${cur}」为：`, cur) || '').trim();
  if (!next || next === cur) return;
  if (!/^[A-Za-z0-9_\-./]+$/.test(next)) {
    toast('❌ 分支名格式不合法');
    return;
  }
  const r = await callGit('branch_rename', { new: next });
  if (!r.ok) {
    toast('❌ 重命名失败：' + (r.error || ''), 6000);
    return;
  }
  toast(`✅ 已重命名为 ${next}`);
  await _refreshGitPanel();
}

async function _doBranchDelete(name, force) {
  const ok = await _confirmDangerous({
    title: `${force ? '强制' : ''}删除分支 ${name}`,
    intro: force
      ? '即使此分支有未合并的 commit 也会被强制删除，可能导致改动永久丢失！'
      : '若分支未合并到当前分支，git 会拒绝删除（可勾选强制）。',
    danger: force,
  });
  if (!ok) return;
  const r = await callGit('branch_delete', { name, force, confirm: force ? '我确定' : '' });
  if (!r.ok) {
    // 未合并 → 提示是否要强制
    if (r.notMerged && !force) {
      if (confirm(`分支「${name}」尚未合并，普通删除会丢失改动。\n\n是否改用强制删除（-D）？`)) {
        return _doBranchDelete(name, true);
      }
      return;
    }
    toast('❌ 删除失败：' + (r.error || ''), 6000);
    return;
  }
  toast(`✅ 分支 ${name} 已删除`);
  // 重新打开菜单显示最新列表
  await _refreshGitPanel();
}

// ---------- ⚙ 配置面板：用户/远程/推送拉取 ----------
async function _openRemotePanel() {
  let dlg = document.getElementById('gitRemotePanel');
  if (dlg) dlg.remove();
  dlg = document.createElement('div');
  dlg.id = 'gitRemotePanel';
  dlg.className = 'modal-mask git-modal';
  dlg.innerHTML = `
    <div class="modal git-remote-box">
      <h2>
        <span>⚙ Git 配置</span>
        <button class="modal-close" onclick="document.getElementById('gitRemotePanel').remove()" style="margin-left:auto;">×</button>
      </h2>
      <div class="git-remote-body" id="gitRemoteBody">
        <div class="git-loading">加载中…</div>
      </div>
    </div>
  `;
  document.body.appendChild(dlg);
  requestAnimationFrame(() => dlg.classList.add('show'));
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.remove();
  });
  await _refreshRemotePanel();
}

async function _refreshRemotePanel() {
  const body = document.getElementById('gitRemoteBody');
  if (!body) return;
  // 并行拿：用户配置 + 远程列表 + 当前分支
  const [uname, uemail, rl, st] = await Promise.all([
    callGit('config_get', { key: 'user.name' }),
    callGit('config_get', { key: 'user.email' }),
    callGit('remote_list'),
    callGit('status'),
  ]);
  const remotes = (rl && rl.remotes) || [];
  const branch = (st && st.branch) || '';
  const ahead = (st && st.ahead) || 0;
  const behind = (st && st.behind) || 0;
  const hasOrigin = remotes.find(r => r.name === 'origin');
  body.innerHTML = `
    <!-- 用户信息 -->
    <section class="git-remote-section">
      <h3>👤 用户信息（git config）</h3>
      <div class="git-form-row"><label>用户名</label><input id="cfgRpUserName" value="${escapeHtml((uname && uname.value) || '')}" placeholder="alice" /></div>
      <div class="git-form-row"><label>邮箱</label><input id="cfgRpUserEmail" value="${escapeHtml((uemail && uemail.value) || '')}" placeholder="me@example.com" /></div>
      <div class="git-form-actions"><button class="git-btn git-btn-primary" onclick="_savePanelUser()">💾 保存</button></div>
    </section>

    <!-- 远程仓库 -->
    <section class="git-remote-section">
      <h3>🌐 远程仓库</h3>
      ${remotes.length ? `
        <table class="git-remote-table">
          <thead><tr><th>名称</th><th>URL</th><th></th></tr></thead>
          <tbody>${remotes.map(r => `
            <tr data-remote-name="${escapeHtml(r.name)}" data-remote-url="${escapeHtml(r.url)}">
              <td><code>${escapeHtml(r.name)}</code></td>
              <td><span class="git-remote-url" title="${escapeHtml(r.url)}">${escapeHtml(r.url)}</span></td>
              <td>
                <button class="git-btn-tiny git-remote-edit-btn" type="button">✏️</button>
                <button class="git-btn-tiny git-btn-danger git-remote-remove-btn" type="button">🗑</button>
              </td>
            </tr>
          `).join('')}</tbody>
        </table>
      ` : `<div class="git-empty-state-small">（暂无远程仓库）</div>`}
      <div class="git-remote-add-row">
        <input id="newRemoteName" placeholder="名称（如 origin）" />
        <input id="newRemoteUrl" placeholder="https://github.com/you/repo.git 或 git@github.com:you/repo.git" />
        <button class="git-btn git-btn-primary" onclick="_addRemote()">➕ 添加</button>
      </div>
    </section>

    <!-- 同步 -->
    <section class="git-remote-section">
      <h3>⬆⬇ 同步</h3>
      <div class="git-sync-status">
        当前分支：<code>${escapeHtml(branch || '(未知)')}</code>
        ${ahead ? `<span class="git-sync-ahead">↑${ahead}</span>` : ''}
        ${behind ? `<span class="git-sync-behind">↓${behind}</span>` : ''}
      </div>
      <div class="git-sync-actions">
        <button class="git-btn git-btn-primary" ${hasOrigin ? '' : 'disabled'} onclick="_doPush(false)">⬆️ 推送 origin/${escapeHtml(branch || '?')}</button>
        <button class="git-btn" ${hasOrigin ? '' : 'disabled'} onclick="_doPull()">⬇️ 拉取</button>
        <button class="git-btn" ${hasOrigin ? '' : 'disabled'} onclick="_doFetch()">🔄 抓取 (fetch)</button>
        <button class="git-btn git-btn-warn" ${hasOrigin ? '' : 'disabled'} onclick="_doPush(true)" title="--force-with-lease，比强制推送安全">⚡ 强制推送</button>
      </div>
      <div id="gitSyncLog" class="git-sync-log" hidden></div>
    </section>

    <!-- 凭证 -->
    <section class="git-remote-section">
      <h3>🔐 凭证</h3>
      <div class="git-cred-info">
        本面板 <b>不存任何 token / 密码</b>，全部交给系统 git credential helper。<br/>
        推送/拉取需要登录时，会弹出系统对话框。推荐方式：
        <ul>
          <li><b>SSH Key</b>（最稳）— 使用 <code>git@github.com:...</code> 形式的 URL</li>
          <li><b>GitHub Personal Access Token</b> — 当 https:// 推送时作为密码粘贴</li>
          <li><b>GitHub CLI</b> — 终端运行 <code>gh auth login</code> 自动配置</li>
        </ul>
        <button class="git-btn-link" onclick="_showCredHelp()">📖 查看详细教程</button>
      </div>
    </section>
  `;
  body.querySelectorAll('.git-remote-edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const row = e.currentTarget.closest('tr[data-remote-name]');
      if (row) _editRemoteUrl(row.dataset.remoteName || '', row.dataset.remoteUrl || '');
    });
  });
  body.querySelectorAll('.git-remote-remove-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const row = e.currentTarget.closest('tr[data-remote-name]');
      if (row) _removeRemote(row.dataset.remoteName || '');
    });
  });
}

async function _savePanelUser() {
  const name = document.getElementById('cfgRpUserName').value.trim();
  const email = document.getElementById('cfgRpUserEmail').value.trim();
  if (!name || !email) return toast('⚠️ 请填写完整');
  const r1 = await callGit('config_set', { key: 'user.name', value: name });
  const r2 = await callGit('config_set', { key: 'user.email', value: email });
  if (!r1.ok || !r2.ok) return toast('❌ 保存失败');
  toast('✅ 已保存');
}

async function _addRemote() {
  const name = document.getElementById('newRemoteName').value.trim();
  const url = document.getElementById('newRemoteUrl').value.trim();
  if (!name || !url) return toast('⚠️ 请填写名称和 URL');
  const r = await callGit('remote_add', { name, url });
  if (!r.ok) return toast('❌ ' + (r.error || ''), 5000);
  toast('✅ 已添加');
  await _refreshRemotePanel();
}

async function _editRemoteUrl(name, oldUrl) {
  const url = (prompt(`修改 ${name} 的 URL：`, oldUrl) || '').trim();
  if (!url || url === oldUrl) return;
  const r = await callGit('remote_set_url', { name, url });
  if (!r.ok) return toast('❌ ' + (r.error || ''), 5000);
  toast('✅ 已更新');
  await _refreshRemotePanel();
}

async function _removeRemote(name) {
  const ok = await _confirmDangerous({
    title: `删除远程 ${name}`,
    intro: '只移除本地对该远程的引用，不会影响远程服务器上的代码。',
    danger: false,
  });
  if (!ok) return;
  const r = await callGit('remote_remove', { name });
  if (!r.ok) return toast('❌ ' + (r.error || ''), 5000);
  toast('✅ 已删除');
  await _refreshRemotePanel();
}

function _syncLog(msg, isError) {
  const box = document.getElementById('gitSyncLog');
  if (!box) return;
  box.hidden = false;
  box.className = 'git-sync-log' + (isError ? ' error' : '');
  box.textContent = msg;
}

async function _doPush(force) {
  const branch = (GIT_STATE.status && GIT_STATE.status.branch) || '';
  if (!branch) return toast('❌ 无法确定当前分支');
  // 🔍 先扫敏感信息
  toast('🔍 扫描敏感信息…');
  const scan = await callGit('scan_diff', { remote: 'origin', branch });
  if (scan.ok && scan.findings && scan.findings.length) {
    const ok = await _showSensitiveWarning(scan.findings, force);
    if (!ok) return;
  }
  // 强制推送 → 再确认一次
  if (force) {
    const ok = await _confirmDangerous({
      title: `强制推送 origin/${branch}`,
      intro: '将使用 --force-with-lease：仅当远程没有你不知道的新提交时才允许覆盖。仍可能影响协作者，请确认无他人正在使用同一分支。',
      danger: true,
    });
    if (!ok) return;
  }
  _syncLog('⬆️ 推送中…', false);
  const r = await callGit('push', {
    remote: 'origin',
    branch,
    forceWithLease: force,
    confirm: force ? '我确定' : '',
  });
  if (!r.ok) {
    _syncLog('❌ 推送失败：\n' + (r.error || ''), true);
    if (r.authFailed) {
      _syncLog((r.error || '') + '\n\n👉 看起来是凭证问题，点上面的「📖 查看详细教程」获取帮助。', true);
    }
    return;
  }
  _syncLog('✅ 推送成功\n\n' + (r.output || ''), false);
  toast('✅ 已推送');
  await _refreshRemotePanel();
}

async function _doPull() {
  const branch = (GIT_STATE.status && GIT_STATE.status.branch) || '';
  _syncLog('⬇️ 拉取中…', false);
  const r = await callGit('pull', { remote: 'origin', branch });
  if (!r.ok) {
    _syncLog('❌ 拉取失败：\n' + (r.error || ''), true);
    return;
  }
  _syncLog('✅ 拉取成功\n\n' + (r.output || ''), false);
  toast('✅ 已拉取');
  await _refreshRemotePanel();
}

async function _doFetch() {
  _syncLog('🔄 抓取中…', false);
  const r = await callGit('fetch', { remote: 'origin' });
  if (!r.ok) {
    _syncLog('❌ 抓取失败：\n' + (r.error || ''), true);
    return;
  }
  _syncLog('✅ 抓取完成\n\n' + (r.output || '(无更新)'), false);
  await _refreshRemotePanel();
}

// ---------- 敏感信息警告 ----------
function _showSensitiveWarning(findings, isForce) {
  return new Promise((resolve) => {
    // 按文件分组
    const byFile = {};
    for (const f of findings) {
      const k = f.file || '(未知文件)';
      if (!byFile[k]) byFile[k] = [];
      byFile[k].push(f);
    }
    const fileBlocks = Object.entries(byFile).map(([file, list]) => `
      <div class="git-sensitive-file">
        <div class="git-sensitive-file-name">📄 ${escapeHtml(file)}</div>
        ${list.map(f => `
          <div class="git-sensitive-item">
            <span class="git-sensitive-type">${escapeHtml(f.type)}</span>
            ${f.line ? `<span class="git-sensitive-line">L${f.line}</span>` : ''}
            <div class="git-sensitive-desc">${escapeHtml(f.desc)}</div>
            ${f.matched ? `<div class="git-sensitive-match">匹配：<code>${escapeHtml(f.matched)}</code></div>` : ''}
            <div class="git-sensitive-snippet">${escapeHtml((f.snippet || '').slice(0, 200))}</div>
          </div>
        `).join('')}
      </div>
    `).join('');
    const extraHtml = `
      <div class="git-sensitive-summary">
        检测到 <b>${findings.length}</b> 处潜在敏感信息（在将要推送的改动中）：
      </div>
      <div class="git-sensitive-list">${fileBlocks}</div>
      <div class="git-sensitive-tips">
        💡 <b>建议</b>：
        <ul>
          <li>把含密钥的文件加进 <code>.gitignore</code>，用环境变量替代</li>
          <li>用 <code>git rm --cached</code> 把已暂存的敏感文件移除</li>
          <li>若已提交过敏感信息，请 <b>立刻轮换该密钥</b>（推送公网即视作泄露）</li>
        </ul>
      </div>
    `;
    _confirmDangerous({
      title: `推送前敏感信息检查`,
      intro: '在即将推送的改动中发现潜在敏感凭证。是否仍要推送？',
      extraHtml,
      danger: true,
    }).then(resolve);
  });
}

// ---------- 凭证教程 ----------
function _showCredHelp() {
  const dlg = document.createElement('div');
  dlg.className = 'modal-mask git-modal';
  dlg.innerHTML = `
    <div class="modal git-help-box">
      <h2><span>🔐 GitHub 凭证配置教程</span>
        <button class="modal-close" onclick="this.closest('.modal-mask').remove()" style="margin-left:auto;">×</button>
      </h2>
      <div class="git-help-body">
        <h3>方式 ① SSH Key（推荐，一次配好永久免密）</h3>
        <ol>
          <li>终端运行：<code>ssh-keygen -t ed25519 -C "你的邮箱"</code> 一路回车</li>
          <li>查看公钥：<code>cat ~/.ssh/id_ed25519.pub</code>（Windows 在 <code>%USERPROFILE%\\.ssh\\</code>）</li>
          <li>登录 GitHub → Settings → SSH and GPG keys → New SSH key → 粘贴公钥</li>
          <li>把远程 URL 改成 <code>git@github.com:用户名/仓库.git</code></li>
        </ol>
        <h3>方式 ② Personal Access Token（PAT）</h3>
        <ol>
          <li>GitHub → Settings → Developer settings → Personal access tokens → Generate new token</li>
          <li>勾 <code>repo</code> 权限 → 生成 → 复制（只能看一次）</li>
          <li>首次推送时，账号填用户名，密码栏 <b>粘贴这个 Token</b></li>
          <li>系统 credential helper 会自动记住</li>
        </ol>
        <h3>方式 ③ GitHub CLI（最省事）</h3>
        <ol>
          <li>安装 <a href="https://cli.github.com/" target="_blank">GitHub CLI</a></li>
          <li>终端运行：<code>gh auth login</code> 按提示走完</li>
          <li>完成，所有 git 命令自动鉴权</li>
        </ol>
      </div>
    </div>
  `;
  document.body.appendChild(dlg);
  requestAnimationFrame(() => dlg.classList.add('show'));
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.remove(); });
}

// 末尾追加导出
window._toggleBranchMenu = _toggleBranchMenu;
window._doBranchSwitch = _doBranchSwitch;
window._doBranchCreate = _doBranchCreate;
window._doBranchRename = _doBranchRename;
window._doBranchDelete = _doBranchDelete;
window._doRevert = _doRevert;
window._doResetMixed = _doResetMixed;
window._doResetHard = _doResetHard;
window._openRemotePanel = _openRemotePanel;
window._refreshRemotePanel = _refreshRemotePanel;
window._savePanelUser = _savePanelUser;
window._addRemote = _addRemote;
window._editRemoteUrl = _editRemoteUrl;
window._removeRemote = _removeRemote;
window._doPush = _doPush;
window._doPull = _doPull;
window._doFetch = _doFetch;
window._showCredHelp = _showCredHelp;
