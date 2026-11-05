// Everything that changes data. Edits are applied on screen first, then sent; on failure they're rolled back.
import { addDays, rel, weekStart } from '../shared/dates';
import { type Repeat, describe } from '../shared/repeat';
import { onProject } from '../shared/rules';
import type { AppSettings, Bootstrap, Priority, Project, Role, SyncResponse, Task, TaskEvent, User } from '../shared/types';
import { PRIORITIES } from '../shared/types';
import { api, ApiError } from './api';
import { applyFavicon } from './brand';
import { activeSelector, focusLater, selFor } from './focus';
import { type Page, type Pop, type PopType, type State, S, emptyDraft, set } from './store';
import { draftEffective, firstName, myProjects, sharesWith } from './util';

const pending = new Set<string>(); // tasks with an edit in flight (ignore sync for them)
const mine = new Map<string, number>(); // tasks I changed recently (don't flash my own edits)
const byId = <T extends { id: string }>(arr: T[]) => Object.fromEntries(arr.map((x) => [x.id, x]));
const nowIso = () => new Date().toISOString();
const lowerFirst = (x: string) => x.charAt(0).toLowerCase() + x.slice(1);

// ---------- toasts + flash ----------
let toastSeq = 0;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(text: string, undo?: () => void, error = false) {
  const id = ++toastSeq;
  set({ toast: { id, text, undo, error } });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => S().toast?.id === id && set({ toast: null }), error ? 6000 : 4500);
}
export const toastError = (e: unknown) => toast(e instanceof Error ? e.message : 'Something went wrong.', undefined, true);
export function flash(ids: string[]) {
  const now = Date.now();
  set((s) => ({ flash: { ...s.flash, ...Object.fromEntries(ids.map((i) => [i, now])) } }));
  setTimeout(() => set((s) => {
    const f = { ...s.flash };
    ids.forEach((i) => f[i] === now && delete f[i]);
    return { flash: f };
  }), 2700);
}

// ---------- loading + sync ----------
function applyDirectory(b: Bootstrap): Partial<State> {
  const s = S();
  const users = byId(b.users);
  const projects = byId(b.projects);
  const viewUser = s.viewUser && users[s.viewUser] && users[s.viewUser].status === 'active' ? s.viewUser : b.me.id;
  let page = s.page;
  if ((page === 'team' || page === 'settings') && b.me.role !== 'admin') {
    page = 'tasks';
    history.replaceState(null, '', '/');
  }
  applyFavicon(b.settings.logoVersion);
  return {
    me: b.me, users, projects, today: b.today, tz: b.tz, dirVersion: b.directoryVersion, settings: b.settings, viewUser, page,
    projSel: s.projSel === 'all' || projects[s.projSel] ? s.projSel : 'all',
    projDay: s.projDay || b.today,
  };
}

export async function boot() {
  try {
    const b = await api.get<Bootstrap>('/api/bootstrap');
    const t = await api.get<{ from: string; to: string; tasks: Task[]; version: number }>('/api/tasks');
    set({ ...applyDirectory(b), tasks: byId(t.tasks), version: t.version, range: { from: t.from, to: t.to }, ready: true, lastSync: Date.now() });
    const last = localStorage.getItem('tv:lastProject');
    set((s) => ({ draft: { ...s.draft, projectId: last && myProjects(s).some((p) => p.id === last) ? last : myProjects(s)[0]?.id ?? null } }));
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 401)) set({ bootError: e instanceof Error ? e.message : 'Could not load.' });
  }
}

/** People, projects or access changed: reload them and the tasks we can now see. */
async function reloadDirectory() {
  const s = S();
  const b = await api.get<Bootstrap>('/api/bootstrap');
  const r = s.range;
  const t = await api.get<{ from: string; to: string; tasks: Task[]; version: number }>(`/api/tasks${r ? `?from=${r.from}&to=${r.to}` : ''}`);
  set({ ...applyDirectory(b), tasks: byId(t.tasks), version: t.version, range: { from: t.from, to: t.to }, lastSync: Date.now() });
}

