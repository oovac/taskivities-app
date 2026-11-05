// Webhooks: other services POST to /hooks/<token>, and each request becomes a task.
//
// A new webhook has no mapping: it only stores the last few requests ("capturing"). An admin picks one of
// them on the Settings page and maps its fields to a task (shared/webhook.ts). From then on the webhook is
// live: every request is turned into a task, made by the admin who created the webhook, marked
// "via <name> webhook" in the task's history. Every request is logged with what happened to it.
import { Hono } from 'hono';
import { todayIn } from '../shared/dates';
import { type HookRequestView, type Mapping, type Member, checkMapping, evaluate } from '../shared/webhook';
import type { WebhookInfo, WebhookRequestInfo } from '../shared/types';
import { createTask } from './tasks';
import {
  type AppEnv, type Ctx, type Env, type UserRow, HttpError, auditStmt, bad, defaultTz, getUser, notFound, nowIso, randomToken, toViewer, uid, validTz,
} from './lib';

/** Requests kept per webhook. */
export const KEEP = 15;
const MAX_BODY = 64 * 1024;
const NAME_MAX = 80;

interface HookRow {
  id: string; name: string; token: string; mapping: string | null; active: number;
  created_by: string; created_at: string; updated_at: string; last_received_at: string | null;
}
interface ReqRow {
  id: string; webhook_id: string; received_at: string; method: string; content_type: string | null;
  headers: string; query: string; body: string; result: string; detail: string | null; task_id: string | null;
}

// Never stored: credentials and where the request came from.
const DROP_HEADERS = /^(authorization|proxy-authorization|cookie|set-cookie|x-forwarded-[a-z-]+|forwarded|x-real-ip|true-client-ip|cf-connecting-ip|cf-connecting-ipv6|cf-ipcountry|cf-ray|cf-visitor|cf-ew-via|cf-worker|cdn-loop|x-api-key|x-auth-token)$/;

