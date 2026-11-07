// Dependencies between tasks: when a task waits on others, and when a task holds others up.
// Shared by the app (badges, the task panel, "move them too") and the MCP tools. Dates are YYYY-MM-DD.
import type { Task, TaskLink } from './types';

/** When an open task can be done at the earliest: its due date, or today once it's late (it rolls over). */
export const expectedOn = (dueDate: string, today: string) => (dueDate < today ? today : dueDate);

/** The blockers still open. A done task waits on nothing. */
export const openBlockers = (t: Pick<Task, 'status'>, blockedBy: TaskLink[]) => (t.status === 'open' ? blockedBy.filter((b) => b.open) : []);

/**
 * The date an open task's blockers push it to: the latest date any open blocker is expected, when that's after the
 * task's own (it can't be done on time). null when its date still works.
 */
export function blockedUntil(t: Pick<Task, 'status' | 'dueDate'>, blockedBy: TaskLink[], today: string): string | null {
  const own = expectedOn(t.dueDate, today);
  let latest: string | null = null;
  for (const b of openBlockers(t, blockedBy)) {
    const d = expectedOn(b.dueDate, today);
    if (d > own && (!latest || d > latest)) latest = d;
  }
  return latest;
}

/** A waiting task is in trouble: it's late with something still blocking it, or a blocker is due after it. */
export const waitingBadly = (t: Pick<Task, 'status' | 'dueDate'>, blockedBy: TaskLink[], today: string) =>
  openBlockers(t, blockedBy).length > 0 && (t.dueDate < today || blockedUntil(t, blockedBy, today) !== null);

/**
 * The open tasks this one holds up: they wait on it and are due before it can be done (already late, or due
 * earlier than this task). Empty once it's done.
 */
export function holdingUp(t: Pick<Task, 'status' | 'dueDate'>, blocks: TaskLink[], today: string): TaskLink[] {
  if (t.status !== 'open') return [];
  const own = expectedOn(t.dueDate, today);
  return blocks.filter((d) => d.open && d.dueDate < own);
}
