// Following tasks. Whoever has a task and everyone following it hear about its comments, when it's done or reopened,
// and when it's handed to someone (worker/push.ts for notifications, worker/inbox.ts for the inbox).
// Storage and the creator rule: migrations/0015_followers.sql.
import { Hono } from 'hono';
import { type AppEnv, type Env, type Viewer, CURRENT_VERSION, bad, bumpVersion, eventStmt, getUser, mapTask, nowIso, userOnProject } from './lib';
import { loadEditableTask, loadTask } from './tasks';
import { notify } from './push';
import type { Task } from '../shared/types';

/** SQL: ids of the tasks someone has or follows. Bind their id 4 times. */
export const WATCHED_TASKS =
  'SELECT id FROM tasks WHERE assignee_id = ? ' +
  'UNION SELECT id FROM tasks WHERE created_by = ? AND NOT EXISTS ' +
  '(SELECT 1 FROM task_followers f WHERE f.task_id = tasks.id AND f.user_id = ? AND f.following = 0) ' +
  'UNION SELECT task_id FROM task_followers WHERE user_id = ? AND following = 1';

/** Everyone on a task now: whoever has it and its followers (who may since have lost access: callers check). */
export async function watchersOf(db: D1Database, taskId: string): Promise<string[]> {
  const { results } = await db.prepare(
    `SELECT assignee_id AS u FROM tasks WHERE id = ?1
     UNION SELECT created_by FROM tasks WHERE id = ?1 AND NOT EXISTS
       (SELECT 1 FROM task_followers f WHERE f.task_id = ?1 AND f.user_id = tasks.created_by AND f.following = 0)
     UNION SELECT user_id FROM task_followers WHERE task_id = ?1 AND following = 1`,
  ).bind(taskId).all<{ u: string }>();
  return results.map((r) => r.u);
}

/** Statement: `userId` follows the task (again). Used when they comment, too. */
export const followStmt = (db: D1Database, taskId: string, userId: string, by: string, at: string) =>
  db.prepare(
    `INSERT INTO task_followers (task_id, user_id, following, added_by, at) VALUES (?, ?, 1, ?, ?)
     ON CONFLICT (task_id, user_id) DO UPDATE SET following = 1, added_by = excluded.added_by, at = excluded.at`,
  ).bind(taskId, userId, by, at);

/**
 * Follow or stop following a task, as `v`, for themselves or (`userId`) for someone else on its project.
 * Changes for someone else are recorded in the task history, and someone added hears about it.
 */
export async function setFollowing(env: Env, v: Viewer, taskId: string, follow: boolean, userId?: string | null, via: string | null = null): Promise<Task> {
  const db = env.DB;
  const t = await loadEditableTask(db, v, taskId);
  const who = userId || v.id;
  if (typeof follow !== 'boolean') throw bad('Say whether to follow.');
  if (who !== v.id) {
    const u = await getUser(db, who);
    if (!u || u.status !== 'active' || !(await userOnProject(db, who, t.project_id))) throw bad("They aren't on this task's project.");
  }
  if (!follow && who === t.assignee_id) throw bad(who === v.id ? 'You have this task, so you always hear about it.' : 'They have this task, so they always hear about it.');
  const current = mapTask(t).followers.includes(who);
  if (current === follow) return mapTask(t);
  const now = nowIso();
  const stmts = [bumpVersion(db), db.prepare(`UPDATE tasks SET updated_at = ?, version = ${CURRENT_VERSION} WHERE id = ?`).bind(now, t.id)];
  if (follow) stmts.push(followStmt(db, t.id, who, v.id, now));
  else if (who === t.created_by) {
    stmts.push(db.prepare(
      `INSERT INTO task_followers (task_id, user_id, following, added_by, at) VALUES (?, ?, 0, ?, ?)
       ON CONFLICT (task_id, user_id) DO UPDATE SET following = 0, added_by = excluded.added_by, at = excluded.at`,
    ).bind(t.id, who, v.id, now));
  } else stmts.push(db.prepare('DELETE FROM task_followers WHERE task_id = ? AND user_id = ?').bind(t.id, who));
  if (who !== v.id) stmts.push(eventStmt(db, { taskId: t.id, actorId: v.id, via, type: follow ? 'follower_added' : 'follower_removed', to: who, at: now }));
  await db.batch(stmts);
  if (follow && who !== v.id) notify(env, [{ to: who, kind: 'followed', actorId: v.id, via, taskId: t.id }]);
  return mapTask((await loadTask(db, t.id))!);
}

export const followRoutes = new Hono<AppEnv>();

/** { follow: boolean, userId?: someone else on the project } */
followRoutes.post('/:id/follow', async (c) => {
  const b = await c.req.json<{ follow?: boolean; userId?: string }>().catch(() => ({} as { follow?: boolean; userId?: string }));
  return c.json({ task: await setFollowing(c.env, c.get('viewer'), c.req.param('id'), b.follow as boolean, b.userId) });
});
