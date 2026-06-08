// ============ 🎓 LMS 学习面板 UI ============
// 顶部 🎓 学习 按钮 → 打开抽屉面板
// 4 个标签页：📊 概览 / 📝 待办 / 📚 课程 / 📂 课件

const LMS_PANEL_STATE = {
  tab: 'overview',           // overview | todos | courses | materials
  loading: false,
  cache: {                    // 缓存上次拉取结果
    todos: null,
    courses: null,
    materialsByCid: {},
  },
  selectedCid: null,         // 当前 materials 页选中的课程 id
};

function openLmsPanel() {
  document.getElementById('lmsPanel').classList.add('show');
  lmsPanelRefreshStatus();
  lmsPanelRender();
  // 自动拉一次最新数据（如果 Cookie 有效）
  if (lmsGetCookie() && !LMS_PANEL_STATE.cache.todos) {
    lmsPanelFetchAll();
  }
}

function closeLmsPanel() {
  document.getElementById('lmsPanel').classList.remove('show');
}

function lmsPanelSetTab(tab) {
  LMS_PANEL_STATE.tab = tab;
  lmsPanelRender();
}

/**
 * 刷新顶部状态栏（Cookie 状态徽章）
 */
function lmsPanelRefreshStatus() {
  const el = document.getElementById('lmsStatusBar');
  if (!el) return;
  const cookie = lmsGetCookie();
  if (!cookie) {
    el.innerHTML = `
      <span class="lms-badge lms-badge-warn">⚠️ 未配置 Cookie</span>
      <span class="lms-status-hint">点击下方"配置 Cookie"按钮开始</span>
    `;
    return;
  }
  const info = lmsParseSession(cookie);
  if (!info) {
    // ⚠️ Cookie 已保存但解析失败（粘错了 / 缺 session 字段 / 格式有误）
    // 必须给出「修改」和「清空」入口，否则用户会被困死无法纠错。
    el.innerHTML = `
      <span class="lms-badge lms-badge-warn">⚠️ Cookie 格式异常</span>
      <span class="lms-status-hint">未找到 session 字段</span>
      <button class="lms-mini-btn" onclick="lmsPanelOpenCookieEditor()">✏️ 修改</button>
      <button class="lms-mini-btn" onclick="lmsPanelClearCookie()">🗑 清空</button>
    `;
    return;
  }
  const h = info.remainMs / 3600000;
  const uidSafe = escapeHtml(String(info.uid || '-'));
  if (h < 0) {
    el.innerHTML = `
      <span class="lms-badge lms-badge-err">⛔ 已过期 ${(-h).toFixed(1)} 小时</span>
      <button class="lms-mini-btn" onclick="lmsPanelOpenCookieEditor()">🔄 更新 Cookie</button>
    `;
  } else if (h < 2) {
    el.innerHTML = `
      <span class="lms-badge lms-badge-warn">⏰ 即将过期 ${h.toFixed(1)}h</span>
      <span class="lms-status-hint">👤 ${uidSafe}</span>
      <button class="lms-mini-btn" onclick="lmsPanelOpenCookieEditor()">🔄 更新</button>
    `;
  } else {
    el.innerHTML = `
      <span class="lms-badge lms-badge-ok">✅ Cookie 有效</span>
      <span class="lms-status-hint">👤 ${uidSafe} · 还有 ${h.toFixed(1)}h</span>
      <button class="lms-mini-btn" onclick="lmsPanelOpenCookieEditor()">✏️ 修改</button>
    `;
  }
}

/**
 * 顶层渲染：根据 tab 渲染对应内容
 */
