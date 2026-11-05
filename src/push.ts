// Notifications on this device (Web Push). The account menu turns them on; worker/push.ts decides what's sent and when,
// and public/sw.js shows them and opens the task when one is tapped.
import type { NotifyPrefs } from '../shared/types';
import { api } from './api';
import { isInstalled, isIOS } from './install';
import { S, set } from './store';

/** unavailable: the instance has no push keys. install-first: iPhone/iPad in Safari (only Home Screen apps get notifications). */
export type PushState = 'unknown' | 'unavailable' | 'unsupported' | 'install-first' | 'blocked' | 'off' | 'on';

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const keyBytes = (b64u: string) => {
  const t = b64u.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(t.padEnd(Math.ceil(t.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
};
const sameKey = (sub: PushSubscription, key: string) => {
  const a = sub.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
  const b = keyBytes(key);
  return !!a && a.length === b.length && a.every((x, i) => x === b[i]);
};
const registration = () => navigator.serviceWorker.ready;

async function currentState(): Promise<PushState> {
  if (!S().pushKey) return 'unavailable';
  if (!supported()) return isIOS() && !isInstalled() ? 'install-first' : 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  const sub = await (await registration()).pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

/** This device's subscription, on the instance's current key (a new key means subscribing again). */
async function subscription(key: string) {
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, key)) { await sub.unsubscribe().catch(() => undefined); sub = null; }
  return sub ?? reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
}

/** On every start: keeps this device's subscription stored for whoever is signed in now. */
export async function syncPush() {
  try {
    const state = await currentState();
    if (state === 'on') await api.post('/api/push/subscribe', (await subscription(S().pushKey!)).toJSON());
    set({ pushState: state });
  } catch {
    set({ pushState: 'off' });
  }
}

/** Turns notifications on for this device (must run from a tap: iPhones only ask then). Returns an error to show, or null. */
export async function turnOnPush(): Promise<string | null> {
  const key = S().pushKey;
  if (!key) return "Notifications aren't set up on this instance.";
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      set({ pushState: perm === 'denied' ? 'blocked' : 'off' });
      return perm === 'denied' ? null : 'Notifications were not allowed.';
    }
    const sub = await subscription(key);
    await api.post('/api/push/subscribe', sub.toJSON());
    set({ pushState: 'on' });
    await api.post('/api/push/test', { endpoint: sub.endpoint }).catch(() => undefined);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Could not turn notifications on.';
  }
}

export async function turnOffPush() {
  try {
    const sub = await (await registration()).pushManager.getSubscription();
    if (sub) {
      await api.post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => undefined);
      await sub.unsubscribe().catch(() => undefined);
    }
  } finally {
    set({ pushState: 'off' });
  }
}

export async function testPush(): Promise<boolean> {
  const sub = await (await registration()).pushManager.getSubscription();
  if (!sub) return false;
  const r = await api.post<{ result: string }>('/api/push/test', { endpoint: sub.endpoint }).catch(() => null);
  return r?.result === 'ok';
}

/** What I'm notified about, on all my devices. */
export async function setNotifyPrefs(p: Partial<NotifyPrefs>) {
  const prev = S().notify;
  set({ notify: { ...prev, ...p } });
  try {
    set({ notify: (await api.put<{ notify: NotifyPrefs }>('/api/push/prefs', p)).notify });
  } catch {
    set({ notify: prev });
  }
}

/** The number on the installed app's icon: my open tasks for today, carried-over ones included. */
export function updateBadge(n: number) {
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  if (!nav.setAppBadge || !isInstalled()) return;
  void (n ? nav.setAppBadge(n) : nav.clearAppBadge!()).catch(() => undefined);
}
