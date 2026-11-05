// Notifications on people's phones and computers (Web Push; the sending itself is in worker/webpush.ts).
//   • A device turns them on in the account menu: the browser subscribes with this instance's public key, and the
//     subscription is stored in push_subscriptions.
//   • notify() is called after a task change is saved. It runs after the response (waitUntil), so it never slows a change.
//   • morningSummaries() runs on the Cron Trigger: at 8:00 in each person's time zone, how many tasks today.
// People are only told about other people's changes (and their assistants'), never their own.
import { waitUntil } from 'cloudflare:workers';
import { Hono } from 'hono';
import { addDays, fmt, todayIn } from '../shared/dates';
import { NOTIFY_DEFAULTS, type NotifyPrefs } from '../shared/types';
import { type AppEnv, type Env, bad, defaultTz, nowIso, uid, validTz } from './lib';
import { type PushKeys, type PushTarget, fromB64u, sendPush, validEndpoint } from './webpush';

export const pushKeys = (env: Env): PushKeys | null =>
  env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY ? { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY } : null;

export function prefsOf(raw: string | null | undefined): NotifyPrefs {
  try {
    const p = raw ? (JSON.parse(raw) as Partial<NotifyPrefs>) : {};
    return { assigned: p.assigned !== false, comments: p.comments !== false, morning: p.morning !== false };
  } catch {
    return { ...NOTIFY_DEFAULTS };
  }
}

/** Push services want a contact: VAPID_SUBJECT, or the app's own https address. */
const subjectFor = (env: Env, origin: string) => env.VAPID_SUBJECT || (origin.startsWith('https://') ? origin : 'https://www.taskivities.com');

interface SubRow extends PushTarget { id: string; user_id: string; origin: string }
interface Payload { title: string; body: string; url: string; tag: string; badge?: number }

/** Sends to each of someone's devices; forgets the ones the push service says are gone. */
async function sendAll(env: Env, keys: PushKeys, subs: SubRow[], payload: Payload, opts: { topic?: string; urgency?: 'normal' | 'high' } = {}) {
  const results = await Promise.all(subs.map(async (s) => ({ s, r: await sendPush(s, payload, keys, subjectFor(env, s.origin), opts) })));
  const gone = results.filter((x) => x.r === 'gone').map((x) => x.s.id);
  const ok = results.filter((x) => x.r === 'ok').map((x) => x.s.id);
  const db = env.DB;
  const stmts = [
    ...gone.map((id) => db.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(id)),
    ...ok.map((id) => db.prepare('UPDATE push_subscriptions SET last_ok_at = ? WHERE id = ?').bind(nowIso(), id)),
  ];
  if (stmts.length) await db.batch(stmts);
  return results;
}

/** Open tasks on someone's plate today (due today or carried over), for the app icon's badge. */
async function openToday(db: D1Database, userId: string, day: string) {
  return (await db.prepare(
    `SELECT COUNT(*) AS n FROM tasks WHERE assignee_id = ? AND status = 'open' AND archived_at IS NULL AND due_date <= ?
       AND project_id IN (SELECT id FROM projects WHERE archived = 0)`,
  ).bind(userId, day).first<{ n: number }>())!.n;
}

// ---------- after a change ----------
export interface Notice {
  to: string;
  kind: 'assigned' | 'comment';
  actorId: string;
  /** The assistant ("Claude") or webhook ("GitHub webhook") that made the change for the actor. */
  via: string | null;
  taskId?: string;
  /** A new task (rather than one handed over). */
  isNew?: boolean;
  /** The comment, or the note sent with a transfer. */
  text?: string | null;
  /** Several tasks handed over at once (when someone is disabled), and whose they were. */
  count?: number;
  fromName?: string;
}

