import { useEffect, useRef, type CSSProperties, type DragEvent, type ReactNode } from 'react';
import { DOW, MONS, addDays, fmt, parseDate } from '../../shared/dates';
import { isLate, shownOn } from '../../shared/rules';
import type { Task } from '../../shared/types';
import { ensureRange, moveTasks, openPop, setBoardWeeks, setView, viewPerson } from '../actions';
import { QuickAdd } from '../components/QuickAdd';
import { PreviewCard, PreviewRow, TaskCard, TaskRow, drag, openMove } from '../components/rows';
import { Avatar, I } from '../components/ui';
import { BOARD_WEEKS_MAX, set, useStore, type State } from '../store';
import { type Preview, byPrioThenOldest, displayName, firstName, inRange, lateDays, previewsFor, sortRows, weekInfo } from '../util';

export function TasksPage() {
  const s = useStore();
  const w = weekInfo(s);
  const u = s.viewUser || s.me!.id;
  const isMe = u === s.me!.id;
  const person = s.users[u];
  const TD = s.view === 'today';

  useEffect(() => { void ensureRange(w.ws, w.we); }, [w.ws, w.we]);

  const all = Object.values(s.tasks);
  const mine = all.filter((t) => t.assigneeId === u);
  const carried = mine.filter((t) => isLate(t, s.today)).sort(byPrioThenOldest);
  const inScope = (d: string) => (TD ? d === s.today : inRange(d, w.ws, w.we));
  const byTasks = all.filter((t) => (t.createdBy === u || t.assignedBy === u) && t.assigneeId !== u && inScope(shownOn(t, s.today)));
  const openN = mine.filter((t) => t.status === 'open' && inScope(shownOn(t, s.today))).length;
  const previews = TD ? [] : previewsFor(s, u, w.ws, w.we);

  return (
    <>
      {!isMe && (
        <div className="viewing">
          {I.eye()}
          <span className="grow">
            You're viewing <b>{displayName(person)}'s</b> {TD ? 'day' : 'week'}. Your changes are recorded in each task's history under your name.
            {s.me!.role !== 'admin' && <span className="vh">Only projects you share are shown.</span>}
          </span>
          <button onClick={() => viewPerson(s.me!.id)}>Back to my week</button>
        </div>
      )}
      <div className="phead">
        <button className="who" data-act="person" title="Switch to another person or project  (P)" onClick={(e) => openPop({ type: 'person' }, e.currentTarget)}>
          <Avatar user={person} size={40} />
          <span>
            <span className="h1">{isMe ? (TD ? 'My day' : 'My week') : `${firstName(person)}'s ${TD ? 'day' : 'week'}`} {I.chev()}</span>
            <span className="sub">
              {openN} open{TD ? ' today' : ''}
              {s.weekOffset === 0 && carried.length > 0 && <> · <span className="lt">{carried.length} carried over</span></>}
              {' · '}{byTasks.filter((t) => t.status === 'open').length} assigned to others
            </span>
          </span>
        </button>
        <div className="weeknav">
          <ViewSeg s={s} />
          {TD ? <div className="wk"><b>Today</b><span>{fmt(s.today)}</span></div> : <WeekControls s={s} w={w} />}
        </div>
      </div>
      <QuickAdd />
      {s.view === 'board' ? (
        <PersonBoard s={s} u={u} w={w} />
      ) : (
        <>
          <section className="sec">
            <div className="sec-h"><h2>Assigned to {isMe ? 'me' : firstName(person)}</h2><span className="cnt">{openN} open {TD ? 'today' : 'this week'}</span></div>
            {(TD ? [s.today] : w.days).map((d) => <Day key={d} s={s} d={d} k={u} pool={mine} carried={carried} TD={TD} previews={previews.filter((x) => x.date === d)} />)}
            {TD && <Peek s={s} mine={mine} we={w.we} />}
          </section>
          <section className="sec">
            <div className="sec-h"><h2>Assigned by {isMe ? 'me' : firstName(person)}</h2><span className="cnt">to others, {TD ? 'today' : 'this week'}</span></div>
            <AssignedBy s={s} tasks={byTasks} isMe={isMe} who={firstName(person)} TD={TD} />
          </section>
        </>
      )}
    </>
  );
}

