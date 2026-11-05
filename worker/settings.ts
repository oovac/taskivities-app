// App settings edited by admins on the Settings page. For now: the logo (SVG only).
import type { Context } from 'hono';
import type { AppSettings } from '../shared/types';
import { type AppEnv, auditStmt, bad, bumpDirectory, nowIso } from './lib';

export const LOGO_MAX_BYTES = 256 * 1024;

interface SettingRow { key: string; value: string; updated_at: string }

const getSetting = (db: D1Database, key: string) =>
  db.prepare('SELECT key, value, updated_at FROM settings WHERE key = ?').bind(key).first<SettingRow>();

/** What every signed-in client gets in /api/bootstrap. */
export async function loadSettings(db: D1Database): Promise<AppSettings> {
  const logo = await getSetting(db, 'logo');
  return {
    customLogo: !!logo?.value,
    // Changes whenever the logo does, so /logo.svg?v=… can be cached for good.
    logoVersion: logo ? String(Date.parse(logo.updated_at)) : '0',
  };
}

/**
 * Checks an uploaded logo. Only SVG is accepted, and nothing that could run code or load other content.
 * (The logo is also served with a locked-down Content-Security-Policy, so this is a second line of defence.)
 */
export function checkSvg(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw bad('Choose an SVG file.');
  const svg = raw.trim();
  if (new TextEncoder().encode(svg).length > LOGO_MAX_BYTES) throw bad(`The logo must be under ${LOGO_MAX_BYTES / 1024} KB.`);
  // Allow an XML declaration and comments before the root element; the root must be <svg>.
  const body = svg.replace(/^<\?xml[^>]*\?>/i, '').replace(/^(\s|<!--[\s\S]*?-->)*/, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(svg)) throw bad("SVG files with a DOCTYPE aren't supported. Re-export it without one.");
  if (!/^<svg[\s/>]/i.test(body) || !/(<\/svg>|\/>)\s*$/i.test(svg)) throw bad("That isn't an SVG file. Only SVG logos are supported.");
  if (/<\s*(script|foreignObject|iframe|embed|object|audio|video|link|meta|base)\b/i.test(svg))
    throw bad('The SVG contains scripts or embedded content, which isn\'t allowed in a logo.');
  if (/\son[a-z]+\s*=/i.test(svg) || /(java|vb)script\s*:/i.test(svg) || /@import/i.test(svg))
    throw bad("The SVG contains scripts or event handlers, which aren't allowed in a logo.");
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