let syncing = false;
export async function sync() {
  if (syncing || !S().ready) return;
  syncing = true;
  try {
    const s = S();
    const r = await api.get<SyncResponse>(`/api/sync?since=${s.version}`);
    if (r.directoryVersion !== s.dirVersion) {
      await reloadDirectory();
      return;
    }
    const patch: Partial<State> = { lastSync: Date.now(), offline: false };
    if (r.today !== s.today) patch.today = r.today;
    if (r.changed && r.tasks) {
      const tasks = { ...S().tasks };
      const events = { ...S().events };
      const flashIds: string[] = [];
      const me = s.me!.id;
      for (const t of r.tasks) {
        if (pending.has(t.id)) continue;
        const prev = tasks[t.id];
        if (prev && prev.version >= t.version) continue;
        tasks[t.id] = t;
        delete events[t.id];
        if ((mine.get(t.id) ?? 0) < Date.now() - 15000) flashIds.push(t.id);
        if (!prev && t.assigneeId === me && t.createdBy !== me) {
          toast(`${firstName(s.users[t.createdBy])} assigned you “${t.title}”`);
        }
      }
      for (const id of r.gone ?? []) delete tasks[id];
      Object.assign(patch, { tasks, events, version: r.version });
      if (flashIds.length) setTimeout(() => flash(flashIds), 0);
    } else patch.version = r.version;
    set(patch);
  } catch (e) {
    if (e instanceof ApiError && e.status === 0) set({ offline: true });
  } finally {
    syncing = false;
  }
}

/** Make sure tasks for this date range are loaded (older weeks or days). */
export async function ensureRange(from: string, to: string) {
  const r = S().range;
  if (!r || (from >= r.from && to <= r.to)) return;
  const nf = from < r.from ? from : r.from;
  const nt = to > r.to ? to : r.to;
  const t = await api.get<{ tasks: Task[] }>(`/api/tasks?from=${nf}&to=${nt}`);
  set((s) => ({ tasks: { ...s.tasks, ...byId(t.tasks) }, range: { from: nf, to: nt } }));
}

export async function loadEvents(id: string) {
  try {
    const { events } = await api.get<{ events: TaskEvent[] }>(`/api/tasks/${id}/events`);
    set((s) => ({ events: { ...s.events, [id]: events } }));
  } catch (e) {
    toastError(e);
  }
}

// ---------- task edits ----------
type Changes = Partial<Pick<Task, 'title' | 'notes' | 'projectId' | 'assigneeId' | 'dueDate' | 'priority' | 'status'>>;

const putTask = (t: Task) => set((s) => ({ tasks: { ...s.tasks, [t.id]: t }, events: { ...s.events, [t.id]: undefined } }));

function optimistic(prev: Task, c: Changes): Task {
  const s = S();
  const next: Task = { ...prev, ...c };
  if (c.status === 'done' && prev.status !== 'done') Object.assign(next, { doneAt: nowIso(), doneOn: s.today, doneBy: s.me!.id });
  if (c.status === 'open' && prev.status !== 'open') Object.assign(next, { doneAt: null, doneOn: null, doneBy: null });
  if (c.assigneeId && c.assigneeId !== prev.assigneeId) next.assignedBy = s.me!.id;
  return next;
}

interface PatchOpts { note?: string; restore?: boolean; toast?: string; noUndo?: boolean; thisOnly?: boolean }

