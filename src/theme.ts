// Colour themes for the whole app. The colours themselves are in styles.css, one block per theme.
export type ThemeId = 'system' | 'light' | 'dark' | 'midnight' | 'parchment' | 'forest' | 'rosewood' | 'ocean';

/** `swatch` is background, surface and accent, for the picker. */
export const THEMES: { id: ThemeId; label: string; swatch: [string, string, string] }[] = [
  { id: 'system', label: 'Automatic', swatch: ['#eeece6', '#1d2026', '#2f56d6'] },
  { id: 'light', label: 'Paper', swatch: ['#eeece6', '#fbfaf7', '#2f56d6'] },
  { id: 'parchment', label: 'Parchment', swatch: ['#efe4cc', '#f9f1df', '#9a5b1e'] },
  { id: 'rosewood', label: 'Rosewood', swatch: ['#f4e9e6', '#fdf7f5', '#b13a55'] },
  { id: 'ocean', label: 'Ocean', swatch: ['#e3eef2', '#f6fbfc', '#0f7b8f'] },
  { id: 'dark', label: 'Graphite', swatch: ['#15171b', '#1d2026', '#6f8fff'] },
  { id: 'midnight', label: 'Midnight', swatch: ['#0b1026', '#141b3a', '#8f9bff'] },
  { id: 'forest', label: 'Forest', swatch: ['#0f1a15', '#17261f', '#5fcf96'] },
];

export function applyTheme(id: ThemeId) {
  const root = document.documentElement;
  if (id === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', id);
  // the browser's own chrome (address bar, title bar) follows the page background
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg || '#f6f4ef');
}
