// Dependencies between tasks: a task can wait on others (its blockers), and one task can block several.
// Storage: migrations/0019_dependencies.sql. Rules about dates (late, held up): shared/deps.ts.
//   • Anyone who can change a task can say what it waits on, choosing from tasks they can see. Taking a link off
//     only needs the waiting task: its blocker may be in a project they're not on.
//   • No cycles: a task can't wait on itself, or on anything that (however indirectly) waits on it.
//   • Both tasks' histories record the link, and both tasks' versions move on, so everyone's app shows it.
//   • Nothing moves by itself. When dates clash, the app offers to move the tasks, and people decide.
import { Hono } from 'hono';
import { BLOCKERS_MAX, type Task } from '../shared/types';
import { type AppEnv, type Env, type Viewer, CURRENT_VERSION, bad, bumpVersion, canSeeProject, eventStmt, mapTask, nowIso } from './lib';
import { loadEditableTask, loadTask, loadVisibleTask } from './tasks';
import type { Notice } from './push';

/**
 * Statement: the tasks linked to this one (both ways) get a new version, so apps reload what they show about it
 * (open or done, due date). Run it after `bumpVersion` whenever a task's status, date or archived state changes.
 * updated_at stays as it is: nothing about those tasks themselves changed.
 */
export const touchLinked = (db: D1Database, taskId: string) =>
  db.prepare(
    `UPDATE tasks SET version = ${CURRENT_VERSION}
     WHERE id IN (SELECT task_id FROM task_dependencies WHERE blocker_id = ?1 UNION SELECT blocker_id FROM task_dependencies WHERE task_id = ?1)`,
  ).bind(taskId);

/**
 * When a task is done: the tasks that were waiting on it and now wait on nothing else, for a notice to whoever has
 * each one. Run before the change is saved (the other blockers don't change with it).
 */
export async function unblockedBy(db: D1Database, taskId: string, actorId: string, via: string | null): Promise<Notice[]> {
  const { results } = await db.prepare(
    `SELECT t.id, t.assignee_id FROM task_dependencies d JOIN tasks t ON t.id = d.task_id
     WHERE d.blocker_id = ?1 AND t.status = 'open' AND t.archived_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM task_dependencies d2 JOIN tasks b ON b.id = d2.blocker_id
                       WHERE d2.task_id = t.id AND d2.blocker_id != ?1 AND b.status = 'open' AND b.archived_at IS NULL)`,
  ).bind(taskId).all<{ id: string; assignee_id: string }>();
  return results.map((r) => ({ to: r.assignee_id, kind: 'unblocked' as const, actorId, via, taskId: r.id }));
}

/** Does `from` wait on `target`, directly or through other tasks? */
async function waitsOn(db: D1Database, from: string, target: string): Promise<boolean> {
  const r = await db.prepare(
    `WITH RECURSIVE up(id) AS (
       SELECT blocker_id FROM task_dependencies WHERE task_id = ?1
       UNION SELECT d.blocker_id FROM task_dependencies d JOIN up ON d.task_id = up.id
     ) SELECT 1 FROM up WHERE id = ?2 LIMIT 1`,
  ).bind(from, target).first();
  return !!r;
}

/**
 * Makes `taskId` wait on `blockerId` (add), or stop waiting on it. Returns both tasks as they are now; the blocker
 * only if the viewer can see it.
 */
export async function setBlocker(env: Env, v: Viewer, taskId: string, blockerId: unknown, add: boolean, via: string | null = null): Promise<{ task: Task; other: Task | null }> {
  const db = env.DB;
  if (typeof blockerId !== 'string' || !blockerId) throw bad('Pick a task.');
  const t = await loadEditableTask(db, v, taskId);
  const linked = await db.prepare('SELECT 1 FROM task_dependencies WHERE task_id = ? AND blocker_id = ?').bind(t.id, blockerId).first();
  const now = nowIso();
  const touch = (id: string) => db.prepare(`UPDATE tasks SET updated_at = ?, version = ${CURRENT_VERSION} WHERE id = ?`).bind(now, id);

  if (add) {
    if (blockerId === t.id) throw bad("A task can't wait on itself.");
    const b = await loadVisibleTask(db, v, blockerId);
    if (b.archived_at) throw bad('That task is archived. Restore it first.');
    if (!linked) {
      const { n } = (await db.prepare('SELECT COUNT(*) AS n FROM task_dependencies WHERE task_id = ?').bind(t.id).first<{ n: number }>())!;
      if (n >= BLOCKERS_MAX) throw bad(`A task can wait on at most ${BLOCKERS_MAX} others.`);
      if (await waitsOn(db, b.id, t.id)) throw bad(`“${b.title}” already waits on this task (or on something that does), so this would go round in a circle.`);
      await db.batch([
        bumpVersion(db),
        db.prepare('INSERT INTO task_dependencies (task_id, blocker_id, added_by, at) VALUES (?, ?, ?, ?)').bind(t.id, b.id, v.id, now),
        touch(t.id), touch(b.id),
        eventStmt(db, { taskId: t.id, actorId: v.id, via, type: 'blocker_added', to: b.id, at: now }),
        eventStmt(db, { taskId: b.id, actorId: v.id, via, type: 'dependent_added', to: t.id, at: now }),
      ]);
    }
  } else if (linked) {
    // The blocker may be in a project the viewer isn't on: the link can still come off the task they can change.
    await db.batch([
      bumpVersion(db),
      db.prepare('DELETE FROM task_dependencies WHERE task_id = ? AND blocker_id = ?').bind(t.id, blockerId),
      touch(t.id), touch(blockerId),
      eventStmt(db, { taskId: t.id, actorId: v.id, via, type: 'blocker_removed', to: blockerId, at: now }),
      eventStmt(db, { taskId: blockerId, actorId: v.id, via, type: 'dependent_removed', to: t.id, at: now }),
    ]);
  }
  const task = mapTask((await loadTask(db, t.id))!);
  const o = await loadTask(db, blockerId);
  return { task, other: o && canSeeProject(v, o.project_id) && !o.archived_at ? mapTask(o) : null };
}

export const dependencyRoutes = new Hono<AppEnv>();

/** { blockerId }: this task waits on that one. Answers with this task, and the blocker in `tasks`. */
dependencyRoutes.post('/:id/blockers', async (c) => {
  const b = await c.req.json<{ blockerId?: string }>().catch(() => ({} as { blockerId?: string }));
  const { task, other } = await setBlocker(c.env, c.get('viewer'), c.req.param('id'), b.blockerId, true);
  return c.json({ task, tasks: other ? [other] : [] });
});
dependencyRoutes.delete('/:id/blockers/:blocker', async (c) => {
  const { task, other } = await setBlocker(c.env, c.get('viewer'), c.req.param('id'), c.req.param('blocker'), false);
  return c.json({ task, tasks: other ? [other] : [] });
});
