// Other instances (sources): this app signs in to other Taskivities instances as you and works with them directly,
// from the browser, through their /v1 API (worker/v1.ts). The servers stay single-tenant: each only knows its own
// people and tasks. Notifications from other instances come through your home instance (worker/relay.ts).
//
// Signing in is OAuth with PKCE, the way AI assistants connect: you approve on the other instance, and this browser
// keeps the tokens (per device). Your home instance keeps a relay per connected instance, so a new device can offer
// to reconnect them in one tap.
//
// Their tasks, projects and people live in the same store as this instance's, under ids that can't clash:
// "f~<source>~<their id>". Your account there is you here, so their tasks are simply yours in My day, week and board.
// Their projects and people carry `feed` (the instance's name), so this instance's own lists leave them out
// (localProjects / localUsers). Requests about any task go through clientFor(id), which picks the right server.
import type { Bootstrap, InboxItem, InboxPage, Project, SyncResponse, Task, TaskEvent, User } from '../shared/types';
import { PROJECT_COLORS, appName } from '../shared/types';
import { onProject } from '../shared/rules';
import { api, ApiError } from './api';
import { S, set, type State } from './store';

// =====================================================================================================================
// Connections (this device) and their tokens
// =====================================================================================================================
export interface Conn {
  /** Short id used in this device's ids ("f~<id>~…"). */
  id: string;
  origin: string;
  clientId: string;
  access: string;
  refresh: string;
  /** ms since epoch */
  expires: number;
  color: string;
  /** Who I am there. One connection per instance: reconnecting has to be as the same person. */
  user?: { id: string; name: string };
}
const KEY = 'tv:sources';
const loadConns = (): Conn[] => { try { return JSON.parse(localStorage.getItem(KEY) || '[]') as Conn[]; } catch { return []; } };
const saveConns = (cs: Conn[]) => localStorage.setItem(KEY, JSON.stringify(cs));
export const conns = () => loadConns();
export const connById = (id: string) => loadConns().find((c) => c.id === id) ?? null;
export const connByOrigin = (origin: string) => loadConns().find((c) => c.origin === origin) ?? null;
export const connByHost = (host: string) => loadConns().find((c) => new URL(c.origin).host === host) ?? null;
const putConn = (c: Conn) => saveConns([...loadConns().filter((x) => x.id !== c.id), c]);

/** What the app shows about a connection. */
export interface SourceInfo { id: string; origin: string; name: string; color: string; status: 'ok' | 'loading' | 'error' | 'signed-out'; error?: string; user?: string }

// =====================================================================================================================
// Ids: theirs ↔ ours
// =====================================================================================================================
const SEP = '~';
export const isFeed = (id: string | null | undefined) => !!id && id.startsWith(`f${SEP}`);
export const nsId = (src: string, id: string) => `f${SEP}${src}${SEP}${id}`;
/** "f~<source>~<their id>" → its parts. */
export const feedParts = (id: string) => { const [, src, ...rest] = id.split(SEP); return { src, rid: rest.join(SEP) }; };
export const sourceOf = (s: State, id: string) => (isFeed(id) ? s.sources.find((x) => x.id === feedParts(id).src) ?? null : null);
/** A task on its own instance. */
export const remoteTaskUrl = (src: SourceInfo, id: string) => `${src.origin}/?task=${encodeURIComponent(feedParts(id).rid)}`;

/** This instance's own projects and people, without other instances'. */
export const localProjects = (s: State): Project[] => Object.values(s.projects).filter((p) => !p.feed);
export const localUsers = (s: State): User[] => Object.values(s.users).filter((u) => !u.feed);
const srcOfId = (id: string | null | undefined) => (isFeed(id) ? feedParts(id!).src : null);
/** Can this person (me included, as I am there) be on this project? Only within one instance. */
export function personOn(s: State, userId: string, projectId: string): boolean {
  const ps = srcOfId(projectId);
  if (userId === s.me?.id) { const u = ps ? s.feedDir.me[ps] : s.me; return !!u && onProject(u, projectId); }
  const u = s.users[userId];
  return !!u && srcOfId(userId) === ps && onProject(u, projectId);
}
/** Projects I can add tasks to: this instance's, then each connected instance's. */
export const myProjectsEverywhere = (s: State): Project[] =>
  Object.values(s.projects).filter((p) => personOn(s, s.me!.id, p.id))
    .sort((a, b) => Number(!!a.feed) - Number(!!b.feed) || a.name.localeCompare(b.name));