function lmsPanelRender() {
  // 标签按钮选中态
  ['overview', 'todos', 'courses', 'materials'].forEach(t => {
    const b = document.getElementById('lmsTab_' + t);
    if (b) b.classList.toggle('active', LMS_PANEL_STATE.tab === t);
  });

  const body = document.getElementById('lmsPanelBody');
  if (!body) return;

  const _cookie = lmsGetCookie();
  if (!_cookie) {
    body.innerHTML = lmsPanelRenderNoCookie();
    return;
  }
  // 🛠 Cookie 已保存但解析失败 → 直接进入"修复模式"，避免用户被困
  if (!lmsParseSession(_cookie)) {
    body.innerHTML = lmsPanelRenderBadCookie();
    return;
  }

  switch (LMS_PANEL_STATE.tab) {
    case 'overview':  body.innerHTML = lmsPanelRenderOverview(); break;
    case 'todos':     body.innerHTML = lmsPanelRenderTodos();    break;
    case 'courses':   body.innerHTML = lmsPanelRenderCourses();  break;
    case 'materials': body.innerHTML = lmsPanelRenderMaterials();break;
  }
}

// ============ 各个标签页内容 ============

function lmsPanelRenderBadCookie() {
  // 当 Cookie 已保存但 lmsParseSession 失败时调用，提供醒目的修复入口
  const raw = lmsGetCookie();
  const preview = raw.length > 80 ? raw.slice(0, 80) + '…' : raw;
  return `
    <div class="lms-empty">
      <div class="lms-empty-icon">⚠️</div>
      <h3>Cookie 格式异常</h3>
      <p>已保存的 Cookie 字符串中找不到 <code>session=...</code> 字段，或格式不对。</p>
      <p style="font-family:Consolas,monospace;font-size:12px;background:var(--bg-input,#f5f5f5);padding:8px 12px;border-radius:6px;word-break:break-all;max-width:560px;margin:12px auto;">
        ${escapeHtml(preview) || '<em>（空）</em>'}
      </p>
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
        <button class="lms-big-btn" onclick="lmsPanelOpenCookieEditor()">✏️ 重新填写</button>
        <button class="lms-big-btn" style="background:var(--danger,#e74c3c);" onclick="lmsPanelClearCookie()">🗑 清空重来</button>
      </div>
      <div class="lms-guide">
        <h4>📝 正确的 Cookie 长这样</h4>
        <p style="font-family:Consolas,monospace;font-size:12px;">_ga=GA1.x.xxx; <strong>session=V2-1-xxxxx.yyyyy.1700000000000</strong>; ...</p>
        <p>必须包含 <code>session=</code> 开头的那一段（用 <code>copy(document.cookie)</code> 复制即可获得完整字符串）。</p>
      </div>
    </div>
  `;
}

function lmsPanelRenderNoCookie() {
  return `
    <div class="lms-empty">
      <div class="lms-empty-icon">🔐</div>
      <h3>欢迎使用学习面板</h3>
      <p>这是西安交大 LMS (lms.xjtu.edu.cn) 的可视化助手</p>
      <p>第一步：配置你的 LMS Cookie</p>
      <button class="lms-big-btn" onclick="lmsPanelOpenCookieEditor()">🔑 配置 Cookie</button>

      <div class="lms-guide">
        <h4>📝 如何获取 Cookie</h4>
        <ol>
          <li>浏览器打开并登录 <a href="https://lms.xjtu.edu.cn" target="_blank">https://lms.xjtu.edu.cn</a></li>
          <li>按 <kbd>F12</kbd> 打开开发者工具</li>
          <li>切到 <strong>Console（控制台）</strong></li>
          <li>输入 <code>copy(document.cookie)</code> 回车</li>
          <li>Cookie 已复制到剪贴板，回来粘贴即可</li>
        </ol>
      </div>
    </div>
  `;
}

