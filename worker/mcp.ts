// Remote MCP server (Streamable HTTP at /mcp). Each connected assistant acts as the person who approved it
// on /authorize: same visibility, same rules (worker/tasks.ts), and every write is logged with `via` set.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import { z } from 'zod';
import { diffDays, isDate } from '../shared/dates';
import { isLate, shownOn } from '../shared/rules';
import { describe as describeRepeat } from '../shared/repeat';
import { DESCRIPTION_MAX, PRIORITIES, TITLE_MAX, type Priority, type Project, type Task, type User } from '../shared/types';
import {
  type Env, type ProjectRow, type TaskRow, type UserRow, type Viewer,
  HttpError, TASK_COLS, bad, canSeeProject, loadViewer, mapProject, mapTask, mapUser, today,
} from './lib';
import type { McpProps } from './oauth';
import { createTask, loadVisibleTask, updateTask, updateTaskWithNext, visible } from './tasks';

const PRIORITY_NAMES = ['urgent', 'high', 'normal', 'low'] as const;
type PriorityName = (typeof PRIORITY_NAMES)[number];
const toPriority = (p: PriorityName) => (PRIORITY_NAMES.indexOf(p) + 1) as Priority;
const priorityName = (p: Priority) => PRIORITIES[p].name.toLowerCase();

const MAX_RANGE_DAYS = 92;
const MAX_RESULTS = 300;

/** Everything the viewer may see about people and projects, for name lookups and readable output. */
interface Directory {
  projects: Project[];
  users: Map<string, User>;
  /** project id → ids of people who can be assigned there (its members plus every admin). */
  assignable: Map<string, string[]>;
}

async function loadDirectory(db: D1Database, v: Viewer): Promise<Directory> {
  const [users, members, projects] = await Promise.all([
    db.prepare("SELECT * FROM users WHERE status != 'removed' ORDER BY name").all<UserRow>(),
    db.prepare('SELECT user_id, project_id FROM project_members').all<{ user_id: string; project_id: string }>(),
    db.prepare('SELECT * FROM projects WHERE archived = 0 ORDER BY name').all<ProjectRow>(),
  ]);
  const visibleProjects = projects.results.filter((p) => canSeeProject(v, p.id)).map(mapProject);
  const visibleIds = new Set(visibleProjects.map((p) => p.id));
  const byUser = new Map<string, string[]>();
  for (const m of members.results) {
    if (!visibleIds.has(m.project_id)) continue; // members only learn about projects they can see
    byUser.set(m.user_id, [...(byUser.get(m.user_id) ?? []), m.project_id]);
  }
  const all = users.results.map((u) => mapUser(u, byUser.get(u.id) ?? []));
  const admins = all.filter((u) => u.role === 'admin').map((u) => u.id);
  const assignable = new Map<string, string[]>();
  for (const p of visibleProjects) {
    assignable.set(p.id, [...new Set([...all.filter((u) => u.projects.includes(p.id)).map((u) => u.id), ...admins])]);
  }
  return { projects: visibleProjects, users: new Map(all.map((u) => [u.id, u])), assignable };
}

const norm = (s: string) => s.trim().toLowerCase();

function findProject(dir: Directory, input: string): Project {
  const q = norm(input);
  const exact = dir.projects.filter((p) => p.id === input || norm(p.name) === q);
  const hits = exact.length ? exact : dir.projects.filter((p) => norm(p.name).includes(q));
  if (hits.length === 1) return hits[0];
  const names = dir.projects.map((p) => `"${p.name}"`).join(', ');
  if (!hits.length) throw bad(`No project matches "${input}". Your projects: ${names || 'none'}.`);
  throw bad(`"${input}" matches several projects: ${hits.map((p) => `"${p.name}"`).join(', ')}. Use the full name.`);
}