/** Same instance? (This one's ids have no prefix.) */
export const sameSource = (a: string, b: string) => srcOfId(a) === srcOfId(b);
/** People of one other instance (ids starting with its prefix, "f~<connection>~"). */
export const localUsersOf = (s: State, prefix: string): User[] => Object.values(s.users).filter((u) => u.id.startsWith(prefix));

interface Ctx { src: string; theirMe: string; me: string }
const ctxFor = (src: string): Ctx | null => {
  const s = S();
  const m = s.feedDir.me[src];
  return m && s.me ? { src, theirMe: m.id, me: s.me.id } : null;
};
const uIn = (c: Ctx, id: string | null) => (id === null ? null : id === c.theirMe ? c.me : nsId(c.src, id));
/** Our id → theirs (people, projects and tasks of that source; "me" → their id for me). */
const out = (c: Ctx, id: string | null | undefined) => (id == null ? id : id === c.me ? c.theirMe : isFeed(id) ? feedParts(id).rid : id);

function taskIn(c: Ctx, t: Task): Task {
  return {
    ...t,
    id: nsId(c.src, t.id), projectId: nsId(c.src, t.projectId),
    assigneeId: uIn(c, t.assigneeId)!, createdBy: uIn(c, t.createdBy)!, assignedBy: uIn(c, t.assignedBy)!, doneBy: uIn(c, t.doneBy),
    archivedBy: uIn(c, t.archivedBy), followers: t.followers.map((x) => uIn(c, x)!),
    attachments: t.attachments.map((a) => ({ ...a, by: uIn(c, a.by)! })),
    series: t.series ? { ...t.series, assigneeId: uIn(c, t.series.assigneeId)! } : null,
  };
}
const PERSON_EVENTS = new Set(['transferred', 'follower_added', 'follower_removed']);
function eventIn(c: Ctx, e: TaskEvent): TaskEvent {
  const ppl = PERSON_EVENTS.has(e.type), proj = e.type === 'project_changed';
  const v = (x: string | null) => (ppl ? uIn(c, x) : proj && x ? nsId(c.src, x) : x);
  return { ...e, id: nsId(c.src, e.id), taskId: nsId(c.src, e.taskId), actorId: uIn(c, e.actorId)!, fromValue: v(e.fromValue), toValue: v(e.toValue) };
}
function inboxIn(c: Ctx, i: InboxItem): InboxItem {
  return { ...i, id: nsId(c.src, i.id), taskId: nsId(c.src, i.taskId), projectId: nsId(c.src, i.projectId), actorId: uIn(c, i.actorId)!, to: uIn(c, i.to) };
}
/** Their answer, with our ids (task, next, tasks, events). */
function answerIn<T>(src: string, r: T): T {
  const c = ctxFor(src);
  if (!c || !r || typeof r !== 'object') return r;
  const o = r as { task?: Task; next?: Task | null; tasks?: Task[]; events?: TaskEvent[] };
  return {
    ...r,
    ...(o.task ? { task: taskIn(c, o.task) } : {}),
    ...(o.next ? { next: taskIn(c, o.next) } : {}),
    ...(o.tasks ? { tasks: o.tasks.map((t) => taskIn(c, t)) } : {}),
    ...(o.events ? { events: o.events.map((e) => eventIn(c, e)) } : {}),
  };
}
/** A request body with our ids turned into theirs. */
function bodyOut(src: string, b: unknown): unknown {
  const c = ctxFor(src);
  if (!c || !b || typeof b !== 'object' || Array.isArray(b)) return b;
  const o = { ...(b as Record<string, unknown>) };
  for (const k of ['assigneeId', 'projectId', 'userId']) if (typeof o[k] === 'string') o[k] = out(c, o[k] as string);
  if (Array.isArray(o.ids)) o.ids = (o.ids as string[]).map((x) => out(c, x));
  return o;
}

