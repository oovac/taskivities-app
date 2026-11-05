// Google sign-in (OAuth 2.0 authorization code + PKCE) and cookie sessions.
// Only emails that exist in `users` (added by an admin) can get in. On a brand-new install the first person
// to sign in becomes the admin. ADMIN_EMAILS (optional) names extra addresses that are always let in as admins.
import { Hono, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { USER_COLORS } from '../shared/types';
import {
  type AppEnv, type Ctx, type UserRow, b64url, bumpDirectory, defaultTz, nowIso, randomToken, sha256, sha256hex, toViewer, uid, validTz,
} from './lib';

const SESSION_COOKIE = 'tv_session';
const SESSION_DAYS = 30;
const isLocal = (c: Ctx) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(c.req.url).hostname);
const cookieBase = (c: Ctx) => ({ httpOnly: true, secure: !isLocal(c) || new URL(c.req.url).protocol === 'https:', sameSite: 'Lax' as const, path: '/' });
const redirectUri = (c: Ctx) => `${new URL(c.req.url).origin}/auth/callback`;
/** Where to go after sign-in: only same-site paths (e.g. back to /authorize for an MCP client). */
const safeNext = (next: string | undefined | null) => (next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/');
const NEXT_COOKIE = 'tv_next';

export const authRoutes = new Hono<AppEnv>();

authRoutes.get('/login', async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    return c.text('Google sign-in is not configured yet: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.', 500);
  }
  const state = randomToken(16);
  const verifier = randomToken(32);
  const challenge = b64url(await sha256(verifier));
  setCookie(c, 'tv_oauth', `${state}.${verifier}`, { ...cookieBase(c), path: '/auth', maxAge: 600 });
  const next = safeNext(c.req.query('next'));
  if (next !== '/') setCookie(c, NEXT_COOKIE, next, { ...cookieBase(c), path: '/auth', maxAge: 600 });
  else deleteCookie(c, NEXT_COOKIE, { path: '/auth' });
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(c),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return c.redirect(u.toString());
});

authRoutes.get('/callback', async (c) => {
  const { code, state, error } = c.req.query();
  const saved = getCookie(c, 'tv_oauth');
  const next = safeNext(getCookie(c, NEXT_COOKIE));
  deleteCookie(c, 'tv_oauth', { path: '/auth' });
  deleteCookie(c, NEXT_COOKIE, { path: '/auth' });
  if (error || !code || !saved) return c.redirect('/login?error=cancelled');
  const [savedState, verifier] = saved.split('.');
  if (savedState !== state) return c.redirect('/login?error=expired');

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID!,
      client_secret: c.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri(c),
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  if (!tokenRes.ok) return c.redirect('/login?error=google');
  const { access_token } = await tokenRes.json<{ access_token: string }>();
  const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${access_token}` } });
  if (!infoRes.ok) return c.redirect('/login?error=google');
  const info = await infoRes.json<{ email?: string; email_verified?: boolean; name?: string; picture?: string }>();
  if (!info.email || !info.email_verified) return c.redirect('/login?error=unverified');
  return signIn(c, info.email, info.name ?? '', info.picture ?? null, next);
});

/** Local development only: sign in as any existing user without Google. */
authRoutes.get('/dev-login', async (c) => {
  if (c.env.DEV_LOGIN !== '1' || !isLocal(c)) return c.notFound();
  const email = c.req.query('email');
  if (!email) return c.text('Add ?email=someone@example.com', 400);
  return signIn(c, email, '', null, safeNext(c.req.query('next')));
});

authRoutes.post('/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256hex(token)).run();
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.body(null, 204);
});

async function signIn(c: Ctx, rawEmail: string, name: string, picture: string | null, next = '/') {
  const db = c.env.DB;
  const email = rawEmail.trim().toLowerCase();
  const now = nowIso();
  const bootstrapAdmins = (c.env.ADMIN_EMAILS || '').toLowerCase().split(/[\s,;]+/).filter(Boolean);
  let user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<UserRow>();

  if ((!user || user.status === 'removed') && bootstrapAdmins.includes(email)) {
    if (user) {
      await db.batch([
        db.prepare("UPDATE users SET role = 'admin', status = 'active', name = ?, avatar_url = ?, last_seen_at = ? WHERE id = ?")
          .bind(name || user.name, picture, now, user.id),
        bumpDirectory(db),
      ]);
    } else {
      const id = uid();
      await db.batch([
        db.prepare("INSERT INTO users (id, email, name, avatar_url, color, role, status, added_by, added_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 'admin', 'active', NULL, ?, ?)")
          .bind(id, email, name, picture, USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)], now, now),
        bumpDirectory(db),
      ]);
    }
    user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<UserRow>();
  }

  if (!user) {
    // Brand-new install: the very first person to sign in becomes the admin.
    // One conditional INSERT, so if two people race, only one can win.
    await db
      .prepare(
        `INSERT INTO users (id, email, name, avatar_url, color, role, status, added_by, added_at, last_seen_at)
         SELECT ?, ?, ?, ?, ?, 'admin', 'active', NULL, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
      )
      .bind(uid(), email, name, picture, USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)], now, now)
      .run();
    // If the insert won, this person now exists (as the admin); otherwise someone else was first.
    user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<UserRow>();
    if (user) await bumpDirectory(db).run();
  }

  if (!user || user.status === 'removed') {
    // Shown on the sign-in page so people know which address was refused.
    setCookie(c, 'tv_denied', email, { secure: cookieBase(c).secure, sameSite: 'Lax', path: '/', maxAge: 300 });
    return c.redirect('/login?error=no_access');
  }

  const changed = user.status !== 'active' || (name && name !== user.name) || (picture && picture !== user.avatar_url);
  const stmts = [
    db.prepare("UPDATE users SET status = 'active', name = COALESCE(NULLIF(?, ''), name), avatar_url = COALESCE(?, avatar_url), last_seen_at = ? WHERE id = ?")
      .bind(name, picture, now, user.id),
  ];
  if (changed) stmts.push(bumpDirectory(db));
  await createSession(c, user.id, stmts);
  return c.redirect(next);
}