export async function patchTask(id: string, c: Changes, opts: PatchOpts = {}) {
  const prev = S().tasks[id];
  if (!prev) return;
  putTask(optimistic(prev, c));
  pending.add(id);
  mine.set(id, Date.now());
  flash([id]);
  try {
    const { task, next } = await api.patch<{ task: Task; next: Task | null }>(`/api/tasks/${id}`, { ...c, note: opts.note, restore: opts.restore, thisOnly: opts.thisOnly });
    putTask(task);
    if (next) { mine.set(next.id, Date.now()); putTask(next); }
    const text = opts.toast && next ? `${opts.toast} · next one ${rel(next.dueDate, S().today)}` : opts.toast;
    if (text) toast(text, opts.noUndo ? undefined : () => undo(prev, c));
  } catch (e) {
    putTask(prev);
    toastError(e);
  } finally {
    pending.delete(id);
  }
}

function undo(prev: Task, c: Changes) {
  const back: Changes = {};
  for (const k of Object.keys(c) as (keyof Changes)[]) (back as Record<string, unknown>)[k] = prev[k];
  set({ toast: null });
  void patchTask(prev.id, back, { restore: true });
}

export const toggleDone = (id: string) => {
  const t = S().tasks[id];
  if (!t) return;
  const done = t.status !== 'done';
  void patchTask(id, { status: done ? 'done' : 'open' }, done ? { toast: `Done: ${t.title}` } : {});
};
export const transfer = (id: string, to: string, note?: string, thisOnly?: boolean) =>
  patchTask(id, { assigneeId: to }, { note, thisOnly, toast: `Transferred to ${firstName(S().users[to])}${thisOnly ? ' (just this one)' : ''}` });

/** Repeating tasks: change the rule (a Repeat), or stop repeating for good (null). Not optimistic: the server decides dates. */
export async function setRepeat(id: string, rule: Repeat | null) {
  const t = S().tasks[id];
  if (!t) return;
  pending.add(id);
  mine.set(id, Date.now());
  try {
    const { task } = await api.patch<{ task: Task }>(`/api/tasks/${id}`, { repeat: rule });
    putTask(task);
    flash([id]);
    // Stopping can't be undone: a task can only start repeating when it's created.
    const old = t.series?.active ? t.series.rule : null;
    if (!rule) toast('Stopped repeating. This task is now a normal task.');
    else toast(`Repeats: ${describe(rule, task.series?.anchor ?? task.dueDate)}`, old ? () => { set({ toast: null }); void setRepeat(id, old); } : undefined);
  } catch (e) {
    toastError(e);
  } finally {
    pending.delete(id);
  }
}

/** Repeating tasks: skip this copy; its date moves to the next scheduled one. */
export async function skipTask(id: string) {
  const t = S().tasks[id];
  if (!t) return;
  pending.add(id);
  mine.set(id, Date.now());
  try {
    const { task } = await api.patch<{ task: Task }>(`/api/tasks/${id}`, { skip: true });
    putTask(task);
    flash([id]);
    toast(`Skipped · next one ${rel(task.dueDate, S().today)}`, () => {
      set({ toast: null });
      void patchTask(id, { dueDate: t.dueDate }, { restore: true });
    });
  } catch (e) {
    toastError(e);
  } finally {
    pending.delete(id);
  }
}
export const setPriority = (id: string, p: Priority) => patchTask(id, { priority: p }, { toast: `Priority set to ${PRIORITIES[p].name}` });
export const setProject = (id: string, p: string) => patchTask(id, { projectId: p }, { toast: `Moved to ${S().projects[p]?.name}` });

export async function moveTasks(ids: string[], dueDate: string) {
  const s = S();
  const prevs = ids.map((i) => s.tasks[i]).filter((t): t is Task => !!t && t.dueDate !== dueDate);
  if (!prevs.length) return;
  prevs.forEach((t) => { putTask({ ...t, dueDate }); pending.add(t.id); mine.set(t.id, Date.now()); });
  flash(prevs.map((t) => t.id));
  try {
    if (prevs.length === 1) {
      const { task } = await api.patch<{ task: Task }>(`/api/tasks/${prevs[0].id}`, { dueDate });
      putTask(task);
    } else {
      const { tasks } = await api.post<{ tasks: Task[] }>('/api/tasks/move', { ids: prevs.map((t) => t.id), dueDate });
      tasks.forEach(putTask);
    }
    toast(prevs.length > 1 ? `Moved ${prevs.length} tasks to ${rel(dueDate, s.today)}` : `Moved to ${rel(dueDate, s.today)}`, () => {
      set({ toast: null });
      prevs.forEach((t) => void patchTask(t.id, { dueDate: t.dueDate }, { restore: true }));
    });
  } catch (e) {
    prevs.forEach(putTask);
    toastError(e);
  } finally {
    prevs.forEach((t) => pending.delete(t.id));
  }
}