// =====================================================================================================================
// Talking to another instance
// =====================================================================================================================
const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } })();
const refreshing = new Map<string, Promise<Conn | null>>();

async function tokenCall(c: Pick<Conn, 'origin' | 'clientId'>, params: Record<string, string>) {
  const res = await fetch(`${c.origin}/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, ...params }),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !data.access_token) throw new ApiError(res.status || 400, data.error_description || 'Sign-in there failed.');
  return { access: data.access_token, refresh: data.refresh_token ?? '', expires: Date.now() + (data.expires_in ?? 3600) * 1000 };
}

/** Ends a sign-in there (RFC 7009 at its token endpoint): revoking the refresh token ends the whole grant. */
async function revoke(c: Pick<Conn, 'origin' | 'clientId'>, token: string) {
  if (!token) return;
  await fetch(`${c.origin}/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, token, token_type_hint: 'refresh_token' }),
  }).catch(() => { /* gone already, or unreachable: it expires on its own */ });
}

/** A fresh access token (refreshed once at a time per connection). null: signed out there; reconnect. */
function refreshConn(c: Conn): Promise<Conn | null> {
  let p = refreshing.get(c.id);
  if (!p) {
    p = (async () => {
      try {
        const t = await tokenCall(c, { grant_type: 'refresh_token', refresh_token: c.refresh });
        const next = { ...c, ...t, refresh: t.refresh || c.refresh };
        putConn(next);
        return next;
      } catch (e) {
        return e instanceof ApiError && e.status >= 400 && e.status < 500 ? null : c; // 4xx: the grant is gone
      } finally {
        refreshing.delete(c.id);
      }
    })();
    refreshing.set(c.id, p);
  }
  return p;
}

/** A call to another instance's /v1 API, as you. Refreshes the token when needed; ids in and out are translated. */
export async function srcCall<T>(src: string, method: string, path: string, body?: unknown, raw = false): Promise<T> {
  let c = connById(src);
  if (!c) throw new ApiError(404, "That instance isn't connected on this device.");
  if (c.expires - Date.now() < 60_000) c = (await refreshConn(c)) ?? c;
  const send = (k: Conn) => fetch(`${k.origin}/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${k.access}`, ...(TZ ? { 'x-tz': TZ } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(raw ? body : bodyOut(src, body)) : undefined,
  });
  let res: Response;
  try {
    res = await send(c);
    if (res.status === 401) {
      const n = await refreshConn(c);
      if (!n) { markSource(src, { status: 'signed-out', error: 'Signed out there. Reconnect to keep seeing its tasks.' }); throw new ApiError(409, `${nameOf(src)} signed you out. Reconnect it under Other instances.`); }
      res = await send(n);
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(0, `Can't reach ${nameOf(src)}.`);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status === 401 ? 409 : res.status, data.error || `${nameOf(src)} had a problem.`);
  return raw ? data : answerIn(src, data);
}
const nameOf = (src: string) => S().sources.find((x) => x.id === src)?.name ?? 'That instance';

/** Requests about a task, wherever it lives: /api/tasks/<id>… here, or /v1/tasks/<their id>… on its instance. */
export function clientFor(id: string) {
  const call = async <T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', rest: string, body?: unknown): Promise<T> => {
    if (!isFeed(id)) {
      const url = `/api/tasks/${id}${rest}`;
      return method === 'GET' ? api.get<T>(url) : method === 'DELETE' ? api.del<T>(url) : method === 'POST' ? api.post<T>(url, body) : api.patch<T>(url, body);
    }
    const { src, rid } = feedParts(id);
    return srcCall<T>(src, method, `/tasks/${encodeURIComponent(rid)}${rest}`, body);
  };
  return {
    get: <T>(rest = '') => call<T>('GET', rest),
    post: <T>(rest: string, body?: unknown) => call<T>('POST', rest, body ?? {}),
    patch: <T>(rest: string, body: unknown) => call<T>('PATCH', rest, body),
    del: <T>(rest: string) => call<T>('DELETE', rest),
  };
}

