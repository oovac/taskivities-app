// Task rules shared by the REST API (worker/api.ts) and the MCP tools (worker/mcp.ts).
// Every check about who may see or change a task lives here, so the two can't drift apart.
import { addDays, isDate } from '../shared/dates';
import { type Repeat, cleanRepeat, describe, firstDate, nextDate, sameRule } from '../shared/repeat';
import { NOTES_MAX, TITLE_MAX, type Priority, type Task } from '../shared/types';
import {
  type Env, type EventRow, type TaskRow, type Viewer,
  CURRENT_VERSION, TASK_COLS, bad, bumpVersion, canSeeProject, eventStmt, forbidden, mapTask, notFound, nowIso, today, uid,
  userOnProject,
} from './lib';

/** SQL fragment limiting tasks to the projects the viewer can see. */
export const visible = (v: Viewer, alias = '') =>
  v.role === 'admin'
    ? { sql: '1 = 1', binds: [] as unknown[] }
    : { sql: `${alias}project_id IN (SELECT project_id FROM project_members WHERE user_id = ?)`, binds: [v.id] as unknown[] };

export async function loadTask(db: D1Database, id: string) {
  return db.prepare(`SELECT ${TASK_COLS} FROM tasks WHERE id = ?`).bind(id).first<TaskRow>();
}

/** A task the viewer can see, or 404 (never 403: hidden tasks don't exist for them). */
export async function loadVisibleTask(db: D1Database, v: Viewer, id: string) {
  const t = await loadTask(db, id);
  if (!t || !canSeeProject(v, t.project_id)) throw notFound('Task not found.');
  return t;
}

const isPriority = (p: unknown): p is Priority => p === 1 || p === 2 || p === 3 || p === 4;

// ---------- repeating tasks ----------
interface SeriesRow {
  id: string; rule: string; starts_on: string; title: string; notes: string; project_id: string; assignee_id: string;
  priority: number; made: number; active: number;
}
const loadSeries = (db: D1Database, id: string | null) =>
  id ? db.prepare('SELECT * FROM series WHERE id = ?').bind(id).first<SeriesRow>() : Promise.resolve(null);

function parseRule(raw: unknown): Repeat {
  const r = cleanRepeat(raw);
  if (typeof r === 'string') throw bad(r);
  return r;
}

/** Statements that insert a series. */
const insertSeries = (db: D1Database, id: string, rule: Repeat, startsOn: string, t: { title: string; notes: string; projectId: string; assigneeId: string; priority: number }, by: string, now: string) =>
  db.prepare(
    `INSERT INTO series (id, rule, starts_on, title, notes, project_id, assignee_id, priority, made, active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`,
  ).bind(id, JSON.stringify(rule), startsOn, t.title, t.notes, t.projectId, t.assigneeId, t.priority, by, now, now);

// ---------- create ----------
export interface NewTask {
  title: string;
  notes?: string;
  projectId: string;
  assigneeId: string;
  dueDate: string;
  priority: number;
  /** Makes it a repeating task (see shared/repeat.ts). The first copy lands on the first scheduled date on or after dueDate. */
  repeat?: unknown;
}

/**
 * Validates and inserts a task as `v`. `via` names the AI assistant that made it (null from the app).
 * Callers fill in their own defaults first: the app defaults to "me, today, Normal"; MCP requires all of them.
 */
