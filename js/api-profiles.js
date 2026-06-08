// ============ 🗂️ API 配置档案（Profile）管理 ============
// 【模块定位】支持保存多套 API 配置，一键切换
// 依赖：state.js / settings.js / idb-store.js（storage 对象）
// 加载顺序：在 state.js 之后、settings.js 之后均可（本模块仅在用户操作时被调用）
//
// 数据结构：
//   storage[API_PROFILES_KEY] = [
//     { id, name, settings: {provider, baseUrl, apiPath, apiFormat, apiKey,
//       modelName, currentModel, temperature, maxTokens, useLocalProxy, systemPrompt}, createdAt, updatedAt }
//   ]
//   storage[ACTIVE_PROFILE_ID_KEY] = '<id>'  // 当前激活的 profile id

const API_PROFILES_KEY = 'aichat_api_profiles_v1';
const ACTIVE_PROFILE_ID_KEY = 'aichat_active_profile_id_v1';

// profile 中保存的 settings 字段白名单
// 只存"和某个 API 强相关"的字段，避免把全局开关（useTools/useOutline 等）也覆盖
const PROFILE_SETTINGS_KEYS = [
  'provider',
  'baseUrl',
  'apiPath',
  'apiFormat',
  'apiKey',
  'modelName',
  'currentModel',
  'temperature',
  'maxTokens',
  'useLocalProxy',
  'contextLimitMode',
  'contextLimitOverride',
  'systemPrompt',
  'useCustomJson',
  'jsonTemplate',
  'jsonHeaders'
];

// ============ 读写工具 ============