export async function createTask(): Promise<boolean> {
  const s = S();
  const d = s.draft;
  let title = d.title.trim();
  if (!title) return false;
  let priority = d.priority;
  const bang = title.match(/^(!{1,2})\s*/); // "!Fix bug" → High, "!!Prod down" → Urgent
  if (bang) { priority = bang[1].length === 2 ? 1 : 2; title = title.slice(bang[0].length) || title; }
  const { projectId, assigneeId } = draftEffective(s);
  if (!projectId) { toast("You're not on any project yet. Ask an admin to add you to one.", undefined, true); return false; }
  const due = d.dueDate || defaultDraftDate(s);
  try {
    const { task } = await api.post<{ task: Task }>('/api/tasks', { title, notes: d.notes, projectId, assigneeId, dueDate: due, priority, repeat: d.repeat ?? undefined });
    mine.set(task.id, Date.now());
    localStorage.setItem('tv:lastProject', projectId);
    set((st) => ({ tasks: { ...st.tasks, [task.id]: task }, draft: { ...emptyDraft(projectId), open: true } }));
    flash([task.id]);
    toast(`Added for ${assigneeId === s.me!.id ? 'you' : firstName(s.users[assigneeId])} · ${rel(task.dueDate, s.today)}${task.series ? ` · ${lowerFirst(describe(task.series.rule, task.series.anchor))}` : ''}`);
    return true;
  } catch (e) {
    toastError(e);
    return false;
  }
}

export function defaultDraftDate(s: State) {
  // Current week, Today view or other pages: today. A future week: its Monday.
  if (s.view === 'today' || s.page !== 'tasks' || s.weekOffset <= 0) return s.today;
  return addDays(weekStart(s.today), s.weekOffset * 7);
}

// ---------- UI helpers ----------
export function openPop(p: Omit<Pop, 'rect' | 'returnSel'> & { returnSel?: string | null }, anchor: HTMLElement) {
  const r = anchor.getBoundingClientRect();
  set({ pop: { ...p, rect: { l: r.left, t: r.top, b: r.bottom, r: r.right }, returnSel: p.returnSel ?? selFor(anchor) } });
}
export function closePop(restore: boolean) {
  const p = S().pop;
  set({ pop: null });
  if (restore && p?.returnSel) focusLater(p.returnSel);
}
export const popIs = (t: PopType) => S().pop?.type === t;

export function openDrawer(id: string, editTitle = false) {
  set({ drawer: id, pop: null });
  focusLater(editTitle ? '.dr-title' : '.drawer');
}
export function closeDrawer(restore = true) {
  const id = S().drawer;
  set({ drawer: null });
  if (restore && id) focusLater(`[data-nav="task:${id}"]`);
}

let connectReturn: string | null = null;
export function openConnect() {
  connectReturn = activeSelector();
  set({ connect: true, pop: null, help: false });
  focusLater('[data-act="copy-mcp"]');
}
export function closeConnect() {
  set({ connect: false });
  focusLater(connectReturn || '[data-act="account"]');
}

let helpReturn: string | null = null;
export function openHelp() {
  helpReturn = activeSelector();
  set({ help: true, pop: null });
  focusLater('.help-close');
}
export function closeHelp() {
  set({ help: false });
  focusLater(helpReturn);
}