export async function createTask(env: Env, v: Viewer, b: NewTask, via: string | null = null): Promise<Task> {
  const db = env.DB;
  const title = (b.title ?? '').trim();
  const notes = (b.notes ?? '').trim();
  const t0 = today(v);
  if (!title) throw bad('A task needs a title.');
  if (title.length > TITLE_MAX) throw bad(`Titles can be at most ${TITLE_MAX} characters.`);
  if (notes.length > NOTES_MAX) throw bad('Notes are too long.');
  if (!b.projectId || !canSeeProject(v, b.projectId)) throw bad('Pick one of your projects.');
  const project = await db.prepare('SELECT id FROM projects WHERE id = ? AND archived = 0').bind(b.projectId).first();
  if (!project) throw bad('That project no longer exists.');
  if (!b.assigneeId || !(await userOnProject(db, b.assigneeId, b.projectId))) throw bad("That person isn't on this project.");
  if (!isDate(b.dueDate)) throw bad('Invalid date.');
  if (b.dueDate < t0) throw bad("Tasks can't be due in the past.");
  if (!isPriority(b.priority)) throw bad('Invalid priority.');
  const rule = b.repeat != null ? parseRule(b.repeat) : null;
  const due = rule ? firstDate(rule, b.dueDate) : b.dueDate;
  if (rule?.until && rule.until < due) throw bad('The repeat ends before the first date.');

  const id = uid();
  const seriesId = rule ? uid() : null;
  const now = nowIso();
  const stmts = [bumpVersion(db)];
  if (rule) stmts.push(insertSeries(db, seriesId!, rule, due, { title, notes, projectId: b.projectId, assigneeId: b.assigneeId, priority: b.priority }, v.id, now));
  stmts.push(
    db.prepare(
      `INSERT INTO tasks (id, title, notes, project_id, assignee_id, created_by, assigned_by, due_date, priority, status, created_at, updated_at, version, series_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ${CURRENT_VERSION}, ?)`,
    ).bind(id, title, notes, b.projectId, b.assigneeId, v.id, v.id, due, b.priority, now, now, seriesId),
    eventStmt(db, {
      taskId: id, actorId: v.id, via, type: 'created', at: now,
      to: JSON.stringify({ assignee: b.assigneeId, due, priority: b.priority, project: b.projectId }),
    }),
  );
  if (rule) stmts.push(eventStmt(db, { taskId: id, actorId: v.id, via, type: 'repeat_set', to: describe(rule, due), at: now }));
  await db.batch(stmts);
  return mapTask((await loadTask(db, id))!);
}

// ---------- edit (every change is logged) ----------
export interface Patch {
  title?: string; notes?: string; projectId?: string; assigneeId?: string; dueDate?: string; priority?: number;
  status?: 'open' | 'done';
  /** Optional message attached to a transfer. */
  note?: string;
  /** Undo of your own last date move: allows putting a past due date back. */
  restore?: boolean;
  /** Repeating tasks: start, change (a rule) or stop (null) repeating. Undefined leaves it alone. */
  repeat?: unknown;
  /** Repeating tasks: skip this copy, moving it to the next scheduled date. */
  skip?: boolean;
  /** Repeating tasks: change only this copy. By default edits to the open copy also apply to future copies. */
  thisOnly?: boolean;
}

/**
 * Validates a change and returns the statements that make it (task update + one history event per field).
 * Nothing is written; run the statements with `commit()` (or batch several patches together).
 */
