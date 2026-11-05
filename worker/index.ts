import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { Hono } from 'hono';
import { admin } from './admin';
import { api } from './api';
import { authRoutes, requireSession, sameOrigin } from './auth';
import { type AppEnv, type Env, HttpError } from './lib';
import { TaskivitiesMCP } from './mcp';
import { oauthRoutes } from './oauth';
import { serveLogo } from './settings';

// The MCP session Durable Object (bound as MCP_OBJECT in wrangler.jsonc).
export { TaskivitiesMCP };

const app = new Hono<AppEnv>();

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: 'Something went wrong. Please try again.' }, 500);
});

// The logo (header, sign-in page, browser tab icon). Public, so the sign-in page can show it.
app.get('/logo.svg', serveLogo);

app.route('/auth', authRoutes);
// Sign-in + consent page for AI assistants connecting over MCP.
app.route('/authorize', oauthRoutes);

app.use('/api/*', sameOrigin, requireSession);
app.route('/api/admin', admin);
app.route('/api', api);
app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

// Anything else is the React app.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

// The OAuth provider sits in front of everything: it serves /token, /register and the
// /.well-known metadata, checks the bearer token on /mcp, and passes all other requests to the app.
// The MCP resource is this Worker's own origin + /mcp, so one provider is built per origin
// (localhost in development, the workers.dev and custom domains in production).
const mcp = TaskivitiesMCP.serve('/mcp', { binding: 'MCP_OBJECT' });
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string) {
  let p = providers.get(origin);
  if (!p) {
    if (providers.size > 20) providers.clear();
    p = new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: mcp,
      defaultHandler: { fetch: (req, env, ctx) => app.fetch(req, env, ctx) },
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      clientRegistrationEndpoint: '/register',
      resourceMetadata: { resource: `${origin}/mcp`, resource_name: 'Taskivities' },
      accessTokenTTL: 60 * 60,
      refreshTokenTTL: 365 * 86400, // an assistant connection lasts a year from approval
    });
    providers.set(origin, p);
  }
  return p;
}

export default {
  fetch: (req, env, ctx) => providerFor(new URL(req.url).origin).fetch(req, env, ctx),
} satisfies ExportedHandler<Env>;
