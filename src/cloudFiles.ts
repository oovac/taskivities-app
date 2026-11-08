// Picking files from Google Drive and OneDrive / SharePoint, in each provider's own picker (worker/cloud-files.ts
// explains the server side). Both return the picked file ids and a short-lived access token, which the server uses
// once to copy or link the files. Tokens stay in this tab's memory, never in storage.
//
// Popups only open from a click, so everything a click needs is loaded beforehand (preloadPickers, when the attach
// menu opens), and the OneDrive window is opened before anything is awaited.
import type { CloudPickers, CloudProvider } from '../shared/types';

export interface PickedFile { id: string; driveId?: string; name: string }
export interface Picked { provider: CloudProvider; token: string; files: PickedFile[] }

/** Closing a picker or its sign-in isn't an error: nothing happens. */
export class PickCancelled extends Error {}

const scripts = new Map<string, Promise<void>>();
function loadScript(src: string) {
  let p = scripts.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => { scripts.delete(src); reject(new Error(`Couldn't load ${new URL(src).hostname}. Check your connection.`)); };
      document.head.appendChild(el);
    });
    scripts.set(src, p);
  }
  return p;
}

// ---------------------------------------------------------------------------------------------------------------------
// Google Drive: Google Identity Services for the token (drive.file), the Google Picker for the files.
// ---------------------------------------------------------------------------------------------------------------------
type G = any;
const win = window as unknown as { google?: G; gapi?: G };
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
let googleReady: Promise<void> | null = null;
let googleToken: { token: string; expires: number } | null = null;

function loadGoogle() {
  googleReady ??= Promise.all([
    loadScript('https://accounts.google.com/gsi/client'),
    loadScript('https://apis.google.com/js/api.js').then(() => new Promise<void>((resolve) => win.gapi.load('picker', () => resolve()))),
  ]).then(() => undefined).catch((e) => { googleReady = null; throw e; });
  return googleReady;
}

function googleSignIn(cfg: NonNullable<CloudPickers['google']>, hint?: string) {
  if (googleToken && googleToken.expires - Date.now() > 120_000) return Promise.resolve(googleToken.token);
  return new Promise<string>((resolve, reject) => {
    const client = win.google.accounts.oauth2.initTokenClient({
      client_id: cfg.clientId,
      scope: GOOGLE_SCOPE,
      ...(hint ? { login_hint: hint } : {}),
      callback: (r: { access_token?: string; expires_in?: number; error?: string; error_description?: string; scope?: string }) => {
        if (r.error || !r.access_token) { reject(r.error === 'access_denied' ? new PickCancelled() : new Error(r.error_description || "Google sign-in didn't work.")); return; }
        if (!win.google.accounts.oauth2.hasGrantedAllScopes(r, GOOGLE_SCOPE)) { reject(new Error('Allow Taskivities to see the files you pick, then try again.')); return; }
        googleToken = { token: r.access_token, expires: Date.now() + (r.expires_in ?? 3600) * 1000 };
        resolve(r.access_token);
      },
      error_callback: (e: { type?: string }) => reject(e.type === 'popup_closed' ? new PickCancelled() : new Error(e.type === 'popup_failed_to_open' ? 'Allow pop-ups for this site to pick files from Google Drive.' : "Google sign-in didn't work.")),
    });
    client.requestAccessToken();
  });
}