export async function applyPatch(env: Env, v: Viewer, id: string, b: Patch, via: string | null = null) {
  const db = env.DB;
  const t = await loadVisibleTask(db, v, id);
  const t0 = today(v);
  const now = nowIso();
  const sets: string[] = [];
  const binds: unknown[] = [];
  const events: Parameters<typeof eventStmt>[1][] = [];
  let undidSkip = false;
  const set = (col: string, val: unknown) => { sets.push(`${col} = ?`); binds.push(val); };
  const ev = (e: Omit<Parameters<typeof eventStmt>[1], 'taskId' | 'actorId' | 'via' | 'at'>) =>
    events.push({ ...e, taskId: id, actorId: v.id, via, at: now });

  if (b.title !== undefined) {
    const title = b.title.trim();
    if (!title) throw bad('A task needs a title.');
    if (title.length > TITLE_MAX) throw bad(`Titles can be at most ${TITLE_MAX} characters.`);
    if (title !== t.title) { set('title', title); ev({ type: 'renamed', from: t.title, to: title }); }
  }
  if (b.notes !== undefined) {
    const notes = b.notes.trim();
    if (notes.length > NOTES_MAX) throw bad('Notes are too long.');
    if (notes !== t.notes) { set('notes', notes); ev({ type: 'notes_edited' }); }
  }
  if (b.priority !== undefined && b.priority !== t.priority) {
    if (!isPriority(b.priority)) throw bad('Invalid priority.');
    set('priority', b.priority);
    ev({ type: 'priority_changed', from: String(t.priority), to: String(b.priority) });
  }
  const project = b.projectId ?? t.project_id;
  const assignee = b.assigneeId ?? t.assignee_id;
  if (project !== t.project_id) {
    if (!canSeeProject(v, project)) throw forbidden("You're not on that project.");
    const p = await db.prepare('SELECT id FROM projects WHERE id = ? AND archived = 0').bind(project).first();
    if (!p) throw bad('That project no longer exists.');
    set('project_id', project);
    ev({ type: 'project_changed', from: t.project_id, to: project });
  }
  if (project !== t.project_id || assignee !== t.assignee_id) {
    // The assignee must always be able to see the task.
    if (!(await userOnProject(db, assignee, project))) throw bad("That person isn't on this task's project.");
  }
  if (assignee !== t.assignee_id) {
    set('assignee_id', assignee);
    set('assigned_by', v.id);
    const note = (b.note ?? '').trim().slice(0, 500) || null;
    ev({ type: 'transferred', from: t.assignee_id, to: assignee, note });
  }
  if (b.dueDate !== undefined && b.dueDate !== t.due_date) {
    if (!isDate(b.dueDate)) throw bad('Invalid date.');
    // Undo of your own last move or skip can put the old date back, even if it's in the past.
    const last = b.restore ? await db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY at DESC, rowid DESC LIMIT 1').bind(id).first<EventRow>() : null;
    const isUndo = !!last && (last.type === 'date_moved' || last.type === 'skipped') && last.actor_id === v.id && last.from_value === b.dueDate;
    if (b.dueDate < t0 && !isUndo) throw bad("Tasks can't be moved into the past.");
    undidSkip = isUndo && last!.type === 'skipped';
    set('due_date', b.dueDate);
    ev({ type: 'date_moved', from: t.due_date, to: b.dueDate });
  }
  if (b.status !== undefined && b.status !== t.status) {
    if (b.status === 'done') {
      set('status', 'done'); set('done_at', now); set('done_on', t0); set('done_by', v.id);
      ev({ type: 'done' });
    } else if (b.status === 'open') {
      set('status', 'open'); set('done_at', null); set('done_on', null); set('done_by', null);
      ev({ type: 'reopened' });
    } else throw bad('Invalid status.');
  }
  // ----- repeating tasks -----
  const after: D1PreparedStatement[] = []; // run after the task update
  let nextId: string | null = null;
  let series = await loadSeries(db, t.series_id);
  const isOpen = t.status === 'open';
  const final = {
    title: b.title !== undefined ? b.title.trim() : t.title,
    notes: b.notes !== undefined ? b.notes.trim() : t.notes,
    priority: b.priority ?? t.priority,
    projectId: project,
    assigneeId: assignee,
    due: b.dueDate ?? t.due_date,
  };

  if (b.repeat !== undefined) {
    if (b.repeat === null) {
      if (series?.active) {
        after.push(db.prepare('UPDATE series SET active = 0, updated_at = ? WHERE id = ?').bind(now, series.id));
        ev({ type: 'repeat_stopped' });
        series = { ...series, active: 0 };
      }
    } else {
      // A task can only become repeating when it's created; after that the rule can be changed or stopped, not started.
      if (!series?.active) throw bad('Repeating is set when a task is created. Create a new repeating task instead.');
      if (!isOpen && b.status !== 'open') throw bad('Only an open task can repeat.');
      const rule = parseRule(b.repeat);
      if (rule.until && rule.until < final.due) throw bad('The repeat ends before this task is due.');
      if (!sameRule(JSON.parse(series.rule), rule)) {
        after.push(db.prepare('UPDATE series SET rule = ?, starts_on = ?, made = 1, active = 1, updated_at = ? WHERE id = ?')
          .bind(JSON.stringify(rule), final.due, now, series.id));
        ev({ type: 'repeat_changed', to: describe(rule, final.due) });
        series = { ...series, rule: JSON.stringify(rule), starts_on: final.due, made: 1, active: 1 };
      }
    }
  }

  const live = series?.active ? series : null;
  if (live && (isOpen || b.status === 'open') && !b.thisOnly) {
    // Edits to the open copy carry forward to future copies (only the fields this change touches,
    // so an earlier "just this one" transfer isn't undone by a later edit).
    const ts: string[] = [];
    const tb: unknown[] = [];
    const tset = (col: keyof SeriesRow, val: unknown, given: boolean) => {
      if (given && val !== live[col]) { ts.push(`${col} = ?`); tb.push(val); (live as unknown as Record<string, unknown>)[col] = val; }
    };
    tset('title', final.title, b.title !== undefined);
    tset('notes', final.notes, b.notes !== undefined);
    tset('priority', final.priority, b.priority !== undefined);
    tset('project_id', final.projectId, b.projectId !== undefined);
    tset('assignee_id', final.assigneeId, b.assigneeId !== undefined);
    if (ts.length) after.push(db.prepare(`UPDATE series SET ${ts.join(', ')}, updated_at = ? WHERE id = ?`).bind(...tb, now, live.id));
  }

  if (undidSkip && live) after.push(db.prepare('UPDATE series SET made = MAX(1, made - 1), updated_at = ? WHERE id = ?').bind(now, live.id));

  if (b.skip) {
    if (!live || !isOpen) throw bad("Only the open copy of a repeating task can be skipped.");
    if (b.dueDate !== undefined || b.status !== undefined) throw bad('Skip on its own.');
    const rule = JSON.parse(live.rule) as Repeat;
    const next = nextDate(rule, live.starts_on, t.due_date, t0, live.made, t0);
    if (!next) throw bad("That's the last one. Mark it done, or stop repeating.");
    set('due_date', next);
    ev({ type: 'skipped', from: t.due_date, to: next });
    after.push(db.prepare('UPDATE series SET made = made + 1, updated_at = ? WHERE id = ?').bind(now, live.id));
  }

  if (live && b.status === 'done' && isOpen) {
    const rule = JSON.parse(live.rule) as Repeat;
    // Finished late? The next copy still lands after today: missed dates are skipped, never piled up.
    const next = nextDate(rule, live.starts_on, final.due, addDays(t0, 1), live.made, t0);
    const proj = next ? await db.prepare('SELECT id FROM projects WHERE id = ? AND archived = 0').bind(live.project_id).first() : null;
    if (next && proj) {
      // The template's person may have left the project: fall back to whoever had this copy, then to whoever finished it.
      let who = live.assignee_id;
      if (!(await userOnProject(db, who, live.project_id))) who = (await userOnProject(db, final.assigneeId, live.project_id)) ? final.assigneeId : v.id;
      nextId = uid();
      // Guarded so that two people finishing it at once can't create two copies.
      after.push(
        db.prepare(
          `INSERT INTO tasks (id, title, notes, project_id, assignee_id, created_by, assigned_by, due_date, priority, status, created_at, updated_at, version, series_id)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ${CURRENT_VERSION}, ?
           WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE series_id = ? AND status = 'open')`,
        ).bind(nextId, live.title, live.notes, live.project_id, who, v.id, v.id, next, live.priority, now, now, live.id, live.id),
        db.prepare(
          `INSERT INTO task_events (id, task_id, actor_id, via, type, from_value, to_value, note, at)
           SELECT ?, ?, ?, ?, 'created', ?, ?, NULL, ? WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ?)`,
        ).bind(uid(), nextId, v.id, via, id, JSON.stringify({ assignee: who, due: next, priority: live.priority, project: live.project_id, repeat: true }), now, nextId),
        db.prepare('UPDATE series SET made = made + 1, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM tasks WHERE id = ?)').bind(now, live.id, nextId),
      );
    } else {
      after.push(db.prepare('UPDATE series SET active = 0, updated_at = ? WHERE id = ?').bind(now, live.id));
    }
  }

  if (!events.length) return { stmts: [] as D1PreparedStatement[], changed: false, nextId: null };
  const stmts = [
    // Even with no column changes (e.g. only the repeat changed) the task is touched, so everyone's view syncs.
    db.prepare(`UPDATE tasks SET ${[...sets, 'updated_at = ?', `version = ${CURRENT_VERSION}`].join(', ')} WHERE id = ?`).bind(...binds, now, id),
    ...events.map((e) => eventStmt(db, e)),
    ...after,
  ];
  return { stmts, changed: true, nextId };
}

/** Writes the statements from one or more patches in a single batch (one version bump). */
export async function commit(env: Env, stmts: D1PreparedStatement[]) {
  if (stmts.length) await env.DB.batch([bumpVersion(env.DB), ...stmts]);
}

/** Validate, write and return the updated task, plus the next copy if finishing a repeating task created one. */
export async function updateTaskWithNext(env: Env, v: Viewer, id: string, b: Patch, via: string | null = null): Promise<{ task: Task; next: Task | null }> {
  const { stmts, nextId } = await applyPatch(env, v, id, b, via);
  await commit(env, stmts);
  const task = mapTask((await loadTask(env.DB, id))!);
  const n = nextId ? await loadTask(env.DB, nextId) : null;
  return { task, next: n ? mapTask(n) : null };
}

/** Validate, write and return the updated task. */
export async function updateTask(env: Env, v: Viewer, id: string, b: Patch, via: string | null = null): Promise<Task> {
  return (await updateTaskWithNext(env, v, id, b, via)).task;
}
