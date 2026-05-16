import type { Theme } from './storage.js';

type ThemeValue = 'light' | 'dark';

function resolveTheme(theme: Theme): ThemeValue {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return theme;
}

export function applyTheme(theme: Theme): void {
  const resolved = resolveTheme(theme);
  document.documentElement.setAttribute('data-theme', resolved);
}

export function watchSystemTheme(theme: Theme, onChange: (resolved: ThemeValue) => void): () => void {
  if (theme !== 'system') return () => {};

  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = (e: MediaQueryListEvent) => {
    onChange(e.matches ? 'dark' : 'light');
  };
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}