function findUser(dir: Directory, v: Viewer, input: string): User {
  const q = norm(input);
  if (q === 'me' || q === 'myself') return dir.users.get(v.id)!;
  const people = [...dir.users.values()];
  const first = (u: User) => norm(u.name).split(/\s+/)[0];
  const tiers = [
    people.filter((u) => u.id === input || norm(u.email) === q || norm(u.name) === q),
    people.filter((u) => first(u) === q),
    people.filter((u) => norm(u.name).includes(q) || norm(u.email).startsWith(q)),
  ];
  for (const hits of tiers) {
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw bad(`"${input}" matches several people: ${hits.map((u) => `${u.name} <${u.email}>`).join(', ')}. Use their email.`);
  }
  throw bad(`No one called "${input}" is on Taskivities. Use list_projects to see who is on each project.`);
}

const userLabel = (dir: Directory, id: string | null) => (id ? (dir.users.get(id)?.name ?? 'Former member') : null);

function describeTask(t: Task, dir: Directory, t0: string) {
  return {
    id: t.id,
    title: t.title,
    project: dir.projects.find((p) => p.id === t.projectId)?.name ?? t.projectId,
    assignee: userLabel(dir, t.assigneeId),
    priority: priorityName(t.priority),
    status: t.status,
    due_date: t.dueDate,
    /** The day the app shows it on (overdue open tasks roll into today). */
    shown_on: shownOn(t, t0),
    ...(isLate(t, t0) ? { days_late: diffDays(t0, t.dueDate) } : {}),
    ...(t.status === 'done' ? { done_on: t.doneOn, done_by: userLabel(dir, t.doneBy) } : {}),
    ...(t.notes ? { notes: t.notes } : {}),
    ...(t.series?.active ? { repeats: describeRepeat(t.series.rule, t.series.anchor) } : {}),
  };
}

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
const fail = (message: string) => ({ isError: true, content: [{ type: 'text' as const, text: message }] });

const dateArg = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

/** Repeat rule as assistants send it (snake_case), mapped to shared/repeat.ts. */
const repeatArg = z.object({
  freq: z.enum(['day', 'week', 'month', 'year']),
  every: z.number().int().min(1).max(99).optional().describe('Every N days/weeks/months/years. Default 1.'),
  days: z.array(z.number().int().min(0).max(6)).optional().describe('Weekly: weekdays, 0 = Sunday … 6 = Saturday. Default: the weekday of due_date. Every weekday = [1,2,3,4,5].'),
  month_by: z.enum(['date', 'weekday']).optional().describe('Monthly: "date" = same day of the month as due_date (the 15th); "weekday" = same position (the 2nd Tuesday; a 5th weekday means "last").'),
  after_done: z.boolean().optional().describe('Count the next date from when it was finished ("7 days after done") instead of a fixed schedule.'),
  until: dateArg.optional().describe('Last possible date.'),
  count: z.number().int().min(1).max(1000).optional().describe('Total number of copies.'),
}).describe(
  'Makes this a repeating task. Only one copy is open at a time: finishing it creates the next one on the next scheduled date (never in the past). ' +
  'Missed dates are not piled up: an unfinished copy rolls over like any task. The schedule counts from due_date.',
);
const toRepeat = (r: z.infer<typeof repeatArg>) => ({
  freq: r.freq, every: r.every ?? 1, days: r.days, monthBy: r.month_by, afterDone: r.after_done, until: r.until, count: r.count,
});

export class TaskivitiesMCP extends McpAgent<Env, unknown, McpProps> {
  server = new McpServer({ name: 'Taskivities', version: '0.1.0' });

  /** "via …" in task history. */
  private get via() {
    return this.props?.clientName || 'AI assistant';
  }

  /** The person this assistant acts for, loaded fresh on every call so access changes apply at once. */
  private async viewer(): Promise<Viewer> {
    const v = this.props?.userId ? await loadViewer(this.env, this.props.userId) : null;
    if (!v) throw new HttpError(401, 'Your Taskivities access has ended. Reconnect, or ask an admin to add you back.');
    return v;
  }

