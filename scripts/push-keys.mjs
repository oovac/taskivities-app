#!/usr/bin/env node
// Web Push ("VAPID") keys: a P-256 key pair that signs this instance's notifications.
// Deployed instances get theirs automatically: `npm run deploy` creates them the first time and stores them as Worker
// secrets. For local development, add a pair to .dev.vars:   npm run -s push-keys >> .dev.vars
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY }, both base64url (public: the uncompressed point; private: d). */
export function newPushKeys() {
  const jwk = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' });
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { VAPID_PUBLIC_KEY: pub.toString('base64url'), VAPID_PRIVATE_KEY: jwk.d };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const k = newPushKeys();
  console.log(`\n# Notifications (Web Push keys for local development; deployed instances make their own)\nVAPID_PUBLIC_KEY=${k.VAPID_PUBLIC_KEY}\nVAPID_PRIVATE_KEY=${k.VAPID_PRIVATE_KEY}`);
}
