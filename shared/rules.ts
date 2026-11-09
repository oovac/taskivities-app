import { addDays, diffDays } from './dates';
import type { Task, User } from './types';

/** The last day a task runs: its due date, or later when it lasts several days (due Nov 1 for 2 days → Nov 2). */
export const lastDay = (t: Pick<Task, 'dueDate' | 'durationDays'>): string =>
  t.durationDays && t.durationDays > 1 ? addDays(t.dueDate, t.durationDays - 1) : t.dueDate;

/** Open and past its last day: overdue. It rolls into today and keeps counting. */
export const isLate = (t: Task, today: string): boolean => t.status === 'open' && lastDay(t) < today;
/** How many days overdue (counted from the day after its last day). */
export const lateDays = (t: Pick<Task, 'dueDate' | 'durationDays'>, today: string): number => diffDays(today, lastDay(t));
/** Finished after its last day: how many days late it was (0: on time). */
export const doneLate = (t: Pick<Task, 'dueDate' | 'durationDays' | 'doneOn'>): number =>
  t.doneOn && t.doneOn > lastDay(t) ? diffDays(t.doneOn, lastDay(t)) : 0;

/**
 * The day a task is shown on. Rollover is a display rule, never stored:
 * open and past its due date (overdue, or within the days it lasts) → today; done after its due date → the day it was
 * finished; otherwise its due date.
 */
export const shownOn = (t: Task, today: string): string => {
  if (t.status === 'done') return t.doneOn && t.doneOn > t.dueDate ? t.doneOn : t.dueDate;
  return t.dueDate < today ? today : t.dueDate;
};

export const isAdmin = (u: Pick<User, 'role'>): boolean => u.role === 'admin';
/** Admins are on every project. */
export const onProject = (u: Pick<User, 'role' | 'projects'>, projectId: string): boolean =>
  u.role === 'admin' || u.projects.includes(projectId);

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