  /** Runs a tool body, turning rule violations into readable tool errors. */
  private async run<T>(fn: (v: Viewer, dir: Directory, t0: string) => Promise<T>) {
    try {
      const v = await this.viewer();
      const dir = await loadDirectory(this.env.DB, v);
      return json(await fn(v, dir, today(v)));
    } catch (e) {
      if (e instanceof HttpError) return fail(e.message);
      console.error(e);
      return fail('Something went wrong. Please try again.');
    }
  }

  async init() {
    let t0 = '';
    let zone = '';
    // Project descriptions say what belongs where; folding them into create_task lets the assistant pick
    // the right project without a list_projects call. Snapshot at connect time; list_projects is always current.
    let projectGuide = '';
    try {
      const v = await this.viewer();
      t0 = today(v);
      zone = v.tz;
      const dir = await loadDirectory(this.env.DB, v);
      projectGuide = dir.projects
        .map((p) => `- ${p.name}: ${p.description.slice(0, DESCRIPTION_MAX).replace(/\s+/g, ' ').trim() || '(no description)'}`)
        .join('\n');
    } catch {
      // No access: the tools themselves will say so.
    }

    this.server.registerTool(
      'list_projects',
      {
        title: 'List projects',
        description:
          'Projects you can see, with their descriptions (what belongs in each project and how tasks are named), colors, ' +
          'and the people who can be assigned tasks there. Read the descriptions to decide which project a task belongs in. ' +
          "Also returns today's date and your time zone (all dates are in your time zone).",
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      () =>
        this.run(async (v, dir, today) => ({
          today,
          time_zone: v.tz,
          you: { name: dir.users.get(v.id)?.name, email: v.email, role: v.role },
          projects: dir.projects.map((p) => ({
            name: p.name,
            description: p.description,
            color: p.color,
            members: (dir.assignable.get(p.id) ?? []).map((id) => {
              const u = dir.users.get(id)!;
              return { name: u.name, email: u.email, ...(u.role === 'admin' ? { role: 'admin' } : {}), ...(u.status === 'invited' ? { status: 'invited' } : {}) };
            }),
          })),
        })),
    );

    this.server.registerTool(
      'list_tasks',
      {
        title: 'List tasks',
        description:
          'Tasks in your projects, grouped by the day the app shows them on. Rollover works as in the app: an open task ' +
          "whose due date has passed is shown on today (with days_late), and a task finished late is shown on the day it was finished. " +
          'So "what is on today" includes carried-over tasks. Dates are YYYY-MM-DD in your time zone; from defaults to today and to defaults to from ' +
          `(at most ${MAX_RANGE_DAYS} days).`,
        inputSchema: {
          user: z.string().optional().describe('Only tasks assigned to this person: name, first name, email, or "me".'),
          project: z.string().optional().describe('Only tasks in this project (name).'),
          from: dateArg.optional().describe('First day, YYYY-MM-DD. Default: today.'),
          to: dateArg.optional().describe('Last day, YYYY-MM-DD. Default: same as from.'),
          status: z.enum(['open', 'done', 'all']).optional().describe('Default: all.'),
        },
        annotations: { readOnlyHint: true },
      },
      (args) =>
        this.run(async (v, dir, t0) => {
          const from = args.from ?? t0;
          const to = args.to ?? from;
          if (!isDate(from) || !isDate(to)) throw bad('Dates must be real days in YYYY-MM-DD form.');
          if (to < from) throw bad('"to" must be on or after "from".');
          if (diffDays(to, from) >= MAX_RANGE_DAYS) throw bad(`Ask for at most ${MAX_RANGE_DAYS} days at a time.`);
          const vis = visible(v);
          const where = [`(status = 'open' OR due_date BETWEEN ? AND ? OR done_on BETWEEN ? AND ?)`, vis.sql];
          const binds: unknown[] = [from, to, from, to, ...vis.binds];
          if (args.user) { where.push('assignee_id = ?'); binds.push(findUser(dir, v, args.user).id); }
          if (args.project) { where.push('project_id = ?'); binds.push(findProject(dir, args.project).id); }
          if (args.status && args.status !== 'all') { where.push('status = ?'); binds.push(args.status); }
          const { results } = await this.env.DB
            .prepare(`SELECT ${TASK_COLS} FROM tasks WHERE ${where.join(' AND ')}`)
            .bind(...binds)
            .all<TaskRow>();
          const tasks = results
            .map(mapTask)
            .filter((t) => { const d = shownOn(t, t0); return d >= from && d <= to; })
            .sort((a, b) => shownOn(a, t0).localeCompare(shownOn(b, t0)) || a.priority - b.priority || a.dueDate.localeCompare(b.dueDate));
          return {
            today: t0, from, to,
            count: tasks.length,
            ...(tasks.length > MAX_RESULTS ? { truncated: true, note: `Showing the first ${MAX_RESULTS}; narrow the range or filters.` } : {}),
            tasks: tasks.slice(0, MAX_RESULTS).map((t) => describeTask(t, dir, t0)),
          };
        }),
    );

    this.server.registerTool(
      'create_task',
      {
        title: 'Create a task',
        description:
          `Create a task as the signed-in person. All five fields are required: title, project, due_date, assignee and priority. ` +
          `The assignee must be on the project (see list_projects), and the due date can't be in the past (today is ${t0} in ${zone} as of connecting). ` +
          `Use "normal" priority unless the person says otherwise. Titles are at most ${TITLE_MAX} characters.\n\n` +
          `Pick the project from these descriptions (what belongs where, and how tasks are named):\n${projectGuide || '- (call list_projects)'}`,
        inputSchema: {
          title: z.string().min(1).max(TITLE_MAX),
          project: z.string().describe('Project name.'),
          due_date: dateArg.describe('YYYY-MM-DD, today or later.'),
          assignee: z.string().describe('Name, first name, email, or "me".'),
          priority: z.enum(PRIORITY_NAMES).describe('urgent: drop everything · high: do first · normal: the default · low: when there is time.'),
          notes: z.string().optional().describe('Optional details.'),
          repeat: repeatArg.optional(),
        },
      },
      (args) =>
        this.run(async (v, dir, t0) => {
          const project = findProject(dir, args.project);
          const assignee = findUser(dir, v, args.assignee);
          const task = await createTask(this.env, v, {
            title: args.title, notes: args.notes, projectId: project.id, assigneeId: assignee.id,
            dueDate: args.due_date, priority: toPriority(args.priority), repeat: args.repeat ? toRepeat(args.repeat) : undefined,
          }, this.via);
          return { created: describeTask(task, dir, t0) };
        }),
    );

    this.server.registerTool(
      'update_task',
      {
        title: 'Update a task',
        description:
          'Change a task: title, notes, project, due date, priority, or status (use "open" to reopen a finished task). ' +
          "Only the fields you pass change. Due dates can't move into the past, and if the project changes the assignee must be on the new one. " +
          'Use transfer_task to change who it is assigned to, and complete_task to finish it. Every change is recorded in the task history.\n\n' +
          'Repeating tasks (those with "repeats"): edits to the open copy carry over to future copies. Pass repeat to change the rule, ' +
          'stop_repeating to stop for good, or skip to skip this copy (its date moves to the next scheduled one). ' +
          "A task that doesn't repeat can't be made repeating: repeating is set in create_task.",
        inputSchema: {
          id: z.string().describe('Task id from list_tasks.'),
          title: z.string().min(1).max(TITLE_MAX).optional(),
          notes: z.string().optional().describe('Replaces the notes. Pass "" to clear them.'),
          project: z.string().optional().describe('Project name.'),
          due_date: dateArg.optional(),
          priority: z.enum(PRIORITY_NAMES).optional(),
          status: z.enum(['open', 'done']).optional(),
          repeat: repeatArg.optional().describe('Repeating tasks only: the new rule.'),
          stop_repeating: z.boolean().optional().describe("Stop repeating for good. The current copy stays as a normal task. Can't be undone."),
          skip: z.boolean().optional().describe('Repeating tasks: skip this copy. Pass on its own.'),
        },
      },
      (args) =>
        this.run(async (v, dir, t0) => {
          if (args.repeat && args.stop_repeating) throw bad('Pass repeat or stop_repeating, not both.');
          const { task, next } = await updateTaskWithNext(this.env, v, args.id, {
            title: args.title,
            notes: args.notes,
            projectId: args.project !== undefined ? findProject(dir, args.project).id : undefined,
            dueDate: args.due_date,
            priority: args.priority ? toPriority(args.priority) : undefined,
            status: args.status,
            repeat: args.stop_repeating ? null : args.repeat ? toRepeat(args.repeat) : undefined,
            skip: args.skip,
          }, this.via);
          return { updated: describeTask(task, dir, t0), ...(next ? { next_copy: describeTask(next, dir, t0) } : {}) };
        }),
    );

    this.server.registerTool(
      'complete_task',
      {
        title: 'Complete a task',
        description: 'Mark a task as done (today, in your time zone). For a repeating task this also creates the next copy, returned as next_copy.',
        inputSchema: { id: z.string().describe('Task id from list_tasks.') },
        annotations: { idempotentHint: true },
      },
      (args) =>
        this.run(async (v, dir, t0) => {
          const { task, next } = await updateTaskWithNext(this.env, v, args.id, { status: 'done' }, this.via);
          return { completed: describeTask(task, dir, t0), ...(next ? { next_copy: describeTask(next, dir, t0) } : {}) };
        }),
    );

    this.server.registerTool(
      'transfer_task',
      {
        title: 'Transfer a task',
        description: "Assign a task to someone else, optionally with a short note they'll see in its history. The new assignee must be on the task's project.",
        inputSchema: {
          id: z.string().describe('Task id from list_tasks.'),
          to: z.string().describe('Name, first name, email, or "me".'),
          note: z.string().max(500).optional(),
          this_only: z.boolean().optional().describe('Repeating tasks: transfer only this copy; future copies stay with the current person.'),
        },
      },
      (args) =>
        this.run(async (v, dir, t0) => {
          await loadVisibleTask(this.env.DB, v, args.id); // "not found" before "who?"
          const to = findUser(dir, v, args.to);
          const task = await updateTask(this.env, v, args.id, { assigneeId: to.id, note: args.note, thisOnly: args.this_only }, this.via);
          return { transferred: describeTask(task, dir, t0) };
        }),
    );

    this.server.registerTool(
      'project_day',
      {
        title: 'What got done in a project on a day',
        description:
          'Tasks finished in one project on one day, by priority, then due date. Good for "what got done on Acme yesterday?" ' +
          'Also lists what is still open for that day.',
        inputSchema: {
          project: z.string().describe('Project name.'),
          date: dateArg.describe('YYYY-MM-DD.'),
        },
        annotations: { readOnlyHint: true },
      },
      (args) =>
        this.run(async (_v, dir, t0) => {
          const project = findProject(dir, args.project);
          if (!isDate(args.date)) throw bad('Use a real day in YYYY-MM-DD form.');
          const day = args.date;
          const { results } = await this.env.DB
            .prepare(`SELECT ${TASK_COLS} FROM tasks WHERE project_id = ? AND (done_on = ? OR (status = 'open' AND due_date <= ?))`)
            .bind(project.id, day, day)
            .all<TaskRow>();
          const tasks = results.map(mapTask);
          const done = tasks
            .filter((t) => t.status === 'done' && t.doneOn === day)
            .sort((a, b) => a.priority - b.priority || a.dueDate.localeCompare(b.dueDate) || (a.doneAt ?? '').localeCompare(b.doneAt ?? ''));
          // Same rule as the Projects page: on today, open includes carried-over tasks; other days, only tasks due that day.
          const open = tasks
            .filter((t) => t.status === 'open' && (day === t0 ? shownOn(t, t0) === t0 : t.dueDate === day))
            .sort((a, b) => a.priority - b.priority || a.dueDate.localeCompare(b.dueDate));
          return {
            project: project.name,
            date: day,
            done: done.map((t) => describeTask(t, dir, t0)),
            still_open: open.map((t) => describeTask(t, dir, t0)),
          };
        }),
    );
  }
}
