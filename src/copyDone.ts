// "Copy done": what got done in the days shown, as a Markdown list, with the effort total where projects track it.
import { EFFORT_ORDER, effortFor, effortLabel, effortTotal } from '../shared/effort';
import { PRIORITIES, type Task } from '../shared/types';
import { toast } from './actions';
import type { State } from './store';
import { MONS, parseDate } from '../shared/dates';

/** Keeps Markdown from reading a title's own * _ ` [ ] as formatting. */
const md = (x: string) => x.replace(/([\\`*_[\]])/g, '\\$1');

/** "Nov 5". */
const shortDay = (d: string) => { const x = parseDate(d); return `${MONS[x.getMonth()]} ${x.getDate()}`; };
/** "Jordan Lee" → "JL". */
export const initials = (name: string) => name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

/** Effort of these tasks, each counted the way its own project measures it: "6h 15m", or "6h 15m · 13 pts" when mixed. */
export function effortSummary(s: State, tasks: Task[]): string {
  return EFFORT_ORDER.map((type) => effortTotal(type, tasks.filter((t) => s.projects[t.projectId]?.effort === type).map((t) => t.effort)))
    .filter(Boolean).join(' · ');
}

/**
 * Copies the tasks in `tasks` that were done between `from` and `to` (by the day they were done), as one list.
 * Each task says the day it was done (unless it's a single day) and, with `who` (views of several people or a project),
 * the initials of whoever ticked it. `project`: say which project.
 */
export async function copyDone(s: State, o: { title: string; span: string; tasks: Task[]; from: string; to: string; who: boolean; project: boolean }) {
  const done = o.tasks.filter((t) => t.status === 'done' && t.doneOn && t.doneOn >= o.from && t.doneOn <= o.to);
  if (!done.length) { toast('Nothing was done in these days yet.', undefined, true); return; }
  const oneDay = o.from === o.to;
  // Oldest first, by the day it was done, then priority.
  const list = done.sort((a, b) => a.doneOn!.localeCompare(b.doneOn!) || a.priority - b.priority || (a.doneAt ?? '').localeCompare(b.doneAt ?? ''));
  const total = effortSummary(s, list);
  const lines = [`${md(o.title)}: done, ${o.span}`, '', ...(total ? [`**Total effort: ${total}**`, ''] : [])];
  for (const t of list) {
    const p = s.projects[t.projectId];
    const eff = p?.effort ? effortFor(t.effort, p.effort) : null;
    const by = s.users[t.doneBy ?? t.assigneeId];
    const meta = [
      oneDay ? '' : shortDay(t.doneOn!),
      o.who && by ? initials(by.name || by.email) : '',
      o.project && p ? p.name : '',
      p?.effort && eff ? effortLabel(p.effort, eff) : '',
    ].filter(Boolean);
    const prio = t.priority < 3 ? ` (${PRIORITIES[t.priority].name})` : '';
    lines.push(`- ${md(t.title)}${prio}${meta.length ? ` — ${meta.map(md).join(' · ')}` : ''}`);
  }
  try {
    await navigator.clipboard.writeText(lines.join('\n') + '\n');
    toast(`Copied ${done.length} done task${done.length === 1 ? '' : 's'} as Markdown`);
  } catch {
    toast('Copy failed. Your browser blocked the clipboard.', undefined, true);
  }
}
