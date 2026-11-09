// A project's Gantt chart: its High-priority tasks as bars over five weeks, from each task's due date through the
// last day it lasts (shared/rules.ts → lastDay), with arrows for what waits on what (shared/deps.ts). Every other
// priority (Urgent, Normal, Low) is left out on purpose: the chart is for the few tasks that set the project's pace.
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { DOW, MONS, addDays, diffDays, fmt, parseDate, weekStart } from '../../shared/dates';
import { lastDay, lateDays } from '../../shared/rules';
import { DURATION_MAX, type Task } from '../../shared/types';
import { moveTasks, openDrawer, setDuration } from '../actions';
import { Avatar, I } from '../components/ui';
import { set, type State } from '../store';
import { truncatedTip } from '../tooltip';
import { daysLabel, displayName, firstName } from '../util';

/** How many weeks the chart shows: last week, this week and three more (moved with ← → or [ ]). */
export const GANTT_WEEKS = 5;
/** Only High-priority tasks (2) are charted. */
export const inGantt = (t: Task) => t.priority === 2 && !t.archivedAt;

const ROW = 36; // px, one task
const BAR = 18; // px, a bar's height

/** The days the chart shows, for a week offset (0: this week is the second one). */
export function ganttRange(today: string, offset: number) {
  const from = addDays(weekStart(today), (offset - 1) * 7);
  const to = addDays(from, GANTT_WEEKS * 7 - 1);
  const f = parseDate(from), t = parseDate(to);
  const label = f.getFullYear() === t.getFullYear()
    ? `${MONS[f.getMonth()]} ${f.getDate()} – ${f.getMonth() === t.getMonth() ? '' : MONS[t.getMonth()] + ' '}${t.getDate()}`
    : `${fmt(from)} – ${fmt(to)}`;
  return { from, to, days: GANTT_WEEKS * 7, label };
}

/**
 * A bar being dragged (mouse or pen; on touch screens a sideways swipe scrolls the chart instead). `move` shifts the
 * due date and keeps the length; `resize` (the grip on the right edge) changes how many days it lasts.
 */
interface Drag { id: string; mode: 'move' | 'resize'; x0: number; dayW: number; start: string; n: number; delta: number }

/**
 * Where a dragged bar would land: never before today (the server refuses past dates), 1 to DURATION_MAX days.
 * A bar dragged into the past stops at today; one already in the past (overdue) only moves when dragged later.
 */
function landing(d: Drag, today: string) {
  if (d.mode === 'resize') return { start: d.start, n: Math.max(1, Math.min(DURATION_MAX, d.n + d.delta)) };
  if (!d.delta) return { start: d.start, n: d.n };
  const start = addDays(d.start, d.delta);
  if (start >= today) return { start, n: d.n };
  return { start: d.start < today && d.delta < 0 ? d.start : today, n: d.n };
}

/** A task's bar: its own days, plus (open and overdue) the days since, up to today, or (done late) up to when it was done. */
function barOf(t: Task, today: string) {
  const end = lastDay(t);
  const late = t.status === 'open' && end < today ? today : t.status === 'done' && t.doneOn && t.doneOn > end ? t.doneOn : null;
  return { start: t.dueDate, end, lateTo: late };
}

/** The tasks the chart shows for a range: charted priorities whose bar touches it, earliest first. */
export function ganttTasks(s: State, inP: (t: Task) => boolean, from: string, to: string) {
  return Object.values(s.tasks)
    .filter((t) => inP(t) && inGantt(t))
    .map((t) => ({ t, b: barOf(t, s.today) }))
    .filter(({ b }) => b.start <= to && (b.lateTo ?? b.end) >= from)
    .sort((a, b) => a.b.start.localeCompare(b.b.start) || a.t.priority - b.t.priority || a.b.end.localeCompare(b.b.end) || a.t.title.localeCompare(b.t.title));
}

/** ← Nov 2 – Dec 6 → for the chart (the label goes back to this week when you're elsewhere). */
export function GanttControls({ s }: { s: State }) {
  const r = ganttRange(s.today, s.weekOffset);
  return (
    <>
      <button className="icon-btn" data-act="week" data-dir="-1" title="A week earlier  [" aria-label="A week earlier" onClick={() => set({ weekOffset: s.weekOffset - 1 })}>{I.left()}</button>
      {s.weekOffset === 0 ? (
        <div className="wk"><b>{GANTT_WEEKS} weeks</b><span>{r.label}</span></div>
      ) : (
        <button className="wk back" data-act="week" data-dir="0" title="Back to this week" aria-label={`${r.label}. Back to this week`}
          onClick={() => set({ weekOffset: 0 })}><b>{GANTT_WEEKS} weeks</b><span>{r.label} · <u>this week</u></span></button>
      )}
      <button className="icon-btn" data-act="week" data-dir="1" title="A week later  ]" aria-label="A week later" onClick={() => set({ weekOffset: s.weekOffset + 1 })}>{I.right()}</button>
    </>
  );
}