/** Today / Week / Board: the same three ways to look at a person or a project (the choice is shared). */
export function ViewSeg({ s }: { s: State }) {
  return (
    <div className="seg" role="group" aria-label="View">
      <button className={s.view === 'today' ? 'on' : ''} data-act="view-mode" data-m="today" onClick={() => setView('today')}>{I.sun()}<span className="sl">Today</span></button>
      <button className={s.view === 'list' ? 'on' : ''} data-act="view-mode" data-m="list" onClick={() => setView('list')}>{I.list()}<span className="sl">Week</span></button>
      <button className={s.view === 'board' ? 'on' : ''} data-act="view-mode" data-m="board" onClick={() => setView('board')}>{I.board()}<span className="sl">Board</span></button>
    </div>
  );
}

/** ← This week → (the label takes you back to this week when you're elsewhere). */
export function WeekControls({ s, w }: { s: State; w: ReturnType<typeof weekInfo> }) {
  return (
    <>
      <button className="icon-btn" data-act="week" data-dir="-1" title="Previous week  [" aria-label="Previous week" onClick={() => set({ weekOffset: s.weekOffset - 1 })}>{I.left()}</button>
      {s.weekOffset === 0 ? (
        <div className="wk"><b>{w.label}</b><span>{w.range}</span></div>
      ) : (
        // Away from this week, the label itself takes you back (no separate button, so the header stays on one row).
        <button className="wk back" data-act="week" data-dir="0" title="Back to this week" aria-label={`${w.label}, ${w.range}. Back to this week`}
          onClick={() => set({ weekOffset: 0 })}><b>{w.label}</b><span>{w.range} · <u>this week</u></span></button>
      )}
      <button className="icon-btn" data-act="week" data-dir="1" title="Next week  ]" aria-label="Next week" onClick={() => set({ weekOffset: s.weekOffset + 1 })}>{I.right()}</button>
    </>
  );
}

/**
 * One day of a week list. `pool`: the tasks in view (a person's, or a project's); `k`: whose (for remembering which
 * past days are opened or folded; past days start folded only in your own week). `ctx`: 'to' for a person, 'proj' for a project (rows then say whose each task is).
 */
