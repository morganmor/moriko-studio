
(function applyStoredTheme() {
  try {
    var stored = JSON.parse(localStorage.getItem('nova.theme.v1') || '"dark"');
    var theme = stored === 'light' ? 'light' : 'dark';
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
  } catch (error) {
    document.documentElement.classList.add('dark');
  }
})();
