// App settings edited by admins on the Settings page: the logo (SVG), the name and wordmark that replace
// "TASKIVITIES", and the home-screen icon.
import type { Context } from 'hono';
import { type AppSettings, ICON_SIZES, NAME_MAX, appName } from '../shared/types';
import { type AppEnv, auditStmt, bad, bumpDirectory, nowIso } from './lib';

export const LOGO_MAX_BYTES = 256 * 1024;

interface SettingRow { key: string; value: string; updated_at: string }

const getSetting = (db: D1Database, key: string) =>
  db.prepare('SELECT key, value, updated_at FROM settings WHERE key = ?').bind(key).first<SettingRow>();

/** What every signed-in client gets in /api/bootstrap. */
export async function loadSettings(db: D1Database): Promise<AppSettings> {
  const [logo, icon, name, wordmark] = await Promise.all([getSetting(db, 'logo'), getSetting(db, 'icon_512'), getSetting(db, 'name'), getSetting(db, 'wordmark')]);
  return {
    customLogo: !!logo?.value,
    // Changes whenever the logo does, so /logo.svg?v=… can be cached for good.
    logoVersion: logo ? String(Date.parse(logo.updated_at)) : '0',
    customIcon: !!icon?.value,
    iconVersion: icon ? String(Date.parse(icon.updated_at)) : '0',
    name: name?.value ?? '',
    customWordmark: !!wordmark?.value,
    wordmarkVersion: wordmark ? String(Date.parse(wordmark.updated_at)) : '0',
  };
}

const putSetting = (db: D1Database, key: string, value: string, actorId: string, now = nowIso()) =>
  db.prepare(
    'INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at',
  ).bind(key, value, actorId, now);

/** The team's name: one line of plain text, at most NAME_MAX characters. Empty goes back to "Taskivities". */
export function checkName(raw: unknown): string {
  if (typeof raw !== 'string') throw bad('Type a name.');
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (name.length > NAME_MAX) throw bad(`Names can be at most ${NAME_MAX} characters.`);
  return name;
}

export async function saveName(db: D1Database, actorId: string, name: string) {
  await db.batch([
    putSetting(db, 'name', name, actorId),
    auditStmt(db, actorId, name ? 'name_changed' : 'name_reset', null, name ? { name } : null),
    bumpDirectory(db),
  ]);
  return loadSettings(db);
}

export async function saveWordmark(db: D1Database, actorId: string, svg: string | null) {
  await db.batch([
    putSetting(db, 'wordmark', svg ?? '', actorId),
    auditStmt(db, actorId, svg ? 'wordmark_changed' : 'wordmark_reset', null, svg ? { bytes: svg.length } : null),
    bumpDirectory(db),
  ]);
  return loadSettings(db);
}

/**
 * Checks an uploaded logo. Only SVG is accepted, and nothing that could run code or load other content.
 * (The logo is also served with a locked-down Content-Security-Policy, so this is a second line of defence.)
 */
export function checkSvg(raw: unknown, what = 'logo'): string {
  if (typeof raw !== 'string' || !raw.trim()) throw bad('Choose an SVG file.');
  const svg = raw.trim();
  if (new TextEncoder().encode(svg).length > LOGO_MAX_BYTES) throw bad(`The ${what} must be under ${LOGO_MAX_BYTES / 1024} KB.`);
  // Allow an XML declaration and comments before the root element; the root must be <svg>.
  const body = svg.replace(/^<\?xml[^>]*\?>/i, '').replace(/^(\s|<!--[\s\S]*?-->)*/, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(svg)) throw bad("SVG files with a DOCTYPE aren't supported. Re-export it without one.");
  if (!/^<svg[\s/>]/i.test(body) || !/(<\/svg>|\/>)\s*$/i.test(svg)) throw bad(`That isn't an SVG file. Only SVG ${what}s are supported.`);
  if (/<\s*(script|foreignObject|iframe|embed|object|audio|video|link|meta|base)\b/i.test(svg))
    throw bad(`The SVG contains scripts or embedded content, which isn't allowed in a ${what}.`);
  if (/\son[a-z]+\s*=/i.test(svg) || /(java|vb)script\s*:/i.test(svg) || /@import/i.test(svg))
    throw bad(`The SVG contains scripts or event handlers, which aren't allowed in a ${what}.`);
  if (/(href|src)\s*=\s*["']\s*(https?:)?\/\//i.test(svg) || /url\(\s*["']?\s*(https?:)?\/\//i.test(svg))
    throw bad('The SVG links to files elsewhere. Use a self-contained SVG (embedded images are fine).');
  return svg;
}

export async function saveLogo(db: D1Database, actorId: string, svg: string | null) {
  const now = nowIso();
  await db.batch([
    db.prepare(
      'INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at',
    ).bind('logo', svg ?? '', actorId, now),
    auditStmt(db, actorId, svg ? 'logo_changed' : 'logo_reset', null, svg ? { bytes: svg.length } : null),
    bumpDirectory(db), // everyone's app reloads settings on its next poll
  ]);
  return loadSettings(db);
}

// Locks the SVG down even if someone opens /logo.svg directly: no scripts, no outside requests.
const SVG_HEADERS = {
  'content-type': 'image/svg+xml; charset=utf-8',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox",
  'x-content-type-options': 'nosniff',
};

/** GET /logo.svg (public: the sign-in page and the browser tab icon use it). The built-in logo when none is set. */
export async function serveLogo(c: Context<AppEnv>) {
  const row = await getSetting(c.env.DB, 'logo');
  // ?v=… (from the app) never changes, so it's cached for good. Plain /logo.svg (sign-in page, first tab icon)
  // is checked every time, cheaply, with an ETag, so a new logo shows up right away.
  const etag = `"${row ? Date.parse(row.updated_at) : 0}"`;
  const headers = {
    ...SVG_HEADERS,
    etag,
    'cache-control': c.req.query('v') ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
  if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers });
  if (row?.value) return new Response(row.value, { headers });
  const res = await c.env.ASSETS.fetch(new Request(new URL('/favicon.svg', c.req.url)));
  return new Response(res.body, { status: res.status, headers });
}

/** GET /wordmark.svg (public: the sign-in page shows it). 404 when none is uploaded: the app then shows the name. */
export async function serveWordmark(c: Context<AppEnv>) {
  const row = await getSetting(c.env.DB, 'wordmark');
  if (!row?.value) return c.notFound();
  const etag = `"${Date.parse(row.updated_at)}"`;
  const headers = { ...SVG_HEADERS, etag, 'cache-control': c.req.query('v') ? 'public, max-age=31536000, immutable' : 'no-cache' };
  if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers });
  return new Response(row.value, { headers });
}

