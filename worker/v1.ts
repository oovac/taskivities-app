// The app's API for other apps acting as a person (/v1/…): the same routes as /api, with an OAuth access token
// instead of the session cookie. Taskivities apps on other instances use it to show and change your tasks here
// (src/sources.ts), as AI assistants use /mcp, and with the same tokens (same sign-in and consent page).
//
// Any origin may call it: a bearer token isn't an ambient credential (no cookies are read here), so CORS only has
// to let the browser send it. The token is checked here (unwrapToken) rather than by the provider's API routes,
// so the assistants' existing /mcp resource and tokens stay exactly as they were.
import { Hono } from 'hono';
import { admin } from './admin';
import { api } from './api';
import { attachmentRoutes } from './attachments';
import { dependencyRoutes } from './dependencies';
import { followRoutes } from './followers';
import { inboxRoutes } from './inbox';
import { type AppEnv, type Env, HttpError, loadViewer, validTz } from './lib';
import type { McpProps } from './oauth';
import { pushRoutes } from './push';
import { relayTargetRoutes } from './relay';

const v1 = new Hono<AppEnv>();

v1.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: 'Something went wrong. Please try again.' }, 500);
});

const cors = (origin: string | undefined): Record<string, string> => (origin ? {
  'Access-Control-Allow-Origin': origin, Vary: 'Origin',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Tz, X-File-Name',
  'Access-Control-Expose-Headers': 'Content-Disposition, WWW-Authenticate',
  'Access-Control-Max-Age': '86400',
} : {});

v1.use('*', async (c, next) => {
  const origin = c.req.header('origin');
  if (c.req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
  await next();
  for (const [k, v] of Object.entries(cors(origin))) c.res.headers.set(k, v);
});

v1.use('*', async (c, next) => {
  const m = (c.req.header('authorization') || '').match(/^Bearer\s+(\S+)$/);
  const t = m ? await c.env.OAUTH_PROVIDER.unwrapToken<McpProps>(m[1]).catch(() => null) : null;
  if (!t) return c.json({ error: 'Sign in again.' }, 401, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
  const v = await loadViewer(c.env, t.grant.props.userId);
  // Disabled since they approved it: the token is no good any more.
  if (!v) return c.json({ error: 'You can no longer sign in here.' }, 401);
  // "Today" is the calling app's today, as with the session cookie.
  const tz = validTz(c.req.header('x-tz'));
  if (tz) v.tz = tz;
  c.set('viewer', v);
  await next();
});

v1.route('/v1/admin', admin);
v1.route('/v1/tasks', attachmentRoutes);
v1.route('/v1/tasks', followRoutes);
v1.route('/v1/tasks', dependencyRoutes);
v1.route('/v1/push', pushRoutes);
v1.route('/v1/push-relays', relayTargetRoutes);
v1.route('/v1/inbox', inboxRoutes);
v1.route('/v1', api);
v1.all('*', (c) => c.json({ error: 'Not found' }, 404));

export const v1Handler = { fetch: (req: Request, env: Env, ctx: ExecutionContext) => v1.fetch(req, env, ctx) };
