// The address bar follows what you're looking at, so Back and Forward work and any view (or task) can be bookmarked
// or shared. One subscriber writes the URL from the state; popstate (Back / Forward) and the first load read it back.
//
//   /                              My week (/people/<id> for someone else's)
//   /people/<id>                   someone's week
//   /projects                      All projects
//   /projects/<id>                 a project
//   /projects?people=a,b&projects=c   several at once (the switcher's Several)
//   /manage, /manage/projects      People & projects (admins)
//   /settings                      Settings (admins)
//   ?task=<id>                     an open task, on any of these
//   ?view=today|board  ?week=N  ?day=YYYY-MM-DD   the view (Week is the default), week offset, a project's day
//
// Ids from another instance (src/sources.ts) are written as <their id>@<host>, so a link works on any device that
// connected that instance (this device's own ids for it differ). Opening a page changes the history (Back returns);
// switching view, week or day, or stepping from one task to the next, replaces it.
import { feedParts, isFeed, connByHost, nsId, connById } from './sources';
import { S, set, useStore, type MultiSel, type State } from './store';

// ---------- ids in URLs ----------
const hostOf = (origin: string) => new URL(origin).host;
/** Our id → URL form. */
function tok(id: string): string {
  if (!isFeed(id)) return id;
  const { src, rid } = feedParts(id);
  const c = connById(src);
  return c ? `${rid}@${hostOf(c.origin)}` : rid;
}
/** URL form → our id (null: on an instance this device hasn't connected; `host` says which). */
function untok(t: string): { id: string | null; host?: string } {
  const at = t.lastIndexOf('@');
  if (at < 0) return { id: t };
  const host = t.slice(at + 1), rid = t.slice(0, at);
  const c = connByHost(host);
  return c ? { id: nsId(c.id, rid) } : { id: null, host };
}

// ---------- state → URL ----------
export function urlFor(s: State): string {
  let path = '/';
  const q = new URLSearchParams();
  if (s.page === 'team') path = s.manageTab === 'projects' ? '/manage/projects' : '/manage';
  else if (s.page === 'settings') path = '/settings';
  else if (s.page === 'projects') {
    if (s.projSel === 'multi') {
      path = '/projects';
      if (s.multi.people.length) q.set('people', s.multi.people.map(tok).join(','));
      if (s.multi.projects.length) q.set('projects', s.multi.projects.map(tok).join(','));
    } else path = s.projSel === 'all' ? '/projects' : `/projects/${encodeURIComponent(tok(s.projSel))}`;
  } else if (s.viewUser && s.viewUser !== s.me?.id) path = `/people/${encodeURIComponent(tok(s.viewUser))}`;
  if (s.page === 'tasks' || s.page === 'projects') {
    if (s.view !== 'list') q.set('view', s.view);
    if (s.view !== 'today' && s.weekOffset) q.set('week', String(s.weekOffset));
    if (s.page === 'projects' && s.view === 'today' && s.projDay && s.projDay !== s.today) q.set('day', s.projDay);
  }
  if (s.drawer) q.set('task', tok(s.drawer));
  const qs = q.toString().replace(/%2C/g, ',').replace(/%40/g, '@');
  return `${path}${qs ? `?${qs}` : ''}`;
}

// ---------- URL → state ----------
interface Parsed { state: Partial<State>; task: string | null; missing: string | null }
export function stateFromUrl(loc: Location | URL, first = false): Parsed {
  const s = S();
  const p = loc.pathname.replace(/\/+$/, '') || '/';
  const q = new URLSearchParams(loc.search);
  const st: Partial<State> = {};
  let missing: string | null = null;
  const id = (t: string) => { const r = untok(decodeURIComponent(t)); if (!r.id && r.host) missing = r.host; return r.id; };

  if (p === '/manage' || p === '/team') Object.assign(st, { page: 'team', manageTab: 'people' });
  else if (p === '/manage/projects') Object.assign(st, { page: 'team', manageTab: 'projects' });
  else if (p === '/settings') st.page = 'settings';
  else if (p === '/projects' || p.startsWith('/projects/')) {
    st.page = 'projects';
    const ppl = (q.get('people') ?? '').split(',').filter(Boolean).map(id).filter((x): x is string => !!x);
    const prj = (q.get('projects') ?? '').split(',').filter(Boolean).map(id).filter((x): x is string => !!x);
    if (ppl.length || prj.length) Object.assign(st, { projSel: 'multi', multi: { people: ppl, projects: prj } satisfies MultiSel });
    else st.projSel = p === '/projects' ? 'all' : id(p.slice('/projects/'.length)) ?? 'all';
  } else if (p.startsWith('/people/')) Object.assign(st, { page: 'tasks', viewUser: id(p.slice('/people/'.length)) ?? s.me?.id ?? '' });
  else Object.assign(st, { page: 'tasks', viewUser: s.me?.id ?? '' });

  const v = q.get('view');
  // No view in the URL: Week, except on first load, where this device's last choice stays.
  if (v === 'today' || v === 'board' || v === 'list' || v === 'week' || !first) st.view = v === 'today' || v === 'board' ? v : 'list';
  st.weekOffset = Number(q.get('week')) || 0;
  const day = q.get('day');
  if (st.page === 'projects') st.projDay = day && /^\d{4}-\d{2}-\d{2}$/.test(day) && day <= s.today ? day : s.today;

  // A notification from another instance (worker/relay.ts): ?open=<its origin>&task=<its id>.
  const open = q.get('open');
  let task: string | null = null;
  if (open) {
    let host = '';
    try { host = hostOf(open); } catch { /* not an address */ }
    const c = host ? connByHost(host) : null;
    const rid = q.get('task');
    if (c && rid) task = nsId(c.id, rid);
    else if (host) missing = open;
  } else if (q.get('task')) task = id(q.get('task')!);
  return { state: st, task, missing };
}

// ---------- keeping them together ----------
let applying = false;
/** The part of a URL whose change is a new place to go Back from: where, and whether a task is open. */
const placeOf = (url: string) => { const u = new URL(url, location.origin); return `${u.pathname}|${u.searchParams.has('task')}`; };

/** Applies a URL (first load, Back / Forward). Opening its task waits for `ready` (other instances loading). */
export function applyUrl(loc: Location | URL, ready: Promise<unknown>, openTask: (id: string) => void, first = false) {
  const { state, task, missing } = stateFromUrl(loc, first);
  applying = true;
  set({ ...state, drawer: task && S().tasks[task] ? task : null, pop: null, ...(missing ? { instancesOpen: missing } : {}) });
  applying = false;
  if (task && !S().tasks[task]) void ready.then(() => openTask(task));
}

/** From now on: every change to what's shown updates the address bar. */
export function startRouter(ready: Promise<unknown>, openTask: (id: string) => void) {
  // Tidy the first URL (old forms like /team or ?open=…) without adding a history entry.
  history.replaceState(null, '', urlFor(S()));
  useStore.subscribe((s) => {
    if (applying || !s.ready) return;
    const next = urlFor(s);
    const cur = location.pathname + location.search;
    if (next === cur) return;
    if (placeOf(next) !== placeOf(cur)) history.pushState(null, '', next);
    else history.replaceState(null, '', next);
  });
  window.addEventListener('popstate', () => applyUrl(location, ready, openTask));
}
