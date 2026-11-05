import { useEffect } from 'react';
import { DOW, addDays, fmt, parseDate } from '../../shared/dates';
import { isAdmin } from '../../shared/rules';
import { PRIORITIES, type Task } from '../../shared/types';
import { ensureRange, openPop, toast } from '../actions';
import { TaskRow } from '../components/rows';
import { I, ProjBadge } from '../components/ui';
import { set, useStore, type State } from '../store';
import { displayName, shownOn, byPrioThenOldest } from '../util';

export function projectDayData(s: State, pid: string, day: string) {
  const inP = (t: Task) => (pid === 'all' ? !!s.projects[t.projectId] : t.projectId === pid);
  const all = Object.values(s.tasks);
  // Finished that day, by priority, then due date, then finish time.
  const done = all
    .filter((t) => inP(t) && t.status === 'done' && t.doneOn === day)
    .sort((a, b) => a.priority - b.priority || a.dueDate.localeCompare(b.dueDate) || (a.doneAt || '').localeCompare(b.doneAt || ''));
  const open = all
    .filter((t) => inP(t) && t.status === 'open' && (day === s.today ? shownOn(t, s.today) === s.today : t.dueDate === day))
    .sort(byPrioThenOldest);
  return { done, open };
}

export function ProjectsPage() {
  const s = useStore();
  const pid = s.projSel !== 'all' && s.projects[s.projSel] ? s.projSel : 'all';
  const day = s.projDay || s.today;
  const all = pid === 'all';
  const project = all ? null : s.projects[pid];
  useEffect(() => { void ensureRange(day, day); }, [day]);

  const { done, open } = projectDayData(s, pid, day);
  const name = all ? (isAdmin(s.me!) ? 'All projects' : 'All my projects') : project!.name;
  const goDay = (n: number) => set({ projDay: n === 0 ? s.today : addDays(day, n) > s.today ? s.today : addDays(day, n) });

  const copy = async () => {
    const lines = [
      `${name}: done on ${fmt(day)} (${done.length})`,
      ...done.map((t) => `• ${t.priority !== 3 ? `[${PRIORITIES[t.priority].name}] ` : ''}${t.title}: ${displayName(s.users[t.assigneeId])}${all ? ` (${s.projects[t.projectId]?.name})` : ''}`),
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      toast(`Copied ${done.length} tasks as text`);
    } catch {
      toast('Copy failed. Select and copy manually.', undefined, true);
    }
  };

  return (
    <>
      <div className="phead">
        <button className="who" data-act="proj-pick" title={project?.description || undefined} onClick={(e) => openPop({ type: 'projpick' }, e.currentTarget)}>
          <ProjBadge project={project ?? 'all'} />
          <span>
            <span className="h1">{name} {I.chev()}</span>
            <span className="sub">{done.length} done{open.length > 0 && ` · ${open.length} not finished`}</span>
          </span>
        </button>
        <div className="weeknav">
          <button className="icon-btn" data-act="pday" data-dir="-1" title="Previous day  [" aria-label="Previous day" onClick={() => goDay(-1)}>{I.left()}</button>
          <div className="wk">
            <b>{day === s.today ? 'Today' : day === addDays(s.today, -1) ? 'Yesterday' : DOW[parseDate(day).getDay()]}</b>
            <span>{fmt(day)}</span>
          </div>
          <button className="icon-btn" data-act="pday" data-dir="1" title="Next day  ]" aria-label="Next day" disabled={day >= s.today} onClick={() => goDay(1)}>{I.right()}</button>
          <button className="btn-ghost" data-act="pday" data-dir="0" disabled={day === s.today} onClick={() => goDay(0)}>Today</button>
          <button className="btn-ghost" data-act="copy-day" disabled={!done.length} title="Copy a plain-text summary for chat or email" onClick={() => void copy()}>Copy summary</button>
        </div>
      </div>
      <section className="sec">
        <div className="sec-h"><h2>Done</h2><span className="cnt">by priority, then due date</span></div>
        {done.length
          ? <div className="card">{done.map((t) => <TaskRow key={t.id} t={t} ctx={all ? 'pdone-all' : 'pdone'} />)}</div>
          : <div className="empty-sec">Nothing was finished in {name} {day === s.today ? 'yet today' : `on ${fmt(day)}`}.</div>}
      </section>
      {open.length > 0 && (
        <section className="sec">
          <button className="collapsed" data-act="proj-open" data-nav="popen" tabIndex={-1} aria-expanded={s.projOpen} onClick={() => set({ projOpen: !s.projOpen })}>
            <span className="dn">Not finished</span> {day === s.today ? 'planned for today' : 'planned for this day'}
            <span className="sum">{open.length} task{open.length > 1 ? 's' : ''} {!s.projOpen && I.chev()}</span>
          </button>
          {s.projOpen && <div className="card" style={{ marginTop: 8 }}>{open.map((t) => <TaskRow key={t.id} t={t} ctx="popen" />)}</div>}
        </section>
      )}
    </>
  );
}