export function setPage(page: Page) {
  const s = S();
  if ((page === 'team' || page === 'settings') && s.me?.role !== 'admin') return;
  set({ page, drawer: null, pop: null, invite: null, projDay: s.projDay || s.today });
  history.replaceState(null, '', page === 'tasks' ? '/' : `/${page}`);
}
export function viewPerson(userId: string) {
  set({ viewUser: userId, page: 'tasks', drawer: null, pop: null, draft: { ...S().draft, assigneeId: null } });
  history.replaceState(null, '', '/');
}
export function setView(view: State['view']) {
  set({ view, ...(view === 'today' ? { weekOffset: 0 } : {}) });
  localStorage.setItem('tv:view', view);
}

export async function signOut() {
  await api.post('/auth/logout').catch(() => {});
  location.href = '/login';
}

// ---------- admin ----------
export async function addPeople(emails: string[], role: Role, projects: string[]) {
  const r = await api.post<{ added: string[]; skipped: string[] }>('/api/admin/users', { emails, role, projects });
  await reloadDirectory();
  toast(r.added.length
    ? `Added ${r.added.length} ${r.added.length > 1 ? 'people' : 'person'}${r.skipped.length ? ` · ${r.skipped.length} already on the team` : ''}`
    : 'Everyone there is already on the team');
}
export async function updateUser(id: string, body: { role?: Role; projects?: string[] }, message?: string) {
  try {
    await api.patch(`/api/admin/users/${id}`, body);
    await reloadDirectory();
    if (message) toast(message);
    flash(['u:' + id]);
  } catch (e) {
    toastError(e);
  }
}
export async function removeUser(id: string, transferTo?: string) {
  const u = S().users[id];
  try {
    const r = await api.del<{ transferred: number }>(`/api/admin/users/${id}${transferTo ? `?transferTo=${transferTo}` : ''}`);
    await reloadDirectory();
    toast(`Removed ${u?.name || u?.email}${r.transferred ? ` · ${r.transferred} task${r.transferred > 1 ? 's' : ''} moved to ${firstName(S().users[transferTo!])}` : ''}`);
  } catch (e) {
    toastError(e);
  }
}
export async function saveProject(p: { id: string | null; name: string; color: string; description: string; members: string[] }): Promise<string | null> {
  const body = { name: p.name, color: p.color, description: p.description, members: p.members };
  try {
    let id = p.id;
    if (id) await api.patch(`/api/admin/projects/${id}`, body);
    else id = (await api.post<{ id: string }>('/api/admin/projects', body)).id;
    await reloadDirectory();
    toast(p.id ? `Saved ${p.name}` : `Created ${p.name}`);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Could not save.';
  }
}

// ---------- access-aware lookups used by menus ----------
export const assignable = (s: State, projectId: string): User[] =>
  Object.values(s.users).filter((u) => u.status !== 'removed' && onProject(u, projectId));
export const switchablePeople = (s: State): User[] =>
  Object.values(s.users).filter((u) => u.status === 'active' && (u.id === s.me!.id || sharesWith(s, u)));
export const projectList = (s: State): Project[] => myProjects(s);

// ---------- app settings (admins) ----------
function putSettings(settings: AppSettings) {
  set({ settings });
  applyFavicon(settings.logoVersion);
}

/** Uploads an SVG logo. Returns an error message to show next to the button, or null. */
export async function uploadLogo(svg: string): Promise<string | null> {
  try {
    const r = await api.put<{ settings: AppSettings }>('/api/admin/settings/logo', { svg });
    putSettings(r.settings);
    toast('Logo updated');
    return null;
  } catch (e) {
    return e instanceof ApiError ? e.message : 'Upload failed.';
  }
}

export async function resetLogo() {
  try {
    const r = await api.del<{ settings: AppSettings }>('/api/admin/settings/logo');
    putSettings(r.settings);
    toast('Back to the built-in logo');
  } catch (e) {
    toastError(e);
  }
}