function lmsPanelRenderOverview() {
  const todos = LMS_PANEL_STATE.cache.todos;
  const courses = LMS_PANEL_STATE.cache.courses;
  let html = '<div class="lms-overview">';

  // 统计卡片
  html += '<div class="lms-stat-grid">';
  html += `
    <div class="lms-stat-card">
      <div class="lms-stat-num">${courses ? courses.length : '—'}</div>
      <div class="lms-stat-lbl">📚 课程</div>
    </div>
    <div class="lms-stat-card">
      <div class="lms-stat-num">${todos ? todos.length : '—'}</div>
      <div class="lms-stat-lbl">📝 待办</div>
    </div>
  `;
  if (todos) {
    const now = Date.now();
    const urgent = todos.filter(t => {
      const end = t.end_time ? new Date(t.end_time).getTime() : 0;
      return end && end > now && end - now < 7 * 86400000;
    }).length;
    const overdue = todos.filter(t => {
      const end = t.end_time ? new Date(t.end_time).getTime() : 0;
      return end && end < now;
    }).length;
    html += `
      <div class="lms-stat-card ${urgent ? 'urgent' : ''}">
        <div class="lms-stat-num">${urgent}</div>
        <div class="lms-stat-lbl">🚨 一周内截止</div>
      </div>
      <div class="lms-stat-card ${overdue ? 'overdue' : ''}">
        <div class="lms-stat-num">${overdue}</div>
        <div class="lms-stat-lbl">⛔ 已逾期</div>
      </div>
    `;
  }
  html += '</div>';

  // 最紧急的 3 项
  if (todos && todos.length) {
    const sorted = [...todos].sort((a, b) => {
      const ea = a.end_time ? new Date(a.end_time).getTime() : Infinity;
      const eb = b.end_time ? new Date(b.end_time).getTime() : Infinity;
      return ea - eb;
    }).slice(0, 5);
    html += '<h3 class="lms-section-title">🔥 最紧急的 5 项</h3>';
    html += '<div class="lms-todo-list">';
    sorted.forEach(t => html += lmsRenderTodoCard(t));
    html += '</div>';
    html += '<div style="text-align:center;margin-top:12px;">';
    html += '<button class="lms-mini-btn" onclick="lmsPanelSetTab(\'todos\')">查看全部待办 →</button>';
    html += '</div>';
  } else {
    html += '<div class="lms-empty-mini">';
    html += '<button class="lms-big-btn" onclick="lmsPanelFetchAll()">📡 拉取最新数据</button>';
    html += '</div>';
  }

  html += '</div>';
  return html;
}

function lmsPanelRenderTodos() {
  const todos = LMS_PANEL_STATE.cache.todos;
  if (!todos) {
    return `<div class="lms-empty-mini">
      <button class="lms-big-btn" onclick="lmsPanelFetchTodos()">📡 拉取待办列表</button>
    </div>`;
  }
  if (!todos.length) {
    return `<div class="lms-empty"><div class="lms-empty-icon">🎉</div><h3>暂无未完成作业</h3></div>`;
  }
  const sorted = [...todos].sort((a, b) => {
    const ea = a.end_time ? new Date(a.end_time).getTime() : Infinity;
    const eb = b.end_time ? new Date(b.end_time).getTime() : Infinity;
    return ea - eb;
  });
  let html = `<div class="lms-toolbar">
    <span>共 <strong>${sorted.length}</strong> 项</span>
    <button class="lms-mini-btn" onclick="lmsPanelFetchTodos()">🔄 刷新</button>
  </div>`;
  html += '<div class="lms-todo-list">';
  sorted.forEach(t => html += lmsRenderTodoCard(t));
  html += '</div>';
  return html;
}

