// Runs before first paint (CSP forbids inline scripts): apply the saved theme so there is no flash.
(function () {
  try {
    var p = JSON.parse(localStorage.getItem('hub.prefs') || '{}');
    var theme = p.theme === 'light' || p.theme === 'dark' ? p.theme : (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.accent = p.accent === 'orange' ? 'orange' : 'green';
  } catch (e) { /* defaults */ }
})();
