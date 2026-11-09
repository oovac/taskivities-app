import { useEffect, useState, type CSSProperties } from 'react';
import { DOW, MONS, parseDate } from '../../shared/dates';
import { isLate, shownOn } from '../../shared/rules';
import type { Task } from '../../shared/types';
import { ensureRange, exitFocus, openDrawer, toggleDone } from '../actions';
import { useStore } from '../store';
import { ariaFor, byPrioThenOldest, firstName, lateDays, sortRows } from '../util';
import { openMove } from './rows';
import { I, PrioTag } from './ui';

const FULL_DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const FULL_MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** How long a ticked task stays in place (its check animating) before it moves down to Done. */
const TICK_MS = 420;

const greeting = (h: number) => (h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening');

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * Focus mode: the whole screen is my tasks for today (carried-over ones first), nothing else. Ticking a task
 * moves it down to "Done today"; Esc, ⇧F or Exit goes back to where I was.
 */
export function FocusMode() {
  const s = useStore();
  const now = useClock();
  const [ticking, setTicking] = useState<Record<string, true>>({});
  const me = s.me!;
  const today = s.today;
  // Opened from any page (or straight from a ?focus link): make sure today's tasks are loaded.
  useEffect(() => { void ensureRange(today, today); }, [today]);

  const mine = Object.values(s.tasks).filter((t) => t.assigneeId === me.id && !t.archivedAt);
  const carried = mine.filter((t) => isLate(t, today)).sort(byPrioThenOldest);
  const todays = sortRows(mine.filter((t) => shownOn(t, today) === today && !isLate(t, today)));
  const open = [...carried, ...todays.filter((t) => t.status === 'open')];
  const done = todays.filter((t) => t.status === 'done').sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''));
  const total = open.length + done.length;
  const left = open.filter((t) => !ticking[t.id]).length;
  const doneN = total - left;

  const tick = (t: Task, btn: HTMLElement) => {
    if (ticking[t.id]) return;
    setTicking((x) => ({ ...x, [t.id]: true }));
    setTimeout(() => {
      toggleDone(t.id, btn.isConnected ? btn : null);
      setTicking((x) => { const n = { ...x }; delete n[t.id]; return n; });
    }, TICK_MS);
  };

  const d = parseDate(today);
  const time = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  return (
    <div className="focus" role="region" aria-label="Focus mode: your tasks for today">
      <div className="fx-glow" aria-hidden="true" />
      <header className="fx-top">
        <span className="fx-badge">{I.target(14)}Focus</span>
        <span className="fx-time" aria-hidden="true">{time}</span>
        <button className="fx-exit" data-act="focus-exit" title="Leave focus mode  (Esc)" onClick={exitFocus}>
          {I.x(14)}<span>Exit focus</span><kbd>Esc</kbd>
        </button>
      </header>

      <main className="fx-main">
        <div className="fx-hero">
          <Ring done={doneN} total={total} />
          <div className="fx-hero-t">
            <div className="fx-date">{FULL_DOW[d.getDay()]}, {FULL_MON[d.getMonth()]} {d.getDate()}</div>
            <h1>
              {total === 0 ? `${greeting(now.getHours())}, ${firstName(me)}.`
                : left === 0 ? 'All clear for today.'
                : <>{left} {left === 1 ? 'task' : 'tasks'} <span>left today</span></>}
            </h1>
            <div className="fx-sub">
              {total === 0 ? 'Nothing is planned for today.'
                : left === 0 ? `You finished all ${total}. Nice work.`
                : <>{doneN} of {total} done{carried.length > 0 && <> · <span className="fx-carry">{carried.length} carried over</span></>}</>}
            </div>
          </div>
        </div>

        {open.length > 0 ? (
          <div className="fx-list" role="list">
            {open.map((t, i) => <FocusRow key={t.id} t={t} today={today} next={i === 0} ticking={!!ticking[t.id]} onTick={tick} />)}
          </div>
        ) : (
          <div className={`fx-empty${total ? ' win' : ''}`}>
            <span className="fx-empty-i">{total ? I.check(30) : I.sun(30)}</span>
            <b>{total ? 'Everything for today is done.' : 'A clear day.'}</b>
            <span>{total ? 'Take a breath, then plan tomorrow or call it a day.' : 'Add tasks for today, then come back here to work through them.'}</span>
            <button className="fx-empty-btn" onClick={exitFocus}>Back to my day</button>
          </div>
        )}

        {done.length > 0 && (
          <section className="fx-done" aria-label="Done today">
            <h2>Done today <span>{done.length}</span></h2>
            <div className="fx-list" role="list">
              {done.map((t) => <FocusRow key={t.id} t={t} today={today} next={false} ticking={false} onTick={(x) => toggleDone(x.id)} />)}
            </div>
          </section>
        )}
      </main>

      <footer className="fx-foot" aria-hidden="true">
        <span><kbd>↑</kbd><kbd>↓</kbd> select</span>
        <span><kbd>X</kbd> done</span>
        <span><kbd>Enter</kbd> open</span>
        <span><kbd>D</kbd> move date</span>
        <span><kbd>Esc</kbd> exit</span>
      </footer>
    </div>
  );
}

