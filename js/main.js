// ============ 初始化入口 ============

async function init() {
  // ⭐ 0. 先把 IndexedDB 灌入内存缓存（含 localStorage 旧数据自动迁移）
  //    所有后续 storage.get/set 都是同步走内存，但必须等这次异步加载完成
  if (typeof idbInit === 'function') {
    try { await idbInit(); }
    catch (e) { console.error('[init] idbInit 失败，将继续使用 localStorage 兜底', e); }
  }

  // ⭐ 0.1 trace.js 在模块加载时已 loadTraces() 过一次（那时 IDB 还没就绪），
  //       这里 IDB 就绪后再 load 一次，确保拿到 IndexedDB 里的真实数据
  if (typeof loadTraces === 'function') {
    try { loadTraces(); } catch (e) {}
  }

  // ⭐ 0.2 terminal.js 在模块加载时已读过 token/perms（同样在 IDB 就绪前），
  //       这里 IDB 就绪后强制刷一遍
  if (typeof TERMINAL_CONFIG !== 'undefined' && typeof storage !== 'undefined') {
    try {
      const tk = storage.get('aichat_terminal_token_v1');
      if (tk) TERMINAL_CONFIG.token = tk;
      const permsRaw = storage.get('aichat_terminal_perms_v1');
      if (permsRaw) {
        try { TERMINAL_CONFIG.permanentAllow = JSON.parse(permsRaw) || {}; } catch (e) {}
      }
    } catch (e) {}
  }

  // 1. 加载本地数据
  loadData();
  const recoveredTimers = (typeof recoverInterruptedMsgTimers === 'function') ? recoverInterruptedMsgTimers() : false;
  if (typeof registerMsgTimerExitRecovery === 'function') registerMsgTimerExitRecovery();
  if (recoveredTimers && typeof saveData === 'function') saveData();
  if (typeof loadTaskQueue === 'function') {
    loadTaskQueue();
  }
  
  // 2. 应用主题
  applyTheme();
  
  // 3. 刷新模型下拉框
  refreshModelSelect();
  
  // 4. 渲染聊天列表和消息
  renderChatList();
  renderMessages();
  
  // 5. 恢复各按钮的激活状态
  if (state.settings.useTools) {
    const btn = document.getElementById('toolsBtn');
    if (btn) btn.classList.add('tool-active');
  }
  if (state.settings.useReflection) {
    const btn = document.getElementById('reflectBtn');
    if (btn) btn.classList.add('reflect-active');
  }
  if (state.settings.usePlan) {
    const btn = document.getElementById('planBtn');
    if (btn) btn.classList.add('plan-active');
  }
  if (state.settings.useOutline) {
    const btn = document.getElementById('outlineBtn');
    if (btn) btn.classList.add('outline-active');
  }
  
  // 6. 更新底部状态信息
  updateSendBtn();
  
  // 7. 更新 URL 预览
  updateTopUrlPreview();
  
  // ⭐ 7.5 启动时检测沙箱目录，并每 30s 心跳一次
  if (typeof refreshWorkspaceInfo === 'function') {
    refreshWorkspaceInfo();
    setInterval(refreshWorkspaceInfo, 30000);
  }
  
  // ⭐ 7.5.1 本地代理自检：双击 HTML 打开（file://）时，浏览器对 https 跨域几乎必死
  //         → 启动时主动测一下：① 本地服务在不在？② 有没有 token？③ 代理开关有没有开？
  //         三样齐全才能保证 fetch 真的不会撞 CORS。任何一项缺失都直接帮用户补上。
  (async function autoSetupLocalProxy() {
    try {
      const tc = (typeof TERMINAL_CONFIG !== 'undefined') ? TERMINAL_CONFIG : null;
      if (!tc || !tc.serverUrl) return;
      // ① 服务在不在
      let serverAlive = false;
      try {
        const r = await fetch(tc.serverUrl + '/workspace', { method: 'GET' });
        serverAlive = r.ok;
      } catch (e) { serverAlive = false; }
      if (!serverAlive) {
        console.warn('[自检] 本地服务未启动（http://localhost:8765），LLM 请求若遇 CORS 将无法绕过');
        if (typeof toast === 'function') toast('⚠️ 本地服务未启动，遇到 CORS 时无法绕过\n请运行 python local_terminal_server.py', 5000);
        return;
      }
      // ② token 有没有
      if (!tc.token && typeof fetchTerminalToken === 'function') {
        console.log('[自检] 自动拉取 token…');
        await fetchTerminalToken(true);
      }
      // ③ 代理开关默认开启（state.js 里默认就是 true，但用户可能手动关过 → 不强改）
      if (state.settings.useLocalProxy && tc.token) {
        console.log('[自检] ✅ 本地代理已就绪');
      } else if (!state.settings.useLocalProxy) {
        console.log('[自检] ℹ️ 本地代理开关未开启（设置面板里可打开）');
      } else if (!tc.token) {
        console.warn('[自检] ⚠️ 本地代理开启了但 token 没拿到');
      }
    } catch (e) {
      console.warn('[自检] 异常:', e);
    }
  })();
  
  // ⭐ 7.6 消息计时器心跳：每 250ms 刷新一次进行中消息的等待/耗时显示
  // 只改 timer 节点的 textContent，不重渲染整条消息，零卡顿
  if (typeof tickMsgTimers === 'function') {
    setInterval(tickMsgTimers, 250);
  }
  
  // 8. 更新 Token 显示
  if (typeof updateTokenDisplay === 'function') updateTokenDisplay();

  // ⭐ 8.5 项目记忆：只有显式开启后才检测/读取/生成
  if (typeof initProjectMemory === 'function') {
    setTimeout(() => initProjectMemory(false), 800);
  }
  
  // ⭐ 9. 初始化请求频率管理
  if (typeof loadRateLimiter === 'function') {
    loadRateLimiter();
    updateRateDisplay();
  }
  
  // 10. 输入框自适应高度
  const input = document.getElementById('input');
  if (input) {
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 200) + 'px';
      clearTimeout(window._tokenUpdateTimer);
      window._tokenUpdateTimer = setTimeout(() => {
        if (typeof updateTokenDisplay === 'function') updateTokenDisplay();
      }, 300);
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        onSend();
      }
    });
  }
  
  // 11. 监听导入文本框变化
  const importTa = document.getElementById('importText');
  if (importTa) importTa.addEventListener('input', parseAndPreviewImport);
  
  // 12. ESC 键关闭模态框
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      // ⭐ 顺序：先关最上层（图片预览、终端确认）→ 普通模态 → LMS 抽屉
      const modals = [
        'imgPreview', 'termConfirmMask',
        'toolEditModal', 'backupModal', 'projectMemoryModal', 'mcpSkillModal', 'toolsModal', 'reflectionModal',
        'planModal', 'outlineModal', 'taskQueueModal', 'settingsModal', 'jsonEditorModal',
        'rateSettingsModal', 'tokenDetailModal', 'permissionsModal',
        'lmsCookieModal', 'lmsModal'
      ];
      for (const id of modals) {
        const el = document.getElementById(id);
        if (el && el.classList.contains('show')) {
          el.classList.remove('show');
          return;
        }
      }
      // 上面没关掉任何模态 → 再尝试关 LMS 抽屉
      const lmsPanel = document.getElementById('lmsPanel');
      if (lmsPanel && lmsPanel.classList.contains('show')) {
        lmsPanel.classList.remove('show');
      }
    }
  });
  
  // 13. 移动端"更多"菜单切换
  document.addEventListener('click', e => {
    const wrap = document.querySelector('.more-menu-wrap');
    if (!wrap) return;
    if (e.target.closest('.more-btn')) {
      wrap.classList.toggle('open');
    } else if (!e.target.closest('.more-menu')) {
      wrap.classList.remove('open');
    }
  });
  
  // 14. 拖拽和粘贴支持
  setupDrag();
  setupPaste();
  
  // ⭐ 15. 安装 Trace 钩子（fetch + executeTool 自动插桩）
  if (typeof installTraceHooks === 'function') {
    installTraceHooks();
    if (typeof renderTracePanel === 'function') renderTracePanel();
  }
  
  console.log('🚀 AI Chat 已启动');
  console.log('📦 已加载工具:', state.tools.length);
  console.log('💬 已有对话:', state.chats.length);
}

