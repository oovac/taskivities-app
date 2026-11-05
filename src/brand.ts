// The logo is uploaded by an admin on the Settings page and served by the Worker at /logo.svg
// (the built-in logo when none is uploaded). It's used in the header, the sign-in page and as the tab icon.

/** `version` changes whenever the logo does, so the browser never shows a stale one. */
export const logoUrl = (version?: string) => (version ? `/logo.svg?v=${encodeURIComponent(version)}` : '/logo.svg');

/** Points the browser tab icon at the current logo. */
export function applyFavicon(version: string) {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  const href = logoUrl(version);
  if (link && link.getAttribute('href') !== href) link.setAttribute('href', href);
}
