// Webhooks: how an incoming request becomes a task. Shared by the Worker (which creates the task)
// and the app (which previews the result on a captured sample), so both always agree.
//
// A request is seen as one object:  { body, headers, query }
//   body     parsed JSON, or form fields, or { text } for anything else
//   headers  lower-case names (credentials and IP addresses are dropped before storing)
//   query    the URL's ?a=b parameters
// Paths point into it with dots: body.issue.title, body.items.0.name, headers.x-github-event

import { addDays } from './dates';
import { NOTES_MAX, type Priority, TITLE_MAX } from './types';

export interface Mapping {
  /** Template: text with {{path}} placeholders. Required. */
  title: string;
  /** Template. */
  notes?: string;
  projectId: string;
  /** The default person. With `fromPath`, a project member whose email (or name) matches that value gets it instead. */
  assignee: { userId: string; fromPath?: string };
  /** today · `days` days from today · a date read from `path` (ISO date, ISO time or Unix time); missing → today. */
  due: { mode: 'today' | 'days' | 'path'; days?: number; path?: string };
  /** A fixed priority, or read from `fromPath` (1–4, P1–P4, urgent/high/normal/low…) with `value` as the fallback. */
  priority: { value: Priority; fromPath?: string };
  /** Only create a task when the value at `path` equals `equals` (case-insensitive). */
  when?: { path: string; equals: string } | null;
  /** Skip a request when a task was already made from one with the same value here (e.g. an issue id). */
  dedupePath?: string | null;
}

export interface HookRequestView {
  body: unknown;
  headers: Record<string, string>;
  query: Record<string, string>;
}

export interface Member { id: string; email: string; name: string }

export type Outcome =
  | { kind: 'task'; task: { title: string; notes: string; projectId: string; assigneeId: string; dueDate: string; priority: Priority }; dedupeKey: string | null; warnings: string[] }
  | { kind: 'skip'; reason: string }
  | { kind: 'error'; error: string };

// ---------- reading values ----------

const PATH_RE = /^[A-Za-z0-9_$@-]+(\.[A-Za-z0-9_$@:-]+)*$/;
export const validPath = (p: string) => PATH_RE.test(p.replace(/\[(\d+)\]/g, '.$1'));

/** body.items.0.name (or body.items[0].name). Missing → undefined. */
export function getPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const key of path.replace(/\[(\d+)\]/g, '.$1').split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** A value as text: strings and numbers as they are, lists joined with commas, objects as JSON. */
export function toText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v) && v.every((x) => x == null || typeof x !== 'object')) return v.filter((x) => x != null).join(', ');
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

/** Fills {{path}} placeholders. */
export const render = (template: string, root: unknown) =>
  template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, p: string) => toText(getPath(root, p)));

