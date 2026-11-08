// Linked files (attachments that are only an address): what to call a link, worked out from the address alone.
// Nothing is fetched: private files only answer with a sign-in page, and fetching addresses people type is risky.

/** The type stored for a pasted link (it isn't fetched, so its real type isn't known). */
export const LINK_TYPE = 'text/uri-list';

/** The site a link points to, for known ones ("Google Sheets", "OneDrive"…), or null. */
export function linkSite(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const h = u.hostname.toLowerCase().replace(/^www\./, '');
  const p = u.pathname;
  if (h === 'docs.google.com') {
    if (p.startsWith('/document')) return 'Google Docs';
    if (p.startsWith('/spreadsheets')) return 'Google Sheets';
    if (p.startsWith('/presentation')) return 'Google Slides';
    if (p.startsWith('/forms')) return 'Google Forms';
    if (p.startsWith('/drawings')) return 'Google Drawings';
    return 'Google Drive';
  }
  if (h === 'drive.google.com') return 'Google Drive';
  if (h === 'onedrive.live.com' || h === '1drv.ms' || /-my\.sharepoint\.(com|us|cn)$/.test(h)) return 'OneDrive';
  if (/\.sharepoint\.(com|us|cn)$/.test(h)) return 'SharePoint';
  if (h === 'dropbox.com' || h.endsWith('.dropbox.com') || h === 'db.tt') return 'Dropbox';
  if (h === 'figma.com' || h.endsWith('.figma.com')) return 'Figma';
  if (h === 'github.com' || h === 'gist.github.com') return 'GitHub';
  if (h === 'notion.so' || h.endsWith('.notion.site')) return 'Notion';
  if (h === 'box.com' || h.endsWith('.box.com')) return 'Box';
  return null;
}

/** The link's site, or its host ("example.com"), for "Link · …". */
export function linkWhere(raw: string): string {
  const site = linkSite(raw);
  if (site) return site;
  try { return new URL(raw).hostname.replace(/^www\./, ''); } catch { return 'link'; }
}

/** Path words that aren't a file's name. */
const NOT_NAMES = new Set(['edit', 'view', 'preview', 'open', 'd', 'file', 'files', 'folders', 'drive', 'u', 'r', 's', 'sh', 'scl', 'fi', 'fo',
  'document', 'spreadsheets', 'presentation', 'forms', 'drawings', 'blob', 'tree', 'main', 'master', 'personal', 'sites', 'shared documents',
  'redir', 'download', 'design', 'board', 'proto']);

/** A name for a pasted link when none is given: a file name in its address, else its site or host. */
export function nameForLink(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { return 'Link'; }
  const segs = u.pathname.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  // OneDrive / SharePoint sharing links (/:x:/g/personal/…/<id>) carry no file name.
  if (/^:[a-z]:$/i.test(segs[0] ?? '')) return `${linkSite(raw) ?? 'Shared'} file`;
  // From the end: the first segment that reads like a name (not an id, not a word like "edit").
  for (let i = segs.length - 1; i >= 0; i--) {
    // A file name ("Q4 plan.pdf") stays as it is; a slug ("q4-plan") reads better with spaces.
    const s = (/\.[a-z0-9]{1,6}$/i.test(segs[i]) ? segs[i] : segs[i].replace(/[-_+]+/g, ' ')).trim();
    if (!s || NOT_NAMES.has(s.toLowerCase())) continue;
    // Ids: long runs mixing upper case, lower case and digits ("1BxiMVs0XRA5…"), numbers, and hex/UUIDs.
    const seg = segs[i];
    const idLike = (seg.length >= 16 && /^[A-Za-z0-9_-]+$/.test(seg) && /[A-Z]/.test(seg) && /[a-z]/.test(seg) && /\d/.test(seg))
      || /^\d+$/.test(s) || /^[0-9a-f-]{20,}$/i.test(s);
    if (idLike) continue;
    if (/\.[a-z0-9]{1,6}$/i.test(s) || /\s/.test(s) || s.length >= 3) return s.slice(0, 180);
  }
  const site = linkSite(raw);
  return site ? `${site} file` : u.hostname.replace(/^www\./, '');
}
