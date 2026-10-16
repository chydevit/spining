// Apply the saved colour theme before first paint (loaded as a blocking script).
try {
  if (localStorage.getItem('pk-spin-theme') === 'dark') document.documentElement.dataset.theme = 'dark';
} catch { /* storage unavailable: stay light */ }