async function createSession(c: Ctx, userId: string, extra: D1PreparedStatement[] = []) {
  const db = c.env.DB;
  const token = randomToken(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await db.batch([
    ...extra,
    db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(await sha256hex(token), userId, nowIso(), expires),
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(nowIso()),
  ]);
  setCookie(c, SESSION_COOKIE, token, { ...cookieBase(c), maxAge: SESSION_DAYS * 86400 });
}

/**
 * The signed-in user for this request's session cookie, or null. Sessions slide forward when they're half used up.
 * Clears a stale cookie.
 */
export async function currentUser(c: Ctx): Promise<UserRow | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const db = c.env.DB;
  const id = await sha256hex(token);
  const row = await db
    .prepare("SELECT s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND u.status = 'active'")
    .bind(id)
    .first<UserRow & { expires_at: string }>();
  if (!row || row.expires_at < nowIso()) {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return null;
  }
  if (new Date(row.expires_at).getTime() - Date.now() < (SESSION_DAYS / 2) * 864e5) {
    const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
    await db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').bind(expires, id).run();
    setCookie(c, SESSION_COOKIE, token, { ...cookieBase(c), maxAge: SESSION_DAYS * 86400 });
  }
  return row;
}

/** Loads the signed-in viewer, or answers 401. */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const row = await currentUser(c);
  if (!row) return c.json({ error: 'Signed out' }, 401);
  // The app sends the browser's time zone on every request, so "today" follows people when they travel.
  const sent = validTz(c.req.header('x-tz'));
  // Saved for AI assistants (which don't send one) and the Team page. No directory bump: two open devices
  // in different zones would otherwise make everyone reload the team list on every poll.
  if (sent && sent !== row.time_zone) await c.env.DB.prepare('UPDATE users SET time_zone = ? WHERE id = ?').bind(sent, row.id).run();
  c.set('viewer', await toViewer(c.env, row, sent || validTz(row.time_zone) || defaultTz(c.env)));
  await next();
};

/** Writes must come from our own pages: same origin plus a custom header (which forces a CORS preflight). */
export const sameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const origin = c.req.header('origin');
    if (origin && new URL(origin).host !== new URL(c.req.url).host) return c.json({ error: 'Bad origin' }, 403);
    if (c.req.header('x-taskivities') !== '1') return c.json({ error: 'Missing header' }, 403);
  }
  await next();
};
