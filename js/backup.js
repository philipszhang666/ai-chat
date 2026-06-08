// ============ 备份与恢复 ============

function openBackup() {
  document.getElementById('backupModal').classList.add('show');
  document.getElementById('importText').value = '';
  document.getElementById('importFile').value = '';
  document.getElementById('importPreview').className = 'test-result';
  document.getElementById('importPreview').textContent = '';
  pendingImportData = null;
}

function closeBackup() {
  document.getElementById('backupModal').classList.remove('show');
}

function backupJsonClone(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch (e) { return value; }
}

function backupReadChecked(id, fallback = false) {
  const el = document.getElementById(id);
  return el ? !!el.checked : fallback;
}

function buildApiProfilesBackup(includeApiKey) {
  if (typeof loadApiProfiles !== 'function') {
    return { version: 1, activeProfileId: '', profiles: [] };
  }
  const profiles = backupJsonClone(loadApiProfiles()) || [];
  for (const p of profiles) {
    if (!includeApiKey && p && p.settings) p.settings.apiKey = '';
  }
  return {
    version: 1,
    activeProfileId: typeof getActiveProfileId === 'function' ? getActiveProfileId() : '',
    profiles
  };
}

function uniqueImportedProfileName(baseName, usedNames) {
  const base = String(baseName || '导入配置').trim() || '导入配置';
  if (!usedNames.has(base)) return base;
  let i = 2;
  while (usedNames.has(`${base}（导入 ${i}）`)) i++;
  return `${base}（导入 ${i}）`;
}

function importApiProfilesFromBackup(payload) {
  const incoming = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.profiles) ? payload.profiles : []);
  if (typeof loadApiProfiles !== 'function' || typeof saveApiProfiles !== 'function') {
    return { imported: 0, skipped: 0, renamed: 0, invalid: incoming.length, activated: false };
  }
  
  const profiles = loadApiProfiles();
  const existingIds = new Set(profiles.map(p => p && p.id).filter(Boolean));
  const usedNames = new Set(profiles.map(p => p && p.name).filter(Boolean));
  let imported = 0;
  let skipped = 0;
  let renamed = 0;
  let invalid = 0;
  
  for (const raw of incoming) {
    const p = backupJsonClone(raw);
    if (!p || typeof p !== 'object' || !p.settings || typeof p.settings !== 'object') {
      invalid++;
      continue;
    }
    if (!p.id) p.id = 'prof_import_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    if (!p.name) p.name = '导入配置';
    if (existingIds.has(p.id)) {
      skipped++;
      continue;
    }
    const finalName = uniqueImportedProfileName(p.name, usedNames);
    if (finalName !== p.name) renamed++;
    p.name = finalName;
    p.createdAt = p.createdAt || Date.now();
    p.updatedAt = Date.now();
    profiles.push(p);
    existingIds.add(p.id);
    usedNames.add(p.name);
    imported++;
  }
  
  saveApiProfiles(profiles);
  
  let activated = false;
  const activeId = payload && !Array.isArray(payload) ? payload.activeProfileId : '';
  if (activeId && typeof setActiveProfileId === 'function' && profiles.some(p => p && p.id === activeId)) {
    setActiveProfileId(activeId);
    activated = true;
  }
  if (typeof renderApiProfileSelect === 'function') renderApiProfileSelect();
  return { imported, skipped, renamed, invalid, activated };
}

