// Task attachments. Files are stored in R2 (binding FILES); the list is in the `attachments` table.
//
// Everything goes through the Worker, so every upload and download checks that the person can see the task.
// Files are served so they can't run code in the app: only images, PDFs and plain text open in the browser
// (with a sandboxing Content-Security-Policy); anything else downloads.
import { Hono } from 'hono';
import { ATTACH_MAX_BYTES, ATTACH_PER_TASK_MAX, type Task } from '../shared/types';
import { type AppEnv, type Env, type Viewer, HttpError, CURRENT_VERSION, bad, bumpVersion, eventStmt, forbidden, mapTask, notFound, nowIso, uid } from './lib';
import { loadTask, loadVisibleTask } from './tasks';

interface AttachmentRow {
  id: string; task_id: string; key: string; name: string; size: number; type: string; uploaded_by: string; uploaded_at: string;
}

/** Shown in the browser (with a sandboxing CSP); everything else is a download. SVG and HTML are deliberately not here. */
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'application/pdf', 'text/plain']);

const bucket = (env: Env) => {
  if (!env.FILES) throw new HttpError(409, "Attachments aren't set up on this instance.");
  return env.FILES;
};

/** A safe file name: no paths or control characters, and not too long. */
function cleanName(raw: string | undefined) {
  let name = '';
  try { name = decodeURIComponent(raw ?? ''); } catch { name = raw ?? ''; }
  name = name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f"]/g, '').replace(/\s+/g, ' ').trim();
  if (name.length > 180) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    name = name.slice(0, 180 - ext.length) + ext;
  }
  return name || 'file';
}

/** The MIME type to store: what the browser said, if it's a sane one. */
const cleanType = (t: string | undefined) => {
  const v = (t ?? '').split(';')[0].trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(v) ? v : 'application/octet-stream';
};

const touch = (db: D1Database, taskId: string, now: string) => [
  bumpVersion(db),
  db.prepare(`UPDATE tasks SET updated_at = ?, version = ${CURRENT_VERSION} WHERE id = ?`).bind(now, taskId),
];

export async function addAttachment(env: Env, v: Viewer, taskId: string, body: ReadableStream | null, size: number, rawName: string | undefined, rawType: string | undefined, via: string | null = null): Promise<Task> {
  const files = bucket(env);
  const db = env.DB;
  const t = await loadVisibleTask(db, v, taskId);
  if (!body || !Number.isFinite(size) || size <= 0) throw bad('That file is empty.');
  if (size > ATTACH_MAX_BYTES) throw new HttpError(400, `Files can be at most ${ATTACH_MAX_BYTES / 1024 / 1024} MB.`);
  const { n } = (await db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE task_id = ? AND removed_at IS NULL').bind(t.id).first<{ n: number }>())!;
  if (n >= ATTACH_PER_TASK_MAX) throw bad(`A task can have at most ${ATTACH_PER_TASK_MAX} attachments.`);

  const id = uid();
  const name = cleanName(rawName);
  const type = cleanType(rawType);
  const key = `tasks/${t.id}/${id}`;
  // R2 needs the length up front; FixedLengthStream also stops a body that's longer than it claimed.
  const fixed = new FixedLengthStream(size);
  const piping = body.pipeTo(fixed.writable);
  await Promise.all([files.put(key, fixed.readable, { httpMetadata: { contentType: type }, customMetadata: { taskId: t.id, name } }), piping]);
  const now = nowIso();
  await db.batch([
    ...touch(db, t.id, now),
    db.prepare('INSERT INTO attachments (id, task_id, key, name, size, type, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, t.id, key, name, size, type, v.id, now),
    eventStmt(db, { taskId: t.id, actorId: v.id, via, type: 'attached', to: name, at: now }),
  ]);
  return mapTask((await loadTask(db, t.id))!);
}

async function loadAttachment(env: Env, v: Viewer, taskId: string, id: string) {
  const t = await loadVisibleTask(env.DB, v, taskId);
  const a = await env.DB.prepare('SELECT * FROM attachments WHERE id = ? AND task_id = ? AND removed_at IS NULL').bind(id, t.id).first<AttachmentRow>();
  if (!a) throw notFound('That file is gone.');
  return { t, a };
}

/** Removing is for whoever uploaded it, or an admin. The file is deleted; the history keeps its name. */
export async function removeAttachment(env: Env, v: Viewer, taskId: string, id: string, via: string | null = null): Promise<Task> {
  const { t, a } = await loadAttachment(env, v, taskId, id);
  if (a.uploaded_by !== v.id && v.role !== 'admin') throw forbidden('Only the person who attached it, or an admin, can remove it.');
  const now = nowIso();
  await env.DB.batch([
    ...touch(env.DB, t.id, now),
    env.DB.prepare('UPDATE attachments SET removed_at = ?, removed_by = ? WHERE id = ?').bind(now, v.id, a.id),
    eventStmt(env.DB, { taskId: t.id, actorId: v.id, via, type: 'detached', to: a.name, at: now }),
  ]);
  await bucket(env).delete(a.key).catch(() => undefined);
  return mapTask((await loadTask(env.DB, t.id))!);
}

/** The file's bytes, for the API route and for AI assistants (small text files). */
export async function readAttachment(env: Env, v: Viewer, taskId: string, id: string) {
  const { a } = await loadAttachment(env, v, taskId, id);
  const obj = await bucket(env).get(a.key);
  if (!obj) throw notFound('That file is missing from storage.');
  return { a, obj };
}

// ---------- routes: /api/tasks/:id/attachments ----------
export const attachmentRoutes = new Hono<AppEnv>();

/** Upload: the file is the raw request body; its name goes in x-file-name (URI-encoded). */
attachmentRoutes.post('/:id/attachments', async (c) => {
  const size = Number(c.req.header('content-length'));
  if (!c.req.header('content-length')) throw bad('Missing file size.');
  const task = await addAttachment(c.env, c.get('viewer'), c.req.param('id'), c.req.raw.body, size, c.req.header('x-file-name'), c.req.header('content-type'));
  return c.json({ task });
});

attachmentRoutes.delete('/:id/attachments/:aid', async (c) =>
  c.json({ task: await removeAttachment(c.env, c.get('viewer'), c.req.param('id'), c.req.param('aid')) }));

/** Download / view. ?download forces a download even for images. */
attachmentRoutes.get('/:id/attachments/:aid', async (c) => {
  const { a, obj } = await readAttachment(c.env, c.get('viewer'), c.req.param('id'), c.req.param('aid'));
  const inline = INLINE.has(a.type) && c.req.query('download') === undefined;
  const ascii = a.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return new Response(obj.body, {
    headers: {
      'content-type': inline ? (a.type === 'text/plain' ? 'text/plain; charset=utf-8' : a.type) : 'application/octet-stream',
      'content-length': String(a.size),
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(a.name)}`,
      // Even opened directly, a file can't run scripts or load anything. (Not for PDFs: browsers' PDF viewers
      // refuse to run inside a sandbox, and they keep a PDF's own scripts away from the page anyway.)
      ...(a.type === 'application/pdf' ? {} : { 'content-security-policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox" }),
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=3600',
    },
  });
});
