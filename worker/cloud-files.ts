// Files picked from Google Drive or OneDrive / SharePoint, attached as a copy or as a link; and pasted links.
//
// The person picks files in the provider's own picker, in the browser, signed in to their own account there. The
// browser sends us the picked ids and the short-lived access token the picker used. We use it once, here, to ask the
// provider (only googleapis.com or graph.microsoft.com, never an address from the request) for the file's name and
// address, and for a copy, its bytes. The token is never stored or logged.
//
// - Copy: an ordinary attachment in R2 (worker/attachments.ts). Our access rules apply; it doesn't follow edits.
// - Link: a row with the file's address and no bytes (key ''). The provider's sharing decides who can open it.
//
// Google uses the drive.file scope: the token only reaches files the person picked for this app (its Cloud project,
// GOOGLE_APP_ID), and Google treats that scope as non-sensitive, so the app needs no verification for it.
import { Hono } from 'hono';
import type { CloudPickers, CloudProvider, Task } from '../shared/types';
import { type AppEnv, type Env, type Viewer, HttpError, bad, eventStmt, mapTask, nowIso, uid } from './lib';
import { addAttachmentBytes, cleanName, readCapped, taskWithRoom, touch, typeFromName } from './attachments';
import { loadTask, loadVisibleTask } from './tasks';
import { LINK_TYPE, nameForLink } from '../shared/links';

/** What the browser needs to open each picker. All of it is public (the API key is limited to this site in Google Cloud). */
export function cloudPickers(env: Env): CloudPickers {
  return {
    google: env.GOOGLE_CLIENT_ID && env.GOOGLE_PICKER_API_KEY && env.GOOGLE_APP_ID
      ? { clientId: env.GOOGLE_CLIENT_ID, apiKey: env.GOOGLE_PICKER_API_KEY, appId: env.GOOGLE_APP_ID } : null,
    microsoft: env.MS_CLIENT_ID && env.MS_TENANT_ID && /^(on|1|true|yes)$/i.test(env.MS_FILES ?? '')
      ? { clientId: env.MS_CLIENT_ID, tenant: env.MS_TENANT_ID } : null,
  };
}

/** One picked file, as the provider describes it. `download` is null when it can only be linked (a folder, a form…). */
interface CloudFile { name: string; type: string; size: number; link: string; download: { url: string; name: string; type: string } | null }

const PICK_MAX = 20;
const NAMES: Record<CloudProvider, string> = { google: 'Google Drive', microsoft: 'OneDrive' };

/** Google's own formats have no file to download: they're exported. Docs and Slides as PDF (they open in the browser), Sheets as Excel. */
const GOOGLE_EXPORTS: Record<string, { type: string; ext: string }> = {
  'application/vnd.google-apps.document': { type: 'application/pdf', ext: 'pdf' },
  'application/vnd.google-apps.presentation': { type: 'application/pdf', ext: 'pdf' },
  'application/vnd.google-apps.spreadsheet': { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' },
  'application/vnd.google-apps.drawing': { type: 'image/png', ext: 'png' },
};

const withExt = (name: string, ext: string) => (name.toLowerCase().endsWith(`.${ext}`) ? name : `${name}.${ext}`);

/** A link we're willing to store: https, a real host. */
function safeLink(raw: unknown) {
  try {
    const u = new URL(String(raw));
    if (u.protocol === 'https:' && u.hostname.includes('.') && !u.username && !u.password) return u.toString();
  } catch { /* not a URL */ }
  return null;
}

/** Asks the provider. Its refusals become messages people can act on. */
async function ask(provider: CloudProvider, url: string, token: string) {
  let res: Response;
  try {
    res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
  } catch {
    throw bad(`Couldn't reach ${NAMES[provider]}. Try again.`);
  }
  // Not 401: the app reads that as signed out of Taskivities.
  if (res.status === 401) throw new HttpError(409, `${NAMES[provider]} sign-in expired. Pick the files again.`);
  if (res.status === 403 || res.status === 404) throw bad(`${NAMES[provider]} didn't let Taskivities read that file. Pick it again, or check you can open it.`);
  if (!res.ok) throw bad(`${NAMES[provider]} answered ${res.status}. Try again.`);
  return res;
}

async function describeGoogle(id: string, token: string): Promise<CloudFile> {
  const base = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`;
  const f = (await (await ask('google', `${base}?fields=name,mimeType,size,webViewLink&supportsAllDrives=true`, token)).json()) as
    { name?: string; mimeType?: string; size?: string; webViewLink?: string };
  const link = safeLink(f.webViewLink);
  if (!link) throw bad("Google Drive didn't give an address for that file.");
  const name = f.name || 'file';
  const type = f.mimeType || 'application/octet-stream';
  const exp = GOOGLE_EXPORTS[type];
  const download = exp
    ? { url: `${base}/export?mimeType=${encodeURIComponent(exp.type)}`, name: withExt(name, exp.ext), type: exp.type }
    : type.startsWith('application/vnd.google-apps.') ? null // folders, forms, sites, shortcuts: link only
      : { url: `${base}?alt=media&supportsAllDrives=true`, name, type };
  return { name, type, size: Number(f.size) || 0, link, download };
}

async function describeMicrosoft(id: string, driveId: string, token: string): Promise<CloudFile> {
  const base = `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(id)}`;
  const f = (await (await ask('microsoft', `${base}?$select=name,size,webUrl,file,folder,package`, token)).json()) as
    { name?: string; size?: number; webUrl?: string; file?: { mimeType?: string }; folder?: unknown; package?: unknown };
  const link = safeLink(f.webUrl);
  if (!link) throw bad("OneDrive didn't give an address for that file.");
  const name = f.name || 'file';
  const type = f.file?.mimeType || (f.folder ? 'inode/directory' : typeFromName(name));
  // /content answers with a redirect to a short-lived download address (fetch drops our token on the way, as it should).
  const download = f.file ? { url: `${base}/content`, name, type: f.file.mimeType || typeFromName(name) } : null;
  return { name, type, size: f.size ?? 0, link, download };
}

/** Stores a link (no bytes; key ''). provider is set for files picked from a drive, null for pasted links. */
export async function addLinkAttachment(env: Env, v: Viewer, taskId: string, f: { name: string; link: string; type: string; size: number },
  provider: CloudProvider | null, via: string | null): Promise<Task> {
  const db = env.DB;
  const t = await taskWithRoom(db, v, taskId);
  const now = nowIso();
  const name = cleanName(encodeURIComponent(f.name));
  await db.batch([
    ...touch(db, t.id, now),
    db.prepare("INSERT INTO attachments (id, task_id, key, name, size, type, uploaded_by, uploaded_at, url, provider) VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?)")
      .bind(uid(), t.id, name, Math.max(0, Math.floor(f.size)), f.type.slice(0, 120), v.id, now, f.link, provider),
    eventStmt(db, { taskId: t.id, actorId: v.id, via, type: 'attached', to: name, at: now }),
  ]);
  return mapTask((await loadTask(db, t.id))!);
}

export const LINK_MAX = 2000;

/**
 * Attaches a pasted link, on any instance (no drive or bucket needed). It's never fetched: the name is the one given,
 * or one worked out from the address (shared/links.ts). Only https addresses.
 */
export function attachPastedLink(env: Env, v: Viewer, taskId: string, rawUrl: unknown, rawName: unknown, via: string | null = null) {
  const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!url) throw bad('Paste a link.');
  if (url.length > LINK_MAX) throw bad('That link is too long.');
  const link = safeLink(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`);
  if (!link || !link.startsWith('https://')) throw bad('Only https links can be attached.');
  const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : nameForLink(link);
  return addLinkAttachment(env, v, taskId, { name, link, type: LINK_TYPE, size: 0 }, null, via);
}