function buildExportData() {
  const OUTLINE_KEYS = ['useOutline', 'outlineMaxRounds', 'outlineModel', 'outlineSystemPrompt'];
  const REFLECTION_KEYS = ['useReflection', 'refRounds', 'refMinScore', 'refStudentModel', 'refTeacherModel', 'refStudentPrompt', 'refTeacherPrompt', 'refStudentUseTools', 'refTeacherUseTools', 'refStudentMaxToolRounds', 'refTeacherMaxToolRounds'];
  const PLAN_KEYS = ['usePlan', 'planReview', 'planSynthesize', 'planMaxSteps', 'planReviewRounds', 'planPlannerModel', 'planExecutorModel', 'planPlannerPrompt', 'planExecutorPrompt'];

  const inc = {
    settings: backupReadChecked('exp_settings', true),
    apiKey: backupReadChecked('exp_apiKey', true),
    apiProfiles: backupReadChecked('exp_apiProfiles', true),
    plan: backupReadChecked('exp_plan', true),
    reflection: backupReadChecked('exp_reflection', true),
    outline: backupReadChecked('exp_outline', true),
    tools: backupReadChecked('exp_tools', true),
    toolArtifacts: backupReadChecked('exp_toolArtifacts', true),
    chats: backupReadChecked('exp_chats', false)
  };
  
  const data = {
    _meta: {
      app: 'AI Chat',
      version: 'v6',
      exportedAt: new Date().toISOString(),
      includes: inc
    }
  };
  
  if (inc.settings) {
    const settings = JSON.parse(JSON.stringify(state.settings));
    if (!inc.apiKey) settings.apiKey = '';
    if (!inc.reflection) REFLECTION_KEYS.forEach(k => delete settings[k]);
    if (!inc.plan) PLAN_KEYS.forEach(k => delete settings[k]);
    if (!inc.outline) OUTLINE_KEYS.forEach(k => delete settings[k]);
    data.settings = settings;
  } else {
    const ds = {};
    if (inc.reflection) REFLECTION_KEYS.forEach(k => ds[k] = state.settings[k]);
    if (inc.plan) PLAN_KEYS.forEach(k => ds[k] = state.settings[k]);
    if (inc.outline) OUTLINE_KEYS.forEach(k => ds[k] = state.settings[k]);
    if (Object.keys(ds).length) data.settings = ds;
  }
  
  if (inc.tools) data.tools = state.tools;
  if (inc.apiProfiles) data.apiProfiles = buildApiProfilesBackup(inc.apiKey);
  if (inc.toolArtifacts && typeof exportToolArtifactsForBackup === 'function') {
    data.toolArtifacts = exportToolArtifactsForBackup();
  }
  if (inc.chats) data.chats = state.chats;
  
  return data;
}

