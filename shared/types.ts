// Types shared by the Worker (API) and the browser app.
import type { SeriesInfo } from './repeat';

export type Role = 'admin' | 'member';
export type UserStatus = 'invited' | 'active' | 'removed';
export type Priority = 1 | 2 | 3 | 4; // 1 Urgent · 2 High · 3 Normal (default) · 4 Low

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  color: string;
  role: Role;
  status: UserStatus;
  /** Project ids this member belongs to (empty for admins: they are on every project). */
  projects: string[];
  addedAt: string;
  /** IANA time zone from their browser (null until they've opened the app). */
  timeZone: string | null;
}

export interface Project {
  id: string;
  name: string;
  color: string;
  /** Written mainly for AI assistants (MCP clients): what belongs here, what doesn't, naming conventions. */
  description: string;
  archived: boolean;
}

export interface Task {
  id: string;
  title: string;
  notes: string;
  projectId: string;
  assigneeId: string;
  createdBy: string;
  assignedBy: string;
  /** YYYY-MM-DD, always set */
  dueDate: string;
  priority: Priority;
  status: 'open' | 'done';
  doneAt: string | null;
  /** YYYY-MM-DD in the time zone of whoever marked it done */
  doneOn: string | null;
  doneBy: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  /** Set when this task is a copy of a repeating task. */
  series: SeriesInfo | null;
}

export type EventType =
  | 'created'
  | 'transferred'
  | 'date_moved'
  | 'priority_changed'
  | 'project_changed'
  | 'renamed'
  | 'notes_edited'
  | 'done'
  | 'reopened'
  /** Repeating tasks: to_value holds the rule's description. */
  | 'repeat_set'
  | 'repeat_changed'
  | 'repeat_stopped'
  /** Skipped this copy: the date moved to the next scheduled one. */
  | 'skipped';

export interface TaskEvent {
  id: string;
  taskId: string;
  actorId: string;
  /** Set when an AI assistant made the change on the actor's behalf (e.g. "Claude"). */
  via: string | null;
  type: EventType;
  fromValue: string | null;
  toValue: string | null;
  note: string | null;
  at: string;
}

/** Settings an admin edits on the Settings page. */
export interface AppSettings {
  /** An uploaded logo is in use (otherwise the built-in one). */
  customLogo: boolean;
  /** Cache-buster for /logo.svg; changes whenever the logo does. */
  logoVersion: string;
}

export interface Bootstrap {
  me: User;
  users: User[];
  projects: Project[];
  today: string;
  tz: string;
  version: number;
  directoryVersion: number;
  settings: AppSettings;
}

export interface SyncResponse {
  changed: boolean;
  version: number;
  directoryVersion: number;
  today: string;
  tasks?: Task[];
  /** Tasks that changed but are no longer visible to you (e.g. moved to a project you're not on). */
  gone?: string[];
}

export const NORMAL: Priority = 3;
export const PRIORITIES: Record<Priority, { name: string; hint: string; color: string }> = {
  1: { name: 'Urgent', hint: 'Drop everything', color: '#D92D20' },
  2: { name: 'High', hint: 'Do these first', color: '#DC6803' },
  3: { name: 'Normal', hint: 'The default', color: '#6B6B78' },
  4: { name: 'Low', hint: "When there's time", color: '#A0A0AB' },
};

export const PROJECT_COLORS = ['#2E90FA', '#7A5AF8', '#F79009', '#12B76A', '#06AED4', '#DB2777', '#D92D20', '#667085'];
export const USER_COLORS = ['#4F46E5', '#DB2777', '#0E9384', '#E8590C', '#2E90FA', '#7A5AF8', '#9E77ED', '#15B79E', '#F79009', '#D92D20'];
export const DESCRIPTION_MAX = 600;
export const TITLE_MAX = 300;
export const NOTES_MAX = 10000;