/** Several tasks to one date, each on its own instance (POST /tasks/move there). */
export async function moveOnSources(ids: string[], dueDate: string): Promise<Task[]> {
  const bySrc = new Map<string, string[]>();
  for (const id of ids) { const { src } = feedParts(id); bySrc.set(src, [...(bySrc.get(src) ?? []), id]); }
  const res = await Promise.all([...bySrc].map(([src, list]) => srcCall<{ tasks: Task[] }>(src, 'POST', '/tasks/move', { ids: list, dueDate }).then((r) => r.tasks)));
  return res.flat();
}

/** An attachment's file, through its instance (a token can't go in <img src>): an object URL. */
const blobs = new Map<string, Promise<string>>();
export function attachmentBlob(taskId: string, aid: string): Promise<string> {
  const k = `${taskId}|${aid}`;
  let p = blobs.get(k);
  if (!p) {
    p = (async () => {
      const { src, rid } = feedParts(taskId);
      let c = connById(src);
      if (!c) throw new Error('Not connected');
      if (c.expires - Date.now() < 60_000) c = (await refreshConn(c)) ?? c;
      const res = await fetch(`${c.origin}/v1/tasks/${encodeURIComponent(rid)}/attachments/${aid}`, { headers: { authorization: `Bearer ${c.access}` } });
      if (!res.ok) throw new Error('Could not load the file');
      return URL.createObjectURL(await res.blob());
    })();
    blobs.set(k, p);
    p.catch(() => blobs.delete(k));
  }
  return p;
}
/** Upload address and headers for a task's files (XHR in actions.uploadFiles). */
export async function uploadTarget(taskId: string): Promise<{ url: string; headers: Record<string, string> }> {
  if (!isFeed(taskId)) return { url: `/api/tasks/${taskId}/attachments`, headers: { 'x-taskivities': '1' } };
  const { src, rid } = feedParts(taskId);
  let c = connById(src);
  if (!c) throw new ApiError(404, "That instance isn't connected on this device.");
  if (c.expires - Date.now() < 60_000) c = (await refreshConn(c)) ?? c;
  return { url: `${c.origin}/v1/tasks/${encodeURIComponent(rid)}/attachments`, headers: { authorization: `Bearer ${c.access}` } };
}
/** An upload's answer (a task) with our ids. */
export const taskFromSource = (taskId: string, t: Task) => (isFeed(taskId) ? answerIn(feedParts(taskId).src, { task: t }).task! : t);

// =====================================================================================================================
// Loading and keeping up (each instance syncs on its own, like this one)
// =====================================================================================================================
interface SrcState { version: number; dirVersion: number; last: number }
const state = new Map<string, SrcState>();

