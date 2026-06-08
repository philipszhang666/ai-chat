// ============ 工具权限管理面板 ============

function openPermissions() {
  document.getElementById('permissionsModal').classList.add('show');
  renderPermissionsList();
  renderTaskPermissionsList();
}

function closePermissions() {
  document.getElementById('permissionsModal').classList.remove('show');
}

function renderPermissionsList() {
  const container = document.getElementById('permissionsList');
  if (!container) return;
  if (typeof PERMISSION_CATEGORIES === 'undefined') {
    container.innerHTML = '<div style="color:var(--danger)">⚠️ terminal.js 未加载</div>';
    return;
  }
  
  const perms = (TERMINAL_CONFIG && TERMINAL_CONFIG.permanentAllow) || {};
  
  container.innerHTML = Object.entries(PERMISSION_CATEGORIES).map(([key, info]) => {
    const granted = !!perms[key];
    return `
      <label class="perm-item">
        <input type="checkbox" ${granted ? 'checked' : ''} 
               onchange="onTogglePermission('${key}', this.checked)">
        <div class="perm-item-info">
          <div class="perm-item-title">${info.icon} ${info.label}</div>
          <div class="perm-item-desc">${info.desc}</div>
        </div>
        <span class="perm-item-badge ${granted ? 'granted' : 'denied'}">
          ${granted ? '✓ 已允许' : '需确认'}
        </span>
      </label>
    `;
  }).join('');
}

function renderTaskPermissionsList() {
  const container = document.getElementById('taskPermissionsList');
  if (!container) return;
  const taskAllow = (typeof getTaskAllowForChat === 'function')
    ? getTaskAllowForChat(state.currentId)
    : ((TERMINAL_CONFIG && TERMINAL_CONFIG.taskAllow) || {});
  const keys = Object.keys(taskAllow);
  
  if (keys.length === 0) {
    container.innerHTML = '<span class="perm-task-empty">（暂无任务级临时授权）</span>';
    return;
  }
  
  container.innerHTML = keys.map(k => {
    const info = PERMISSION_CATEGORIES[k];
    return `<span class="perm-task-chip">${info ? info.icon + ' ' + info.label : k}</span>`;
  }).join('') + ' <button class="btn" style="padding:2px 10px;font-size:11px;margin-left:4px;" onclick="onClearTaskPerms()">清除</button>';
}

function onTogglePermission(category, checked) {
  if (typeof setPermanentPermission !== 'function') return;
  setPermanentPermission(category, checked);
  const info = PERMISSION_CATEGORIES[category];
  const name = info ? info.label : category;
  toast(checked
    ? `✓ 已永久允许「${name}」`
    : `🗑️ 已撤销「${name}」的永久授权`, 2000);
  renderPermissionsList();
}

function onClearAllPerms() {
  const perms = (TERMINAL_CONFIG && TERMINAL_CONFIG.permanentAllow) || {};
  const count = Object.keys(perms).length;
  if (count === 0) {
    toast('当前没有任何永久授权', 1800);
    return;
  }
  if (!confirm(`确认撤销全部 ${count} 项永久授权？\n下次调用相应工具会重新弹窗。`)) return;
  clearAllPermanentPermissions();
  toast(`🗑️ 已清空全部 ${count} 项永久授权`, 2500);
  renderPermissionsList();
}

function onClearTaskPerms() {
  if (typeof TERMINAL_CONFIG === 'undefined') return;
  if (typeof clearTaskPermissions === 'function') clearTaskPermissions();
  else TERMINAL_CONFIG.taskAllow = {};
  toast('🗑️ 任务级授权已清除', 1800);
  renderTaskPermissionsList();
}

// ============ 🛡️ 一键清除所有敏感凭证 ============
function onClearAllSecrets() {
  if (typeof SECRET_REGISTRY === 'undefined') {
    alert('配置未加载');
    return;
  }
  const list = SECRET_REGISTRY.map(s => '  • ' + s.label).join('\n');
  const ok = confirm(
    '⚠️ 即将清除以下所有本地凭证：\n\n' + list +
    '\n\n清除后需要重新输入 API Key / LMS Cookie / 重新授权本地终端。\n\n' +
    '本操作不会删除聊天记录和工具配置。确认继续？'
  );
  if (!ok) return;
  const cleared = clearAllSecrets();
  // 同步刷新设置面板（如果开着）
  try {
    const apiInput = document.getElementById('apiKey');
    if (apiInput) apiInput.value = '';
  } catch (e) {}
  if (cleared.length === 0) {
    toast('✓ 没有需要清除的凭证（当前已是干净状态）', 2500);
  } else {
    toast(`🗑️ 已清除 ${cleared.length} 项凭证：\n` + cleared.join('、'), 3500);
  }
}