/** Done rows have their own key, so ticking a task leaves the selection on the next open one instead of following it down. */
function FocusRow({ t, today, next, ticking, onTick }: {
  t: Task; today: string; next: boolean; ticking: boolean; onTick: (t: Task, btn: HTMLElement) => void;
}) {
  const p = useStore((st) => st.projects[t.projectId]);
  const done = t.status === 'done';
  const late = isLate(t, today);
  const ck = t.checklist.length ? t.checklist.filter((c) => c.done).length : 0;
  const cls = ['fx-row', next && 'next', done && 'done', ticking && 'ticking'].filter(Boolean).join(' ');
  return (
    <div className={cls} role="listitem" data-id={t.id} data-nav={`${done ? 'done' : 'task'}:${t.id}`} tabIndex={-1} aria-label={ariaFor(t, today)}
      style={{ '--pc': p?.color ?? 'var(--faint)' } as CSSProperties}>
      <button className="fx-chk" tabIndex={-1} data-act="toggle" title={done ? 'Mark not done' : 'Mark done  (X)'} aria-label={done ? 'Mark not done' : 'Mark done'}
        onClick={(e) => onTick(t, e.currentTarget)}>{I.check(16)}</button>
      <div className="fx-body" data-act="open" onClick={() => openDrawer(t.id)}>
        {next && !done && <span className="fx-next">Up next</span>}
        <div className="fx-title">{!done && <PrioTag p={t.priority} />}<span>{t.title}</span></div>
        <div className="fx-meta">
          <span className="fx-proj"><i />{p?.name ?? 'Another project'}</span>
          {late && <span className="fx-late" title={`Was due ${DOW[parseDate(t.dueDate).getDay()]}, ${MONS[parseDate(t.dueDate).getMonth()]} ${parseDate(t.dueDate).getDate()}`}>{lateDays(t, today)}d late</span>}
          {t.checklist.length > 0 && <span className="fx-ck">{I.check(11)}{ck}/{t.checklist.length}</span>}
        </div>
      </div>
      {!done && (
        <button className="icon-btn fx-move" tabIndex={-1} data-act="move" title="Move to another day  (D)" aria-label="Move to another day"
          onClick={(e) => openMove([t.id], e.currentTarget)}>{I.cal()}</button>
      )}
    </div>
  );
}

/** Today's progress as a ring: done of total. */
function Ring({ done, total }: { done: number; total: number }) {
  const R = 30, C = 2 * Math.PI * R;
  const f = total ? done / total : 0;
  return (
    <div className={`fx-ring${total && done === total ? ' full' : ''}`} role="img" aria-label={`${done} of ${total} done`}>
      <svg viewBox="0 0 72 72" width="72" height="72" aria-hidden="true">
        <circle cx="36" cy="36" r={R} className="bg" />
        <circle cx="36" cy="36" r={R} className="fg" strokeDasharray={C} strokeDashoffset={C * (1 - f)} />
      </svg>
      <span>{total ? `${Math.round(f * 100)}%` : '—'}</span>
    </div>
  );
}