function loadApiProfiles() {
  try {
    const raw = storage.get(API_PROFILES_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.warn('[api-profiles] 加载失败:', e);
    return [];
  }
}

function saveApiProfiles(profiles) {
  try {
    storage.set(API_PROFILES_KEY, JSON.stringify(profiles));
  } catch (e) {
    console.warn('[api-profiles] 保存失败:', e);
  }
}

function getActiveProfileId() {
  try {
    return storage.get(ACTIVE_PROFILE_ID_KEY) || '';
  } catch (e) {
    return '';
  }
}

function setActiveProfileId(id) {
  try {
    if (id) storage.set(ACTIVE_PROFILE_ID_KEY, id);
    else storage.remove(ACTIVE_PROFILE_ID_KEY);
  } catch (e) {}
}

// ============ 工具函数 ============

function _genProfileId() {
  return 'prof_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// 从 state.settings 中提取 profile 字段子集
function _extractProfileFromSettings() {
  const out = {};
  for (const k of PROFILE_SETTINGS_KEYS) {
    if (state.settings[k] !== undefined) out[k] = state.settings[k];
  }
  return out;
}

// 把 profile.settings 写回 state.settings（只覆盖白名单字段）
function _applyProfileToSettings(profSettings) {
  if (!profSettings || typeof profSettings !== 'object') return;
  for (const k of PROFILE_SETTINGS_KEYS) {
    if (profSettings[k] !== undefined) {
      state.settings[k] = profSettings[k];
    }
  }
  // 旧版 profile 没有上下文长度字段；切换旧档案时应回到自动识别，
  // 避免沿用上一个档案的手动上下文窗口。
  if (profSettings.contextLimitMode === undefined) state.settings.contextLimitMode = 'auto';
  if (profSettings.contextLimitOverride === undefined) state.settings.contextLimitOverride = 0;
  // 旧版 profile 没有本地代理字段；切换旧档案时回到默认启用，
  // 避免沿用上一个档案的直连/代理状态。
  if (profSettings.useLocalProxy === undefined) state.settings.useLocalProxy = true;
}

// 摘要：用于触发器和菜单项的小字
function _profileSummary(p) {
  const s = p.settings || {};
  const url = s.baseUrl || '?';
  const model = s.currentModel || (s.modelName || '').split(',')[0].trim() || '?';
  const keyHint = s.apiKey ? (s.apiKey.slice(0, 4) + '...' + s.apiKey.slice(-4)) : '(无 Key)';
  const proxyHint = s.useLocalProxy === false ? '直连' : '本地代理';
  return `${url} · ${model} · ${proxyHint} · ${keyHint}`;
}

// ============ 对外 API ============

// 保存当前设置为一个新 profile
function saveCurrentAsProfile(name) {
  const finalName = (name || '').trim() || `配置 ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
  const profiles = loadApiProfiles();
  
  // 名字重复时给提示，让用户选择覆盖还是新建
  const dupIdx = profiles.findIndex(p => p.name === finalName);
  if (dupIdx >= 0) {
    if (!confirm(`已有同名配置「${finalName}」。\n\n点击「确定」覆盖原配置，点击「取消」放弃保存。`)) {
      return null;
    }
    const old = profiles[dupIdx];
    old.settings = _extractProfileFromSettings();
    old.updatedAt = Date.now();
    saveApiProfiles(profiles);
    setActiveProfileId(old.id);
    if (typeof toast === 'function') toast(`✓ 已覆盖配置「${finalName}」`);
    return old;
  }
  
  const profile = {
    id: _genProfileId(),
    name: finalName,
    settings: _extractProfileFromSettings(),
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  profiles.push(profile);
  saveApiProfiles(profiles);
  setActiveProfileId(profile.id);
  if (typeof toast === 'function') toast(`✓ 已保存配置「${finalName}」`);
  return profile;
}

// 把指定 profile 的设置应用到当前 state，并持久化
function switchToProfile(id) {
  const profiles = loadApiProfiles();
  const p = profiles.find(x => x.id === id);
  if (!p) {
    if (typeof toast === 'function') toast('⚠️ 配置不存在或已被删除');
    return false;
  }
  _applyProfileToSettings(p.settings);
  setActiveProfileId(p.id);
  
  if (typeof persistSettings === 'function') persistSettings();
  
  // 刷新 UI（如果设置面板正打开）
  if (document.getElementById('settingsModal') && document.getElementById('settingsModal').classList.contains('show')) {
    _refreshSettingsModalFromState();
  }
  // 刷新顶部模型选择和 URL 预览
  if (typeof refreshModelSelect === 'function') refreshModelSelect();
  if (typeof updateTopUrlPreview === 'function') updateTopUrlPreview();
  if (typeof updateSendBtn === 'function') updateSendBtn();
  
  if (typeof toast === 'function') toast(`✅ 已切换到「${p.name}」`);
  
  // 重新渲染 profile 下拉（高亮当前项）
  renderApiProfileSelect();
  return true;
}

// 用当前设置覆盖现有 profile
function overwriteProfile(id) {
  const profiles = loadApiProfiles();
  const p = profiles.find(x => x.id === id);
  if (!p) return false;
  if (!confirm(`将当前设置保存到配置「${p.name}」？\n\n原数据会被覆盖。`)) return false;
  p.settings = _extractProfileFromSettings();
  p.updatedAt = Date.now();
  saveApiProfiles(profiles);
  setActiveProfileId(p.id);
  if (typeof toast === 'function') toast(`✓ 已更新配置「${p.name}」`);
  renderApiProfileSelect();
  return true;
}

// 重命名 profile
function renameProfile(id) {
  const profiles = loadApiProfiles();
  const p = profiles.find(x => x.id === id);
  if (!p) return false;
  const newName = prompt('新的配置名称：', p.name);
  if (newName === null) return false;
  const trimmed = newName.trim();
  if (!trimmed) return false;
  if (profiles.some(x => x.id !== id && x.name === trimmed)) {
    alert('已有同名配置');
    return false;
  }
  p.name = trimmed;
  p.updatedAt = Date.now();
  saveApiProfiles(profiles);
  if (typeof toast === 'function') toast(`✓ 已重命名为「${trimmed}」`);
  renderApiProfileSelect();
  return true;
}

// 删除 profile
function deleteProfile(id) {
  const profiles = loadApiProfiles();
  const idx = profiles.findIndex(x => x.id === id);
  if (idx < 0) return false;
  const p = profiles[idx];
  if (!confirm(`删除配置「${p.name}」？\n\n此操作不可撤销，但当前正在使用的设置不会受影响（仍保留在主设置里）。`)) return false;
  profiles.splice(idx, 1);
  saveApiProfiles(profiles);
  if (getActiveProfileId() === id) setActiveProfileId('');
  if (typeof toast === 'function') toast(`🗑 已删除「${p.name}」`);
  renderApiProfileSelect();
  return true;
}

// 复制 profile（创建一个副本）
function duplicateProfile(id) {
  const profiles = loadApiProfiles();
  const p = profiles.find(x => x.id === id);
  if (!p) return false;
  const copy = {
    id: _genProfileId(),
    name: p.name + ' (副本)',
    settings: JSON.parse(JSON.stringify(p.settings)),
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  profiles.push(copy);
  saveApiProfiles(profiles);
  if (typeof toast === 'function') toast(`✓ 已复制为「${copy.name}」`);
  renderApiProfileSelect();
  return true;
}

// ============ UI 渲染与事件 ============

// 刷新自定义两行下拉 + 同步隐藏的原生 select（兼容层）
function renderApiProfileSelect() {
  const sel = document.getElementById('apiProfileSelect');
  const trigger = document.getElementById('apiProfileTrigger');
  const triggerText = document.getElementById('apiProfileTriggerText');
  const menu = document.getElementById('apiProfileMenu');
  if (!sel) return;

  const profiles = loadApiProfiles();
  const activeId = getActiveProfileId();
  const activeP = profiles.find(p => p.id === activeId);

  // 1) 同步隐藏的原生 select（保留旧逻辑可用）
  let selHtml = '<option value="">— 未保存的临时配置 —</option>';
  for (const p of profiles) {
    const summary = _profileSummary(p);
    selHtml += `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}  ·  ${escapeHtml(summary)}</option>`;
  }
  sel.innerHTML = selHtml;
  sel.value = activeP ? activeId : '';

  // 2) 渲染自定义触发器（两行）
  if (triggerText) {
    if (activeP) {
      triggerText.innerHTML = `
        <div class="api-profile-name">${escapeHtml(activeP.name)}</div>
        <div class="api-profile-summary" title="${escapeHtml(_profileSummary(activeP))}">${escapeHtml(_profileSummary(activeP))}</div>
      `;
    } else {
      triggerText.innerHTML = `
        <div class="api-profile-name">— 未保存的临时配置 —</div>
        <div class="api-profile-summary">点击选择已保存的配置</div>
      `;
    }
  }

  // 3) 渲染弹出菜单
  if (menu) {
    let menuHtml = `
      <div class="api-profile-item${activeId ? '' : ' active'}" data-id="">
        <div class="api-profile-name">— 未保存的临时配置 —</div>
        <div class="api-profile-summary">不绑定任何已保存档案</div>
      </div>
    `;
    if (profiles.length) {
      menuHtml += `<div class="api-profile-item-divider"></div>`;
      for (const p of profiles) {
        const summary = _profileSummary(p);
        const isActive = p.id === activeId;
        menuHtml += `
          <div class="api-profile-item${isActive ? ' active' : ''}" data-id="${escapeHtml(p.id)}">
            <div class="api-profile-name">${escapeHtml(p.name)}</div>
            <div class="api-profile-summary" title="${escapeHtml(summary)}">${escapeHtml(summary)}</div>
          </div>
        `;
      }
    }
    menu.innerHTML = menuHtml;
    // 绑定点击事件
    menu.querySelectorAll('.api-profile-item').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.id || '';
        _closeApiProfileMenu();
        if (id === activeId) return;  // 没变就不处理
        if (id) {
          switchToProfile(id);
        } else {
          setActiveProfileId('');
          renderApiProfileSelect();
        }
      });
    });
  }

  // 4) 同步显示/隐藏右侧操作按钮（无 profile 选中时禁用）
  const opBtns = document.querySelectorAll('.api-profile-op-btn');
  opBtns.forEach(b => { b.disabled = !activeId; });
}

// 切换自定义菜单的打开/关闭
function toggleApiProfileMenu() {
  const trigger = document.getElementById('apiProfileTrigger');
  const menu = document.getElementById('apiProfileMenu');
  if (!trigger || !menu) return;
  if (menu.hidden) _openApiProfileMenu();
  else _closeApiProfileMenu();
}

function _openApiProfileMenu() {
  const trigger = document.getElementById('apiProfileTrigger');
  const menu = document.getElementById('apiProfileMenu');
  if (!trigger || !menu) return;
  menu.hidden = false;
  trigger.classList.add('open');
  // 绑定一次性的外点关闭
  setTimeout(() => {
    document.addEventListener('click', _outsideClickCloseMenu, { capture: true });
  }, 0);
}

function _closeApiProfileMenu() {
  const trigger = document.getElementById('apiProfileTrigger');
  const menu = document.getElementById('apiProfileMenu');
  if (!trigger || !menu) return;
  menu.hidden = true;
  trigger.classList.remove('open');
  document.removeEventListener('click', _outsideClickCloseMenu, { capture: true });
}

function _outsideClickCloseMenu(e) {
  const dropdown = document.getElementById('apiProfileDropdown');
  if (dropdown && !dropdown.contains(e.target)) {
    _closeApiProfileMenu();
  }
}

// 用户操作：下拉变更 = 切换 profile
function onApiProfileSelectChange() {
  const sel = document.getElementById('apiProfileSelect');
  if (!sel) return;
  const id = sel.value;
  if (!id) {
    setActiveProfileId('');
    // 同步禁用按钮
    renderApiProfileSelect();
    return;
  }
  switchToProfile(id);
}

// 用户操作：保存当前为新 profile
function onSaveAsNewProfile() {
  // 先把面板里的当前输入应用到 state（让用户对刚改的字段也生效）
  _harvestSettingsModalToState();
  
  const name = prompt(
    '为这套 API 配置命名：\n\n' +
    '（例如：OpenAI 正式 / DeepSeek 测试 / Claude 备用）',
    `配置 ${loadApiProfiles().length + 1}`
  );
  if (name === null) return;
  saveCurrentAsProfile(name);
  renderApiProfileSelect();
}

function onOverwriteActiveProfile() {
  const sel = document.getElementById('apiProfileSelect');
  if (!sel || !sel.value) return;
  _harvestSettingsModalToState();
  overwriteProfile(sel.value);
}

function onRenameActiveProfile() {
  const sel = document.getElementById('apiProfileSelect');
  if (!sel || !sel.value) return;
  renameProfile(sel.value);
}

function onDeleteActiveProfile() {
  const sel = document.getElementById('apiProfileSelect');
  if (!sel || !sel.value) return;
  deleteProfile(sel.value);
}

function onDuplicateActiveProfile() {
  const sel = document.getElementById('apiProfileSelect');
  if (!sel || !sel.value) return;
  duplicateProfile(sel.value);
}

// ============ 与设置面板的双向同步 ============

// 把当前设置面板的输入框值收集到 state.settings（不持久化、不关闭面板）
// 用于"保存为新 profile"前确保改动也被纳入
function _harvestSettingsModalToState() {
  const s = state.settings;
  const get = id => {
    const el = document.getElementById(id);
    return el ? el.value : undefined;
  };
  const provider = get('provider');         if (provider !== undefined) s.provider = provider;
  const baseUrl = get('baseUrl');           if (baseUrl !== undefined)  s.baseUrl  = baseUrl.trim();
  const apiPath = get('apiPath');           if (apiPath !== undefined)  s.apiPath  = apiPath.trim() || '/chat/completions';
  const apiFormat = get('apiFormat');       if (apiFormat !== undefined) s.apiFormat = apiFormat;
  const apiKey = get('apiKey');             if (apiKey !== undefined)   s.apiKey   = apiKey.trim();
  const modelName = get('modelName');       if (modelName !== undefined) s.modelName = modelName.trim();
  const systemPrompt = get('systemPrompt'); if (systemPrompt !== undefined) s.systemPrompt = systemPrompt;
  const temperature = get('temperature');   if (temperature !== undefined) s.temperature = parseFloat(temperature);
  const maxTokens = get('maxTokens');       if (maxTokens !== undefined) s.maxTokens = parseInt(maxTokens);
  const useLocalProxy = document.getElementById('useLocalProxy');
  if (useLocalProxy) s.useLocalProxy = useLocalProxy.checked;
  const contextMode = get('contextLimitMode');
  if (contextMode !== undefined) s.contextLimitMode = contextMode === 'manual' ? 'manual' : 'auto';
  const contextLimit = get('contextLimitOverride');
  if (contextLimit !== undefined && contextLimit !== '') s.contextLimitOverride = parseInt(contextLimit);
}

// 把 state.settings 的值写回设置面板的输入框
// 切换 profile 后调用，让用户在 UI 上看到新值
function _refreshSettingsModalFromState() {
  const s = state.settings;
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (el && v !== undefined) el.value = v;
  };
  set('provider', s.provider);
  set('baseUrl', s.baseUrl);
  set('apiPath', s.apiPath);
  set('apiFormat', s.apiFormat);
  set('apiKey', s.apiKey);
  set('modelName', s.modelName);
  set('systemPrompt', s.systemPrompt);
  set('temperature', s.temperature);
  const tempVal = document.getElementById('tempVal');
  if (tempVal && s.temperature !== undefined) tempVal.textContent = s.temperature;
  set('maxTokens', s.maxTokens);
  const proxyEl = document.getElementById('useLocalProxy');
  if (proxyEl) proxyEl.checked = !!s.useLocalProxy;
  set('contextLimitMode', s.contextLimitMode || 'auto');
  set('contextLimitOverride', s.contextLimitOverride || '');
  if (typeof updateContextLimitModeUI === 'function') updateContextLimitModeUI();
  if (typeof updateUrlPreview === 'function') updateUrlPreview();
}

// 让 saveAndClose 之后能自动同步当前激活的 profile（如果有）
// 这里通过 monkey-patch 的方式包装原 saveAndClose，避免改动 settings.js
(function _hookSaveAndClose() {
  // 等 settings.js 加载后再 hook（在 init 阶段或 DOMContentLoaded 后）
  function tryHook() {
    if (typeof window.saveAndClose !== 'function') return false;
    if (window._saveAndCloseHooked) return true;
    const orig = window.saveAndClose;
    window.saveAndClose = function() {
      const result = orig.apply(this, arguments);
      if (result === false) return false;
      // 保存后：如果当前有激活的 profile，自动同步它的 settings
      try {
        const activeId = getActiveProfileId();
        if (activeId) {
          const profiles = loadApiProfiles();
          const p = profiles.find(x => x.id === activeId);
          if (p) {
            p.settings = _extractProfileFromSettings();
            p.updatedAt = Date.now();
            saveApiProfiles(profiles);
            renderApiProfileSelect();
          }
        }
      } catch (e) {
        console.warn('[api-profiles] 保存后同步失败:', e);
      }
      return result;
    };
    window._saveAndCloseHooked = true;
    return true;
  }
  if (!tryHook()) {
    // 还没加载完，延迟重试
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(tryHook, 100);
    });
  }
})();

// 导出全局
window.renderApiProfileSelect = renderApiProfileSelect;
window.toggleApiProfileMenu = toggleApiProfileMenu;
window.onApiProfileSelectChange = onApiProfileSelectChange;
window.onSaveAsNewProfile = onSaveAsNewProfile;
window.onOverwriteActiveProfile = onOverwriteActiveProfile;
window.onRenameActiveProfile = onRenameActiveProfile;
window.onDeleteActiveProfile = onDeleteActiveProfile;
window.onDuplicateActiveProfile = onDuplicateActiveProfile;
