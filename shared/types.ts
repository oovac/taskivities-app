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
  /** Number of comments in its history. */
  comments: number;
  /** The task's checklist, in order (empty: no checklist). */
  checklist: ChecklistItem[];
  /** Files attached to the task, oldest first. */
  attachments: AttachmentInfo[];
  /** Archived tasks are hidden everywhere except the Projects page's Archived section. */
  archivedAt: string | null;
  archivedBy: string | null;
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
  | 'skipped'
  /** A comment: the text is in `note`. Like everything in the history, it can't be edited or deleted. */
  | 'comment'
  /** Checklist: to_value is the item's text (check_renamed: from_value → to_value). */
  | 'check_added'
  | 'check_done'
  | 'check_undone'
  | 'check_renamed'
  | 'check_removed'
  /** Attachments: to_value is the file name. */
  | 'attached'
  | 'detached'
  /** Archived (hidden from every list) / restored. */
  | 'archived'
  | 'restored';

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
  /** An uploaded home-screen icon (PNG) is in use (otherwise the built-in one). */
  customIcon: boolean;
  /** Cache-buster for /icons/<size>.png. */
  iconVersion: string;
}

/** Home-screen icon sizes: iPhone (180) and Android / install prompts (192, 512). */
export const ICON_SIZES = [180, 192, 512] as const;

export interface Bootstrap {
  me: User;
  users: User[];
  projects: Project[];
  today: string;
  tz: string;
  version: number;
  directoryVersion: number;
  settings: AppSettings;
  /** Attachments are available on this instance (it has an R2 bucket). */
  attachments: boolean;
  /** Admins: the Gmail address invites are emailed from, or null when not connected (then they share the link). */
  gmail: { email: string } | null;
}

/** A webhook as admins see it (Settings → Webhooks; worker/webhooks.ts). */
export interface WebhookInfo {
  id: string;
  name: string;
  /** The secret address other services POST to. */
  url: string;
  /** Paused webhooks log requests but make no tasks. */
  active: boolean;
  /** null = capturing samples (no tasks yet). */
  mapping: import('./webhook').Mapping | null;
  /** Tasks are made as this admin (whoever last saved the mapping). */
  createdBy: string;
  createdAt: string;
  lastReceivedAt: string | null;
}

export interface WebhookRequestInfo {
  id: string;
  receivedAt: string;
  method: string;
  contentType: string | null;
  request: import('./webhook').HookRequestView;
  size: number;
  result: 'captured' | 'created' | 'skipped' | 'duplicate' | 'error' | 'paused';
  detail: string | null;
  taskId: string | null;
}

/** What happened to the invite emails when people were added (worker/gmail.ts). */
export interface InviteEmailResult {
  status: 'sent' | 'not_connected' | 'failed';
  sent: string[];
  failed: string[];
  reason?: string;
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
export const COMMENT_MAX = 4000;
export const CHECK_TEXT_MAX = 300;
export const CHECK_ITEMS_MAX = 100;

export interface ChecklistItem { id: string; text: string; done: boolean }

export const ATTACH_MAX_BYTES = 25 * 1024 * 1024;
export const ATTACH_PER_TASK_MAX = 50;
export interface AttachmentInfo { id: string; name: string; size: number; type: string; by: string; at: string }
