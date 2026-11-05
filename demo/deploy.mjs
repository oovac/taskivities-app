#!/usr/bin/env node
// Deploys or runs the public demo (demo/worker.ts, which wraps the app's Worker; see demo/README.md).
//
//   node demo/deploy.mjs dev [--port 5174]        run it locally, on its own local database
//   node demo/deploy.mjs reset-local [--port 5174] put the local demo back to the sample (runs the Cron Trigger)
//   node demo/deploy.mjs <instance> [--dry-run]   migrate, build and deploy to tenants/<instance>.env
//
// The instance is an ordinary tenants/<instance>.env (create it with `npm run tenant -- create demo`, without
// Google secrets: the demo signs people in as sample users). Optional there: DEMO_RESET_CRON (default "0 * * * *").
// R2_BUCKET is ignored: demo uploads are kept as sample files, not stored.
// Notifications: the first deploy creates the Web Push keys (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY) as secrets, like `npm run deploy`.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePushKeys } from '../scripts/push-keys.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '.wrangler', 'tenants');
const WRANGLER = join(ROOT, 'node_modules', '.bin', 'wrangler');
const die = (m) => { console.error(`\n✘ ${m}\n`); process.exit(1); };
const run = (cmd, args, env = {}) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) die(`${cmd} ${args.join(' ')} failed.`);
};

function parseEnv(file) {
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.trim().match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    v = /^(["']).*\1$/.test(v) ? v.slice(1, -1) : v.replace(/\s+#.*$/, '').trim();
    out[m[1]] = v;
  }
  return out;
}

/** wrangler.jsonc without comments or trailing commas. */
function readJsonc(file) {
  const src = readFileSync(file, 'utf8');
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') { let j = i + 1; while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1; out += src.slice(i, j + 1); i = j; }
    else if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; }
    else if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; }
    else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** The app's wrangler.jsonc, pointed at the demo Worker. `t` = the instance's values (empty for local). */
function config(name, t) {
  const base = readJsonc(join(ROOT, 'wrangler.jsonc'));
  const up = relative(OUT, ROOT);
  const local = !t.WORKER_NAME;
  const cfg = {
    ...base,
    $schema: join(up, base.$schema),
    name: t.WORKER_NAME || 'taskivities-demo-local',
    main: join(up, 'demo', 'worker.ts'),
    workers_dev: t.WORKERS_DEV !== 'false',
    // Every request goes through the demo Worker: it serves /login and adds the banner to the app's pages.
    assets: { ...base.assets, run_worker_first: true },
    d1_databases: base.d1_databases.map((d) => (d.binding === 'DB'
      ? { ...d, database_name: t.D1_DATABASE_NAME || t.WORKER_NAME || 'taskivities-demo-local',
          // Locally, its own database (not the one `npm run dev` uses), since a reset empties it.
          database_id: t.D1_DATABASE_ID || '00000000-0000-0000-0000-00000000de00', migrations_dir: join(up, d.migrations_dir) }
      : d)),
    kv_namespaces: base.kv_namespaces.map((k) => (k.binding === 'OAUTH_KV' ? { ...k, id: t.OAUTH_KV_ID || '000000000000000000000000000de000' } : k)),
    vars: { ...base.vars, ...(t.TEAM_TZ ? { TEAM_TZ: t.TEAM_TZ } : {}) },
    triggers: { crons: [t.DEMO_RESET_CRON || '0 * * * *'] },
  };
  delete cfg.r2_buckets; // uploads are kept as samples (demo/files.ts)
  if (!local) {
    const domains = (t.CUSTOM_DOMAINS || '').split(',').map((d) => d.trim()).filter(Boolean);
    if (domains.length) cfg.routes = domains.map((pattern) => ({ pattern, custom_domain: true }));
    if (t.CLOUDFLARE_ACCOUNT_ID) cfg.account_id = t.CLOUDFLARE_ACCOUNT_ID;
  }
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `${name}.demo.json`);
  writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
  return file;
}

const [cmd, ...rest] = process.argv.slice(2);
const flag = (k) => { const i = rest.indexOf(`--${k}`); return i < 0 ? undefined : rest[i + 1] ?? true; };
const port = String(flag('port') || 5174);

if (!cmd) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 7).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
} else if (cmd === 'dev') {
  const cfg = config('local', {});
  run(WRANGLER, ['d1', 'migrations', 'apply', 'DB', '--local', '--config', cfg, '--persist-to', join(ROOT, '.wrangler', 'state')]);
  console.log(`\n▸ Demo on http://localhost:${port}  (its own local database; the app's \`npm run dev\` data isn't touched)\n`);
  run(join(ROOT, 'node_modules', '.bin', 'vite'), ['--port', port, '--strictPort'], { TASKIVITIES_WRANGLER_CONFIG: cfg });
} else if (cmd === 'reset-local') {
  // The local dev server runs a Worker's scheduled() handler through its explorer API.
  const r = await fetch(`http://localhost:${port}/cdn-cgi/local/explorer/api/local/scheduled?worker=taskivities-demo-local`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cron: '0 * * * *' }),
  }).catch((e) => die(`Is the demo running (node demo/deploy.mjs dev)? ${e.message}`));
  const out = await r.json().catch(() => ({}));
  console.log(out?.result?.outcome === 'ok' ? '✔ Reset to the sample data (everyone is signed out).' : `✘ ${JSON.stringify(out)}`);
} else {
  const file = join(ROOT, 'tenants', `${cmd}.env`);
  let t;
  try { t = parseEnv(file); } catch { die(`No tenants/${cmd}.env. Create it with: npm run tenant -- create ${cmd}`); }
  if (!t.WORKER_NAME || !t.D1_DATABASE_ID || !t.OAUTH_KV_ID) die(`tenants/${cmd}.env needs WORKER_NAME, D1_DATABASE_ID and OAUTH_KV_ID.`);
  const dry = rest.includes('--dry-run');
  const cfg = config(cmd, t);
  const as = [...(t.CLOUDFLARE_PROFILE ? ['--profile', t.CLOUDFLARE_PROFILE] : [])];
  const acct = t.CLOUDFLARE_ACCOUNT_ID ? { CLOUDFLARE_ACCOUNT_ID: t.CLOUDFLARE_ACCOUNT_ID } : {};
  console.log(`\n▸ Demo "${cmd}" → Worker ${t.WORKER_NAME}${dry ? ' (dry run: nothing is changed)' : ''}`);
  if (!dry) run(WRANGLER, ['d1', 'migrations', 'apply', 'DB', '--remote', '--config', cfg, ...as], acct);
  run('npx', ['tsc', '-b']);
  run('npx', ['tsc', '-p', 'demo/tsconfig.json', '--noEmit']);
  rmSync(join(ROOT, 'dist'), { recursive: true, force: true });
  run('npx', ['vite', 'build'], { TASKIVITIES_WRANGLER_CONFIG: cfg });
  run(WRANGLER, ['deploy', ...(dry ? ['--dry-run'] : []), ...as], acct);
  if (!dry) ensurePushKeys({ config: cfg, args: as, env: acct });
  if (!dry) console.log(`\n✔ Deployed. The first sign-in loads the sample data; after that it resets on "${t.DEMO_RESET_CRON || '0 * * * *'}" (UTC).\n`);
}