/** The placeholders a template uses (for validation). */
export const placeholders = (template: string) => [...template.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((m) => m[1]);

/** A date from a payload value: 2026-11-05, 2026-11-05T14:00:00Z, or Unix seconds / milliseconds. */
export function readDate(v: unknown): string | null {
  if (typeof v === 'string') {
    const t = v.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
    if (/^\d{9,13}$/.test(t)) return readDate(Number(t));
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    const d = new Date(v < 1e11 ? v * 1000 : v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  return null;
}

const PRIO_WORDS: Record<string, Priority> = {
  urgent: 1, critical: 1, blocker: 1, highest: 1, p0: 1, p1: 1,
  high: 2, major: 2, p2: 2,
  normal: 3, medium: 3, default: 3, p3: 3,
  low: 4, minor: 4, lowest: 4, trivial: 4, p4: 4,
};
export function readPriority(v: unknown): Priority | null {
  const t = toText(v).trim().toLowerCase();
  if (/^[1-4]$/.test(t)) return Number(t) as Priority;
  return PRIO_WORDS[t] ?? null;
}

// ---------- the mapping ----------

/** Checks a mapping's shape. Returns an error message, or null when it's usable. (Projects and people are checked by the server.) */
export function checkMapping(m: unknown): string | null {
  if (!m || typeof m !== 'object') return 'Missing mapping.';
  const x = m as Mapping;
  if (typeof x.title !== 'string' || !x.title.trim()) return 'The title needs some text or a field.';
  if (x.title.length > 1000 || (x.notes ?? '').length > 4000) return 'A template is too long.';
  if (typeof x.projectId !== 'string' || !x.projectId) return 'Pick a project.';
  if (!x.assignee || typeof x.assignee.userId !== 'string' || !x.assignee.userId) return 'Pick who gets the tasks.';
  if (!x.due || !['today', 'days', 'path'].includes(x.due.mode)) return 'Pick when tasks are due.';
  if (x.due.mode === 'days' && !(Number.isInteger(x.due.days) && x.due.days! >= 0 && x.due.days! <= 365)) return 'Days must be between 0 and 365.';
  if (!x.priority || ![1, 2, 3, 4].includes(x.priority.value)) return 'Pick a priority.';
  const paths = [
    ...placeholders(x.title), ...placeholders(x.notes ?? ''),
    x.assignee.fromPath, x.due.mode === 'path' ? x.due.path : undefined, x.priority.fromPath, x.when?.path, x.dedupePath,
  ].filter((p): p is string => !!p);
  if (x.due.mode === 'path' && !x.due.path) return 'Pick the field with the due date.';
  if (x.when && (!x.when.path || typeof x.when.equals !== 'string')) return '"Only when" needs a field and a value.';
  const bad = paths.find((p) => !validPath(p));
  return bad ? `"${bad}" isn't a field path (use dots, like body.issue.title).` : null;
}

/**
 * What a request would create.
 * `today` is the default assignee's today; `members` are the people on the mapping's project.
 */
export function evaluate(m: Mapping, req: HookRequestView, ctx: { today: string; members: Member[] }): Outcome {
  if (m.when?.path) {
    const got = toText(getPath(req, m.when.path)).trim().toLowerCase();
    if (got !== m.when.equals.trim().toLowerCase()) return { kind: 'skip', reason: `${m.when.path} is "${toText(getPath(req, m.when.path))}", not "${m.when.equals}"` };
  }
  const warnings: string[] = [];
  // Every field the title uses must be there: half a title ("GitHub #44:") is worse than an error you can see.
  const missing = placeholders(m.title).find((p) => !toText(getPath(req, p)).trim());
  if (missing) return { kind: 'error', error: `The title uses ${missing}, which is missing or empty in this request.` };
  const title = render(m.title, req).replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
  if (!title) return { kind: 'error', error: 'The title came out empty: the fields it uses are missing in this request.' };
  const notes = render(m.notes ?? '', req).trim().slice(0, NOTES_MAX);

  let assigneeId = m.assignee.userId;
  if (m.assignee.fromPath) {
    const want = toText(getPath(req, m.assignee.fromPath)).trim().toLowerCase();
    const hit = want && ctx.members.find((u) => u.email.toLowerCase() === want || u.name.toLowerCase() === want || u.id === want);
    if (hit) assigneeId = hit.id;
    else if (want) warnings.push(`"${want}" isn't on the project, so it went to the default person.`);
  }
  if (!ctx.members.some((u) => u.id === assigneeId)) return { kind: 'error', error: "The default person isn't on the project any more." };

  let dueDate = ctx.today;
  if (m.due.mode === 'days') dueDate = addDays(ctx.today, m.due.days ?? 0);
  if (m.due.mode === 'path' && m.due.path) {
    const d = readDate(getPath(req, m.due.path));
    if (d && d >= ctx.today) dueDate = d;
    else if (d) warnings.push(`The date ${d} has passed, so it's due today.`);
    else warnings.push(`No date in ${m.due.path}, so it's due today.`);
  }

  let priority = m.priority.value;
  if (m.priority.fromPath) {
    const p = readPriority(getPath(req, m.priority.fromPath));
    if (p) priority = p;
  }

  const key = m.dedupePath ? toText(getPath(req, m.dedupePath)).trim().slice(0, 200) : '';
  return { kind: 'task', task: { title, notes, projectId: m.projectId, assigneeId, dueDate, priority }, dedupeKey: key || null, warnings };
}

/** Lists every leaf in a request, for the field picker: [path, short value]. */
export function leaves(root: unknown, prefix = '', out: [string, string][] = [], depth = 0): [string, string][] {
  if (out.length >= 400 || depth > 8) return out;
  if (root != null && typeof root === 'object') {
    const entries = Array.isArray(root) ? root.slice(0, 20).map((v, i) => [String(i), v] as const) : Object.entries(root);
    if (!entries.length) out.push([prefix, Array.isArray(root) ? '[]' : '{}']);
    for (const [k, v] of entries) leaves(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
  } else out.push([prefix, toText(root)]);
  return out;
}