/** Sends notices after the response. Nobody is told about their own change, unless a webhook made it for them. */
export function notify(env: Env, notices: Notice[]) {
  const keys = pushKeys(env);
  const list = notices.filter((n) => n.to !== n.actorId || n.via?.endsWith(' webhook'));
  if (!keys || !list.length) return;
  const job = deliver(env, keys, list).catch((e) => console.error('notify failed', e));
  try { waitUntil(job); } catch { /* not inside a request: the promise runs on its own */ }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

async function deliver(env: Env, keys: PushKeys, notices: Notice[]) {
  const db = env.DB;
  const to = [...new Set(notices.map((n) => n.to))];
  const subs = (await db.prepare(`SELECT * FROM push_subscriptions WHERE user_id IN (${to.map(() => '?').join(',')})`).bind(...to).all<SubRow>()).results;
  if (!subs.length) return;
  const people = [...new Set([...to, ...notices.map((n) => n.actorId)])];
  const users = new Map((await db.prepare(`SELECT id, name, email, status, notify, time_zone FROM users WHERE id IN (${people.map(() => '?').join(',')})`)
    .bind(...people).all<{ id: string; name: string; email: string; status: string; notify: string | null; time_zone: string | null }>()).results.map((u) => [u.id, u]));
  const taskIds = [...new Set(notices.map((n) => n.taskId).filter(Boolean) as string[])];
  const tasks = new Map(taskIds.length ? (await db.prepare(
    `SELECT t.id, t.title, t.due_date, p.name AS project FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id IN (${taskIds.map(() => '?').join(',')})`,
  ).bind(...taskIds).all<{ id: string; title: string; due_date: string; project: string }>()).results.map((t) => [t.id, t]) : []);
  const name = (id: string) => { const u = users.get(id); return u?.name || u?.email.split('@')[0] || 'Someone'; };

  const seen = new Set<string>();
  for (const n of notices) {
    const key = `${n.to}|${n.kind}|${n.taskId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const u = users.get(n.to);
    const mine = subs.filter((s) => s.user_id === n.to);
    if (!u || u.status !== 'active' || !mine.length) continue;
    const prefs = prefsOf(u.notify);
    if (n.kind === 'assigned' ? !prefs.assigned : !prefs.comments) continue;
    const who = n.via?.endsWith(' webhook') ? n.via : n.via ? `${name(n.actorId)} via ${n.via}` : name(n.actorId);
    const day = todayIn(validTz(u.time_zone) || defaultTz(env));
    const t = n.taskId ? tasks.get(n.taskId) : undefined;
    const due = t ? (t.due_date === day ? 'due today' : t.due_date === addDays(day, 1) ? 'due tomorrow' : t.due_date < day ? `was due ${fmt(t.due_date)}` : `due ${fmt(t.due_date)}`) : '';
    let payload: Payload;
    if (n.count) {
      payload = { title: `${who} gave you ${n.count} task${n.count > 1 ? 's' : ''}`, body: n.fromName ? `They were ${n.fromName}'s.` : '', url: '/', tag: `handover-${n.actorId}` };
    } else if (!t) {
      continue;
    } else if (n.kind === 'assigned') {
      payload = {
        title: n.isNew ? `New task from ${who}` : `${who} gave you a task`,
        body: [clip(t.title, 120), `${t.project} · ${due}`, n.text ? `“${clip(n.text, 140)}”` : ''].filter(Boolean).join('\n'),
        url: `/?task=${t.id}`, tag: `task-${t.id}`,
      };
    } else {
      payload = { title: `${who} commented`, body: `${clip(t.title, 80)}\n“${clip(n.text ?? '', 180)}”`, url: `/?task=${t.id}`, tag: `task-${t.id}` };
    }
    payload.badge = await openToday(db, n.to, day);
    await sendAll(env, keys, mine, payload, { topic: n.taskId?.replace(/-/g, ''), urgency: n.kind === 'assigned' ? 'high' : 'normal' });
  }
}

// ---------- every morning (Cron Trigger) ----------
const hourIn = (tz: string) => Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));

/** At 8 in the morning in each person's time zone: how many tasks are on their plate today. Once a day, and only if there are some. */
export async function morningSummaries(env: Env) {
  const keys = pushKeys(env);
  if (!keys) return;
  const db = env.DB;
  const { results } = await db.prepare(
    "SELECT * FROM users u WHERE u.status = 'active' AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.user_id = u.id)",
  ).all<{ id: string; notify: string | null; time_zone: string | null; morning_sent_on: string | null }>();
  for (const u of results) {
    // One person's failure never stops the others' summaries.
    await morningFor(env, keys, u).catch((e) => console.error('morning summary failed', u.id, e));
  }
}