function lmsRenderTodoCard(t) {
  const end = t.end_time ? new Date(t.end_time) : null;
  const remain = lmsFmtRemain(end);
  const level = (() => {
    if (!end) return '';
    const d = end.getTime() - Date.now();
    if (d < 0) return 'overdue';
    if (d < 86400000) return 'critical';
    if (d < 3 * 86400000) return 'urgent';
    if (d < 7 * 86400000) return 'soon';
    return '';
  })();
  return `
    <div class="lms-todo-card ${level}">
      <div class="lms-todo-head">
        <span class="lms-todo-title">${escapeHtml(t.title || '?')}</span>
        <span class="lms-todo-badge">${remain}</span>
      </div>
      <div class="lms-todo-meta">
        📚 ${escapeHtml(t.course_name || '?')}
      </div>
      <div class="lms-todo-meta">
        🔴 截止：${lmsFmtTime(end)}
      </div>
      <div class="lms-todo-actions">
        <button class="lms-mini-btn" onclick="lmsPanelShowHomework(${t.id})">📖 查看详情</button>
        <a class="lms-mini-btn" href="https://lms.xjtu.edu.cn/course/${t.course_id}/homework/${t.id}" target="_blank">🔗 打开网页</a>
      </div>
    </div>
  `;
}

function lmsPanelRenderCourses() {
  const courses = LMS_PANEL_STATE.cache.courses;
  if (!courses) {
    return `<div class="lms-empty-mini">
      <button class="lms-big-btn" onclick="lmsPanelFetchCourses()">📡 拉取课程列表</button>
    </div>`;
  }
  if (!courses.length) return '<div class="lms-empty"><div class="lms-empty-icon">📚</div><h3>暂无课程</h3></div>';

  // 按学年分组
  const groups = {};
  courses.forEach(c => {
    const year = (c.academic_year && c.academic_year.name) || '其他';
    (groups[year] = groups[year] || []).push(c);
  });
  let html = `<div class="lms-toolbar">
    <span>共 <strong>${courses.length}</strong> 门</span>
    <button class="lms-mini-btn" onclick="lmsPanelFetchCourses()">🔄 刷新</button>
  </div>`;
  Object.keys(groups).sort().reverse().forEach(year => {
    html += `<h3 class="lms-section-title">📅 ${escapeHtml(year)}（${groups[year].length} 门）</h3>`;
    html += '<div class="lms-course-grid">';
    groups[year].forEach(c => {
      html += `
        <div class="lms-course-card" onclick="lmsPanelShowMaterials(${c.id})">
          <div class="lms-course-name">${escapeHtml(c.name || '?')}</div>
          <div class="lms-course-meta">
            <span>🆔 ${c.id}</span>
            ${c.credit ? `<span>💯 ${c.credit} 学分</span>` : ''}
          </div>
          <button class="lms-mini-btn" onclick="event.stopPropagation();lmsPanelShowMaterials(${c.id})">📂 查看课件</button>
        </div>
      `;
    });
    html += '</div>';
  });
  return html;
}

