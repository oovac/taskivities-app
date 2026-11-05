#!/usr/bin/env node
// Deploys one codebase to many Cloudflare Workers ("instances", e.g. one per team or client).
//
// Each instance's Cloudflare values live in tenants/<instance>.env, which is NOT committed
// (see tenants/example.env for every value and where to find it). wrangler.jsonc holds only
// what all instances share, with placeholder IDs that are used for local development.
//
//   npm run tenant -- create <instance> [--name worker-name] [--tz Area/City] [--domain host]
//                                       [--account <id>] [--profile <wrangler auth profile>]
//   npm run tenant -- list
//   npm run deploy -- <instance> [--dry-run]       migrate the database, build, deploy
//   npm run db:migrate:remote -- <instance>
//   npm run tenant -- secret <instance> <NAME>     e.g. GOOGLE_CLIENT_ID (you type the value)
//   npm run tenant -- wrangler <instance> <args…>  any other wrangler command, e.g. tail
//
// With only one instance file, <instance> can be left out. TENANT=<instance> also works.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TENANTS = join(ROOT, 'tenants');
const GENERATED = join(ROOT, '.wrangler', 'tenants'); // generated wrangler configs (git-ignored)
const WRANGLER = join(ROOT, 'node_modules', '.bin', 'wrangler');

const die = (msg) => {
  console.error(`\n✘ ${msg}\n`);
  process.exit(1);
};

// ---------- reading files ----------

/** KEY=value lines; # comments; optional quotes. */
function parseEnv(file) {
  const out = {};
  readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const m = t.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) die(`${relative(ROOT, file)} line ${i + 1}: expected KEY=value`);
    let v = m[2];
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '').trim();
    out[m[1]] = v;
  });
  return out;
}

/** wrangler.jsonc → object (drops comments and trailing commas, leaving strings alone). */
function readJsonc(file) {
  const src = readFileSync(file, 'utf8');
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

// ---------- instances ----------

const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const instances = () =>
  existsSync(TENANTS) ? readdirSync(TENANTS).filter((f) => f.endsWith('.env') && f !== 'example.env').map((f) => f.slice(0, -4)).sort() : [];

function pick(arg) {
  const name = arg || process.env.TENANT;
  const all = instances();
  if (name) {
    if (!all.includes(name)) die(`No tenants/${name}.env. ${all.length ? `Instances: ${all.join(', ')}` : 'Create one with: npm run tenant -- create <instance>'}`);
    return name;
  }
  if (all.length === 1) return all[0];
  if (!all.length) die('No instances yet. Create one with: npm run tenant -- create <instance>  (or copy tenants/example.env)');
  die(`Which instance? ${all.join(', ')}  (e.g. npm run deploy -- ${all[0]})`);
}

/** Loads and checks tenants/<name>.env. */
function load(name) {
  const file = join(TENANTS, `${name}.env`);
  const e = parseEnv(file);
  const where = `tenants/${name}.env`;
  const need = (k, re, hint) => {
    if (!e[k]) die(`${where}: ${k} is missing. ${hint}`);
    if (re && !re.test(e[k])) die(`${where}: ${k} doesn't look right ("${e[k]}"). ${hint}`);
  };
  const see = 'See tenants/example.env for where to find it.';
  need('WORKER_NAME', NAME_RE, 'Lowercase letters, numbers and dashes.');
  need('D1_DATABASE_ID', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, see);
  need('OAUTH_KV_ID', /^[0-9a-f]{32}$/, see);
  if (e.CLOUDFLARE_ACCOUNT_ID && !/^[0-9a-f]{32}$/.test(e.CLOUDFLARE_ACCOUNT_ID)) die(`${where}: CLOUDFLARE_ACCOUNT_ID doesn't look right. ${see}`);
  if (e.CLOUDFLARE_PROFILE && !PROFILE_RE.test(e.CLOUDFLARE_PROFILE)) die(`${where}: CLOUDFLARE_PROFILE must be a profile name from \`npx wrangler auth list\`.`);
  if (e.TEAM_TZ) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: e.TEAM_TZ });
    } catch {
      die(`${where}: TEAM_TZ "${e.TEAM_TZ}" isn't a time zone. Use a name like America/New_York or Europe/London.`);
    }
  }
  if (e.WORKERS_DEV && !/^(true|false)$/.test(e.WORKERS_DEV)) die(`${where}: WORKERS_DEV must be true or false.`);
  const domains = (e.CUSTOM_DOMAINS || '').split(',').map((d) => d.trim()).filter(Boolean);
  for (const d of domains) if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d)) die(`${where}: "${d}" in CUSTOM_DOMAINS isn't a host name (no https://, no path).`);
  if (e.WORKERS_DEV === 'false' && !domains.length) die(`${where}: with WORKERS_DEV=false, add CUSTOM_DOMAINS or the app has no address.`);
  return { ...e, domains, file };
}