async function pickGoogle(cfg: NonNullable<CloudPickers['google']>, hint?: string): Promise<Picked> {
  await loadGoogle();
  const token = await googleSignIn(cfg, hint);
  const P = win.google.picker;
  const files = await new Promise<PickedFile[]>((resolve) => {
    const mine = new P.DocsView(P.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(true).setMode(P.DocsViewMode.LIST);
    const shared = new P.DocsView(P.ViewId.DOCS).setEnableDrives(true).setIncludeFolders(true).setSelectFolderEnabled(true);
    new P.PickerBuilder()
      .addView(mine).addView(shared).addView(P.ViewId.RECENTLY_PICKED)
      .enableFeature(P.Feature.MULTISELECT_ENABLED).enableFeature(P.Feature.SUPPORT_DRIVES)
      .setOAuthToken(token).setDeveloperKey(cfg.apiKey).setAppId(cfg.appId).setOrigin(location.origin)
      .setTitle('Attach from Google Drive')
      .setCallback((d: { action: string; docs?: { id: string; name: string }[] }) => {
        if (d.action === P.Action.PICKED) resolve((d.docs ?? []).map((x) => ({ id: x.id, name: x.name })));
        else if (d.action === P.Action.CANCEL) resolve([]);
      })
      .build().setVisible(true);
  });
  return { provider: 'google', token, files };
}

// ---------------------------------------------------------------------------------------------------------------------
// OneDrive / SharePoint: sign-in with PKCE in a popup (the Entra app's SPA redirect is public/picker-signin.html, which
// hands the code back over a BroadcastChannel), a Graph token for the server, and SharePoint tokens for Microsoft's
// File Picker (v8), shown in a frame over the app. The sign-in is kept in this tab's memory, so later picks skip it.
// ---------------------------------------------------------------------------------------------------------------------
type MsCfg = NonNullable<CloudPickers['microsoft']>;
const GRAPH = 'https://graph.microsoft.com';
const SIGNIN_MINUTES = 5;
const redirectUri = () => `${location.origin}/picker-signin.html`;
let msRefresh: string | null = null;
const msTokens = new Map<string, { token: string; expires: number }>(); // by resource
let msDriveOrigin: string | null = null;

const b64url = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomString = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const NEEDS_SIGNIN = 'interaction_required';

async function msTokenCall(cfg: MsCfg, params: Record<string, string>) {
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenant)}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, ...params }),
  });
  const d = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !d.access_token) {
    if (d.error === 'interaction_required' || d.error === 'invalid_grant' || d.error === 'consent_required') throw new Error(NEEDS_SIGNIN);
    throw new Error(d.error_description?.split('\n')[0] || "Microsoft sign-in didn't work.");
  }
  if (d.refresh_token) msRefresh = d.refresh_token;
  return { token: d.access_token, expires: Date.now() + (d.expires_in ?? 3600) * 1000 };
}

/** Signs in in the popup for one resource's scopes, and remembers the token (and the refresh token, for the others). */
async function msAuthorize(cfg: MsCfg, popup: Window, resource: string, scopes: string, hint?: string) {
  const verifier = randomString();
  const state = randomString();
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const q = new URLSearchParams({
    client_id: cfg.clientId, response_type: 'code', redirect_uri: redirectUri(), response_mode: 'query',
    scope: `openid offline_access ${scopes}`, state, code_challenge: challenge, code_challenge_method: 'S256',
    ...(hint ? { login_hint: hint } : {}),
  });
  const code = await new Promise<string>((resolve, reject) => {
    const bc = new BroadcastChannel('tv-ms-signin');
    // Microsoft's sign-in pages cut the popup off from this window, so it can't be watched for closing: give up after a while.
    const timer = setTimeout(() => { bc.close(); reject(new PickCancelled()); }, SIGNIN_MINUTES * 60_000);
    bc.onmessage = (e: MessageEvent<{ code?: string; state?: string; error?: string }>) => {
      if (e.data?.state !== state) return;
      bc.close();
      clearTimeout(timer);
      if (e.data.code) resolve(e.data.code);
      else reject(/cancel|denied/i.test(e.data.error ?? '') ? new PickCancelled() : new Error(e.data.error || "Microsoft sign-in didn't work."));
    };
    popup.location.href = `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenant)}/oauth2/v2.0/authorize?${q}`;
  });
  const t = await msTokenCall(cfg, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri(), scope: `openid offline_access ${scopes}` });
  msTokens.set(resource, t);
  return t.token;
}