/** Body text → what mappings see as `body`. */
export function parseBody(text: string, contentType: string): unknown {
  const ct = contentType.toLowerCase();
  if (!text) return {};
  if (ct.includes('json') || /^\s*[{[]/.test(text)) {
    try { return JSON.parse(text); } catch { /* not JSON after all */ }
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    const form = Object.fromEntries(new URLSearchParams(text));
    // Some services (GitHub, Slack) send JSON inside a single `payload` form field.
    if (Object.keys(form).length === 1 && typeof form.payload === 'string') {
      try { return JSON.parse(form.payload); } catch { /* keep the form */ }
    }
    return form;
  }
  return { text };
}

const view = (r: Pick<ReqRow, 'headers' | 'query' | 'body' | 'content_type'>): HookRequestView => ({
  body: parseBody(r.body, r.content_type ?? ''),
  headers: JSON.parse(r.headers),
  query: JSON.parse(r.query),
});

const hookUrl = (c: Ctx, token: string) => `${new URL(c.req.url).origin}/hooks/${token}`;

const toInfo = (c: Ctx, h: HookRow): WebhookInfo => ({
  id: h.id, name: h.name, url: hookUrl(c, h.token), active: !!h.active,
  mapping: h.mapping ? (JSON.parse(h.mapping) as Mapping) : null,
  createdBy: h.created_by, createdAt: h.created_at, lastReceivedAt: h.last_received_at,
});

const toReqInfo = (r: ReqRow): WebhookRequestInfo => ({
  id: r.id, receivedAt: r.received_at, method: r.method, contentType: r.content_type,
  request: view(r), size: r.body.length, result: r.result as WebhookRequestInfo['result'], detail: r.detail, taskId: r.task_id,
});

/** People a task on this project can go to (admins are on every project). */
async function projectMembers(db: D1Database, projectId: string): Promise<(Member & { tz: string | null })[]> {
  const { results } = await db.prepare(
    `SELECT id, email, name, time_zone FROM users WHERE status != 'disabled'
       AND (role = 'admin' OR id IN (SELECT user_id FROM project_members WHERE project_id = ?))`,
  ).bind(projectId).all<{ id: string; email: string; name: string; time_zone: string | null }>();
  return results.map((u) => ({ id: u.id, email: u.email, name: u.name, tz: u.time_zone }));
}

/** Checks a mapping against the current projects and people. */
async function validate(db: D1Database, m: unknown): Promise<Mapping> {
  const err = checkMapping(m);
  if (err) throw bad(err);
  const x = m as Mapping;
  const p = await db.prepare('SELECT id FROM projects WHERE id = ? AND archived = 0').bind(x.projectId).first();
  if (!p) throw bad('That project no longer exists.');
  if (!(await projectMembers(db, x.projectId)).some((u) => u.id === x.assignee.userId)) throw bad("That person isn't on the project.");
  // Store only the known fields.
  return {
    title: x.title, notes: x.notes || undefined, projectId: x.projectId,
    assignee: { userId: x.assignee.userId, fromPath: x.assignee.fromPath || undefined },
    due: { mode: x.due.mode, days: x.due.mode === 'days' ? x.due.days : undefined, path: x.due.mode === 'path' ? x.due.path : undefined },
    priority: { value: x.priority.value, fromPath: x.priority.fromPath || undefined },
    when: x.when?.path ? { path: x.when.path, equals: x.when.equals } : null,
    dedupePath: x.dedupePath || null,
  };
}

type Result = { result: WebhookRequestInfo['result']; detail?: string; taskId?: string };

/** Turns one request into a task, following the webhook's mapping. */
async function handle(env: Env, h: HookRow, req: HookRequestView): Promise<Result> {
  if (!h.mapping) return { result: 'captured' };
  if (!h.active) return { result: 'paused' };
  const m = JSON.parse(h.mapping) as Mapping;
  const db = env.DB;
  const owner = await getUser(db, h.created_by) as UserRow | null;
  if (!owner || owner.status !== 'active' || owner.role !== 'admin') {
    return { result: 'error', detail: 'The admin who set up this webhook is no longer an admin. Open it in Settings and save it again.' };
  }
  const members = await projectMembers(db, m.projectId);
  const assignee = members.find((u) => u.id === m.assignee.userId);
  // "Today" is the default assignee's today (their time zone), like the rest of the app.
  const tz = validTz(assignee?.tz) || defaultTz(env);
  const out = evaluate(m, req, { today: todayIn(tz), members });
  if (out.kind === 'skip') return { result: 'skipped', detail: out.reason };
  if (out.kind === 'error') return { result: 'error', detail: out.error };
  if (out.dedupeKey) {
    const seen = await db.prepare('SELECT task_id FROM webhook_keys WHERE webhook_id = ? AND key = ?').bind(h.id, out.dedupeKey).first<{ task_id: string }>();
    if (seen) return { result: 'duplicate', detail: `Already made a task for ${m.dedupePath} = ${out.dedupeKey}`, taskId: seen.task_id };
  }
  try {
    const task = await createTask(env, await toViewer(env, owner, tz), out.task, `${h.name} webhook`);
    if (out.dedupeKey) {
      await db.prepare('INSERT OR IGNORE INTO webhook_keys (webhook_id, key, task_id, created_at) VALUES (?, ?, ?, ?)')
        .bind(h.id, out.dedupeKey, task.id, nowIso()).run();
    }
    return { result: 'created', taskId: task.id, detail: out.warnings.join(' ') || undefined };
  } catch (e) {
    return { result: 'error', detail: e instanceof HttpError ? e.message : "Couldn't create the task." };
  }
}

async function logRequest(db: D1Database, hookId: string, r: Omit<ReqRow, 'id' | 'webhook_id'>) {
  const id = uid();
  await db.batch([
    db.prepare(
      `INSERT INTO webhook_requests (id, webhook_id, received_at, method, content_type, headers, query, body, result, detail, task_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, hookId, r.received_at, r.method, r.content_type, r.headers, r.query, r.body, r.result, r.detail, r.task_id),
    db.prepare('UPDATE webhooks SET last_received_at = ? WHERE id = ?').bind(r.received_at, hookId),
    db.prepare(
      `DELETE FROM webhook_requests WHERE webhook_id = ? AND id NOT IN
         (SELECT id FROM webhook_requests WHERE webhook_id = ? ORDER BY received_at DESC LIMIT ${KEEP})`,
    ).bind(hookId, hookId),
  ]);
  return id;
}

// ---------- public: POST /hooks/<token> ----------
export const hookRoutes = new Hono<AppEnv>();

hookRoutes.all('/:token', async (c) => {
  const token = c.req.param('token');
  if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) return c.json({ ok: false, error: 'Unknown webhook.' }, 404);
  if (c.req.method !== 'POST' && c.req.method !== 'PUT') {
    return c.json({ ok: false, error: 'Send a POST request to this address.' }, 405, { allow: 'POST, PUT' });
  }
  const h = await c.env.DB.prepare('SELECT * FROM webhooks WHERE token = ?').bind(token).first<HookRow>();
  if (!h) return c.json({ ok: false, error: 'Unknown webhook.' }, 404);

  const len = Number(c.req.header('content-length') || 0);
  if (len > MAX_BODY) return c.json({ ok: false, error: `Requests can be at most ${MAX_BODY / 1024} KB.` }, 413);
  const text = await c.req.text();
  if (text.length > MAX_BODY) return c.json({ ok: false, error: `Requests can be at most ${MAX_BODY / 1024} KB.` }, 413);

  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => { if (!DROP_HEADERS.test(k)) headers[k] = v.slice(0, 500); });
  const query = Object.fromEntries(new URL(c.req.url).searchParams);
  const contentType = c.req.header('content-type') ?? null;
  const req: HookRequestView = { body: parseBody(text, contentType ?? ''), headers, query };

  const out = await handle(c.env, h, req);
  await logRequest(c.env.DB, h.id, {
    received_at: nowIso(), method: c.req.method, content_type: contentType,
    headers: JSON.stringify(headers), query: JSON.stringify(query), body: text,
    result: out.result, detail: out.detail ?? null, task_id: out.taskId ?? null,
  });
  switch (out.result) {
    case 'created': return c.json({ ok: true, result: 'created', task_id: out.taskId }, 201);
    case 'captured': return c.json({ ok: true, result: 'captured', message: 'Stored. Set up the mapping in Taskivities to start creating tasks.' }, 202);
    case 'error': return c.json({ ok: false, result: 'error', error: out.detail }, 422);
    default: return c.json({ ok: true, result: out.result, detail: out.detail ?? null, task_id: out.taskId ?? null }, 200);
  }
});

// ---------- admin: /api/admin/webhooks ----------
export const webhookAdmin = new Hono<AppEnv>();

const loadHook = async (c: Ctx, id: string) => {
  const h = await c.env.DB.prepare('SELECT * FROM webhooks WHERE id = ?').bind(id).first<HookRow>();
  if (!h) throw notFound('Webhook not found.');
  return h;
};
const cleanName = (n: unknown) => {
  const name = typeof n === 'string' ? n.trim() : '';
  if (!name) throw bad('Give the webhook a name.');
  if (name.length > NAME_MAX) throw bad(`Names can be at most ${NAME_MAX} characters.`);
  return name;
};

webhookAdmin.get('/', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM webhooks ORDER BY created_at').all<HookRow>();
  return c.json({ webhooks: results.map((h) => toInfo(c, h)) });
});

webhookAdmin.post('/', async (c) => {
  const v = c.get('viewer');
  const b = await c.req.json<{ name?: string }>();
  const id = uid();
  const now = nowIso();
  const name = cleanName(b.name);
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO webhooks (id, name, token, mapping, active, created_by, created_at, updated_at) VALUES (?, ?, ?, NULL, 1, ?, ?, ?)')
      .bind(id, name, randomToken(24), v.id, now, now),
    auditStmt(c.env.DB, v.id, 'webhook_created', id, { name }),
  ]);
  return c.json({ webhook: toInfo(c, await loadHook(c, id)) });
});

/** Rename, pause/resume, or set the mapping (null = back to capturing). Saving makes you the one tasks are made by. */
webhookAdmin.patch('/:id', async (c) => {
  const v = c.get('viewer');
  const h = await loadHook(c, c.req.param('id'));
  const b = await c.req.json<{ name?: string; active?: boolean; mapping?: unknown }>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (b.name !== undefined) { sets.push('name = ?'); binds.push(cleanName(b.name)); }
  if (b.active !== undefined) { sets.push('active = ?'); binds.push(b.active ? 1 : 0); }
  if (b.mapping !== undefined) {
    sets.push('mapping = ?', 'created_by = ?');
    binds.push(b.mapping === null ? null : JSON.stringify(await validate(c.env.DB, b.mapping)), v.id);
  }
  if (!sets.length) return c.json({ webhook: toInfo(c, h) });
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE webhooks SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).bind(...binds, nowIso(), h.id),
    auditStmt(c.env.DB, v.id, 'webhook_updated', h.id, { name: b.name, active: b.active, mapping: b.mapping === undefined ? undefined : b.mapping ? 'set' : 'cleared' }),
  ]);
  return c.json({ webhook: toInfo(c, await loadHook(c, h.id)) });
});

/** A new secret URL; the old one stops working at once. */
webhookAdmin.post('/:id/rotate', async (c) => {
  const v = c.get('viewer');
  const h = await loadHook(c, c.req.param('id'));
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE webhooks SET token = ?, updated_at = ? WHERE id = ?').bind(randomToken(24), nowIso(), h.id),
    auditStmt(c.env.DB, v.id, 'webhook_rotated', h.id, null),
  ]);
  return c.json({ webhook: toInfo(c, await loadHook(c, h.id)) });
});

webhookAdmin.delete('/:id', async (c) => {
  const v = c.get('viewer');
  const h = await loadHook(c, c.req.param('id'));
  const db = c.env.DB;
  await db.batch([
    db.prepare('DELETE FROM webhook_requests WHERE webhook_id = ?').bind(h.id),
    db.prepare('DELETE FROM webhook_keys WHERE webhook_id = ?').bind(h.id),
    db.prepare('DELETE FROM webhooks WHERE id = ?').bind(h.id),
    auditStmt(db, v.id, 'webhook_deleted', h.id, { name: h.name }),
  ]);
  return c.json({ ok: true });
});

webhookAdmin.get('/:id/requests', async (c) => {
  const h = await loadHook(c, c.req.param('id'));
  const { results } = await c.env.DB.prepare('SELECT * FROM webhook_requests WHERE webhook_id = ? ORDER BY received_at DESC').bind(h.id).all<ReqRow>();
  return c.json({ requests: results.map(toReqInfo) });
});

/** Runs a stored request through the current mapping for real (creates the task). */
webhookAdmin.post('/:id/requests/:rid/replay', async (c) => {
  const h = await loadHook(c, c.req.param('id'));
  if (!h.mapping) throw bad('Set up the mapping first.');
  const r = await c.env.DB.prepare('SELECT * FROM webhook_requests WHERE id = ? AND webhook_id = ?').bind(c.req.param('rid'), h.id).first<ReqRow>();
  if (!r) throw notFound('That request is no longer stored.');
  const out = await handle(c.env, { ...h, active: 1 }, view(r));
  await logRequest(c.env.DB, h.id, { ...r, received_at: nowIso(), method: `${r.method} (replay)`, result: out.result, detail: out.detail ?? null, task_id: out.taskId ?? null });
  return c.json(out);
});
