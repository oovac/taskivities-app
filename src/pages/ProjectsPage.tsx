import { useEffect } from 'react';
import { DOW, addDays, fmt, parseDate } from '../../shared/dates';
import { isAdmin, isLate } from '../../shared/rules';
import { PRIORITIES, type Task } from '../../shared/types';
import { ensureRange, loadArchived, openPop, restoreTask, toast } from '../actions';
import { QuickAdd } from '../components/QuickAdd';
import { TaskRow } from '../components/rows';
import { I, ProjBadge } from '../components/ui';
import { set, useStore, type State } from '../store';
import { displayName, shownOn, byPrioThenOldest, inRange, previewsWhere, weekInfo } from '../util';
import { Day, ViewSeg, WeekBoard, WeekControls } from './TasksPage';

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
  const mode = s.view; // Today (this page's day report) · Week · Board, shared with people's views
  const w = weekInfo(s);
  useEffect(() => { if (mode === 'today') void ensureRange(day, day); else void ensureRange(w.ws, w.we); }, [mode, day, w.ws, w.we]);
  // New tasks from here go in this project (you can still pick another).
  useEffect(() => { if (pid !== 'all') set((st) => ({ draft: { ...st.draft, projectId: pid } })); }, [pid]);

  const { done, open } = projectDayData(s, pid, day);
  const name = all ? (isAdmin(s.me!) ? 'All projects' : 'All my projects') : project!.name;
  const inP = (t: Task) => (all ? !!s.projects[t.projectId] : t.projectId === pid);
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
            <span className="sub">{mode === 'today' ? <>{done.length} done{open.length > 0 && ` · ${open.length} not finished`}</> : <WeekSub s={s} w={w} inP={inP} />}</span>
          </span>
        </button>
        <div className="weeknav">
          <ViewSeg s={s} />
          {mode !== 'today' ? <WeekControls s={s} w={w} /> : <>
          <button className="icon-btn" data-act="pday" data-dir="-1" title="Previous day  [" aria-label="Previous day" onClick={() => goDay(-1)}>{I.left()}</button>
          <div className="wk">
            <b>{day === s.today ? 'Today' : day === addDays(s.today, -1) ? 'Yesterday' : DOW[parseDate(day).getDay()]}</b>
            <span>{fmt(day)}</span>
          </div>
          <button className="icon-btn" data-act="pday" data-dir="1" title="Next day  ]" aria-label="Next day" disabled={day >= s.today} onClick={() => goDay(1)}>{I.right()}</button>
          <button className="btn-ghost" data-act="pday" data-dir="0" disabled={day === s.today} onClick={() => goDay(0)}>Today</button>
          <button className="btn-ghost" data-act="copy-day" disabled={!done.length} title="Copy a plain-text summary for chat or email" onClick={() => void copy()}>Copy summary</button>
          </>}
        </div>
      </div>
      {mode !== 'today' && <QuickAdd />}
      {mode === 'list' && <ProjectWeek s={s} w={w} pid={pid} name={name} inP={inP} all={all} />}
      {mode === 'board' && (
        <WeekBoard s={s} w={w} pool={Object.values(s.tasks).filter(inP)} side="by" hideProject={!all}
          previews={previewsWhere(s, inP, w.ws, w.we)} />
      )}
      {mode === 'today' && <>
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
      </>}
      <ArchivedSection s={s} pid={pid} all={all} />
    </>
  );
}

/** "12 open this week · 3 carried over" for a project's week and board. */
function WeekSub({ s, w, inP }: { s: State; w: ReturnType<typeof weekInfo>; inP: (t: Task) => boolean }) {
  const tasks = Object.values(s.tasks).filter(inP);
  const openN = tasks.filter((t) => t.status === 'open' && inRange(shownOn(t, s.today), w.ws, w.we)).length;
  const late = tasks.filter((t) => isLate(t, s.today)).length;
  return <>{openN} open {s.weekOffset === 0 ? 'this week' : 'that week'}{s.weekOffset === 0 && late > 0 && <> · <span className="lt">{late} carried over</span></>}</>;
}

/** A project's week: every day, everyone's tasks in it (each row says whose it is). */
function ProjectWeek({ s, w, pid, name, inP, all }: {
  s: State; w: ReturnType<typeof weekInfo>; pid: string; name: string; inP: (t: Task) => boolean; all: boolean;
}) {
  const pool = Object.values(s.tasks).filter(inP);
  const carried = pool.filter((t) => isLate(t, s.today)).sort(byPrioThenOldest);
  const previews = previewsWhere(s, inP, w.ws, w.we);
  const openN = pool.filter((t) => t.status === 'open' && inRange(shownOn(t, s.today), w.ws, w.we)).length;
  return (
    <section className="sec">
      <div className="sec-h"><h2>{name}</h2><span className="cnt">{openN} open this week · everyone's tasks</span></div>
      {w.days.map((d) => (
        <Day key={d} s={s} d={d} k={`p:${pid}`} pool={pool} carried={carried} TD={false} ctx="proj" showProject={all}
          previews={previews.filter((x) => x.date === d)} />
      ))}
    </section>
  );
}

/** Archived tasks of this project: collapsed by default; each can be restored (it reappears where it was). */
function ArchivedSection({ s, pid, all }: { s: State; pid: string; all: boolean }) {
  useEffect(() => { void loadArchived(pid); }, [pid]);
  const list = s.archived?.project === pid ? s.archived.tasks : null;
  if (!list?.length) return null;
  return (
    <section className="sec">
      <button className="collapsed" data-act="proj-archived" aria-expanded={s.archOpen} onClick={() => set({ archOpen: !s.archOpen })}>
        <span className="dn">Archived</span> hidden from every list
        <span className="sum">{list.length} task{list.length > 1 ? 's' : ''} {!s.archOpen && I.chev()}</span>
      </button>
      {s.archOpen && (
        <div className="card arch-list" style={{ marginTop: 8 }}>
          {list.map((t) => (
            <div key={t.id} className="arch-row">
              <span className={`st ${t.status === 'done' ? 'ok' : 'inv'}`}>{t.status === 'done' ? 'Done' : 'Open'}</span>
              <div className="arch-main">
                <b className={t.status === 'done' ? 'dn' : ''}>{t.title}</b>
                <span>
                  {all && <>{s.projects[t.projectId]?.name} · </>}
                  {displayName(s.users[t.assigneeId])} · due {fmt(t.dueDate)} · archived by {displayName(s.users[t.archivedBy ?? ''])}, {fmt(t.archivedAt!.slice(0, 10))}
                </span>
              </div>
              <button className="btn-ghost sm" data-act="restore" onClick={() => void restoreTask(t.id)}>Restore</button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
