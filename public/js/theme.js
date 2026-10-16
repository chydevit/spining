// Apply the saved colour theme before first paint (loaded as a blocking script).
// Each page can keep its own choice: <script src="/js/theme.js" data-key="…"> (default: the game's key).
try {
  const key = document.currentScript?.dataset.key || 'pk-spin-theme';
  if (localStorage.getItem(key) === 'dark') document.documentElement.dataset.theme = 'dark';
} catch { /* storage unavailable: stay light */ }
