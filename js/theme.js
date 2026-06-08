// ============ 主题切换 ============

function toggleTheme() {
  state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
  applyTheme();
  persistSettings();
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.settings.theme);
  const btn = document.getElementById('themeBtn');
  if (btn) btn.textContent = state.settings.theme === 'dark' ? '☀' : '🌙';
}