/** A token for a resource (Graph, or a SharePoint host): remembered, refreshed, or signed in for (when there's a popup). */
async function msToken(cfg: MsCfg, popup: Window | null, resource: string, hint?: string): Promise<string> {
  const have = msTokens.get(resource);
  if (have && have.expires - Date.now() > 120_000) return have.token;
  const scopes = resource === GRAPH ? `${GRAPH}/Files.Read.All` : `${resource}/.default`;
  if (msRefresh) {
    try {
      const t = await msTokenCall(cfg, { grant_type: 'refresh_token', refresh_token: msRefresh, scope: `openid offline_access ${scopes}` });
      msTokens.set(resource, t);
      return t.token;
    } catch (e) {
      if ((e as Error).message !== NEEDS_SIGNIN) throw e;
    }
  }
  if (!popup) {
    // Next time, start with a sign-in.
    msRefresh = null;
    msTokens.clear();
    throw new Error('Microsoft needs you to sign in again. Pick the files again.');
  }
  return msAuthorize(cfg, popup, resource, scopes, hint);
}

/** The person's OneDrive host (https://contoso-my.sharepoint.com), where the picker lives. */
async function driveOrigin(graphToken: string) {
  if (msDriveOrigin) return msDriveOrigin;
  const res = await fetch(`${GRAPH}/v1.0/me/drive?$select=webUrl`, { headers: { authorization: `Bearer ${graphToken}` } });
  const d = (await res.json().catch(() => ({}))) as { webUrl?: string };
  if (!res.ok || !d.webUrl) throw new Error(res.status === 404 ? "Your Microsoft account doesn't have a OneDrive yet. Open OneDrive once, then try again." : "Couldn't find your OneDrive.");
  return (msDriveOrigin = new URL(d.webUrl).origin);
}

interface PickerCommand { command: string; resource?: string; items?: { id: string; name?: string; parentReference?: { driveId?: string } }[] }

/** Shows Microsoft's picker in a frame over the app, and answers its requests for tokens. */
function runMsPicker(cfg: MsCfg, origin: string, spToken: string) {
  const channelId = crypto.randomUUID();
  const options = {
    sdk: '8.0',
    entry: { oneDrive: { files: {} } },
    authentication: {},
    messaging: { origin: location.origin, channelId },
    selection: { mode: 'multiple' },
    typesAndSources: { mode: 'all', pivots: { oneDrive: true, recent: true, shared: true, sharedLibraries: true } },
  };
  const frameName = `tv-onedrive-${channelId}`;
  const wrap = document.createElement('div');
  wrap.className = 'ms-picker';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-label', 'Attach from OneDrive');
  const box = document.createElement('div');
  box.className = 'ms-picker-box';
  const close = document.createElement('button');
  close.className = 'ms-picker-x';
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';
  const frame = document.createElement('iframe');
  frame.name = frameName;
  frame.title = 'OneDrive';
  box.append(frame, close);
  wrap.appendChild(box);
  document.body.appendChild(wrap);

  return new Promise<PickedFile[]>((resolve, reject) => {
    let port: MessagePort | null = null;
    const finish = (f: PickedFile[] | Error) => {
      window.removeEventListener('message', onInit);
      document.removeEventListener('keydown', onKey, true);
      port?.close();
      wrap.remove();
      if (f instanceof Error) reject(f); else resolve(f);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); finish([]); } };
    close.onclick = () => finish([]);
    wrap.onclick = (e) => { if (e.target === wrap) finish([]); };
    document.addEventListener('keydown', onKey, true);
    const reply = (id: string, data: unknown) => port!.postMessage({ type: 'result', id, data });
    const onCommand = async (e: MessageEvent) => {
      const m = e.data as { type: string; id: string; data: PickerCommand };
      if (m?.type !== 'command') return;
      port!.postMessage({ type: 'acknowledge', id: m.id });
      const c = m.data;
      if (c.command === 'authenticate') {
        try {
          let res = origin;
          try { if (c.resource) res = new URL(c.resource).origin; } catch { /* keep the drive's */ }
          reply(m.id, { result: 'token', token: await msToken(cfg, null, res) });
        } catch (err) {
          reply(m.id, { result: 'error', error: { code: 'unableToObtainToken', message: (err as Error).message } });
        }
      } else if (c.command === 'pick') {
        const items = (c.items ?? []).filter((x) => x.id && x.parentReference?.driveId);
        reply(m.id, { result: 'success' });
        finish(items.map((x) => ({ id: x.id, driveId: x.parentReference!.driveId!, name: x.name ?? 'file' })));
      } else if (c.command === 'close') {
        finish([]);
      } else {
        reply(m.id, { result: 'error', error: { code: 'unsupportedCommand', message: c.command } });
      }
    };
    const onInit = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow || e.data?.type !== 'initialize' || e.data.channelId !== channelId) return;
      port = e.ports[0];
      port.addEventListener('message', (ev) => void onCommand(ev));
      port.start();
      port.postMessage({ type: 'activate' });
    };
    window.addEventListener('message', onInit);
    // The picker opens by POSTing its options and a SharePoint token into the frame.
    const form = document.createElement('form');
    form.method = 'POST';
    form.target = frameName;
    form.action = `${origin}/_layouts/15/FilePicker.aspx?${new URLSearchParams({ filePicker: JSON.stringify(options), locale: navigator.language || 'en-us' })}`;
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'access_token';
    input.value = spToken;
    form.appendChild(input);
    document.body.appendChild(form);
    form.submit();
    form.remove();
  });
}