function exportConfig() {
  const data = buildExportData();
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  a.href = url;
  a.download = `aichat-backup-${ts}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast('✓ 配置已下载');
}

function copyConfigToClipboard() {
  const data = buildExportData();
  navigator.clipboard.writeText(JSON.stringify(data, null, 2))
    .then(() => toast('✓ 已复制到剪贴板'))
    .catch(e => alert('复制失败：' + e.message));
}

function importFromFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    document.getElementById('importText').value = e.target.result;
    parseAndPreviewImport();
  };
  reader.readAsText(file);
}

function parseAndPreviewImport() {
  const text = document.getElementById('importText').value.trim();
  const preview = document.getElementById('importPreview');
  if (!text) {
    preview.className = 'test-result';
    preview.textContent = '';
    pendingImportData = null;
    return;
  }
  try {
    const data = JSON.parse(text);
    pendingImportData = data;
    let summary = '<strong>📦 待导入：</strong><br>';
    if (data._meta) summary += `- 导出时间：${data._meta.exportedAt || '未知'}<br>`;
    if (data.settings) {
      const keys = Object.keys(data.settings);
      summary += `- ⚙️ 设置 ${keys.length} 项`;
      if (data.settings.apiKey) summary += '（含 API Key）';
      summary += '<br>';
      if (data.settings.baseUrl) summary += `&nbsp;&nbsp;Base URL: <code>${escapeHtml(data.settings.baseUrl)}</code><br>`;
      if (data.settings.currentModel) summary += `&nbsp;&nbsp;模型: <code>${escapeHtml(data.settings.currentModel)}</code><br>`;
    }
    if (data.tools && Array.isArray(data.tools)) {
      const newTools = data.tools.filter(t => !state.tools.some(et => et.name === t.name));
      summary += `- 🛠 工具 ${data.tools.length} 个`;
      if (newTools.length) summary += `（其中 ${newTools.length} 个为新增）`;
      summary += '<br>';
      // ⚠️ 工具代码会被 new Function 直接执行 —— 明确警示
      if (newTools.length) {
        summary += '<div style="margin-top:8px;padding:8px;border-left:3px solid #d9534f;background:rgba(217,83,79,.08);font-size:12px;line-height:1.5">'
          + '<strong style="color:#d9534f">⚠️ 安全提示：</strong>导入的工具代码会以页面权限执行 JS（可访问 localStorage / 调用 fetch）。'
          + '<br>仅在你<strong>完全信任来源</strong>时勾选"导入工具"。'
          + '<br>新增工具名：<code>' + newTools.map(t => escapeHtml(t.name || '(未命名)')).join('</code> <code>') + '</code>'
          + '</div>';
      }
    }
    if (data.apiProfiles) {
      const profiles = Array.isArray(data.apiProfiles)
        ? data.apiProfiles
        : (Array.isArray(data.apiProfiles.profiles) ? data.apiProfiles.profiles : []);
      const existingIds = typeof loadApiProfiles === 'function'
        ? new Set(loadApiProfiles().map(p => p && p.id).filter(Boolean))
        : new Set();
      const newCount = profiles.filter(p => p && p.id && !existingIds.has(p.id)).length;
      summary += `- 🗂️ API 配置档案 ${profiles.length} 个`;
      if (newCount) summary += `（其中 ${newCount} 个为新增）`;
      summary += '<br>';
    }
    if (data.toolArtifacts) {
      const items = Array.isArray(data.toolArtifacts)
        ? data.toolArtifacts
        : (Array.isArray(data.toolArtifacts.items) ? data.toolArtifacts.items : []);
      const totalChars = data.toolArtifacts.totalChars || items.reduce((sum, item) => sum + String(item?.content || '').length, 0);
      summary += `- 🗄️ 工具输出归档 ${items.length} 个`;
      if (typeof formatSize === 'function') summary += `（约 ${formatSize(totalChars)}）`;
      summary += '<br>';
    }
    if (data.chats && Array.isArray(data.chats)) summary += `- 💬 对话 ${data.chats.length} 个<br>`;
    preview.className = 'test-result success';
    preview.innerHTML = summary;
  } catch (e) {
    preview.className = 'test-result error';
    preview.textContent = '❌ JSON 格式错误：' + e.message;
    pendingImportData = null;
  }
}

function applyImport() {
  const text = document.getElementById('importText').value.trim();
  if (text && !pendingImportData) parseAndPreviewImport();
  if (!pendingImportData) { alert('请先选择文件或粘贴 JSON'); return; }
  
  const OUTLINE_KEYS = ['useOutline', 'outlineMaxRounds', 'outlineModel', 'outlineSystemPrompt'];
  const REFLECTION_KEYS = ['useReflection', 'refRounds', 'refMinScore', 'refStudentModel', 'refTeacherModel', 'refStudentPrompt', 'refTeacherPrompt', 'refStudentUseTools', 'refTeacherUseTools', 'refStudentMaxToolRounds', 'refTeacherMaxToolRounds'];
  const PLAN_KEYS = ['usePlan', 'planReview', 'planSynthesize', 'planMaxSteps', 'planReviewRounds', 'planPlannerModel', 'planExecutorModel', 'planPlannerPrompt', 'planExecutorPrompt'];

  const data = pendingImportData;
  const opts = {
    settings: backupReadChecked('imp_settings', true),
    apiProfiles: backupReadChecked('imp_apiProfiles', true),
    plan: backupReadChecked('imp_plan', true),
    reflection: backupReadChecked('imp_reflection', true),
    outline: backupReadChecked('imp_outline', true),
    tools: backupReadChecked('imp_tools', true),
    toolArtifacts: backupReadChecked('imp_toolArtifacts', true),
    chats: backupReadChecked('imp_chats', false)
  };
  
  let imported = [];
  
  if (data.settings) {
    if (opts.settings) {
      const oldTheme = state.settings.theme;
      const incoming = { ...data.settings };
      if (!opts.reflection) REFLECTION_KEYS.forEach(k => delete incoming[k]);
      if (!opts.plan) PLAN_KEYS.forEach(k => delete incoming[k]);
      if (!opts.outline) OUTLINE_KEYS.forEach(k => delete incoming[k]);
      state.settings = { ...state.settings, ...incoming, theme: oldTheme };
      imported.push('设置');
    } else {
      if (opts.reflection) {
        REFLECTION_KEYS.forEach(k => {
          if (data.settings[k] !== undefined) state.settings[k] = data.settings[k];
        });
        imported.push('师生');
      }
      if (opts.plan) {
        PLAN_KEYS.forEach(k => {
          if (data.settings[k] !== undefined) state.settings[k] = data.settings[k];
        });
        imported.push('计划模式');
      }
      if (opts.outline) {
        OUTLINE_KEYS.forEach(k => {
          if (data.settings[k] !== undefined) state.settings[k] = data.settings[k];
        });
        imported.push('大纲');
      }
    }
  }
  
  if (opts.apiProfiles && data.apiProfiles) {
    const result = importApiProfilesFromBackup(data.apiProfiles);
    imported.push(`API档案 ${result.imported} 新增${result.skipped ? `/${result.skipped} 已存在` : ''}${result.renamed ? `/${result.renamed} 重命名` : ''}`);
  }
  
  if (opts.tools && Array.isArray(data.tools)) {
    const existing = new Set(state.tools.map(t => t.name));
    const incoming = data.tools.filter(t => !existing.has(t.name));
    const conflicting = data.tools.filter(t => existing.has(t.name));

    // 先处理新增工具（无名称冲突）
    if (incoming.length > 0) {
      // 🛡️ 二次确认：把即将执行的工具名 + 代码摘要列出来，避免恶意备份偷渡 JS
      const preview = incoming.slice(0, 5).map(t => {
        const code = (t.code || '').trim();
        const head = code.length > 200 ? code.slice(0, 200) + '…（已截断）' : code;
        return `▸ ${t.name || '(未命名)'}\n${head || '(无代码)'}`;
      }).join('\n\n');
      const more = incoming.length > 5 ? `\n\n…还有 ${incoming.length - 5} 个未显示` : '';
      const ok = confirm(
        `⚠️ 即将导入 ${incoming.length} 个新工具。\n\n` +
        `这些工具的 JS 代码将以页面权限执行（可读取 localStorage、调用 fetch、` +
        `操作 DOM）。如果备份文件来源不明，请取消。\n\n` +
        `——— 前 ${Math.min(5, incoming.length)} 个工具代码预览 ———\n${preview}${more}\n\n` +
        `确认导入？`
      );
      if (ok) {
        for (const t of incoming) state.tools.push(t);
        imported.push(`${incoming.length} 新工具`);
      } else {
        imported.push('0 新工具(已取消)');
      }
    } else if (conflicting.length === 0) {
      imported.push('0 工具(无新增)');
    }

    // 再处理同名冲突：让用户决定是覆盖、跳过还是逐个询问
    if (conflicting.length > 0) {
      const names = conflicting.slice(0, 8).map(t => `• ${t.name}`).join('\n');
      const more2 = conflicting.length > 8 ? `\n…还有 ${conflicting.length - 8} 个` : '';
      const choice = prompt(
        `🔁 备份里有 ${conflicting.length} 个工具与现有工具同名：\n\n${names}${more2}\n\n` +
        `请输入处理方式：\n` +
        `  1 = 全部覆盖（用备份版本替换当前版本）\n` +
        `  2 = 全部跳过（保留当前版本）\n` +
        `  3 = 逐个询问\n` +
        `留空 / 取消 = 全部跳过`,
        '2'
      );
      let overwriteCount = 0;
      let skipCount = 0;
      if (choice === '1') {
        for (const t of conflicting) {
          const idx = state.tools.findIndex(x => x.name === t.name);
          if (idx >= 0) state.tools[idx] = t;
          overwriteCount++;
        }
      } else if (choice === '3') {
        for (const t of conflicting) {
          const code = (t.code || '').trim();
          const head = code.length > 200 ? code.slice(0, 200) + '…' : code;
          const yes = confirm(
            `覆盖工具 "${t.name}"？\n\n` +
            `——— 备份版本代码预览 ———\n${head || '(无代码)'}\n\n` +
            `[确定] = 覆盖     [取消] = 跳过`
          );
          if (yes) {
            const idx = state.tools.findIndex(x => x.name === t.name);
            if (idx >= 0) state.tools[idx] = t;
            overwriteCount++;
          } else {
            skipCount++;
          }
        }
      } else {
        // choice === '2' 或留空 / 取消
        skipCount = conflicting.length;
      }
      if (overwriteCount > 0) imported.push(`${overwriteCount} 覆盖`);
      if (skipCount > 0) imported.push(`${skipCount} 跳过`);
    }
  }
  
  if (opts.toolArtifacts && data.toolArtifacts) {
    if (typeof importToolArtifactsFromBackup === 'function') {
      const result = importToolArtifactsFromBackup(data.toolArtifacts);
      imported.push(`归档 ${result.imported} 新增${result.skipped ? `/${result.skipped} 已存在` : ''}${result.invalid ? `/${result.invalid} 无效` : ''}`);
    } else {
      imported.push('归档未导入(模块不可用)');
    }
  }
  
  if (opts.chats && Array.isArray(data.chats)) {
    state.chats = [...data.chats, ...state.chats];
    imported.push(`${data.chats.length} 对话`);
  }
  
  persistSettings();
  persistTools();
  saveData();
  refreshModelSelect();
  applyTheme();
  updateTopUrlPreview();
  if (typeof renderApiProfileSelect === 'function') renderApiProfileSelect();
  renderChatList();
  renderMessages();
  updateSendBtn();
  
  const reflectBtn = document.getElementById('reflectBtn');
  if (state.settings.useReflection) reflectBtn.classList.add('reflect-active');
  else reflectBtn.classList.remove('reflect-active');
  const toolsBtn = document.getElementById('toolsBtn');
  if (state.settings.useTools) toolsBtn.classList.add('tool-active');
  else toolsBtn.classList.remove('tool-active');
  const planBtn = document.getElementById('planBtn');
  if (state.settings.usePlan) planBtn.classList.add('plan-active');
  else planBtn.classList.remove('plan-active');
  const outlineBtn = document.getElementById('outlineBtn');
  if (outlineBtn) {
    if (state.settings.useOutline) outlineBtn.classList.add('outline-active');
    else outlineBtn.classList.remove('outline-active');
  }
  
  toast(`✓ 已导入：${imported.join('、') || '（无）'}`);
  closeBackup();
}

function resetAllData() {
  if (!confirm('⚠️ 清空所有数据？建议先备份！')) return;
  if (!confirm('再次确认：不可恢复！')) return;
  // ⭐ 一键清空：storage.clearAll() 会把 IndexedDB 和 localStorage 一起清掉
  if (typeof storage !== 'undefined' && storage.clearAll) {
    storage.clearAll();
  } else {
    // 兜底
    localStorage.removeItem(STORE_KEY);
    localStorage.removeItem(SETTINGS_KEY);
    localStorage.removeItem(TOOLS_KEY);
    localStorage.removeItem(BUILTIN_TOOLS_LOADED_KEY);
    if (typeof REQUEST_HISTORY_KEY !== 'undefined') localStorage.removeItem(REQUEST_HISTORY_KEY);
  }
  location.reload();
}
