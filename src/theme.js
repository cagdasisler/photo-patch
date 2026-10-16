'use strict';

// Light by default. The choice is remembered, so a dark pick sticks on the next start.
// Loaded in <head> so the right colors are set before the first paint.
const Theme = (() => {
  const KEY = 'theme';
  const root = document.documentElement;

  function stored() {
    try {
      return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  }

  root.dataset.theme = stored();

  return {
    current: () => root.dataset.theme,
    toggle() {
      const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      try {
        localStorage.setItem(KEY, next);
      } catch {
        // Not remembered, but the switch still works for this session.
      }
      return next;
    },
  };
})();