/** Closes the sign-in popup. It may be cut off from this window by now, so it's also asked to close itself. */
function closeSignin(popup: Window | null) {
  if (!popup) return;
  const bc = new BroadcastChannel('tv-ms-signin');
  bc.postMessage({ close: true });
  bc.close();
  if (!popup.closed) popup.close();
}

async function pickMicrosoft(cfg: MsCfg, popup: Window | null, hint?: string): Promise<Picked> {
  try {
    const graphToken = await msToken(cfg, popup, GRAPH, hint);
    const origin = await driveOrigin(graphToken);
    const spToken = await msToken(cfg, popup, origin, hint);
    closeSignin(popup);
    const files = await runMsPicker(cfg, origin, spToken);
    return { provider: 'microsoft', token: await msToken(cfg, null, GRAPH), files };
  } finally {
    closeSignin(popup);
  }
}

// ---------------------------------------------------------------------------------------------------------------------

/** Loads Google's scripts ahead of the click (the attach menu calls this when it opens). */
export function preloadPickers(cfg: CloudPickers) {
  if (cfg.google) void loadGoogle().catch(() => undefined);
}

/**
 * Opens a provider's picker. Call it straight from a click: the OneDrive sign-in window is opened before anything is awaited,
 * and Google's sign-in needs its scripts already loaded (preloadPickers).
 */
export function pickFiles(cfg: CloudPickers, provider: CloudProvider, hint?: string): Promise<Picked> {
  if (provider === 'microsoft') {
    if (!cfg.microsoft) return Promise.reject(new Error("OneDrive isn't set up on this instance."));
    // Signed in already (in this tab): no popup. Otherwise open it now, while this is still the click.
    const signedIn = !!msRefresh;
    const popup = signedIn ? null : window.open(`${location.origin}/picker-signin.html#opening`, 'tv-ms-signin', 'width=520,height=680');
    if (!signedIn && !popup) return Promise.reject(new Error('Allow pop-ups for this site to pick files from OneDrive.'));
    return pickMicrosoft(cfg.microsoft, popup, hint);
  }
  if (!cfg.google) return Promise.reject(new Error("Google Drive isn't set up on this instance."));
  return pickGoogle(cfg.google, hint);
}
