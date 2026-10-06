/**
 * Theme bootstrap.
 *
 * Runs before React mounts so the correct colour scheme is applied on the very
 * first paint. Without this the app flashes the light theme before the store
 * reads localStorage.
 */
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