/** wrangler.jsonc + the instance's values → .wrangler/tenants/<name>.json. Returns its path. */
function generate(name, t) {
  const base = readJsonc(join(ROOT, 'wrangler.jsonc'));
  mkdirSync(GENERATED, { recursive: true });
  const up = relative(GENERATED, ROOT); // paths in a wrangler config are relative to the config file
  const fix = (p) => (p ? join(up, p) : p);
  const cfg = {
    ...base,
    $schema: fix(base.$schema),
    name: t.WORKER_NAME,
    main: fix(base.main),
    workers_dev: t.WORKERS_DEV !== 'false',
    d1_databases: base.d1_databases.map((d) =>
      d.binding === 'DB'
        ? { ...d, database_name: t.D1_DATABASE_NAME || t.WORKER_NAME, database_id: t.D1_DATABASE_ID, migrations_dir: fix(d.migrations_dir) }
        : d,
    ),
    kv_namespaces: base.kv_namespaces.map((k) => (k.binding === 'OAUTH_KV' ? { ...k, id: t.OAUTH_KV_ID } : k)),
    vars: { ...base.vars, ...(t.TEAM_TZ ? { TEAM_TZ: t.TEAM_TZ } : {}) },
  };
  if (t.domains.length) cfg.routes = t.domains.map((pattern) => ({ pattern, custom_domain: true }));
  if (t.CLOUDFLARE_ACCOUNT_ID) cfg.account_id = t.CLOUDFLARE_ACCOUNT_ID;
  const out = join(GENERATED, `${name}.json`);
  writeFileSync(out, `${JSON.stringify(cfg, null, 2)}\n`);
  return out;
}

// ---------- running things ----------

function run(cmd, args, { env = {}, cwd = ROOT, capture = false } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
  });
  if (r.status !== 0) die(`${relative(ROOT, cmd) || cmd} ${args.join(' ')} failed.`);
  return r.stdout ?? '';
}
/**
 * Runs wrangler as the instance's Cloudflare login and account:
 * CLOUDFLARE_PROFILE → --profile (a named login from `wrangler auth create`), CLOUDFLARE_ACCOUNT_ID → that account.
 */
const wrangler = (t, args, opts = {}) =>
  run(WRANGLER, [...args, ...(t?.CLOUDFLARE_PROFILE ? ['--profile', t.CLOUDFLARE_PROFILE] : [])], {
    ...opts,
    env: { ...(t?.CLOUDFLARE_ACCOUNT_ID ? { CLOUDFLARE_ACCOUNT_ID: t.CLOUDFLARE_ACCOUNT_ID } : {}), ...opts.env },
  });

function migrate(name, t, cfg) {
  console.log(`\n▸ Updating the ${t.WORKER_NAME} database`);
  wrangler(t, ['d1', 'migrations', 'apply', 'DB', '--remote', '--config', cfg]);
}

function deploy(name, dryRun) {
  const t = load(name);
  const cfg = generate(name, t);
  console.log(`\n▸ Instance "${name}" → Worker ${t.WORKER_NAME}${dryRun ? ' (dry run: nothing is changed)' : ''}`);
  if (!dryRun) migrate(name, t, cfg);
  console.log('\n▸ Building');
  run('npx', ['tsc', '-b']);
  // The Vite plugin builds the Worker from this config; `wrangler deploy` then follows the config it wrote.
  rmSync(join(ROOT, 'dist'), { recursive: true, force: true });
  run('npx', ['vite', 'build'], { env: { TASKIVITIES_WRANGLER_CONFIG: cfg } });
  console.log(`\n▸ Deploying`);
  wrangler(t, ['deploy', ...(dryRun ? ['--dry-run'] : [])]);
}