export function Gantt({ s, inP, showProject }: { s: State; inP: (t: Task) => boolean; showProject: boolean }) {
  const r = ganttRange(s.today, s.weekOffset);
  const charted = ganttTasks(s, inP, r.from, r.to);
  const area = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0); // the bars area's width, for the dependency arrows
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragged = useRef(false); // a drag just ended: the click that follows it isn't a click
  // Esc puts a dragged bar back where it was.
  useEffect(() => {
    if (!drag) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dragged.current = true; setDrag(null); } };
    addEventListener('keydown', esc, true);
    return () => removeEventListener('keydown', esc, true);
  }, [!!drag]);
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, [charted.length > 0]);
  // Too narrow to show every day (phones): start with today near the left, a couple of days before it showing.
  useLayoutEffect(() => {
    const sc = scroller.current, el = area.current;
    if (!sc || !el || sc.scrollWidth <= sc.clientWidth) return;
    sc.scrollLeft = Math.max(0, (diffDays(s.today, r.from) - 2) * (el.clientWidth / r.days));
  }, [r.from, charted.length > 0]);

  // The dragged bar shows where it would land (its late stripe and arrows follow).
  const land = drag ? landing(drag, s.today) : null;
  const rows = charted.map((x) => (drag && land && x.t.id === drag.id
    ? { t: x.t, b: barOf({ ...x.t, dueDate: land.start, durationDays: land.n }, s.today) } : x));

  const days = [...Array(r.days)].map((_, i) => addDays(r.from, i));
  const col = (d: string) => Math.max(0, Math.min(r.days, diffDays(d, r.from))); // day → column (clamped to the chart)
  const pct = (n: number) => `${(n / r.days) * 100}%`;
  const todayCol = diffDays(s.today, r.from);

  const begin = (e: PointerEvent<HTMLElement>, t: Task, mode: Drag['mode']) => {
    if (e.button !== 0 || e.pointerType === 'touch' || t.status !== 'open' || !w) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget.closest('.gt-bar') as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ id: t.id, mode, x0: e.clientX, dayW: w / r.days, start: t.dueDate, n: t.durationDays ?? 1, delta: 0 });
  };
  const follow = (e: PointerEvent<HTMLElement>) => {
    if (!drag) return;
    const delta = Math.round((e.clientX - drag.x0) / drag.dayW);
    if (delta !== drag.delta) setDrag({ ...drag, delta });
  };
  const end = () => {
    if (!drag) return;
    const t = s.tasks[drag.id], to = landing(drag, s.today);
    setDrag(null);
    if (drag.delta) dragged.current = true;
    if (!t) return;
    if (drag.mode === 'move' && to.start !== t.dueDate) void moveTasks([t.id], to.start);
    if (drag.mode === 'resize' && to.n !== (t.durationDays ?? 1)) setDuration(t.id, to.n);
  };

  if (!charted.length)
    return (
      <section className="sec">
        <div className="empty-sec">No High-priority tasks in these weeks. The Gantt chart shows only those, so the few that set the pace stand out.</div>
      </section>
    );

  // Dependency arrows between tasks that are both on the chart: blocker's end → the waiting task's start.
  const rowOf = new Map(rows.map((x, i) => [x.t.id, i]));
  const dayW = w / r.days;
  const arrows = w ? rows.flatMap(({ t, b }, i) => (t.blockedBy ?? []).flatMap((l) => {
    const j = rowOf.get(l.id);
    if (j === undefined) return [];
    const blocker = rows[j];
    const x1 = col(addDays(blocker.b.end, 1)) * dayW, y1 = j * ROW + ROW / 2;
    const x2 = col(b.start) * dayW, y2 = i * ROW + ROW / 2;
    // Clashing: the blocker is still open and runs past the day this one starts.
    const bad = l.open && t.status === 'open' && blocker.b.end >= b.start;
    const d = x2 - 6 >= x1 + 6
      ? `M${x1} ${y1} H${x1 + 6} V${y2} H${x2 - 1}`
      : `M${x1} ${y1} H${x1 + 6} V${(y1 + y2) / 2} H${x2 - 8} V${y2} H${x2 - 1}`;
    return [{ key: `${l.id}>${t.id}`, d, bad }];
  })) : [];

  return (
    <section className={`sec gantt-sec${drag ? ' gt-dragging' : ''}`}>
      <div className="sec-h"><h2>Gantt</h2><span className="cnt">High-priority tasks only · {rows.length} task{rows.length > 1 ? 's' : ''}</span></div>
      <div className="gantt-scroll" ref={scroller}>
        <div className="gantt" style={{ ['--days' as string]: r.days }}>
          {/* Header: weeks, then days */}
          <div className="gt-corner" />
          <div className="gt-head">
            <div className="gt-weeks">
              {days.filter((_, i) => i % 7 === 0).map((d) => (
                <span key={d} style={{ width: pct(7) }}>{MONS[parseDate(d).getMonth()]} {parseDate(d).getDate()}</span>
              ))}
            </div>
            <div className="gt-days">
              {days.map((d) => {
                const dd = parseDate(d);
                return (
                  <span key={d} className={[dd.getDay() % 6 === 0 && 'we', d === s.today && 'td'].filter(Boolean).join(' ')} title={fmt(d)}>
                    <i>{DOW[dd.getDay()][0]}</i>{dd.getDate()}
                  </span>
                );
              })}
            </div>
          </div>

          {/* Task names */}
          <div className="gt-labels">
            {rows.map(({ t }) => (
              <div key={t.id} className={`gt-label ${t.status === 'done' ? 'done' : ''}`} data-nav={`task:${t.id}`} tabIndex={-1}
                style={{ height: ROW }} onClick={() => openDrawer(t.id)}>
                {t.status === 'done' && <span className="gt-ok" title="Done">{I.check(11)}</span>}
                <span className="gt-t" {...truncatedTip(t.title)}>{t.title}</span>
                {showProject && <i className="gt-dot" style={{ background: s.projects[t.projectId]?.color }} title={s.projects[t.projectId]?.name} />}
                <span title={displayName(s.users[t.assigneeId])}><Avatar user={s.users[t.assigneeId]} size={18} /></span>
              </div>
            ))}
          </div>

          {/* Bars */}
          <div className="gt-area" ref={area} style={{ height: rows.length * ROW }}>
            <div className="gt-grid" aria-hidden="true">
              {days.map((d) => <span key={d} className={[parseDate(d).getDay() % 6 === 0 && 'we', d === s.today && 'td'].filter(Boolean).join(' ')} />)}
            </div>
            {rows.map(({ t, b }, i) => {
              const s0 = col(b.start), e0 = col(addDays(b.end, 1));
              const lateFrom = col(addDays(b.end, 1)), lateEnd = b.lateTo ? col(addDays(b.lateTo, 1)) : 0;
              const n = t.durationDays ?? 1;
              const late = b.lateTo && t.status === 'open' ? lateDays(t, s.today) : 0;
              const tip = `${t.title}\n${fmt(b.start)}${n > 1 ? ` – ${fmt(b.end)} (${daysLabel(n)})` : ''} · ${firstName(s.users[t.assigneeId])}` +
                (t.status === 'done' ? `\nDone ${t.doneOn ? fmt(t.doneOn) : ''}` : late ? `\n${late}d late` : '');
              const color = s.projects[t.projectId]?.color ?? 'var(--accent)';
              return (
                <div key={t.id} className={`gt-row ${t.status === 'done' ? 'done' : ''}`} style={{ top: i * ROW, height: ROW }}>
                  {e0 > s0 && (
                    <button className={['gt-bar', b.start < r.from && 'cut-l', b.end > r.to && 'cut-r', t.status === 'open' && 'can-drag', drag?.id === t.id && 'on'].filter(Boolean).join(' ')}
                      style={{ left: pct(s0), width: pct(e0 - s0), height: BAR, ['--c' as string]: color }} title={drag ? undefined : tip + (t.status === 'open' ? '\nDrag to move · drag the right edge to change how long it lasts' : '')}
                      tabIndex={-1} aria-label={tip.replace(/\n/g, '. ')}
                      onPointerDown={(e) => begin(e, t, 'move')} onPointerMove={follow} onPointerUp={end} onPointerCancel={() => setDrag(null)}
                      onClick={() => { if (dragged.current) { dragged.current = false; return; } openDrawer(t.id); }}>
                      {t.status === 'open' && <span className="gt-grip" onPointerDown={(e) => begin(e, t, 'resize')} />}
                    </button>
                  )}
                  {drag?.id === t.id && land && (
                    <span className="gt-when" style={{ left: pct(Math.min(s0, r.days - 6)) }}>
                      {fmt(land.start)}{land.n > 1 ? ` – ${fmt(addDays(land.start, land.n - 1))}` : ''} · {daysLabel(land.n)}
                    </span>
                  )}
                  {b.lateTo && lateEnd > lateFrom && (
                    <span className={`gt-late ${t.status === 'done' ? 'was' : ''}`} style={{ left: pct(lateFrom), width: pct(lateEnd - lateFrom), height: BAR }}
                      title={t.status === 'done' ? `Done ${fmt(b.lateTo)}, after its last day` : `${late}d late`} />
                  )}
                </div>
              );
            })}
            {todayCol >= 0 && todayCol < r.days && <div className="gt-today" style={{ left: pct(todayCol) }} title="Today" />}
            {arrows.length > 0 && (
              <svg className="gt-links" width={w} height={rows.length * ROW} aria-hidden="true">
                <defs>
                  <marker id="gt-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" /></marker>
                  <marker id="gt-arrow-bad" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" /></marker>
                </defs>
                {arrows.map((a) => <path key={a.key} d={a.d} className={a.bad ? 'bad' : ''} markerEnd={`url(#${a.bad ? 'gt-arrow-bad' : 'gt-arrow'})`} />)}
              </svg>
            )}
          </div>
        </div>
      </div>
      <div className="gt-legend">
        <span><i className="lg-bar" /> due date to last day</span>
        <span><i className="lg-late" /> overdue</span>
        <span><i className="lg-link" /> waits on</span>
        <span className="bad"><i className="lg-link bad" /> dates clash</span>
      </div>
    </section>
  );
}
