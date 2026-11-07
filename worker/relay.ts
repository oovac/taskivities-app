// Notifications from other instances, through your home instance (migration 0017).
//
// When your app connects to another instance (src/sources.ts), it asks home for a relay (relayRoutes) and gives
// that address to the other instance (relayTargetRoutes, there). From then on, that instance sends your
// notifications to the relay too (worker/push.ts), and the relay (relayIn) passes them to your devices with home's
// push key: one subscription per device, however many instances you use. The relay can't read or change anything
// on the other instance; it only passes on what it's sent.
import { Hono } from 'hono';
import { type AppEnv, type Env, bad, nowIso, randomToken, sha256hex, uid } from './lib';
import { sendToUser } from './push';

// ---------- home: the relays I run for my people ----------
interface RelayRow { id: string; user_id: string; origin: string; secret_hash: string; created_at: string; last_at: string | null }

export const relayRoutes = new Hono<AppEnv>();

/** Instances someone connected (from any device): a new device offers to reconnect them. */
relayRoutes.get('/', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM relays WHERE user_id = ? ORDER BY created_at').bind(c.get('viewer').id).all<RelayRow>();
  return c.json({ relays: results.map((r) => ({ id: r.id, origin: r.origin, createdAt: r.created_at, lastAt: r.last_at })) });
});

/** A relay for one other instance (a new one replaces an older one for the same instance). Its address holds the secret. */
relayRoutes.post('/', async (c) => {
  const v = c.get('viewer');
  const b = await c.req.json<{ origin?: string }>().catch(() => ({} as { origin?: string }));
  let origin: string;
  try { origin = new URL(String(b.origin ?? '')).origin; } catch { throw bad('Give the other instance’s address.'); }
  const db = c.env.DB;
  const id = uid();
  const secret = randomToken(24);
  await db.batch([
    db.prepare('DELETE FROM relays WHERE user_id = ? AND origin = ?').bind(v.id, origin),
    db.prepare('INSERT INTO relays (id, user_id, origin, secret_hash, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, v.id, origin, await sha256hex(secret), nowIso()),
  ]);
  return c.json({ id, url: `${new URL(c.req.url).origin}/relay/${id}.${secret}` }, 201);
});

relayRoutes.delete('/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM relays WHERE id = ? AND user_id = ?').bind(c.req.param('id'), c.get('viewer').id).run();
  return c.json({ ok: true });
});

/** What another instance sends (worker/push.ts → sendToRelays). */
interface RelayNotice { title?: string; body?: string; tag?: string; taskId?: string | null }

/** Public: another instance passing on one of your notifications. 410 when the relay is gone, so it stops sending. */
export const relayIn = new Hono<AppEnv>();
relayIn.post('/:key', async (c) => {
  const [id, secret] = c.req.param('key').split('.');
  const db = c.env.DB;
  const row = id && secret ? await db.prepare('SELECT * FROM relays WHERE id = ?').bind(id).first<RelayRow>() : null;
  if (!row || row.secret_hash !== (await sha256hex(secret))) return c.json({ error: 'No such relay.' }, 410);
  // Plenty for a person's notifications; stops a misbehaving sender from flooding their devices.
  if (row.last_at && Date.now() - Date.parse(row.last_at) < 1500) return c.json({ error: 'Too many.' }, 429);
  const n = await c.req.json<RelayNotice>().catch(() => ({} as RelayNotice));
  const title = String(n.title ?? '').slice(0, 120);
  if (!title) throw bad('Nothing to show.');
  const host = new URL(row.origin).host;
  await db.prepare('UPDATE relays SET last_at = ? WHERE id = ?').bind(nowIso(), row.id).run();
  // Opening it opens the task in your home app, through its connection to that instance.
  const url = n.taskId ? `/?${new URLSearchParams({ open: row.origin, task: String(n.taskId) })}` : `/?${new URLSearchParams({ open: row.origin })}`;
  await sendToUser(c.env, row.user_id, { title, body: String(n.body ?? '').slice(0, 400), url, tag: `${host}-${String(n.tag ?? 'notice').slice(0, 80)}` });
  return c.json({ ok: true });
});

// ---------- every instance: where else to send someone's notifications ----------
export const relayTargetRoutes = new Hono<AppEnv>();

/** Only https relays (plain http only between copies running on one computer while developing). */
function relayUrl(env: Env, raw: unknown, self: string): string {
  let u: URL;
  try { u = new URL(String(raw ?? '')); } catch { throw bad('That isn’t a relay address.'); }
  const local = (h: string) => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(h);
  if (!/^\/relay\/[\w-]+\.[\w-]+$/.test(u.pathname)) throw bad('That isn’t a relay address.');
  if (u.protocol !== 'https:' && !(local(u.hostname) && (local(new URL(self).hostname) || env.DEV_LOGIN === '1'))) throw bad('Relays need https.');
  return u.toString();
}

relayTargetRoutes.post('/', async (c) => {
  const v = c.get('viewer');
  const b = await c.req.json<{ url?: string }>().catch(() => ({} as { url?: string }));
  const url = relayUrl(c.env, b.url, c.req.url);
  const db = c.env.DB;
  const n = await db.prepare('SELECT COUNT(*) AS n FROM push_relays WHERE user_id = ?').bind(v.id).first<{ n: number }>();
  if ((n?.n ?? 0) >= 10) await db.prepare('DELETE FROM push_relays WHERE id IN (SELECT id FROM push_relays WHERE user_id = ? ORDER BY created_at LIMIT 1)').bind(v.id).run();
  await db.prepare('INSERT INTO push_relays (id, user_id, url, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, url) DO NOTHING')
    .bind(uid(), v.id, url, nowIso()).run();
  return c.json({ ok: true }, 201);
});

relayTargetRoutes.delete('/', async (c) => {
  const b = await c.req.json<{ url?: string }>().catch(() => ({} as { url?: string }));
  await c.env.DB.prepare('DELETE FROM push_relays WHERE user_id = ? AND url = ?').bind(c.get('viewer').id, String(b.url ?? '')).run();
  return c.json({ ok: true });
});