export function Day({ s, d, k: who, pool, carried, TD, previews, ctx = 'to', showProject = false }: {
  s: State; d: string; k: string; pool: Task[]; carried: Task[]; TD: boolean; previews: Preview[]; ctx?: 'to' | 'proj'; showProject?: boolean;
}) {
  const mine = pool;
  const rowCtx = ctx;
  const carriedCtx = ctx === 'proj' ? 'proj-carried' : 'carried';
  const dd = parseDate(d);
  const label = `${MONS[dd.getMonth()]} ${dd.getDate()}`;
  if (d < s.today) {
    const done = sortRows(mine.filter((t) => t.status === 'done' && shownOn(t, s.today) === d));
    const ghosts = mine.filter((t) => isLate(t, s.today) && t.dueDate === d);
    const key = `${who}:${d}`;
    // Your own week folds past days away, so it stays clean. Someone else's week, or a project's, is a report of
    // their work: every day starts open, except days with nothing in them. Either way a day you open or fold stays that way.
    const folds = (ctx === 'to' && who === s.me!.id && s.weekOffset >= 0) || (!done.length && !ghosts.length);
    const open = folds ? !!s.expanded[key] : s.expanded[key] !== false;
    const parts = [done.length ? `${done.length} done` : '', ghosts.length ? `${ghosts.length} carried to today` : ''].filter(Boolean);
    const toggle = () => set((st) => ({ expanded: { ...st.expanded, [key]: !open } }));
    if (!open)
      return (
        <div className="day">
          <button className="collapsed" data-act="expand" data-k={key} data-nav={`day:${key}`} tabIndex={-1} aria-expanded="false" onClick={toggle}>
            <span className="dn">{DOW[dd.getDay()]}</span> {label}
            <span className="sum">
              {parts.length ? <>{done.length > 0 && `${done.length} done`}{done.length > 0 && ghosts.length > 0 && ' · '}{ghosts.length > 0 && <span className="c">{ghosts.length} carried to today</span>}</> : 'Nothing recorded'} {I.chev()}
            </span>
          </button>
        </div>
      );
    return (
      <div className="day">
        <div className="day-h">
          <span className="dn">{DOW[dd.getDay()]}</span><span className="dd">{label}</span>
          {s.weekOffset === 0
            ? <button className="dc" data-act="expand" data-k={key} style={{ color: 'var(--accent)' }} onClick={toggle}>Collapse</button>
            : <span className="dc">{parts.join(' · ')}</span>}
        </div>
        {done.length || ghosts.length ? (
          <div className="card">{done.map((t) => <TaskRow key={t.id} t={t} ctx={rowCtx} showProject={showProject} />)}{ghosts.map((t) => <TaskRow key={'g' + t.id} t={t} ctx="ghost" />)}</div>
        ) : <div className="empty-day">Nothing recorded</div>}
      </div>
    );
  }
  const isT = d === s.today;
  const list = sortRows(mine.filter((t) => shownOn(t, s.today) === d && !(isT && isLate(t, s.today))));
  const openN = list.filter((t) => t.status === 'open').length + (isT ? carried.length : 0);
  const carriedBlock = isT && carried.length > 0 && (
    <div className="carried" data-carry>
      <div className="carried-h">
        <b>Carried over · {carried.length}</b>
        <span className="grow"><span className="old">oldest is {Math.max(...carried.map((t) => lateDays(t, s.today)))} days late</span></span>
        <button data-act="move-all" onClick={(e) => openMove(carried.map((t) => t.id), e.currentTarget, 'bulk')}>{I.cal()} Move all</button>
      </div>
      <div className="rows">{carried.map((t) => <TaskRow key={t.id} t={t} ctx={carriedCtx} showProject={showProject} />)}</div>
    </div>
  );
  // A day with nothing on it: one dashed row (like a folded day), which adds a task on that day.
  if (!TD && !carriedBlock && list.length + previews.length === 0)
    return (
      <div className="day">
        <button className={`collapsed empty${isT ? ' today' : ''}`} data-act="add-day" data-d={d} data-nav={`add:${d}`} tabIndex={-1}
          aria-label={`Nothing planned on ${fmt(d)}. Add a task`}
          onClick={() => { set((st) => ({ draft: { ...st.draft, dueDate: d, open: true } })); setTimeout(() => document.getElementById('qa-input')?.focus(), 0); }}>
          <span className="dn">{isT ? 'Today' : DOW[dd.getDay()]}</span> {label}
          <span className="sum">Nothing planned<span className="add">{I.plus(12)} Add</span></span>
        </button>
      </div>
    );
  return (
    <div className="day">
      {!TD && (
        <div className={`day-h ${isT ? 'today' : ''}`}>
          <span className="dn">{isT ? 'Today' : DOW[dd.getDay()]}</span>
          <span className="dd">{isT ? `${DOW[dd.getDay()]}, ` : ''}{label}</span>
          <span className="dc">{openN ? `${openN} open` : ''}</span>
        </div>
      )}
      {carriedBlock}
      {list.length + previews.length > 0
        ? <div className="card">{list.map((t) => <TaskRow key={t.id} t={t} ctx={rowCtx} showProject={showProject} />)}{previews.map((x) => <PreviewRow key={`pv${x.task.id}${x.date}`} t={x.task} date={x.date} />)}</div>
        : !carriedBlock && <div className="empty-day">{TD ? 'Nothing left for today. Nice.' : 'Nothing planned'}</div>}
    </div>
  );
}

function Peek({ s, mine, we }: { s: State; mine: Task[]; we: string }) {
  const later = mine.filter((t) => t.status === 'open' && t.dueDate > s.today && t.dueDate <= we);
  if (!later.length) return <div className="peek quiet">Nothing else planned this week.</div>;
  const per: Record<string, number> = {};
  later.forEach((t) => (per[t.dueDate] = (per[t.dueDate] || 0) + 1));
  const parts = Object.keys(per).sort().map((d) => `${d === addDays(s.today, 1) ? 'Tomorrow' : DOW[parseDate(d).getDay()]} ${per[d]}`);
  return (
    <button className="peek" data-act="view-mode" data-m="list" data-nav="peek" tabIndex={-1} onClick={() => setView('list')}>
      <span>Later this week: <b>{later.length} task{later.length > 1 ? 's' : ''}</b></span>
      <span className="pk-d">{parts.join(' · ')}</span>
      <span className="pk-go">Show week {I.arrowR()}</span>
    </button>
  );
}

