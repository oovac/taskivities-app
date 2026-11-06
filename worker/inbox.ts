// The inbox (the bell in the top bar): what other people did that needs you, whether or not notifications are on.
// It's a view of task_events, the history every task already keeps, so nothing is stored per entry and nothing
// needs clearing out. The same people are told as with notifications (worker/push.ts):
//   • new       a task made for you (a 'created' event whose assignee is you)
//   • assigned  a task handed to you ('transferred' to you), including handovers when someone is disabled
//   • comment   a comment on a task you have or created
// Your own changes aren't in it (unless a webhook made them for you), and neither are tasks you can't see now
// (archived, or in a project you're not on or that's archived). users.inbox_read_at marks what's been seen.
import { Hono } from 'hono';
import { INBOX_PAGE, type InboxItem, type InboxKind, type InboxPage } from '../shared/types';
import { type AppEnv, type Viewer, bad, nowIso } from './lib';
import { visible } from './tasks';

interface Row {
  id: string; task_id: string; actor_id: string; via: string | null; note: string | null; at: string; rid: number;
  kind: InboxKind; title: string; status: string; project_id: string;
}

/** Up to `limit` entries for `v`, newest first: older than `before` (a cursor) and/or newer than `after` (a time). */
async function entries(db: D1Database, v: Viewer, opts: { before?: { at: string; rid: number } | null; after?: string | null }, limit: number) {
  const vis = visible(v, 't.');
  let time = '';
  const timeBinds: unknown[] = [];
  if (opts.before) { time += ' AND (e.at < ? OR (e.at = ? AND e.rowid < ?))'; timeBinds.push(opts.before.at, opts.before.at, opts.before.rid); }
  if (opts.after) { time += ' AND e.at > ?'; timeBinds.push(opts.after); }
  const common = `t.archived_at IS NULL AND ${vis.sql} AND (e.actor_id != ? OR e.via LIKE '% webhook')${time}`;
  const commonBinds = [...vis.binds, v.id, ...timeBinds];
  const cols = 'e.id, e.task_id, e.actor_id, e.via, e.note, e.at, e.rowid AS rid, t.title, t.status, t.project_id';
  // One branch per kind, each able to use its own index (migrations/0014_inbox.sql) and each limited on its own.
  const branches: [string, unknown[]][] = [
    [`SELECT ${cols}, 'new' AS kind FROM task_events e JOIN tasks t ON t.id = e.task_id
       WHERE e.type = 'created' AND json_extract(e.to_value, '$.assignee') = ? AND ${common}`, [v.id, ...commonBinds]],
    [`SELECT ${cols}, 'assigned' AS kind FROM task_events e JOIN tasks t ON t.id = e.task_id
       WHERE e.type = 'transferred' AND e.to_value = ? AND ${common}`, [v.id, ...commonBinds]],
    [`SELECT ${cols}, 'comment' AS kind FROM task_events e JOIN tasks t ON t.id = e.task_id
       WHERE e.task_id IN (SELECT id FROM tasks WHERE assignee_id = ? UNION SELECT id FROM tasks WHERE created_by = ?)
         AND e.type = 'comment' AND ${common}`, [v.id, v.id, ...commonBinds]],
  ];
  const sql = branches.map(([q]) => `SELECT * FROM (${q} ORDER BY e.at DESC, e.rowid DESC LIMIT ${limit})`).join(' UNION ALL ') +
    ` ORDER BY at DESC, rid DESC LIMIT ${limit}`;
  return (await db.prepare(sql).bind(...branches.flatMap(([, b]) => b)).all<Row>()).results;
}

const toItem = (r: Row): InboxItem => ({
  id: r.id, kind: r.kind, taskId: r.task_id, title: r.title, done: r.status === 'done', projectId: r.project_id,
  actorId: r.actor_id, via: r.via, note: r.note, at: r.at,
});

export const UNREAD_MAX = 100;

/** How many entries I haven't seen (at most UNREAD_MAX). */
export async function inboxUnread(db: D1Database, v: Viewer, readAt?: string | null) {
  if (readAt === undefined) readAt = (await db.prepare('SELECT inbox_read_at FROM users WHERE id = ?').bind(v.id).first<{ inbox_read_at: string | null }>())?.inbox_read_at ?? null;
  return (await entries(db, v, { after: readAt }, UNREAD_MAX)).length;
}

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;

export const inboxRoutes = new Hono<AppEnv>();

/** A page of my inbox, newest first. `before`: the `next` cursor from the previous page. */
inboxRoutes.get('/', async (c) => {
  const v = c.get('viewer');
  const db = c.env.DB;
  const raw = c.req.query('before');
  let before: { at: string; rid: number } | null = null;
  if (raw) {
    const [at, rid] = raw.split('|');
    if (!ISO.test(at ?? '') || !/^\d+$/.test(rid ?? '')) throw bad('Invalid cursor.');
    before = { at: at!, rid: Number(rid) };
  }
  const [rows, me] = await Promise.all([
    entries(db, v, { before }, INBOX_PAGE + 1),
    db.prepare('SELECT inbox_read_at FROM users WHERE id = ?').bind(v.id).first<{ inbox_read_at: string | null }>(),
  ]);
  const page = rows.slice(0, INBOX_PAGE);
  const last = page[page.length - 1];
  const body: InboxPage = {
    items: page.map(toItem),
    next: rows.length > INBOX_PAGE && last ? `${last.at}|${last.rid}` : null,
    readAt: me?.inbox_read_at ?? null,
  };
  return c.json(body);
});

/** I've seen everything up to `upTo` (the newest entry shown; never later than now, never moving back). */
inboxRoutes.post('/read', async (c) => {
  const v = c.get('viewer');
  const { upTo } = await c.req.json<{ upTo?: string }>().catch(() => ({ upTo: undefined }));
  const now = nowIso();
  const at = typeof upTo === 'string' && ISO.test(upTo) && upTo < now ? upTo : now;
  await c.env.DB.prepare('UPDATE users SET inbox_read_at = ? WHERE id = ? AND (inbox_read_at IS NULL OR inbox_read_at < ?)').bind(at, v.id, at).run();
  return c.json({ ok: true, unread: await inboxUnread(c.env.DB, v) });
});
