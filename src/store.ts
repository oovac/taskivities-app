import { create } from 'zustand';
import type { AppSettings, Priority, Project, Role, Task, TaskEvent, User } from '../shared/types';
import { NORMAL } from '../shared/types';
import type { Repeat } from '../shared/repeat';

export type Page = 'tasks' | 'projects' | 'team' | 'settings';
export type View = 'today' | 'list' | 'board';
export type PopType = 'move' | 'assign' | 'prio' | 'proj' | 'person' | 'projpick' | 'urole' | 'uproj' | 'uremove' | 'account' | 'repeat';

export interface Pop {
  type: PopType;
  /** task = acting on a task; qa = choosing a value for the quick-add draft; bulk = several tasks */
  mode?: 'task' | 'qa' | 'bulk';
  ids?: string[];
  id?: string;
  userId?: string;
  rect: { l: number; t: number; b: number; r: number };
  /** Where focus goes back to when the menu closes. */
  returnSel: string | null;
  month?: string;
  q?: string;
}

export interface Toast { id: number; text: string; undo?: () => void; error?: boolean }
export interface Draft { title: string; notes: string; open: boolean; projectId: string | null; dueDate: string | null; assigneeId: string | null; priority: Priority; repeat: Repeat | null }
export interface InviteDraft { emails: string; role: Role; projects: string[]; err: string | null; busy?: boolean }
export interface ProjEdit { id: string | null; name: string; color: string; description: string; members: string[]; err: string | null; returnSel: string | null; busy?: boolean }

export interface State {
  ready: boolean;
  bootError: string | null;
  me: User | null;
  users: Record<string, User>;
  projects: Record<string, Project>;
  tasks: Record<string, Task>;
  events: Record<string, TaskEvent[] | undefined>;
  today: string;
  tz: string;
  version: number;
  dirVersion: number;
  settings: AppSettings;
  range: { from: string; to: string } | null;
  lastSync: number;
  offline: boolean;

  page: Page;
  view: View;
  viewUser: string;
  weekOffset: number;
  boardSide: 'to' | 'by';
  drawer: string | null;
  pop: Pop | null;
  toast: Toast | null;
  help: boolean;
  connect: boolean;
  expanded: Record<string, boolean>;
  flash: Record<string, number>;
  draft: Draft;
  invite: InviteDraft | null;
  projEdit: ProjEdit | null;
  projSel: string; // project id or 'all'
  projDay: string;
  projOpen: boolean;
}

const pageFromPath = (): Page => {
  const p = location.pathname;
  return p.startsWith('/projects') ? 'projects' : p.startsWith('/team') ? 'team' : p.startsWith('/settings') ? 'settings' : 'tasks';
};
const savedView = (): View => {
  const v = localStorage.getItem('tv:view');
  return v === 'today' || v === 'board' ? v : 'list';
};

export const emptyDraft = (projectId: string | null = null): Draft => ({
  title: '', notes: '', open: false, projectId, dueDate: null, assigneeId: null, priority: NORMAL, repeat: null,
});

export const useStore = create<State>()(() => ({
  ready: false,
  bootError: null,
  me: null,
  users: {},
  projects: {},
  tasks: {},
  events: {},
  today: '',
  tz: 'UTC',
  version: 0,
  dirVersion: 0,
  settings: { customLogo: false, logoVersion: '0' },
  range: null,
  lastSync: Date.now(),
  offline: false,

  page: pageFromPath(),
  view: savedView(),
  viewUser: '',
  weekOffset: 0,
  boardSide: 'to',
  drawer: null,
  pop: null,
  toast: null,
  help: false,
  connect: false,
  expanded: {},
  flash: {},
  draft: emptyDraft(),
  invite: null,
  projEdit: null,
  projSel: 'all',
  projDay: '',
  projOpen: false,
}));

export const S = () => useStore.getState();
export const set = (p: Partial<State> | ((s: State) => Partial<State>)) => useStore.setState(p);