function AssignedBy({ s, tasks, isMe, who, TD }: { s: State; tasks: Task[]; isMe: boolean; who: string; TD: boolean }) {
  if (!tasks.length) return <div className="empty-sec">{isMe ? "You haven't" : `${who} hasn't`} assigned anything to others {TD ? 'today' : 'this week'}.</div>;
  const groups: Record<string, Task[]> = {};
  [...tasks]
    .sort((a, b) => shownOn(a, s.today).localeCompare(shownOn(b, s.today)) || (a.status === b.status ? 0 : a.status === 'open' ? -1 : 1) || a.priority - b.priority)
    .forEach((t) => (groups[t.assigneeId] ||= []).push(t));
  return (
    <div className="card">
      {Object.entries(groups).map(([a, list]) => (
        <div key={a}>
          <div className="grp-h">
            <Avatar user={s.users[a]} size={22} /><b>{displayName(s.users[a])}</b>
            <span className="n">{list.filter((t) => t.status === 'open').length} open</span>
            {s.users[a]?.status === 'active' && <button className="link" data-act="view" data-u={a} onClick={() => viewPerson(a)}>View week →</button>}
          </div>
          {list.map((t) => <TaskRow key={t.id} t={t} ctx="by" />)}
        </div>
      ))}
    </div>
  );
}

function PersonBoard({ s, u, w }: { s: State; u: string; w: ReturnType<typeof weekInfo> }) {
  const isMe = u === s.me!.id;
  const side = s.boardSide;
  const all = Object.values(s.tasks);
  const pool = side === 'to' ? all.filter((t) => t.assigneeId === u) : all.filter((t) => (t.createdBy === u || t.assignedBy === u) && t.assigneeId !== u);
  const inWeek = (t: Task) => t.status === 'open' && inRange(shownOn(t, s.today), w.ws, w.we);
  const nTo = all.filter((t) => t.assigneeId === u && inWeek(t)).length;
  const nBy = all.filter((t) => (t.createdBy === u || t.assignedBy === u) && t.assigneeId !== u && inWeek(t)).length;
  const who = isMe ? 'me' : firstName(s.users[u]);
  return (
    <WeekBoard s={s} w={w} pool={pool} side={side} previews={side === 'to' ? previewsFor(s, u, w.ws, w.we) : []}
      bar={
        <div className="seg sm">
          <button className={side === 'to' ? 'on' : ''} data-act="board-side" data-s="to" onClick={() => set({ boardSide: 'to' })}>Assigned to {who} <span>{nTo}</span></button>
          <button className={side === 'by' ? 'on' : ''} data-act="board-side" data-s="by" onClick={() => set({ boardSide: 'by' })}>Assigned by {who} <span>{nBy}</span></button>
        </div>
      } />
  );
}

/**
 * The week as columns, one per day; cards can be dragged to another day. `pool`: the tasks in view.
 * `side`: 'to' shows who a task came from, 'by' shows whose it is (a project's board uses 'by').
 */
