#!/usr/bin/env node
// Web Push ("VAPID") keys: a P-256 key pair that signs an instance's notifications.
// Deployed instances get theirs automatically: `npm run deploy` (and `node demo/deploy.mjs <instance>`) create them the
// first time and store them as Worker secrets. For local development, add a pair to .dev.vars:
//   npm run -s push-keys >> .dev.vars
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = join(ROOT, 'node_modules', '.bin', 'wrangler');

/** { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY }, both base64url (public: the uncompressed point; private: d). */
export function newPushKeys() {
  const jwk = generateKey();
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { VAPID_PUBLIC_KEY: pub.toString('base64url'), VAPID_PRIVATE_KEY: jwk.d };
}
const generateKey = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' });

/**
 * The names of a deployed Worker's secrets (never their values), or null if they can't be listed.
 * `config`: its generated wrangler config. `args`/`env`: e.g. `--profile <name>` and CLOUDFLARE_ACCOUNT_ID.
 */
export function secretNames({ config, args = [], env = {} }) {
  const r = spawnSync(WRANGLER, ['secret', 'list', '--format', 'json', '--config', config, ...args], {
    cwd: ROOT, encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'], env: { ...process.env, ...env },
  });
  try {
    return JSON.parse(r.stdout.slice(r.stdout.indexOf('['))).map((x) => x.name);
  } catch {
    return null;
  }
}

/** Creates and stores the instance's key pair if it doesn't have one yet (run after a deploy). Never prints the keys. */
export function ensurePushKeys({ config, args = [], env = {} }) {
  const names = secretNames({ config, args, env });
  if (!names) { console.warn('\n! Could not list the secrets, so the notification keys were not checked.'); return; }
  if (names.includes('VAPID_PUBLIC_KEY') && names.includes('VAPID_PRIVATE_KEY')) return;
  console.log('\n▸ Creating the notification keys (once per instance)');
  const dir = mkdtempSync(join(tmpdir(), 'taskivities-'));
  try {
    const file = join(dir, 'push-keys.json');
    writeFileSync(file, JSON.stringify(newPushKeys()), { mode: 0o600 });
    const r = spawnSync(WRANGLER, ['secret', 'bulk', file, '--config', config, ...args], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
    if (r.status !== 0) console.warn('\n! Storing the notification keys failed. Deploy again to retry.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const k = newPushKeys();
  console.log(`\n# Notifications (Web Push keys for local development; deployed instances make their own)\nVAPID_PUBLIC_KEY=${k.VAPID_PUBLIC_KEY}\nVAPID_PRIVATE_KEY=${k.VAPID_PRIVATE_KEY}`);
}
