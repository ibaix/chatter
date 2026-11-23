// Show the light colors before the page draws, so a light page does not flash dark.
// index.html loads this file as a plain script in <head>, so it runs before the page draws.
// It is a file, not a script in the page, because the Content-Security-Policy of the server blocks scripts in the page.
// src/theme/theme.ts does the same after the app starts. Keep the key and the rules the same.
try {
  const choice = localStorage.getItem('chatter-theme');
  const computerIsLight = window.matchMedia('(prefers-color-scheme: light)').matches;
  if (choice === 'light' || (choice === 'system' && computerIsLight)) {
    document.documentElement.dataset.theme = 'light';
    document.querySelector('meta[name="theme-color"]').setAttribute('content', '#f2f2f2');
  }
} catch (e) {
  // The storage is blocked, so the page stays dark
}