async function morningFor(env: Env, keys: PushKeys, u: { id: string; notify: string | null; time_zone: string | null; morning_sent_on: string | null }) {
  const db = env.DB;
  if (!prefsOf(u.notify).morning) return;
  const tz = validTz(u.time_zone) || defaultTz(env);
  if (hourIn(tz) !== 8) return;
  const day = todayIn(tz);
  if (u.morning_sent_on === day) return;
  // Claimed first, so two runs in the same hour can't both send.
  const claimed = await db.prepare('UPDATE users SET morning_sent_on = ? WHERE id = ? AND (morning_sent_on IS NULL OR morning_sent_on != ?)').bind(day, u.id, day).run();
  if (!claimed.meta.changes) return;
  const { results: list } = await db.prepare(
    `SELECT title, due_date FROM tasks WHERE assignee_id = ? AND status = 'open' AND archived_at IS NULL AND due_date <= ?
       AND project_id IN (SELECT id FROM projects WHERE archived = 0) ORDER BY priority, due_date, created_at`,
  ).bind(u.id, day).all<{ title: string; due_date: string }>();
  if (!list.length) return;
  const late = list.filter((t) => t.due_date < day).length;
  const subs = (await db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').bind(u.id).all<SubRow>()).results;
  await sendAll(env, keys, subs, {
    title: `Today: ${list.length} task${list.length > 1 ? 's' : ''}`,
    body: `${late ? `${late} carried over · ` : ''}First: ${clip(list[0].title, 100)}`,
    url: '/', tag: 'morning', badge: list.length,
  }, { topic: 'morning' });
}

// ---------- the app's routes (/api/push) ----------
export const pushRoutes = new Hono<AppEnv>();

/** This device turned notifications on (or the app checked in again): store or refresh its subscription. */
pushRoutes.post('/subscribe', async (c) => {
  if (!pushKeys(c.env)) throw bad('Notifications are not set up on this instance.');
  const v = c.get('viewer');
  const b = await c.req.json<{ endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }>();
  const p256dh = typeof b.keys?.p256dh === 'string' ? b.keys.p256dh : '';
  const auth = typeof b.keys?.auth === 'string' ? b.keys.auth : '';
  let ok = validEndpoint(b.endpoint);
  try { ok &&= fromB64u(p256dh).length === 65 && fromB64u(auth).length === 16; } catch { ok = false; }
  if (!ok) throw bad("This browser's notification address isn't one we can send to.");
  const db = c.env.DB;
  const origin = new URL(c.req.url).origin;
  // The same device always has the same endpoint: whoever is signed in on it now gets its notifications.
  await db.batch([
    db.prepare(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, origin, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, origin = excluded.origin, user_agent = excluded.user_agent`,
    ).bind(uid(), v.id, b.endpoint as string, p256dh, auth, origin, (c.req.header('user-agent') ?? '').slice(0, 300), nowIso()),
    // At most 10 devices each: the oldest go.
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND id NOT IN (SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 10)').bind(v.id, v.id),
  ]);
  return c.json({ ok: true });
});

pushRoutes.post('/unsubscribe', async (c) => {
  const b = await c.req.json<{ endpoint?: unknown }>();
  if (typeof b.endpoint === 'string') await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').bind(b.endpoint, c.get('viewer').id).run();
  return c.json({ ok: true });
});

/** What I want to hear about (all my devices). */
pushRoutes.put('/prefs', async (c) => {
  const b = await c.req.json<Partial<Record<keyof NotifyPrefs, unknown>>>();
  const cur = prefsOf((await c.env.DB.prepare('SELECT notify FROM users WHERE id = ?').bind(c.get('viewer').id).first<{ notify: string | null }>())?.notify);
  const next: NotifyPrefs = {
    assigned: typeof b.assigned === 'boolean' ? b.assigned : cur.assigned,
    comments: typeof b.comments === 'boolean' ? b.comments : cur.comments,
    morning: typeof b.morning === 'boolean' ? b.morning : cur.morning,
  };
  await c.env.DB.prepare('UPDATE users SET notify = ? WHERE id = ?').bind(JSON.stringify(next), c.get('viewer').id).run();
  return c.json({ notify: next });
});

/** A test notification to this device, right after turning them on. */
pushRoutes.post('/test', async (c) => {
  const keys = pushKeys(c.env);
  if (!keys) throw bad('Notifications are not set up on this instance.');
  const b = await c.req.json<{ endpoint?: unknown }>();
  const sub = await c.env.DB.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').bind(String(b.endpoint ?? ''), c.get('viewer').id).first<SubRow>();
  if (!sub) throw bad('Turn notifications on first.');
  const [r] = await sendAll(c.env, keys, [sub], { title: 'Notifications are on', body: "You'll hear when someone gives you a task or comments on yours.", url: '/', tag: 'test' }, { urgency: 'high' });
  return c.json({ result: r?.r ?? 'failed' });
});
