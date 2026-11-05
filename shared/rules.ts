import type { Task, User } from './types';

/** Open and overdue: it rolls into today and keeps counting. */
export const isLate = (t: Task, today: string): boolean => t.status === 'open' && t.dueDate < today;

/**
 * The day a task is shown on. Rollover is a display rule, never stored:
 * open + overdue → today; done late → the day it was finished; otherwise its due date.
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
