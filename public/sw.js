// Taskivities service worker. It exists so phones can install the app to the home screen.
// It caches nothing: every request goes to the network as usual, so tasks are never stale.
// The only extra: if a page can't load because the phone is offline, it shows a short message instead of the browser's error.
const OFFLINE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Offline · Taskivities</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,-apple-system,sans-serif;background:#F7F7F9;color:#16161D;text-align:center;padding:24px}
@media (prefers-color-scheme:dark){body{background:#0E0E13;color:#ECECF1}}b{display:block;font-size:18px;margin-bottom:6px}button{margin-top:16px;font:inherit;font-weight:600;padding:8px 16px;border-radius:9px;border:0;background:#4F46E5;color:#fff}</style>
<div><b>You're offline</b>Taskivities needs a connection. It'll work again as soon as you're back online.<br><button onclick="location.reload()">Try again</button></div></html>`;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return; // everything else: the browser's normal handling
  event.respondWith(
    fetch(event.request).catch(() => new Response(OFFLINE, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } })),
  );
});
