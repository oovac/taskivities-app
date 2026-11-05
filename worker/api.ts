import { Hono } from 'hono';
import { addDays, isDate } from '../shared/dates';
import type { Bootstrap, SyncResponse } from '../shared/types';
import {
  type AppEnv, type EventRow, type ProjectRow, type TaskRow, type UserRow,
  TASK_COLS, bad, canSeeProject, mapEvent, mapProject, mapTask, mapUser, today,
} from './lib';
import { loadSettings } from './settings';
import { type Patch, applyPatch, commit, createTask, loadVisibleTask, updateTaskWithNext, visible } from './tasks';

export const api = new Hono<AppEnv>();

async function getMeta(db: D1Database) {
  const { results } = await db.prepare('SELECT key, value FROM meta').all<{ key: string; value: number }>();
  const m = Object.fromEntries(results.map((r) => [r.key, r.value]));
  return { version: m.version ?? 0, directoryVersion: m.directory_version ?? 0 };
}

// ---------- bootstrap: me, people, projects ----------
api.get('/bootstrap', async (c) => {
  const v = c.get('viewer');
  const db = c.env.DB;
  const [users, members, projects, meta, settings] = await Promise.all([
    db.prepare('SELECT * FROM users ORDER BY name').all<UserRow>(),
    db.prepare('SELECT user_id, project_id FROM project_members').all<{ user_id: string; project_id: string }>(),
    db.prepare('SELECT * FROM projects WHERE archived = 0 ORDER BY name').all<ProjectRow>(),
    getMeta(db),
    loadSettings(db),
  ]);
  const visibleProjects = projects.results.filter((p) => canSeeProject(v, p.id));
  const visibleIds = new Set(visibleProjects.map((p) => p.id));
  const byUser = new Map<string, string[]>();
  for (const m of members.results) {
    // Members only learn about memberships in projects they can see.
    if (!visibleIds.has(m.project_id)) continue;
    byUser.set(m.user_id, [...(byUser.get(m.user_id) ?? []), m.project_id]);
  }
  const all = users.results.map((u) => mapUser(u, byUser.get(u.id) ?? []));
  const me = all.find((u) => u.id === v.id)!;
  // Removed people stay in the list (history still names them) but without their email.
  const list = all.map((u) => (u.status === 'removed' ? { ...u, email: '' } : u));
  const body: Bootstrap = { me, users: list, projects: visibleProjects.map(mapProject), today: today(v), tz: v.tz, ...meta, settings };
  return c.json(body);
});

// ---------- tasks in a window (plus every open task) ----------
api.get('/tasks', async (c) => {
  const v = c.get('viewer');
  const t0 = today(v);
  const from = isDate(c.req.query('from')) ? c.req.query('from')! : addDays(t0, -60);
  const to = isDate(c.req.query('to')) ? c.req.query('to')! : addDays(t0, 365);
  const vis = visible(v);
  const { results } = await c.env.DB
    .prepare(`SELECT ${TASK_COLS} FROM tasks WHERE (status = 'open' OR due_date BETWEEN ? AND ? OR done_on BETWEEN ? AND ?) AND ${vis.sql}`)
    .bind(from, to, from, to, ...vis.binds)
    .all<TaskRow>();
  return c.json({ from, to, tasks: results.map(mapTask), ...(await getMeta(c.env.DB)) });
});

// ---------- polling ----------
api.get('/sync', async (c) => {
  const v = c.get('viewer');
  const since = Number(c.req.query('since') ?? 0);
  const meta = await getMeta(c.env.DB);
  const base = { version: meta.version, directoryVersion: meta.directoryVersion, today: today(v) };
  if (meta.version <= since) return c.json({ changed: false, ...base } satisfies SyncResponse);
  const { results } = await c.env.DB.prepare(`SELECT ${TASK_COLS} FROM tasks WHERE version > ?`).bind(since).all<TaskRow>();
  const tasks = results.filter((r) => canSeeProject(v, r.project_id)).map(mapTask);
  const gone = results.filter((r) => !canSeeProject(v, r.project_id)).map((r) => r.id);
  return c.json({ changed: true, ...base, tasks, gone } satisfies SyncResponse);
});

// ---------- create ----------
api.post('/tasks', async (c) => {
  const v = c.get('viewer');
  const b = await c.req.json<{ title?: string; notes?: string; projectId?: string; assigneeId?: string; dueDate?: string; priority?: number; repeat?: unknown }>();
  // The app's defaults: assigned to me, due today, Normal priority.
  const task = await createTask(c.env, v, {
    title: b.title ?? '',
    notes: b.notes,
    projectId: b.projectId ?? '',
    assigneeId: b.assigneeId || v.id,
    dueDate: b.dueDate ?? today(v),
    priority: b.priority ?? 3,
    repeat: b.repeat,
  });
  return c.json({ task }, 201);
});

// ---------- edit (every change is logged) ----------
api.patch('/tasks/:id', async (c) => {
  // `next`: the new copy, when this finished a repeating task.
  return c.json(await updateTaskWithNext(c.env, c.get('viewer'), c.req.param('id'), await c.req.json<Patch>()));
});

/** Move several tasks to one date (the "Move all" for carried-over tasks). */
api.post('/tasks/move', async (c) => {
  const v = c.get('viewer');
  const db = c.env.DB;
  const b = await c.req.json<{ ids?: string[]; dueDate?: string }>();
  if (!Array.isArray(b.ids) || !b.ids.length || b.ids.length > 200) throw bad('Pick between 1 and 200 tasks.');
  const all: D1PreparedStatement[] = [];
  for (const id of b.ids) all.push(...(await applyPatch(c.env, v, id, { dueDate: b.dueDate })).stmts);
  await commit(c.env, all);
  const placeholders = b.ids.map(() => '?').join(', ');
  const { results } = await db.prepare(`SELECT ${TASK_COLS} FROM tasks WHERE id IN (${placeholders})`).bind(...b.ids).all<TaskRow>();
  return c.json({ tasks: results.map(mapTask) });
});

api.get('/tasks/:id/events', async (c) => {
  const v = c.get('viewer');
  const t = await loadVisibleTask(c.env.DB, v, c.req.param('id'));
  const { results } = await c.env.DB.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY at, rowid').bind(t.id).all<EventRow>();
  return c.json({ events: results.map(mapEvent) });
});
