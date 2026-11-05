// Light / dark theme. The choice is per browser (localStorage); "system" follows the OS setting, live.
// index.html applies it before the page draws, so there's no flash of the wrong theme.
export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'tv:theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

export function themePref(): ThemePref {
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}

export function applyTheme(pref: ThemePref = themePref()) {
  const dark = pref === 'dark' || (pref === 'system' && media.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0E0E13' : '#F7F7F9');
}

export function setThemePref(pref: ThemePref) {
  if (pref === 'system') localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, pref);
  applyTheme(pref);
}

// Following the OS: switch when it does.
media.addEventListener('change', () => themePref() === 'system' && applyTheme());
