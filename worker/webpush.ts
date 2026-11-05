// Sending one Web Push message, with nothing but WebCrypto (no library, no outside service).
//   • VAPID (RFC 8292): a short-lived ES256 token signed with the instance's private key, so push services know who sends.
//   • Payload encryption (RFC 8291, "aes128gcm"): only the subscribed browser can read the message.
// The push services (Google, Apple, Mozilla, Microsoft) deliver it to the phone or computer.

export interface PushKeys {
  /** The P-256 public key, uncompressed (65 bytes), base64url. Browsers subscribe with it. */
  publicKey: string;
  /** The private scalar d (32 bytes), base64url. A Worker secret. */
  privateKey: string;
}
export interface PushTarget { endpoint: string; p256dh: string; auth: string }
export type PushResult = 'ok' | 'gone' | 'failed';

const enc = new TextEncoder();
export const b64u = (b: ArrayBuffer | Uint8Array) => {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const fromB64u = (s: string) => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t.padEnd(Math.ceil(t.length / 4) * 4, '='));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};

/** Push services we send to. Anything else is refused, so a stored subscription can't make the Worker post elsewhere. */
const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', '.push.apple.com', '.push.services.mozilla.com', '.notify.windows.com'];
export function validEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length > 1000) return false;
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && PUSH_HOSTS.some((h) => (h.startsWith('.') ? u.hostname.endsWith(h) : u.hostname === h));
  } catch {
    return false;
  }
}

// ---------- VAPID ----------
let signing: { pub: string; key: Promise<CryptoKey> } | null = null;
function signingKey(keys: PushKeys) {
  if (signing?.pub !== keys.publicKey) {
    const pub = fromB64u(keys.publicKey);
    const jwk = { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ext: true };
    signing = { pub: keys.publicKey, key: crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) };
  }
  return signing.key;
}

/** The Authorization header for one push service: `vapid t=<JWT>, k=<public key>`. */
export async function vapidAuthorization(endpoint: string, keys: PushKeys, subject: string): Promise<string> {
  const json = (o: unknown) => b64u(enc.encode(JSON.stringify(o)));
  const unsigned = `${json({ typ: 'JWT', alg: 'ES256' })}.${json({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await signingKey(keys), enc.encode(unsigned));
  return `vapid t=${unsigned}.${b64u(sig)}, k=${keys.publicKey}`;
}

// ---------- payload encryption (RFC 8291) ----------
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/** The encrypted body for one subscription: header (salt, record size, our public key) + AES-128-GCM ciphertext. */
export async function encryptPayload(target: PushTarget, plaintext: Uint8Array): Promise<Uint8Array> {
  const uaPublic = fromB64u(target.p256dh);
  const authSecret = fromB64u(target.auth);
  const local = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', local.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = { name: 'ECDH', public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh, local.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // One record: the data, then the 0x02 delimiter that marks the last record.
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(plaintext, new Uint8Array([2]))));
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, sealed);
}

/**
 * Sends one message. `topic`: a later message with the same topic replaces this one if it hasn't been delivered yet.
 * Returns 'gone' when the subscription no longer exists (the app was removed, or notifications were turned off), so it can be deleted.
 */
export async function sendPush(
  target: PushTarget, payload: unknown, keys: PushKeys, subject: string,
  opts: { ttl?: number; urgency?: 'normal' | 'high'; topic?: string } = {},
): Promise<PushResult> {
  if (!validEndpoint(target.endpoint)) return 'gone';
  let body: Uint8Array;
  try {
    body = await encryptPayload(target, enc.encode(JSON.stringify(payload)));
  } catch {
    return 'gone'; // keys that aren't a valid P-256 point can never be sent to
  }
  const headers: Record<string, string> = {
    authorization: await vapidAuthorization(target.endpoint, keys, subject),
    'content-encoding': 'aes128gcm',
    'content-type': 'application/octet-stream',
    ttl: String(opts.ttl ?? 86400),
    urgency: opts.urgency ?? 'normal',
  };
  if (opts.topic) headers.topic = opts.topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  const res = await fetch(target.endpoint, { method: 'POST', headers, body }).catch(() => null);
  if (!res) return 'failed';
  if (res.status === 404 || res.status === 410) return 'gone';
  if (!res.ok) console.warn(`push to ${new URL(target.endpoint).hostname} failed: ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
  return res.ok ? 'ok' : 'failed';
}