// ---------- home-screen icon (PNG) and the web app manifest ----------
// The admin's browser resizes the uploaded image to each size in ICON_SIZES (Workers can't resize images),
// and this checks each one really is a PNG of that size before storing it (base64 in settings: icon_180 …).
const ICON_MAX_BYTES = 600 * 1024;

function pngSize(bytes: Uint8Array): [number, number] | null {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || sig.some((b, i) => bytes[i] !== b)) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [dv.getUint32(16), dv.getUint32(20)]; // IHDR width, height
}

export function checkIcons(raw: unknown): Record<number, string> {
  if (!raw || typeof raw !== 'object') throw bad('Choose a PNG image.');
  const out: Record<number, string> = {};
  for (const size of ICON_SIZES) {
    const b64 = (raw as Record<string, unknown>)[size];
    if (typeof b64 !== 'string' || !b64) throw bad(`Missing the ${size}×${size} icon.`);
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); } catch { throw bad("That icon couldn't be read."); }
    if (bytes.byteLength > ICON_MAX_BYTES) throw bad('That icon is too large. Try a simpler image.');
    const dims = pngSize(bytes);
    if (!dims) throw bad('Icons must be PNG images.');
    if (dims[0] !== size || dims[1] !== size) throw bad(`The ${size} icon must be exactly ${size}×${size} pixels.`);
    out[size] = b64;
  }
  return out;
}

export async function saveIcons(db: D1Database, actorId: string, icons: Record<number, string> | null) {
  const now = nowIso();
  await db.batch([
    ...ICON_SIZES.map((size) =>
      db.prepare(
        'INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at',
      ).bind(`icon_${size}`, icons?.[size] ?? '', actorId, now)),
    auditStmt(db, actorId, icons ? 'icon_changed' : 'icon_reset', null, null),
    bumpDirectory(db),
  ]);
  return loadSettings(db);
}

/** GET /icons/<size>.png: the uploaded icon, or the built-in one. Public (phones fetch it when installing). */
export async function serveIcon(c: Context<AppEnv>) {
  const size = Number((c.req.param('file') ?? '').replace(/\.png$/, ''));
  if (!(ICON_SIZES as readonly number[]).includes(size)) return c.notFound();
  const row = await getSetting(c.env.DB, `icon_${size}`);
  const cache = c.req.query('v') ? 'public, max-age=31536000, immutable' : 'no-cache';
  if (row?.value) {
    return new Response(Uint8Array.from(atob(row.value), (ch) => ch.charCodeAt(0)), {
      headers: { 'content-type': 'image/png', 'cache-control': cache, 'x-content-type-options': 'nosniff' },
    });
  }
  const res = await c.env.ASSETS.fetch(new Request(new URL(`/default-icons/${size}.png`, c.req.url)));
  return new Response(res.body, { status: res.status, headers: { 'content-type': 'image/png', 'cache-control': cache } });
}

/** GET /manifest.webmanifest: what phones need to install the app to the home screen. */
export async function serveManifest(c: Context<AppEnv>) {
  const settings = await loadSettings(c.env.DB);
  const { iconVersion } = settings;
  const name = appName(settings);
  const icon = (size: number, purpose: string) => ({ src: `/icons/${size}.png?v=${iconVersion}`, sizes: `${size}x${size}`, type: 'image/png', purpose });
  return c.json(
    {
      name,
      short_name: name,
      description: "Your team's week, at a glance.",
      id: '/',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: '#F7F7F9',
      theme_color: '#F7F7F9',
      icons: [icon(192, 'any'), icon(512, 'any'), icon(512, 'maskable')],
    },
    200,
    { 'content-type': 'application/manifest+json', 'cache-control': 'no-cache' },
  );
}
