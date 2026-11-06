import { closePop, openTask, viewPerson } from '../actions';
import { type InboxRow, inboxRows, loadInbox } from '../inbox';
import type { State } from '../store';
import { andList } from '../history';
import { firstName, stamp } from '../util';
import { Avatar, Dot } from './ui';

/** The inbox: what other people did that needs me, newest first. */
export function InboxPop({ s }: { s: State }) {
  const ib = s.inbox;
  const rows = ib ? inboxRows(ib.items, ib.readAt) : [];
  return (
    <div className="inbox">
      <div className="pop-h">Inbox</div>
      {!ib || (ib.loading && !ib.items.length) ? (
        <div className="pop-empty">Loading…</div>
      ) : ib.error && !ib.items.length ? (
        <div className="pop-empty">Couldn't load your inbox. <button className="linkish" onClick={() => void loadInbox()}>Try again</button></div>
      ) : !rows.length ? (
        <div className="pop-empty">Nothing yet. When someone gives you a task, or comments on one you have or follow, it shows up here.</div>
      ) : (
        <div className="inbox-list">
          {rows.map((r) => <Row key={r.key} r={r} s={s} />)}
          {ib.next && (
            <button className="opt inbox-more" data-act="inbox-more" disabled={ib.loading} onClick={() => void loadInbox(true)}>
              {ib.loading ? 'Loading…' : 'Show older'}
            </button>
          )}
        </div>
      )}
      <div className="pop-foot">Tasks given to you, and what happens on tasks you have or follow. Notifications or not, it's all here.</div>
    </div>
  );
}

function Row({ r, s }: { r: InboxRow; s: State }) {
  const it = r.items[0]!; // the newest
  const who = (actorId: string, via: string | null) =>
    via?.endsWith(' webhook') ? via : `${firstName(s.users[actorId])}${via ? ` via ${via}` : ''}`;
  const people = [...new Map(r.items.map((x) => [`${x.actorId}|${x.via ?? ''}`, who(x.actorId, x.via)])).values()];
  const project = s.projects[it.projectId];
  const head =
    r.kind === 'new' ? <><b>{who(it.actorId, it.via)}</b> gave you a new task</> :
    r.kind === 'assigned' ? <><b>{who(it.actorId, it.via)}</b> gave you a task</> :
    r.kind === 'handover' ? <><b>{who(it.actorId, it.via)}</b> gave you {r.items.length} tasks</> :
    r.kind === 'done' ? <><b>{who(it.actorId, it.via)}</b> finished a task</> :
    r.kind === 'reopened' ? <><b>{who(it.actorId, it.via)}</b> reopened a task</> :
    r.kind === 'handed' ? (it.to === it.actorId ? <><b>{who(it.actorId, it.via)}</b> took a task</> : <><b>{who(it.actorId, it.via)}</b> gave a task to <b>{firstName(s.users[it.to ?? ''])}</b></>) :
    r.kind === 'followed' ? <><b>{who(it.actorId, it.via)}</b> added you as a follower</> :
    <>{andList(people.map((p) => <b key={p}>{p}</b>))} commented{r.items.length > 1 ? ` (${r.items.length})` : ''}</>;
  const open = () => {
    closePop(false);
    if (r.kind === 'handover') viewPerson(s.me!.id);
    else void openTask(it.taskId);
  };
  return (
    <button className={`opt inbox-row${r.unread ? ' unread' : ''}`} data-act="inbox-open" onClick={open}>
      <Avatar user={s.users[it.actorId]} size={26} />
      <span className="inbox-main">
        <span className="inbox-head">{head}</span>
        {r.kind === 'handover' ? (
          it.note && <span className="inbox-title">{it.note}</span>
        ) : (
          <span className={`inbox-title${it.done ? ' done' : ''}`}>{it.title}</span>
        )}
        {r.kind !== 'handover' && it.note && <span className="inbox-note">“{it.note}”</span>}
        <span className="inbox-meta">
          {project && r.kind !== 'handover' && <><Dot color={project.color} size={7} />{project.name} · </>}
          {stamp(it.at, s.today)}
        </span>
      </span>
      {r.unread && <span className="inbox-dot" aria-label="Unread" />}
    </button>
  );
}