/** Creates the D1 database and KV namespace for a new instance and writes tenants/<name>.env. */
function create(name, opts) {
  if (!name || !NAME_RE.test(name)) die('Usage: npm run tenant -- create <instance>   (lowercase letters, numbers, dashes)');
  const file = join(TENANTS, `${name}.env`);
  if (existsSync(file)) die(`tenants/${name}.env already exists.`);
  const worker = opts.name || `taskivities-${name}`;
  if (!NAME_RE.test(worker)) die(`"${worker}" can't be a Worker name: lowercase letters, numbers and dashes.`);
  if (opts.account && !/^[0-9a-f]{32}$/.test(opts.account)) die('--account must be a 32-character account ID (see `npx wrangler whoami`).');
  if (opts.profile && !PROFILE_RE.test(opts.profile)) die('--profile must be a profile name from `npx wrangler auth list`.');
  const acct = { CLOUDFLARE_ACCOUNT_ID: opts.account || '', CLOUDFLARE_PROFILE: opts.profile || '' };
  // Run from an empty folder so wrangler can't offer to edit wrangler.jsonc.
  const scratch = mkdtempSync(join(tmpdir(), 'taskivities-'));
  try {
    console.log(`\n▸ Creating D1 database ${worker}`);
    const d1 = wrangler(acct, ['d1', 'create', worker], { cwd: scratch, capture: true });
    process.stdout.write(d1);
    const dbId = d1.match(/database_id"?\s*[:=]\s*"([0-9a-f-]{36})"/)?.[1];
    if (!dbId) die("Couldn't find the new database's ID in wrangler's output. Run `npx wrangler d1 list` and fill tenants/example.env by hand.");

    console.log(`\n▸ Creating KV namespace ${worker}-oauth`);
    const kv = wrangler(acct, ['kv', 'namespace', 'create', `${worker}-oauth`], { cwd: scratch, capture: true });
    process.stdout.write(kv);
    const kvId = kv.match(/"?id"?\s*[:=]\s*"([0-9a-f]{32})"/)?.[1];
    if (!kvId) die(`Database created (D1_DATABASE_ID=${dbId}), but couldn't read the KV namespace ID. Run \`npx wrangler kv namespace list\` and fill tenants/example.env by hand.`);

    mkdirSync(TENANTS, { recursive: true });
    writeFileSync(
      file,
      [
        `# Taskivities instance "${name}". Not committed: see tenants/example.env for what each value is.`,
        `WORKER_NAME=${worker}`,
        `D1_DATABASE_NAME=${worker}`,
        `D1_DATABASE_ID=${dbId}`,
        `OAUTH_KV_ID=${kvId}`,
        `TEAM_TZ=${opts.tz || 'America/New_York'}`,
        `CUSTOM_DOMAINS=${opts.domain || ''}`,
        `WORKERS_DEV=true`,
        `CLOUDFLARE_ACCOUNT_ID=${opts.account || ''}`,
        `CLOUDFLARE_PROFILE=${opts.profile || ''}`,
        '',
      ].join('\n'),
    );
    load(name); // checks what was written
    console.log(`\n✔ Wrote tenants/${name}.env\n\nNext:\n` +
      `  npm run tenant -- secret ${name} GOOGLE_CLIENT_ID\n` +
      `  npm run tenant -- secret ${name} GOOGLE_CLIENT_SECRET\n` +
      `  npm run deploy -- ${name}\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------- command line ----------

const [cmd, ...rest] = process.argv.slice(2);
// (`wrangler` passes its arguments through as they are; the others take <instance> and --flags.)
const flags = {};
const pos = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) {
    const k = rest[i].slice(2);
    if (k === 'dry-run') flags.dryRun = true;
    else flags[k] = rest[++i];
  } else pos.push(rest[i]);
}

switch (cmd) {
  case 'create':
    create(pos[0], flags);
    break;
  case 'list':
    for (const n of instances()) {
      const t = parseEnv(join(TENANTS, `${n}.env`));
      const extra = [t.CUSTOM_DOMAINS, t.CLOUDFLARE_PROFILE && `profile ${t.CLOUDFLARE_PROFILE}`].filter(Boolean).join(', ');
      console.log(`${n.padEnd(20)} ${t.WORKER_NAME ?? '?'}${extra ? `  (${extra})` : ''}`);
    }
    if (!instances().length) console.log('No instances yet. Create one with: npm run tenant -- create <instance>');
    break;
  case 'deploy':
    deploy(pick(pos[0]), flags.dryRun);
    break;
  case 'migrate': {
    const n = pick(pos[0]);
    const t = load(n);
    migrate(n, t, generate(n, t));
    break;
  }
  case 'secret': {
    // Either `secret <instance> NAME` or, with one instance, `secret NAME`.
    const [a, b] = pos;
    const n = pick(b ? a : undefined);
    const key = b ?? a;
    if (!key || !/^[A-Z][A-Z0-9_]*$/.test(key)) die('Usage: npm run tenant -- secret <instance> <NAME>   e.g. GOOGLE_CLIENT_ID');
    const t = load(n);
    console.log(`\n▸ Setting ${key} on ${t.WORKER_NAME}. Paste the value when asked (it isn't shown or saved here).`);
    wrangler(t, ['secret', 'put', key, '--config', generate(n, t)]);
    break;
  }
  case 'wrangler': {
    // Passes everything through untouched: `wrangler <instance> tail`, or with one instance `wrangler tail`.
    const raw = process.argv.slice(3);
    const named = instances().includes(raw[0]);
    const n = pick(named ? raw[0] : undefined);
    const t = load(n);
    const args = raw.slice(named ? 1 : 0);
    if (args[0] === 'whoami' && t.CLOUDFLARE_PROFILE)
      die(`wrangler whoami only shows your default login, not profiles. To check the "${t.CLOUDFLARE_PROFILE}" login, try: npm run tenant -- wrangler ${n} d1 list`);
    wrangler(t, [...args, '--config', generate(n, t)]);
    break;
  }
  default:
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1).filter((l, i, all) => all.slice(0, i + 1).every((x) => x.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(cmd ? 1 : 0);
}