export function WeekBoard({ s, w, pool, side, previews, bar, hideProject = false }: {
  s: State; w: ReturnType<typeof weekInfo>; pool: Task[]; side: 'to' | 'by'; previews: Preview[]; bar?: ReactNode; hideProject?: boolean;
}) {
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!drag.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.col.over').forEach((c) => c !== e.currentTarget && c.classList.remove('over'));
    e.currentTarget.classList.add('over');
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) e.currentTarget.classList.remove('over');
  };
  const onDrop = (e: DragEvent<HTMLDivElement>, d: string) => {
    e.preventDefault();
    e.currentTarget.classList.remove('over');
    const id = drag.id;
    drag.id = null;
    const t = id ? s.tasks[id] : null;
    if (t && shownOn(t, s.today) !== d) void moveTasks([t.id], d);
  };
  // More than fits on screen: the board scrolls sideways, and while you drag a card near either edge it scrolls by itself
  // (faster the closer you get), so a card can go to any day shown.
  const boardRef = useRef<HTMLDivElement>(null);
  const edgeScroll = (e: DragEvent<HTMLDivElement>) => {
    const b = boardRef.current;
    if (!drag.id || !b || b.scrollWidth <= b.clientWidth) return;
    const r = b.getBoundingClientRect();
    const EDGE = 90;
    const into = e.clientX < r.left + EDGE ? -(r.left + EDGE - e.clientX) : e.clientX > r.right - EDGE ? e.clientX - (r.right - EDGE) : 0;
    if (into) b.scrollLeft += Math.sign(into) * Math.min(36, 4 + Math.abs(into) / 3);
  };
  // Another week at the end, scrolled into view.
  const moreWeeks = () => {
    const first = addDays(w.ws, 7 * w.weeks);
    setBoardWeeks(w.weeks + 1);
    requestAnimationFrame(() => boardRef.current?.querySelector(`[data-day="${first}"]`)?.scrollIntoView({ inline: 'start', block: 'nearest', behavior: 'smooth' }));
  };
  const more = w.weeks < BOARD_WEEKS_MAX;

  return (
    <>
      <div className="board-bar">
        {bar}
        <span className="hint">Drag a card to another day, or select it and press <kbd>⇧</kbd><kbd>←</kbd> <kbd>⇧</kbd><kbd>→</kbd>. Past days are read-only.</span>
        <div className="bweeks" role="group" aria-label="Weeks shown">
          <button className="icon-btn" data-act="board-weeks" data-dir="-1" disabled={w.weeks <= 1} title="Show one week fewer" aria-label="Show one week fewer"
            onClick={() => setBoardWeeks(w.weeks - 1)}>{I.minus(14)}</button>
          <span aria-live="polite">{w.weeks} week{w.weeks === 1 ? '' : 's'}</span>
          <button className="icon-btn" data-act="board-weeks" data-dir="1" disabled={!more} title="Show one more week" aria-label="Show one more week"
            onClick={moreWeeks}>{I.plus(14)}</button>
        </div>
      </div>
      <div className={`board${w.weeks > 1 ? ' multi' : ''}`} ref={boardRef} style={{ '--days': w.days.length } as CSSProperties} onDragOver={edgeScroll}>
        {w.days.map((d) => {
          const dd = parseDate(d);
          const past = d < s.today;
          const isT = d === s.today;
          const we = dd.getDay() % 6 === 0;
          const carried = isT ? pool.filter((t) => isLate(t, s.today)).sort(byPrioThenOldest) : [];
          const list = past
            ? sortRows(pool.filter((t) => t.status === 'done' && shownOn(t, s.today) === d))
            : sortRows(pool.filter((t) => shownOn(t, s.today) === d && !(isT && isLate(t, s.today))));
          const ghosts = past ? pool.filter((t) => isLate(t, s.today) && t.dueDate === d).length : 0;
          const open = list.filter((t) => t.status === 'open').length + carried.length;
          return (
            <div key={d} className={['col', past && 'past', isT && 'today', we && 'we'].filter(Boolean).join(' ')} data-day={d}
              {...(past ? {} : { 'data-drop': '', onDragOver, onDragLeave, onDrop: (e: DragEvent<HTMLDivElement>) => onDrop(e, d) })}>
              <div className="col-h"><span className="dn">{isT ? 'Today' : DOW[dd.getDay()]}</span><span className="dd">{MONS[dd.getMonth()]} {dd.getDate()}</span><span className="n">{open || ''}</span></div>
              <div className="col-b">
                {carried.length > 0 && (
                  <div className="col-carry" data-carry>
                    <div className="cc-h"><span>Carried · {carried.length}</span>
                      <button data-act="move-all" onClick={(e) => openMove(carried.map((t) => t.id), e.currentTarget, 'bulk')}>Move all</button></div>
                    {carried.map((t) => <TaskCard key={t.id} t={t} side={side} hideProject={hideProject} />)}
                  </div>
                )}
                {list.map((t) => <TaskCard key={t.id} t={t} side={side} hideProject={hideProject} />)}
                {!past && previews.filter((x) => x.date === d).map((x) => <PreviewCard key={`pv${x.task.id}${x.date}`} t={x.task} date={x.date} />)}
                {ghosts > 0 && <div className="col-note">{ghosts} carried to today →</div>}
                {past
                  ? !list.length && !ghosts && <div className="col-note">Nothing recorded</div>
                  : (
                    <button className="col-add" data-act="col-add" data-d={d} data-nav={`add:${d}`} tabIndex={-1} aria-label={`Add a task on ${fmt(d)}`}
                      onClick={() => { set((st) => ({ draft: { ...st.draft, dueDate: d, open: true } })); setTimeout(() => document.getElementById('qa-input')?.focus(), 0); }}>
                      {I.plus(13)} Add
                    </button>
                  )}
              </div>
            </div>
          );
        })}
        {more && (
          <button className="col-more" data-act="board-more" title="Show the next week too" aria-label="Show one more week" onClick={moreWeeks}>
            {I.plus(16)}<span>Next week</span>
          </button>
        )}
      </div>
    </>
  );
}

