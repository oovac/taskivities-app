import { useEffect, useState, type ReactNode } from 'react';
import { addDays, fmt } from '../../shared/dates';
import { isLate, shownOn } from '../../shared/rules';
import { describe } from '../../shared/repeat';
import { PRIORITIES, type Priority, type TaskEvent } from '../../shared/types';
import { closeDrawer, loadEvents, openPop, patchTask, skipTask, toggleDone } from '../actions';
import { useStore, type State } from '../store';
import { displayName, firstName, stamp } from '../util';
import { openMove, LateBadge } from './rows';
import { Avatar, Dot, I, PrioIcon, ProjPill } from './ui';

export function Drawer() {
  const s = useStore();
  const t = s.drawer ? s.tasks[s.drawer] : undefined;
  const events = t ? s.events[t.id] : undefined;
  const [notes, setNotes] = useState(t?.notes ?? '');

  useEffect(() => { setNotes(t?.notes ?? ''); }, [t?.id, t?.notes]);
  useEffect(() => { if (t && !events) void loadEvents(t.id); }, [t?.id, t?.version, events]);

  if (!s.drawer) return null;
  if (!t) return <><div className="backdrop" onClick={() => closeDrawer()} /><aside className="drawer" tabIndex={-1}><div className="dr-body">This task is no longer available.</div></aside></>;

  const late = isLate(t, s.today);
  const creator = s.users[t.createdBy];
  const p = s.projects[t.projectId];
  const B = ({ children }: { children: ReactNode }) => <b>{children}</b>;

  return (
    <>
      <div className="backdrop" data-act="close-drawer" onClick={() => closeDrawer()} />
      <aside className="drawer" data-id={t.id} role="dialog" aria-modal="true" aria-label={`Task: ${t.title}`} tabIndex={-1}>
        <div className="dr-top">
          <ProjPill p={p} />
          <span className="spacer" />
          <button className="icon-btn" data-act="close-drawer" title="Close  Esc" aria-label="Close" onClick={() => closeDrawer()}>{I.x()}</button>
        </div>
        <div className="dr-body">
          <div className="dr-title" contentEditable suppressContentEditableWarning spellCheck={false} data-field="title" key={t.id + t.title}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.currentTarget as HTMLElement).blur(); (document.querySelector('.drawer') as HTMLElement | null)?.focus(); } }}
            onBlur={(e) => {
              const v = e.currentTarget.innerText.trim();
              if (v && v !== t.title) void patchTask(t.id, { title: v });
              else if (!v) e.currentTarget.innerText = t.title;
            }}>{t.title}</div>
          <button className={`done-btn ${t.status === 'done' ? 'on' : ''}`} data-act="toggle" onClick={() => toggleDone(t.id)}>
            <span className="chk">{I.check()}</span>{t.status === 'done' ? 'Done' : 'Mark done'}
          </button>
          <dl className="fields">
            <dt>Assignee</dt>
            <dd><button className="field" data-act="assign" onClick={(e) => openPop({ type: 'assign', mode: 'task', id: t.id }, e.currentTarget)}>
              <Avatar user={s.users[t.assigneeId]} /> {displayName(s.users[t.assigneeId])} <span className="c">{I.chev()}</span></button></dd>
            <dt>Date</dt>
            <dd><button className="field" data-act="move" onClick={(e) => openMove([t.id], e.currentTarget)}>
              {I.cal()} {fmt(t.status === 'done' ? t.dueDate : shownOn(t, s.today))}
              {late && <><span style={{ color: 'var(--muted)', fontSize: 12.5 }}>· due {fmt(t.dueDate)}</span> <LateBadge t={t} today={s.today} /></>}
              <span className="c">{I.chev()}</span></button></dd>
            {t.series && <>
              <dt>Repeats</dt>
              <dd>
                {t.status === 'open' && t.series.active ? (
                  <button className="field" data-act="repeat" title="Change or stop repeating  (R)" onClick={(e) => openPop({ type: 'repeat', mode: 'task', id: t.id }, e.currentTarget)}>
                    {I.refresh(14)} {describe(t.series.rule, t.series.anchor)}
                    <span className="c">{I.chev()}</span></button>
                ) : (
                  <span className="field plain">{I.refresh(14)} {t.series.active ? describe(t.series.rule, t.series.anchor) : 'Stopped repeating'}</span>
                )}
                {t.series.active && t.status === 'open' && (
                  <button className="skip-btn" data-act="skip" title="Move this copy to the next scheduled date" onClick={() => void skipTask(t.id)}>Skip this one</button>
                )}
              </dd>
            </>}
            <dt>Priority</dt>
            <dd><button className="field" data-act="prio" onClick={(e) => openPop({ type: 'prio', mode: 'task', id: t.id }, e.currentTarget)}>
              <PrioIcon p={t.priority} s={15} /> {PRIORITIES[t.priority].name} <span className="c">{I.chev()}</span></button></dd>
            <dt>Project</dt>
            <dd><button className="field" data-act="proj" title={p?.description} onClick={(e) => openPop({ type: 'proj', mode: 'task', id: t.id }, e.currentTarget)}>
              <Dot color={p?.color ?? '#A0A0AB'} />{p?.name} <span className="c">{I.chev()}</span></button></dd>
            <dt>Created by</dt>
            <dd className="plain"><Avatar user={creator} /> {displayName(creator)}<span style={{ color: 'var(--faint)' }}>· {stamp(t.createdAt, s.today).split(' · ')[0]}</span></dd>
          </dl>
          {t.series?.active && t.status === 'open' && <div className="dr-hint">Changes to this copy carry over to future ones.</div>}
          <div className="lbl">Notes</div>
          <textarea data-field="notes" placeholder="Add details or links…" value={notes} onChange={(e) => setNotes(e.target.value)}
            onBlur={() => notes.trim() !== t.notes && void patchTask(t.id, { notes })} />
          <div className="lbl">History <span className="muted">· every change, permanently recorded</span></div>
          {!events ? <div className="trail-loading">Loading history…</div> : (
            <ol className="trail">
              {late && (
                <li className="sys"><span className="av" style={{ '--s': '22px' } as React.CSSProperties}>{I.refresh()}</span>
                  <div><div className="tx">Rolling over each day since <B>{fmt(addDays(t.dueDate, 1))}</B> (shown, not logged)</div></div></li>
              )}
              {[...events].reverse().map((e) => (
                <li key={e.id}>
                  <Avatar user={s.users[e.actorId]} />
                  <div>
                    <div className="tx">
                      <b>{firstName(s.users[e.actorId])}</b>
                      {e.via && <> <span className="via" title={`Made by an AI assistant acting as ${displayName(s.users[e.actorId])}`}>via {e.via}</span></>}{' '}
                      <EventText e={e} s={s} />
                      {e.note && <span className="note">“{e.note}”</span>}
                    </div>
                    <div className="tm">{stamp(e.at, s.today)}</div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </aside>
    </>
  );
}

function EventText({ e, s }: { e: TaskEvent; s: State }) {
  const name = (id: string | null) => (id ? firstName(s.users[id]) : 'someone');
  const proj = (id: string | null) => (id && s.projects[id]?.name) || 'another project';
  switch (e.type) {
    case 'created': {
      let v: { assignee?: string; due?: string; priority?: number; repeat?: boolean } = {};
      try { v = JSON.parse(e.toValue || '{}'); } catch { /* ignore */ }
      if (v.repeat) return <>finished the previous copy, which created this one{v.assignee && v.assignee !== e.actorId && <> for <b>{name(v.assignee)}</b></>}{v.due && <> · due {fmt(v.due)}</>}</>;
      return <>created this task{v.assignee && v.assignee !== e.actorId && <> for <b>{name(v.assignee)}</b></>}{v.due && <> · due {fmt(v.due)}</>}{v.priority && v.priority !== 3 && <> · {PRIORITIES[v.priority as Priority].name} priority</>}</>;
    }
    case 'transferred': return <>transferred from <b>{name(e.fromValue)}</b> to <b>{name(e.toValue)}</b></>;
    case 'date_moved': return <>moved date <b>{e.fromValue ? fmt(e.fromValue) : '?'}</b> → <b>{e.toValue ? fmt(e.toValue) : '?'}</b></>;
    case 'priority_changed': return <>changed priority <b>{PRIORITIES[Number(e.fromValue) as Priority]?.name}</b> → <b>{PRIORITIES[Number(e.toValue) as Priority]?.name}</b></>;
    case 'project_changed': return <>moved to <b>{proj(e.toValue)}</b> from <b>{proj(e.fromValue)}</b></>;
    case 'renamed': return <>renamed to “{e.toValue}”</>;
    case 'notes_edited': return <>edited notes</>;
    case 'done': return <>marked this done</>;
    case 'reopened': return <>reopened this task</>;
    case 'repeat_set': return <>set it to repeat: <b>{e.toValue}</b></>;
    case 'repeat_changed': return <>changed the repeat to <b>{e.toValue}</b></>;
    case 'repeat_stopped': return <>stopped repeating</>;
    case 'skipped': return <>skipped <b>{e.fromValue ? fmt(e.fromValue) : '?'}</b> · next one <b>{e.toValue ? fmt(e.toValue) : '?'}</b></>;
    default: return <>{e.type}</>;
  }
}