export interface CloudPick { provider: CloudProvider; token: string; mode: 'copy' | 'link'; files: { id: string; driveId?: string }[] }

/** Attaches picked files, one after another. Stops at the first that fails, keeping the ones before it. */
export async function attachFromCloud(env: Env, v: Viewer, taskId: string, pick: CloudPick, via: string | null = null) {
  await loadVisibleTask(env.DB, v, taskId); // check access before asking anyone for anything
  if (pick.mode === 'copy' && !env.FILES) throw new HttpError(409, "Attachments aren't set up on this instance, so files can only be linked.");
  let task: Task | null = null;
  for (const p of pick.files) {
    const f = pick.provider === 'google' ? await describeGoogle(p.id, pick.token) : await describeMicrosoft(p.id, p.driveId!, pick.token);
    if (pick.mode === 'link') {
      task = await addLinkAttachment(env, v, taskId, f, pick.provider, via);
      continue;
    }
    if (!f.download) throw bad(`“${f.name}” can't be copied (it's a folder or a form). Attach it as a link instead.`);
    const bytes = await readCapped(await ask(pick.provider, f.download.url, pick.token), `“${f.name}”`);
    task = await addAttachmentBytes(env, v, taskId, bytes, f.download.name, f.download.type, via, pick.provider);
  }
  return task!;
}

function parsePick(b: unknown): CloudPick {
  const o = (b ?? {}) as Record<string, unknown>;
  const provider = o.provider;
  if (provider !== 'google' && provider !== 'microsoft') throw bad('Pick Google Drive or OneDrive.');
  if (o.mode !== 'copy' && o.mode !== 'link') throw bad('Attach a copy or a link.');
  if (typeof o.token !== 'string' || !o.token || o.token.length > 8192) throw bad('Missing sign-in. Pick the files again.');
  const id = /^[A-Za-z0-9!._-]{1,200}$/;
  const files = Array.isArray(o.files) ? o.files : [];
  if (!files.length) throw bad('No files were picked.');
  if (files.length > PICK_MAX) throw bad(`Pick at most ${PICK_MAX} files at a time.`);
  return {
    provider, mode: o.mode, token: o.token,
    files: files.map((f) => {
      const x = (f ?? {}) as Record<string, unknown>;
      if (typeof x.id !== 'string' || !id.test(x.id)) throw bad("That isn't a file from the picker.");
      if (provider === 'microsoft' && (typeof x.driveId !== 'string' || !id.test(x.driveId))) throw bad("That isn't a file from the picker.");
      return { id: x.id, ...(provider === 'microsoft' ? { driveId: x.driveId as string } : {}) };
    }),
  };
}

// ---------- routes: /api/tasks/:id/attachments/cloud (and /v1) ----------
export const cloudFileRoutes = new Hono<AppEnv>();

/** A pasted link: { url, name? }. */
cloudFileRoutes.post('/:id/attachments/link', async (c) => {
  const b = ((await c.req.json().catch(() => null)) ?? {}) as { url?: unknown; name?: unknown };
  return c.json({ task: await attachPastedLink(c.env, c.get('viewer'), c.req.param('id'), b.url, b.name) });
});

cloudFileRoutes.post('/:id/attachments/cloud', async (c) => {
  const pick = parsePick(await c.req.json().catch(() => null));
  return c.json({ task: await attachFromCloud(c.env, c.get('viewer'), c.req.param('id'), pick) });
});