function lmsPanelRenderMaterials() {
  const cid = LMS_PANEL_STATE.selectedCid;
  if (!cid) {
    return `<div class="lms-empty">
      <div class="lms-empty-icon">📂</div>
      <h3>请先选择一门课程</h3>
      <p>切到「📚 课程」标签，点击任意课程查看课件</p>
      <button class="lms-big-btn" onclick="lmsPanelSetTab('courses')">前往课程列表</button>
    </div>`;
  }
  const data = LMS_PANEL_STATE.cache.materialsByCid[cid];
  if (!data) {
    return `<div class="lms-empty-mini">
      <button class="lms-big-btn" onclick="lmsPanelFetchMaterials(${cid})">📡 拉取课程 ${cid} 的课件</button>
    </div>`;
  }
  const { activities, modules } = data;
  const modName = {};
  (modules || []).forEach(m => { modName[m.id] = m.name || '未分组'; });
  const materials = (activities || []).filter(a => a.type === 'material');

  let html = `<div class="lms-toolbar">
    <span>📚 课程 <strong>${cid}</strong> · ${materials.length} 项课件</span>
    <button class="lms-mini-btn" onclick="lmsPanelFetchMaterials(${cid})">🔄 刷新</button>
    <button class="lms-mini-btn" onclick="lmsPanelSetTab('courses')">← 返回课程</button>
  </div>`;
  if (!materials.length) {
    html += '<div class="lms-empty-mini">本课程暂无课件</div>';
    return html;
  }

  const groups = {};
  materials.forEach(m => {
    const mid = m.module_id || 0;
    (groups[mid] = groups[mid] || []).push(m);
  });

  Object.keys(groups).forEach(mid => {
    html += `<h3 class="lms-section-title">📁 ${escapeHtml(modName[mid] || '未分组')}</h3>`;
    html += '<div class="lms-material-list">';
    groups[mid].forEach(m => {
      const ups = m.uploads || [];
      ups.forEach(u => {
        const dl = u.allow_download;
        // 🛡️ 把文件名作为合法 JS 字符串字面量嵌入 onclick：先 JSON.stringify 再 HTML escape
        // 避免 "escapeHtml 再当 JS 字符串" 的层级混乱
        const nameForJs = escapeHtml(JSON.stringify(u.name || ''));
        html += `
          <div class="lms-material-item">
            <div class="lms-material-icon">${dl ? '📄' : '🔒'}</div>
            <div class="lms-material-info">
              <div class="lms-material-name">${escapeHtml(m.title || '?')}</div>
              <div class="lms-material-sub">${escapeHtml(u.name || '?')} · ${lmsFmtSize(u.size)}</div>
            </div>
            <div class="lms-material-actions">
              ${dl
                ? `<button class="lms-mini-btn lms-btn-primary" onclick="lmsPanelDownload(${u.id}, ${nameForJs})">⬇️ 下载</button>`
                : `<span class="lms-locked">🔒 仅在线</span>`}
            </div>
          </div>
        `;
      });
      if (!ups.length) {
        html += `<div class="lms-material-item"><div class="lms-material-icon">📄</div>
          <div class="lms-material-info">
            <div class="lms-material-name">${escapeHtml(m.title || '?')}</div>
            <div class="lms-material-sub">_(无附件)_</div>
          </div></div>`;
      }
    });
    html += '</div>';
  });
  return html;
}

// ============ 数据拉取 ============

async function lmsPanelFetchAll() {
  await Promise.all([lmsPanelFetchTodos(), lmsPanelFetchCourses()]);
}

async function lmsPanelFetchTodos() {
  lmsPanelShowLoading('正在拉取待办列表...');
  const r = await lmsApiGet('/api/todos');
  if (r.ok) {
    LMS_PANEL_STATE.cache.todos = r.data.todo_list || [];
    toast(`✅ 已加载 ${LMS_PANEL_STATE.cache.todos.length} 项待办`);
  } else {
    toast('❌ ' + (r.message || r.error));
    if (r.error === 'COOKIE_EXPIRED') lmsPanelOpenCookieEditor();
  }
  lmsPanelRender();
  lmsPanelRefreshStatus();
}

async function lmsPanelFetchCourses() {
  lmsPanelShowLoading('正在拉取课程列表...');
  const r = await lmsApiGet('/api/my-courses');
  if (r.ok) {
    LMS_PANEL_STATE.cache.courses = r.data.courses || [];
    toast(`✅ 已加载 ${LMS_PANEL_STATE.cache.courses.length} 门课程`);
  } else {
    toast('❌ ' + (r.message || r.error));
    if (r.error === 'COOKIE_EXPIRED') lmsPanelOpenCookieEditor();
  }
  lmsPanelRender();
}

async function lmsPanelFetchMaterials(cid) {
  lmsPanelShowLoading(`正在拉取课程 ${cid} 的课件...`);
  const [ra, rm] = await Promise.all([
    lmsApiGet(`/api/courses/${cid}/activities`),
    lmsApiGet(`/api/courses/${cid}/modules`),
  ]);
  if (ra.ok) {
    LMS_PANEL_STATE.cache.materialsByCid[cid] = {
      activities: ra.data.activities || [],
      modules: (rm.ok && rm.data && rm.data.modules) || [],
    };
    toast(`✅ 课件加载完成`);
  } else {
    toast('❌ ' + (ra.message || ra.error));
  }
  lmsPanelRender();
}