function markSource(id: string, patch: Partial<SourceInfo>) {
  set((s) => ({ sources: s.sources.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
}

const asUser = (src: string, u: User, inst: string): User => ({
  ...u, id: nsId(src, u.id), projects: u.projects.map((p) => nsId(src, p)), disabledBy: u.disabledBy ? nsId(src, u.disabledBy) : null, feed: inst,
});

/** Puts other instances' projects and people next to ours (again: loading this instance's directory replaces them). */
export function applyFeedDir() {
  set((s) => {
    const users = Object.fromEntries(Object.entries(s.users).filter(([, x]) => !x.feed));
    const projects = Object.fromEntries(Object.entries(s.projects).filter(([, x]) => !x.feed));
    return { users: { ...users, ...s.feedDir.users }, projects: { ...projects, ...s.feedDir.projects } };
  });
}

/** Its people and projects (bootstrap), then its tasks for the days this window has loaded. */
async function loadSource(c: Conn) {
  const b = await srcCall<Bootstrap>(c.id, 'GET', '/bootstrap', undefined, true);
  const inst = appName(b.settings);
  const users: Record<string, User> = {}, projects: Record<string, Project> = {};
  for (const u of b.users) if (u.id !== b.me.id) users[nsId(c.id, u.id)] = asUser(c.id, u, inst);
  for (const p of b.projects) projects[nsId(c.id, p.id)] = { ...p, id: nsId(c.id, p.id), name: `${inst} · ${p.name}`, feed: inst };
  set((s) => {
    const keep = <V,>(m: Record<string, V>) => Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith(`f${SEP}${c.id}${SEP}`)));
    return {
      feedDir: {
        users: { ...keep(s.feedDir.users), ...users },
        projects: { ...keep(s.feedDir.projects), ...projects },
        me: { ...s.feedDir.me, [c.id]: { ...b.me, projects: b.me.projects.map((p) => nsId(c.id, p)) } },
        unread: { ...s.feedDir.unread, [c.id]: b.inboxUnread ?? 0 },
      },
      sources: s.sources.map((x) => (x.id === c.id ? { ...x, name: inst, status: 'ok', error: undefined } : x)),
    };
  });
  applyFeedDir();
  const r = S().range;
  const t = await srcCall<{ tasks: Task[]; version: number }>(c.id, 'GET', `/tasks${r ? `?from=${r.from}&to=${r.to}` : ''}`);
  set((s) => ({
    tasks: { ...Object.fromEntries(Object.entries(s.tasks).filter(([k]) => !k.startsWith(`f${SEP}${c.id}${SEP}`))), ...Object.fromEntries(t.tasks.map((x) => [x.id, x])) },
  }));
  state.set(c.id, { version: t.version, dirVersion: b.directoryVersion, last: Date.now() });
}

/** All connections on this device: load the ones not loaded yet. Called at start and after connecting. */
export async function loadSources() {
  const cs = loadConns();
  set((s) => ({
    sources: cs.map((c) => ({ ...(s.sources.find((x) => x.id === c.id) ?? { id: c.id, origin: c.origin, name: c.origin.replace(/^https?:\/\//, ''), color: c.color, status: 'loading' as const }), user: c.user?.name })),
  }));
  await Promise.all(cs.map((c) => loadSource(c).catch((e) => markSource(c.id, { status: S().sources.find((x) => x.id === c.id)?.status === 'signed-out' ? 'signed-out' : 'error', error: e instanceof Error ? e.message : String(e) }))));
}

/** Keeps up with each instance, like sync() does with this one (called on the same timer). */
export async function syncSources(isPending: (id: string) => boolean) {
  for (const c of loadConns()) {
    const st = state.get(c.id);
    if (!st) { void loadSource(c).catch(() => {}); continue; }
    if (Date.now() - st.last < 9000) continue;
    st.last = Date.now();
    try {
      const r = await srcCall<SyncResponse>(c.id, 'GET', `/sync?since=${st.version}`);
      if (r.directoryVersion !== st.dirVersion) { await loadSource(c); continue; }
      st.version = r.version;
      if (r.inboxUnread !== undefined) set((s) => ({ feedDir: { ...s.feedDir, unread: { ...s.feedDir.unread, [c.id]: r.inboxUnread! } } }));
      if (r.changed && (r.tasks?.length || r.gone?.length)) {
        set((s) => {
          const tasks = { ...s.tasks };
          const events = { ...s.events };
          for (const t of r.tasks ?? []) { if (isPending(t.id)) continue; tasks[t.id] = t; delete events[t.id]; }
          for (const id of r.gone ?? []) delete tasks[nsId(c.id, id)];
          return { tasks, events };
        });
      }
      const cur = S().sources.find((x) => x.id === c.id);
      if (cur && cur.status !== 'ok') markSource(c.id, { status: 'ok', error: undefined });
    } catch (e) {
      markSource(c.id, { status: S().sources.find((x) => x.id === c.id)?.status === 'signed-out' ? 'signed-out' : 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }
}
/** More days loaded here: load them there too. */
export async function sourcesRange(from: string, to: string) {
  await Promise.all(loadConns().map(async (c) => {
    try {
      const t = await srcCall<{ tasks: Task[] }>(c.id, 'GET', `/tasks?from=${from}&to=${to}`);
      set((s) => ({ tasks: { ...s.tasks, ...Object.fromEntries(t.tasks.map((x) => [x.id, x])) } }));
    } catch { /* shown on its next sync */ }
  }));
}

// ---------- inbox ----------
/** Every instance's newest inbox page, with our ids (merged by src/inbox.ts). */
export async function sourcesInbox(): Promise<{ src: string; page: InboxPage }[]> {
  const out: { src: string; page: InboxPage }[] = [];
  await Promise.all(loadConns().map(async (c) => {
    try {
      const page = await srcCall<InboxPage>(c.id, 'GET', '/inbox', undefined, true);
      const ctx = ctxFor(c.id);
      if (ctx) out.push({ src: c.id, page: { ...page, items: page.items.map((i) => inboxIn(ctx, i)) } });
    } catch { /* skipped this time */ }
  }));
  return out;
}
export async function sourcesMarkRead(upTo: string) {
  await Promise.all(loadConns().map((c) => srcCall(c.id, 'POST', '/inbox/read', { upTo }, true).catch(() => {})));
  set((s) => ({ feedDir: { ...s.feedDir, unread: Object.fromEntries(Object.keys(s.feedDir.unread).map((k) => [k, 0])) } }));
}

// =====================================================================================================================
// Connecting (OAuth with PKCE) and disconnecting
// =====================================================================================================================
const PENDING = 'tv:connecting';
const b64u = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomStr = (n = 32) => b64u(crypto.getRandomValues(new Uint8Array(n)));
const redirectUri = () => `${location.origin}/oauth/done`;

/** The other instance's origin from what someone typed. */
export function cleanOrigin(raw: string): string {
  let u: URL;
  try { u = new URL(raw.trim().replace(/^(?!https?:\/\/)/, 'https://')); } catch { throw new Error("That isn't a web address."); }
  const local = (h: string) => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(h);
  if (u.protocol !== 'https:' && !(local(u.hostname) && local(location.hostname))) throw new Error('Use the https:// address of the other instance.');
  if (u.origin === location.origin) throw new Error("That's this instance.");
  return u.origin;
}

/**
 * Starts connecting: registers this app there (once), then goes there to sign in and approve. One connection per
 * instance: connecting one that's already connected is refused (disconnect it first to connect as someone else),
 * and `reconnect` (signed out there, or a new device) has to be as the same person.
 */
export async function connectInstance(raw: string, reconnect = false) {
  const origin = cleanOrigin(raw);
  const here = connByOrigin(origin);
  if (here && !reconnect) throw new Error(`${origin.replace(/^https?:\/\//, '')} is already connected${here.user ? ` as ${here.user.name}` : ''}. Disconnect it first to connect as someone else.`);
  const elsewhere = here?.user ? null : (await api.get<{ relays: { origin: string; user: { id: string; name: string } }[] }>('/api/relays').catch(() => ({ relays: [] }))).relays.find((r) => r.origin === origin);
  const expect = here?.user ?? (elsewhere?.user?.id ? elsewhere.user : null);
  const clients = JSON.parse(localStorage.getItem('tv:clients') || '{}') as Record<string, string>;
  let clientId = clients[origin];
  if (!clientId) {
    let res: Response;
    try {
      res = await fetch(`${origin}/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: `Taskivities on ${location.host}`, redirect_uris: [redirectUri()],
          grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
        }),
      });
    } catch { throw new Error(`Can't reach ${origin.replace(/^https?:\/\//, '')}. Is it a Taskivities instance?`); }
    const data = (await res.json().catch(() => ({}))) as { client_id?: string; error_description?: string };
    if (!res.ok || !data.client_id) throw new Error(data.error_description || `${origin.replace(/^https?:\/\//, '')} doesn't support connecting (it needs Taskivities 0.6 or later).`);
    clientId = data.client_id;
    localStorage.setItem('tv:clients', JSON.stringify({ ...clients, [origin]: clientId }));
  }
  const verifier = randomStr(48);
  const challenge = b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const st = randomStr(18);
  sessionStorage.setItem(PENDING, JSON.stringify({ origin, clientId, verifier, state: st, expect }));
  location.href = `${origin}/authorize?${new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri(), code_challenge: challenge, code_challenge_method: 'S256', state: st,
  })}`;
}

/** Back from approving there (/oauth/done): swap the code for tokens, set up its notifications, load it. */
export async function finishConnect(): Promise<{ ok: boolean; message: string }> {
  const q = new URLSearchParams(location.search);
  history.replaceState(null, '', '/');
  const pending = JSON.parse(sessionStorage.getItem(PENDING) || 'null') as { origin: string; clientId: string; verifier: string; state: string; expect?: { id: string; name: string } | null } | null;
  sessionStorage.removeItem(PENDING);
  if (!pending || q.get('state') !== pending.state) return { ok: false, message: 'That connection request expired. Try again.' };
  if (q.get('error')) return { ok: false, message: q.get('error') === 'access_denied' ? 'Access wasn’t approved.' : q.get('error_description') || 'Connecting didn’t work.' };
  try {
    const t = await tokenCall(pending, { grant_type: 'authorization_code', code: q.get('code') ?? '', redirect_uri: redirectUri(), code_verifier: pending.verifier });
    // Who did they approve as? Reconnecting has to be as the same person.
    const meRes = await fetch(`${pending.origin}/v1/bootstrap`, { headers: { authorization: `Bearer ${t.access}` } });
    const me = ((await meRes.json().catch(() => ({}))) as { me?: User }).me;
    if (!me) return { ok: false, message: 'Signed in there, but couldn’t tell as whom. Try again.' };
    const user = { id: me.id, name: me.name || me.email };
    const host = pending.origin.replace(/^https?:\/\//, '');
    if (pending.expect && pending.expect.id !== user.id) {
      await revoke(pending, t.refresh); // not kept: leave nothing behind there
      return { ok: false, message: `You signed in to ${host} as ${user.name}, but it's connected as ${pending.expect.name}. Sign in there as ${pending.expect.name}, or disconnect it first.` };
    }
    // Home keeps one relay per instance, for every device: it refuses a second person (worker/relay.ts).
    let relay: string;
    try { relay = (await api.post<{ url: string }>('/api/relays', { origin: pending.origin, user })).url; } catch (e) {
      await revoke(pending, t.refresh);
      return { ok: false, message: e instanceof Error ? e.message : 'Connecting didn’t work.' };
    }
    const old = connByOrigin(pending.origin);
    const used = new Set(loadConns().map((c) => c.color));
    const c: Conn = {
      id: old?.id ?? randomStr(6).replace(/[-_]/g, 'x'), origin: pending.origin, clientId: pending.clientId, ...t, user,
      color: old?.color ?? PROJECT_COLORS.find((x) => !used.has(x)) ?? PROJECT_COLORS[0],
    };
    putConn(c);
    await srcCall(c.id, 'POST', '/push-relays', { url: relay }, true).catch(() => { /* notifications only; the rest works */ });
    await loadSources();
    return { ok: true, message: `Connected ${S().sources.find((x) => x.id === c.id)?.name ?? pending.origin}. Your tasks there now show with yours.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Connecting didn’t work.' };
  }
}

export async function disconnectInstance(id: string) {
  const c = connById(id);
  if (c) {
    // End the sign-in there (as revoking it there would), and stop its notifications (the relay here goes too, so it would stop anyway) and forget it on this device.
    const relays = await api.get<{ relays: { id: string; origin: string }[] }>('/api/relays').catch(() => ({ relays: [] }));
    await Promise.all([
      ...relays.relays.filter((r) => r.origin === c.origin).map((r) => api.del(`/api/relays/${r.id}`).catch(() => {})),
      revoke(c, c.refresh),
    ]);
  }
  saveConns(loadConns().filter((x) => x.id !== id));
  state.delete(id);
  set((s) => {
    const drop = <V,>(m: Record<string, V>) => Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith(`f${SEP}${id}${SEP}`)));
    const { [id]: _m, ...me } = s.feedDir.me;
    const { [id]: _u, ...unread } = s.feedDir.unread;
    return { sources: s.sources.filter((x) => x.id !== id), tasks: drop(s.tasks), feedDir: { users: drop(s.feedDir.users), projects: drop(s.feedDir.projects), me, unread } };
  });
  applyFeedDir();
}

/** Instances connected on another device (from home's relays) but not this one: offered for a one-tap reconnect. */
export async function connectedElsewhere(): Promise<{ origin: string; user: string }[]> {
  const { relays } = await api.get<{ relays: { origin: string; user: { name: string } }[] }>('/api/relays');
  const here = new Set(loadConns().map((c) => c.origin));
  return relays.filter((r) => !here.has(r.origin)).map((r) => ({ origin: r.origin, user: r.user?.name ?? '' }));
}
