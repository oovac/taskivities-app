import { useEffect, type DragEvent } from 'react';
import { DOW, MONS, addDays, fmt, parseDate } from '../../shared/dates';
import { isLate, shownOn } from '../../shared/rules';
import type { Task } from '../../shared/types';
import { ensureRange, moveTasks, openPop, setView, viewPerson } from '../actions';
import { QuickAdd } from '../components/QuickAdd';
import { PreviewCard, PreviewRow, TaskCard, TaskRow, drag, openMove } from '../components/rows';
import { Avatar, I } from '../components/ui';
import { set, useStore, type State } from '../store';
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
        <button className="who" data-act="person" onClick={(e) => openPop({ type: 'person' }, e.currentTarget)}>
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
          <div className="seg" role="group" aria-label="View">
            <button className={TD ? 'on' : ''} data-act="view-mode" data-m="today" onClick={() => setView('today')}>{I.sun()}<span className="sl">Today</span></button>
            <button className={s.view === 'list' ? 'on' : ''} data-act="view-mode" data-m="list" onClick={() => setView('list')}>{I.list()}<span className="sl">Week</span></button>
            <button className={s.view === 'board' ? 'on' : ''} data-act="view-mode" data-m="board" onClick={() => setView('board')}>{I.board()}<span className="sl">Board</span></button>
          </div>
          {TD ? (
            <div className="wk"><b>Today</b><span>{fmt(s.today)}</span></div>
          ) : (
            <>
              <button className="icon-btn" data-act="week" data-dir="-1" title="Previous week  [" aria-label="Previous week" onClick={() => set({ weekOffset: s.weekOffset - 1 })}>{I.left()}</button>
              <div className="wk"><b>{w.label}</b><span>{w.range}</span></div>
              <button className="icon-btn" data-act="week" data-dir="1" title="Next week  ]" aria-label="Next week" onClick={() => set({ weekOffset: s.weekOffset + 1 })}>{I.right()}</button>
              <button className="btn-ghost" data-act="week" data-dir="0" disabled={s.weekOffset === 0} onClick={() => set({ weekOffset: 0 })}>This week</button>
            </>
          )}
        </div>
      </div>
      <QuickAdd />
      {s.view === 'board' ? (
        <Board s={s} u={u} w={w} />
      ) : (
        <>
          <section className="sec">
            <div className="sec-h"><h2>Assigned to {isMe ? 'me' : firstName(person)}</h2><span className="cnt">{openN} open {TD ? 'today' : 'this week'}</span></div>
            {(TD ? [s.today] : w.days).map((d) => <Day key={d} s={s} d={d} u={u} mine={mine} carried={carried} TD={TD} previews={previews.filter((x) => x.date === d)} />)}
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

function Day({ s, d, u, mine, carried, TD, previews }: { s: State; d: string; u: string; mine: Task[]; carried: Task[]; TD: boolean; previews: Preview[] }) {
  const dd = parseDate(d);
  const label = `${MONS[dd.getMonth()]} ${dd.getDate()}`;
  if (d < s.today) {
    const done = sortRows(mine.filter((t) => t.status === 'done' && shownOn(t, s.today) === d));
    const ghosts = mine.filter((t) => isLate(t, s.today) && t.dueDate === d);
    const key = `${u}:${d}`;
    const open = s.expanded[key] || s.weekOffset < 0;
    const parts = [done.length ? `${done.length} done` : '', ghosts.length ? `${ghosts.length} carried to today` : ''].filter(Boolean);
    const toggle = () => set((st) => ({ expanded: { ...st.expanded, [key]: !st.expanded[key] } }));
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
          <div className="card">{done.map((t) => <TaskRow key={t.id} t={t} ctx="to" />)}{ghosts.map((t) => <TaskRow key={'g' + t.id} t={t} ctx="ghost" />)}</div>
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
      <div className="rows">{carried.map((t) => <TaskRow key={t.id} t={t} ctx="carried" />)}</div>
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
        ? <div className="card">{list.map((t) => <TaskRow key={t.id} t={t} ctx="to" />)}{previews.map((x) => <PreviewRow key={`pv${x.task.id}${x.date}`} t={x.task} date={x.date} />)}</div>
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

function Board({ s, u, w }: { s: State; u: string; w: ReturnType<typeof weekInfo> }) {
  const isMe = u === s.me!.id;
  const side = s.boardSide;
  const all = Object.values(s.tasks);
  const pool = side === 'to' ? all.filter((t) => t.assigneeId === u) : all.filter((t) => (t.createdBy === u || t.assignedBy === u) && t.assigneeId !== u);
  const inWeek = (t: Task) => t.status === 'open' && inRange(shownOn(t, s.today), w.ws, w.we);
  const nTo = all.filter((t) => t.assigneeId === u && inWeek(t)).length;
  const nBy = all.filter((t) => (t.createdBy === u || t.assignedBy === u) && t.assigneeId !== u && inWeek(t)).length;
  const who = isMe ? 'me' : firstName(s.users[u]);
  const previews = side === 'to' ? previewsFor(s, u, w.ws, w.we) : [];

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

  return (
    <>
      <div className="board-bar">
        <div className="seg sm">
          <button className={side === 'to' ? 'on' : ''} data-act="board-side" data-s="to" onClick={() => set({ boardSide: 'to' })}>Assigned to {who} <span>{nTo}</span></button>
          <button className={side === 'by' ? 'on' : ''} data-act="board-side" data-s="by" onClick={() => set({ boardSide: 'by' })}>Assigned by {who} <span>{nBy}</span></button>
        </div>
        <span className="hint">Drag a card to another day, or select it and press <kbd>⇧</kbd><kbd>←</kbd> <kbd>⇧</kbd><kbd>→</kbd>. Past days are read-only.</span>
      </div>
      <div className="board">
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
                    {carried.map((t) => <TaskCard key={t.id} t={t} side={side} />)}
                  </div>
                )}
                {list.map((t) => <TaskCard key={t.id} t={t} side={side} />)}
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
      </div>
    </>
  );
}