async function lmsPanelShowMaterials(cid) {
  LMS_PANEL_STATE.selectedCid = cid;
  LMS_PANEL_STATE.tab = 'materials';
  lmsPanelRender();
  if (!LMS_PANEL_STATE.cache.materialsByCid[cid]) {
    await lmsPanelFetchMaterials(cid);
  }
}

async function lmsPanelShowHomework(hwId) {
  const r = await lmsApiGet(`/api/homework-activities/${hwId}`);
  if (!r.ok) {
    toast('❌ ' + (r.message || r.error));
    return;
  }
  // 渲染到模态弹窗
  const html = renderMarkdown(lmsRenderHomeworkDetail(r.data));
  document.getElementById('lmsModalContent').innerHTML = html;
  document.getElementById('lmsModal').classList.add('show');
}

function lmsPanelCloseModal() {
  document.getElementById('lmsModal').classList.remove('show');
}

async function lmsPanelDownload(uploadId, filename) {
  const msg = await lmsToolDownload(uploadId, filename);
  toast(msg.startsWith('✅') ? '✅ 下载已开始' : msg);
}

function lmsPanelShowLoading(text) {
  const body = document.getElementById('lmsPanelBody');
  if (body) {
    body.innerHTML = `<div class="lms-loading">
      <div class="lms-spinner"></div>
      <div>${escapeHtml(text || '加载中...')}</div>
    </div>`;
  }
}

// ============ Cookie 编辑器 ============

function lmsPanelOpenCookieEditor() {
  const cur = lmsGetCookie();
  document.getElementById('lmsCookieInput').value = cur;
  document.getElementById('lmsCookieModal').classList.add('show');
  // 触发解析显示
  lmsPanelCookieParse();
}

function lmsPanelCloseCookieEditor() {
  document.getElementById('lmsCookieModal').classList.remove('show');
}

function lmsPanelCookieParse() {
  const val = document.getElementById('lmsCookieInput').value.trim();
  const info = lmsParseSession(val);
  const el = document.getElementById('lmsCookieParseResult');
  if (!val) {
    el.innerHTML = '<span style="color:var(--text-secondary)">在上方粘贴 Cookie 字符串</span>';
    return;
  }
  if (!info) {
    el.innerHTML = '<span style="color:var(--danger,#e74c3c)">⚠️ 解析失败，缺少 session=... 字段或格式错误</span>';
    return;
  }
  const h = info.remainMs / 3600000;
  const status = h < 0
    ? `<span style="color:var(--danger,#e74c3c)">⛔ 已过期 ${(-h).toFixed(1)} 小时</span>`
    : `<span style="color:var(--success,#27ae60)">✅ 有效，还有 ${h.toFixed(1)} 小时</span>`;
  el.innerHTML = `
    <div>👤 用户 ID：<code>${info.uid || '?'}</code></div>
    <div>⏰ 过期时间：${lmsFmtTime(info.expireAt)}</div>
    <div>${status}</div>
  `;
}

function lmsPanelSaveCookie() {
  const val = document.getElementById('lmsCookieInput').value.trim();
  lmsSetCookie(val);
  lmsPanelCloseCookieEditor();
  lmsPanelRefreshStatus();
  lmsPanelRender();
  toast(val ? '✅ Cookie 已保存' : '🗑 Cookie 已清空');
  // 自动拉一次数据
  if (val && LMS_PANEL_STATE.tab === 'overview') {
    lmsPanelFetchAll();
  }
}

function lmsPanelClearCookie() {
  if (!confirm('确定清空 LMS Cookie 吗？')) return;
  lmsSetCookie('');
  LMS_PANEL_STATE.cache = { todos: null, courses: null, materialsByCid: {} };
  lmsPanelCloseCookieEditor();
  lmsPanelRefreshStatus();
  lmsPanelRender();
  toast('🗑 已清空');
}