// 启动应用
init();

// ============ 🩺 浏览器控制台调试工具 ============
// 用法：在浏览器 F12 控制台输入  debugLLM()  即可查看完整链路状态
window.debugLLM = async function() {
  const log = (...a) => console.log('%c[debugLLM]', 'color:#0a7', ...a);
  const err = (...a) => console.log('%c[debugLLM]', 'color:#c33', ...a);
  console.log('═══════════ 🩺 LLM 链路自检 ═══════════');
  
  // 1. 当前页面环境
  log('1️⃣ 页面 Origin:', location.origin, location.protocol === 'file:' ? '(file:// 双击打开)' : '');
  
  // 2. 设置
  const s = state.settings;
  log('2️⃣ baseUrl:', s.baseUrl);
  log('   apiPath:', s.apiPath);
  log('   model  :', s.currentModel);
  log('   stream :', s.stream);
  log('   useLocalProxy:', s.useLocalProxy ? '✅ 已开启' : '❌ 未开启');
  log('   apiKey :', s.apiKey ? s.apiKey.slice(0, 8) + '...' + s.apiKey.slice(-4) : '❌ 未填写');
  
  // 3. 本地服务
  const tc = (typeof TERMINAL_CONFIG !== 'undefined') ? TERMINAL_CONFIG : null;
  if (!tc) { err('❌ TERMINAL_CONFIG 未定义'); return; }
  log('3️⃣ 本地服务 URL:', tc.serverUrl);
  log('   Token:', tc.token ? '✅ 已有 (' + tc.token.length + ' 字符)' : '❌ 未拉取');
  try {
    const r = await fetch(tc.serverUrl + '/workspace');
    if (r.ok) {
      const j = await r.json();
      log('   服务状态: ✅ 在线，workspace=' + j.workspace);
    } else {
      err('   服务状态: ❌ HTTP ' + r.status);
    }
  } catch (e) {
    err('   服务状态: ❌ 连不上 —— 请运行 python local_terminal_server.py');
    err('   错误:', e.message);
    return;
  }
  
  // 4. 自动拉 token（若没有）
  if (!tc.token && typeof fetchTerminalToken === 'function') {
    log('4️⃣ 正在自动拉取 Token…');
    await fetchTerminalToken(true);
    log('   Token 拉取结果:', tc.token ? '✅' : '❌');
  }
  
  // 5. 走代理实际发一条
  log('5️⃣ 尝试通过本地代理发送测试请求…');
  const url = buildFullUrl(s.baseUrl, s.apiPath);
  const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s.apiKey };
  const body = { model: s.currentModel, messages: [{ role: 'user', content: 'reply OK' }], max_tokens: 10, stream: false };
  try {
    const r = await fetch(tc.serverUrl + '/llm-proxy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Token': tc.token,
        'X-Target-Url': url,
        'X-Target-Headers': JSON.stringify(headers)
      },
      body: JSON.stringify(body)
    });
    const txt = await r.text();
    log('   HTTP:', r.status);
    log('   响应:', txt.slice(0, 300));
    if (r.ok) {
      log('✅ 全链路通！前端如果还报错，请清浏览器缓存重试（Ctrl+Shift+R）');
    } else {
      err('❌ 代理返回非 200');
    }
  } catch (e) {
    err('❌ 代理请求异常:', e.message);
  }
  console.log('═══════════════════════════════════════');
};
console.log('%c💡 调试提示: 遇到问题在控制台输入 debugLLM() 即可自检', 'color:#888');
