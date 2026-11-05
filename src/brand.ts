// The logo is uploaded by an admin on the Settings page and served by the Worker at /logo.svg
// (the built-in logo when none is uploaded). It's used in the header, the sign-in page and as the tab icon.
// The team's name (Settings → Name) replaces "Taskivities" in the tab title and the home-screen label, and an uploaded
// wordmark (/wordmark.svg) replaces the TASKIVITIES lettering in the top bar.
import { type AppSettings, appName } from '../shared/types';

/** `version` changes whenever the logo does, so the browser never shows a stale one. */
export const logoUrl = (version?: string) => (version ? `/logo.svg?v=${encodeURIComponent(version)}` : '/logo.svg');

/** Points the browser tab icon at the current logo. */
export function applyFavicon(version: string) {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  const href = logoUrl(version);
  if (link && link.getAttribute('href') !== href) link.setAttribute('href', href);
}

export const wordmarkUrl = (version: string) => `/wordmark.svg?v=${encodeURIComponent(version)}`;

/** The browser tab icon and title, and the name iPhones suggest when adding the app to the Home Screen. */
export function applyBrand(settings: AppSettings) {
  applyFavicon(settings.logoVersion);
  const name = appName(settings);
  if (document.title !== name) document.title = name;
  document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', name);
}
