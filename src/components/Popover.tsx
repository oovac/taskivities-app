import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DOW, MONL, addDays, fmt, parseDate, toDate, weekStart } from '../../shared/dates';
import { type Freq, type Repeat, cleanRepeat, describe, presets, sameRule } from '../../shared/repeat';
import { isAdmin, onProject } from '../../shared/rules';
import { PRIORITIES, type Priority } from '../../shared/types';
import {
  assignable, closePop, defaultDraftDate, moveTasks, openConnect, removeUser, setPage, setPriority, setProject, setRepeat, signOut, switchablePeople, transfer,
  updateUser, viewPerson,
} from '../actions';
import { focusLater } from '../focus';
import { S, set, useStore, type Pop, type State } from '../store';
import { displayName, draftEffective, firstName, isLate, myProjects, shownOn } from '../util';
import { projectDayData } from '../pages/ProjectsPage';
import { Avatar, Dot, I, PrioIcon, ProjBadge } from './ui';

const setDraft = (p: Partial<State['draft']>) => set((s) => ({ draft: { ...s.draft, ...p } }));
const updatePop = (p: Partial<Pop>) => set((s) => (s.pop ? { pop: { ...s.pop, ...p } } : {}));

export function Popover() {
  const s = useStore();
  const p = s.pop;
  const ref = useRef<HTMLDivElement>(null);
  const opened = useRef<Pop | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!p || !el) { opened.current = null; return; }
    // Position first (synchronously), then focus: hidden elements can't take focus.
    const W = el.offsetWidth, H = el.offsetHeight, r = p.rect;
    let top = r.b + 6;
    if (top + H > innerHeight - 12) top = Math.max(12, r.t - H - 6);
    el.style.left = `${Math.max(12, Math.min(r.l, innerWidth - W - 12))}px`;
    el.style.top = `${top}px`;
    el.style.visibility = 'visible';
    const isNew = !opened.current || opened.current.rect !== p.rect || opened.current.type !== p.type;
    opened.current = p;
    if (isNew) {
      const first = el.querySelector<HTMLElement>('#pop-q') || el.querySelector<HTMLElement>('.opt.cur:not(:disabled)') ||
        el.querySelector<HTMLElement>('.opt:not(:disabled)') || el.querySelector<HTMLElement>('button:not(:disabled)');
      first?.focus({ preventScroll: true });
    }
  });

  if (!p) return null;
  return (
    <div id="pop">
      <div className="pop" ref={ref} role="dialog" aria-label="Menu" style={{ visibility: 'hidden', left: 0, top: 0 }}>
        <Content p={p} s={s} />
      </div>
    </div>
  );
}

function Content({ p, s }: { p: Pop; s: State }) {
  switch (p.type) {
    case 'move': return <MovePop p={p} s={s} />;
    case 'assign': return <AssignPop p={p} s={s} />;
    case 'prio': return <PrioPop p={p} s={s} />;
    case 'proj': return <ProjPop p={p} s={s} />;
    case 'person': return <PersonPop s={s} />;
    case 'projpick': return <ProjPickPop s={s} />;
    case 'urole': return <RolePop p={p} s={s} />;
    case 'uproj': return <UserProjectsPop p={p} s={s} />;
    case 'uremove': return <RemovePop p={p} s={s} />;
    case 'account': return <AccountPop s={s} />;
    case 'repeat': return <RepeatPop p={p} s={s} />;
  }
}

function MovePop({ p, s }: { p: Pop; s: State }) {
  const qa = p.mode === 'qa';
  const cur = qa ? s.draft.dueDate || s.today : p.ids!.length === 1 ? s.tasks[p.ids![0]]?.dueDate : null;
  const nextMon = addDays(weekStart(s.today), 7);
  const fri = addDays(weekStart(s.today), 4);
  const quick: [string, string][] = [
    ...(qa ? [['Today', s.today] as [string, string]] : []),
    ['Tomorrow', addDays(s.today, 1)],
    ...(fri > addDays(s.today, 1) ? [['This Friday', fri] as [string, string]] : []),
    ['Next Monday', nextMon],
    ['In a week', addDays(s.today, 7)],
  ];
  const pick = (d: string) => {
    closePop(true);
    if (qa) setDraft({ dueDate: d });
    else void moveTasks(p.ids!, d);
  };
  const title = qa ? 'Due date' : p.ids!.length > 1 ? `Move ${p.ids!.length} carried tasks to…` : 'Move to…';
  const month = p.month || s.today.slice(0, 8) + '01';
  const first = parseDate(month);
  const start = addDays(month, -((first.getDay() + 6) % 7));
  const shift = (n: number) => { const f = parseDate(month); f.setMonth(f.getMonth() + n); updatePop({ month: toDate(f) }); };
  return (
    <>
      <div className="pop-h">{title}</div>
      {quick.map(([l, d]) => (
        <button key={l} className="opt" data-act="setdate" data-d={d} onClick={() => pick(d)}>{l}<span className="r">{fmt(d)}</span></button>
      ))}
      <div className="pop-sep" />
      <div className="cal">
        <div className="cal-h">
          <button className="icon-btn" data-act="cal" data-dir="-1" aria-label="Previous month" onClick={() => shift(-1)}>{I.left()}</button>
          <b>{MONL[first.getMonth()]} {first.getFullYear()}</b>
          <button className="icon-btn" data-act="cal" data-dir="1" aria-label="Next month" onClick={() => shift(1)}>{I.right()}</button>
        </div>
        <div className="cal-g">
          {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((x, i) => <span key={i} className="dw">{x}</span>)}
          {[...Array(42)].map((_, i) => {
            const d = addDays(start, i);
            const dd = parseDate(d);
            const cls = [dd.getMonth() !== first.getMonth() && 'om', d === s.today && 'td', d === cur && 'sel'].filter(Boolean).join(' ');
            return (
              <button key={d} className={cls} disabled={d < s.today} aria-label={fmt(d)} onClick={() => pick(d)}>{dd.getDate()}</button>
            );
          })}
        </div>
      </div>
    </>
  );
}

function AssignPop({ p, s }: { p: Pop; s: State }) {
  const qa = p.mode === 'qa';
  const t = qa ? null : s.tasks[p.id!];
  const pid = qa ? draftEffective(s).projectId : t?.projectId;
  const cur = qa ? draftEffective(s).assigneeId : t?.assigneeId;
  const noteRef = useRef<HTMLInputElement>(null);
  const onlyRef = useRef<HTMLInputElement>(null);
  const repeating = !!t?.series?.active && t.status === 'open';
  if (!pid) return <div className="pop-body">Pick a project first.</div>;
  const q = (p.q || '').toLowerCase();
  const list = assignable(s, pid)
    .filter((u) => !q || `${u.name} ${u.email}`.toLowerCase().includes(q))
    .sort((a, b) => displayName(a).localeCompare(displayName(b)));
  const choose = (u: string) => {
    const note = noteRef.current?.value.trim();
    const thisOnly = !!onlyRef.current?.checked;
    closePop(true);
    if (qa) setDraft({ assigneeId: u });
    else void transfer(p.id!, u, note, thisOnly);
  };
  return (
    <>
      <div className="pop-h">{qa ? 'Assign to' : 'Transfer to…'}</div>
      <div style={{ padding: '0 4px' }}>
        <input className="pin" id="pop-q" placeholder="Search people" value={p.q || ''} autoComplete="off"
          onChange={(e) => updatePop({ q: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); const f = list.find((u) => u.id !== cur); if (f) choose(f.id); } }} />
      </div>
      {list.length ? list.map((u) => (
        <button key={u.id} className={`opt ${u.id === cur ? 'cur' : ''}`} onClick={() => u.id !== cur && choose(u.id)}>
          <Avatar user={u} />{displayName(u)}{u.id === s.me!.id && <span style={{ color: 'var(--faint)' }}> (you)</span>}
          <span className="r">{u.id === cur ? 'current' : u.status === 'invited' ? 'invited' : ''}</span>
        </button>
      )) : <div className="pop-empty">No one on this project matches.</div>}
      <div className="pop-foot">Only people on <b>{s.projects[pid]?.name}</b> are listed.</div>
      {!qa && (
        <><div className="pop-sep" /><div style={{ padding: '2px 4px' }}>
          <input className="pin" ref={noteRef} placeholder="Add a note for the history (optional)" style={{ margin: 0 }} />
        </div></>
      )}
      {repeating && (
        <label className="pop-check">
          <input type="checkbox" ref={onlyRef} />
          <span>Just this one. Future copies stay with {firstName(s.users[t!.series!.assigneeId])}.</span>
        </label>
      )}
    </>
  );
}

function PrioPop({ p, s }: { p: Pop; s: State }) {
  const qa = p.mode === 'qa';
  const cur = qa ? s.draft.priority : s.tasks[p.id!]?.priority;
  return (
    <>
      <div className="pop-h">Priority</div>
      {([1, 2, 3, 4] as Priority[]).map((k) => (
        <button key={k} className={`opt ${k === cur ? 'cur' : ''}`} data-p={k}
          onClick={() => { if (k === cur) return; closePop(true); if (qa) setDraft({ priority: k }); else void setPriority(p.id!, k); }}>
          <PrioIcon p={k} s={15} />{PRIORITIES[k].name}<span className="r">{k === cur ? 'current' : PRIORITIES[k].hint}</span>
        </button>
      ))}
    </>
  );
}

function ProjPop({ p, s }: { p: Pop; s: State }) {
  const qa = p.mode === 'qa';
  const t = qa ? null : s.tasks[p.id!];
  const cur = qa ? draftEffective(s).projectId : t?.projectId;
  const owner = t ? s.users[t.assigneeId] : null;
  return (
    <>
      <div className="pop-h">Project</div>
      {myProjects(s).map((pr) => {
        const blocked = !!owner && !onProject(owner, pr.id);
        return (
          <button key={pr.id} className={`opt ${pr.id === cur ? 'cur' : ''}`} disabled={blocked} title={pr.description}
            onClick={() => {
              if (pr.id === cur) return;
              closePop(true);
              if (qa) {
                const d = S().draft;
                const a = d.assigneeId ? s.users[d.assigneeId] : null;
                setDraft({ projectId: pr.id, ...(a && !onProject(a, pr.id) ? { assigneeId: null } : {}) });
              } else void setProject(p.id!, pr.id);
            }}>
            <Dot color={pr.color} />{pr.name}
            <span className="r">{pr.id === cur ? 'current' : blocked ? `${firstName(owner!)} isn't on it` : ''}</span>
          </button>
        );
      })}
      {isAdmin(s.me!)
        ? <><div className="pop-sep" /><button className="opt" style={{ color: 'var(--accent)' }}
            onClick={() => { closePop(false); setPage('team'); set({ projEdit: { id: null, name: '', color: '#2E90FA', description: '', members: [], err: null, returnSel: null } }); focusLater('#pe-name'); }}>
            {I.plus(14)} New project…</button></>
        : <div className="pop-foot">Only your projects are listed.</div>}
    </>
  );
}

function PersonPop({ s }: { s: State }) {
  const all = Object.values(s.tasks);
  const ws = addDays(weekStart(s.today), s.weekOffset * 7);
  const we = addDays(ws, 6);
  const list = switchablePeople(s).sort((a, b) => (a.id === s.me!.id ? -1 : b.id === s.me!.id ? 1 : displayName(a).localeCompare(displayName(b))));
  return (
    <>
      <div className="pop-h">View the week of</div>
      {list.map((u) => {
        const open = all.filter((t) => t.assigneeId === u.id && t.status === 'open' && shownOn(t, s.today) >= ws && shownOn(t, s.today) <= we).length;
        const late = all.filter((t) => t.assigneeId === u.id && isLate(t, s.today)).length;
        return (
          <button key={u.id} className={`opt ${u.id === s.viewUser ? 'cur' : ''}`} data-u={u.id}
            onClick={() => { closePop(false); focusLater('[data-act="person"]'); viewPerson(u.id); }}>
            <Avatar user={u} size={24} />{u.id === s.me!.id ? 'Me' : displayName(u)}
            <span className="r">{late > 0 && <><span style={{ color: 'var(--late)' }}>{late} late</span> · </>}{open} open</span>
          </button>
        );
      })}
    </>
  );
}

function ProjPickPop({ s }: { s: State }) {
  const pick = (id: string) => { closePop(false); focusLater('[data-act="proj-pick"]'); set({ projSel: id, projOpen: false }); };
  const count = (id: string) => projectDayData(s, id, s.projDay).done.length;
  return (
    <>
      <div className="pop-h">Show work finished in</div>
      <button className={`opt ${s.projSel === 'all' ? 'cur' : ''}`} onClick={() => pick('all')}>
        <ProjBadge project="all" size={22} />{isAdmin(s.me!) ? 'All projects' : 'All my projects'}<span className="r">{count('all')} done</span>
      </button>
      <div className="pop-sep" />
      {myProjects(s).map((pr) => (
        <button key={pr.id} className={`opt ${pr.id === s.projSel ? 'cur' : ''}`} title={pr.description} onClick={() => pick(pr.id)}>
          <Dot color={pr.color} />{pr.name}<span className="r">{count(pr.id)} done</span>
        </button>
      ))}
    </>
  );
}

function RolePop({ p, s }: { p: Pop; s: State }) {
  const u = s.users[p.userId!];
  const admins = Object.values(s.users).filter((x) => x.status !== 'removed' && x.role === 'admin').length;
  const lastAdmin = u.role === 'admin' && admins <= 1;
  const choose = (role: 'admin' | 'member') => {
    closePop(true);
    void updateUser(u.id, { role }, role === 'admin' ? `${firstName(u)} is now an admin` : `${firstName(u)} is now a member. Check their projects.`);
  };
  return (
    <>
      <div className="pop-h">Role for {displayName(u)}</div>
      <button className={`opt ${u.role === 'admin' ? 'cur' : ''}`} onClick={() => u.role !== 'admin' && choose('admin')}>
        Admin<span className="r">{u.role === 'admin' ? 'current' : 'every project + team'}</span></button>
      <button className={`opt ${u.role === 'member' ? 'cur' : ''}`} disabled={lastAdmin} onClick={() => u.role !== 'member' && choose('member')}>
        Member<span className="r">{u.role === 'member' ? 'current' : lastAdmin ? 'last admin' : 'only their projects'}</span></button>
    </>
  );
}

function UserProjectsPop({ p, s }: { p: Pop; s: State }) {
  const u = s.users[p.userId!];
  const openIn = (pid: string) => Object.values(s.tasks).filter((t) => t.assigneeId === u.id && t.status === 'open' && t.projectId === pid).length;
  return (
    <>
      <div className="pop-h">{displayName(u)} can see</div>
      {Object.values(s.projects).sort((a, b) => a.name.localeCompare(b.name)).map((pr) => {
        const on = u.projects.includes(pr.id);
        const n = openIn(pr.id);
        const lock = on && (n > 0 || u.projects.length === 1);
        return (
          <button key={pr.id} className={`opt check ${on ? 'on' : ''}`} role="menuitemcheckbox" aria-checked={on} disabled={lock} data-p={pr.id}
            onClick={() => void updateUser(u.id, { projects: on ? u.projects.filter((x) => x !== pr.id) : [...u.projects, pr.id] })}>
            <span className="cb">{on && I.check()}</span><Dot color={pr.color} />{pr.name}
            <span className="r">{lock ? (n > 0 ? `${n} open task${n > 1 ? 's' : ''}` : 'needs one') : ''}</span>
          </button>
        );
      })}
      <div className="pop-foot">To take someone off a project, first transfer their open tasks there.</div>
    </>
  );
}

function RemovePop({ p, s }: { p: Pop; s: State }) {
  const u = s.users[p.userId!];
  const open = Object.values(s.tasks).filter((t) => t.assigneeId === u.id && t.status === 'open');
  const projs = [...new Set(open.map((t) => t.projectId))];
  const admins = Object.values(s.users).filter((x) => x.status !== 'removed' && x.role === 'admin').length;
  if (u.role === 'admin' && admins <= 1) return <><div className="pop-h">Can't remove the last admin</div><div className="pop-body">Make someone else an admin first.</div></>;
  const targets = Object.values(s.users).filter((x) => x.id !== u.id && x.status === 'active' && projs.every((pid) => onProject(x, pid)));
  const go = (to?: string) => { closePop(false); focusLater('[data-act="inv-open"]'); void removeUser(u.id, to); };
  return (
    <>
      <div className="pop-h">Remove {displayName(u)}?</div>
      <div className="pop-body">{u.status === 'invited' ? 'Their invite is cancelled and the address can no longer sign in.' : 'They lose access immediately. Their finished work and history stay.'}</div>
      {open.length ? (
        <>
          <div className="pop-h">First, give their {open.length} open task{open.length > 1 ? 's' : ''} to</div>
          {targets.map((x) => (
            <button key={x.id} className="opt" onClick={() => go(x.id)}><Avatar user={x} />{displayName(x)}{x.id === s.me!.id && <span style={{ color: 'var(--faint)' }}> (you)</span>}<span className="r">then remove</span></button>
          ))}
          <div className="pop-foot">Only people on all of their projects are listed.</div>
        </>
      ) : <div style={{ padding: 4 }}><button className="btn-danger" onClick={() => go()}>Remove from team</button></div>}
    </>
  );
}

function AccountPop({ s }: { s: State }) {
  const me = s.me!;
  return (
    <>
      <div className="pop-h" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <Avatar user={me} size={30} />
        <span><b style={{ color: 'var(--text)', display: 'block' }}>{displayName(me)}</b><span style={{ fontWeight: 400 }}>{me.email} · {me.role === 'admin' ? 'Admin' : 'Member'}</span></span>
      </div>
      <div className="pop-sep" />
      <button className="opt" onClick={() => { closePop(false); openConnect(); }}>{I.bolt(15)}Connect an AI assistant</button>
      <button className="opt" onClick={() => void signOut()}>Sign out</button>
    </>
  );
}

// ---------- repeating tasks ----------
function RepeatPop({ p, s }: { p: Pop; s: State }) {
  const qa = p.mode === 'qa';
  const t = qa ? null : s.tasks[p.id!];
  const base = qa ? s.draft.dueDate || defaultDraftDate(s) : t?.dueDate ?? s.today;
  const cur: Repeat | null = qa ? s.draft.repeat : t?.series?.active ? t.series.rule : null;
  const anchor = !qa && t?.series?.active ? t.series.anchor : base;
  const [custom, setCustom] = useState<Repeat | null>(null);
  const choose = (r: Repeat | null) => {
    closePop(true);
    if (qa) setDraft({ repeat: r });
    else if (!sameRule(r, cur)) void setRepeat(p.id!, r);
  };
  if (custom) return <CustomRepeat init={custom} base={base} onBack={() => setCustom(null)} onSave={choose} />;
  const list = presets(base);
  // Rules that read the same count as the same (weekly with no days = weekly on the due date's weekday).
  const isCur = (r: Repeat) => !!cur && (sameRule(r, cur) || describe(r, anchor) === describe(cur, anchor));
  const isPreset = !cur || list.some((x) => isCur(x.rule));
  return (
    <>
      <div className="pop-h">Repeat</div>
      {qa ? (
        <button className={`opt ${!cur ? 'cur' : ''}`} data-act="repeat-none" onClick={() => cur && choose(null)}>
          Doesn't repeat<span className="r">{!cur ? 'current' : ''}</span>
        </button>
      ) : (
        <button className="opt" data-act="repeat-none" title="It can't be turned back on" onClick={() => choose(null)}>Stop repeating</button>
      )}
      {list.map(({ label, rule }) => (
        <button key={label} className={`opt ${isCur(rule) ? 'cur' : ''}`} onClick={() => !isCur(rule) && choose(rule)}>
          {I.refresh(13)}{label}<span className="r">{isCur(rule) ? 'current' : ''}</span>
        </button>
      ))}
      {!isPreset && <button className="opt cur">{I.refresh(13)}{describe(cur!, anchor)}<span className="r">current</span></button>}
      <div className="pop-sep" />
      <button className="opt" data-act="repeat-custom" onClick={() => setCustom(cur ?? { freq: 'week', every: 1, days: [parseDate(base).getDay()] })}>
        Custom…
      </button>
      <div className="pop-foot">{qa ? 'Only one copy is open at a time. The next appears when this one is done.' : 'Stopping is permanent. This copy stays as a normal task.'}</div>
    </>
  );
}

const UNITS: [Freq, string][] = [['day', 'Days'], ['week', 'Weeks'], ['month', 'Months'], ['year', 'Years']];
const WEEK = [1, 2, 3, 4, 5, 6, 0];

function CustomRepeat({ init, base, onBack, onSave }: { init: Repeat; base: string; onBack: () => void; onSave: (r: Repeat) => void }) {
  const [r, setR] = useState<Repeat>(init);
  const [every, setEvery] = useState(String(init.every));
  const [ends, setEnds] = useState<'never' | 'on' | 'after'>(init.until ? 'on' : init.count ? 'after' : 'never');
  const [until, setUntil] = useState(init.until ?? addDays(base, 30));
  const [count, setCount] = useState(String(init.count ?? 10));
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); first.current?.select(); }, []);
  const up = (x: Partial<Repeat>) => setR((o) => ({ ...o, ...x }));
  const dow = parseDate(base).getDay();
  const days = r.days?.length ? r.days : [dow];
  const toggleDay = (d: number) => {
    const next = days.includes(d) ? days.filter((x) => x !== d) : [...days, d];
    if (next.length) up({ days: next });
  };
  const built = cleanRepeat({
    ...r,
    every: Number(every),
    days: r.freq === 'week' ? days : undefined,
    until: ends === 'on' ? until : null,
    count: ends === 'after' ? Number(count) : null,
  });
  const err = typeof built === 'string' ? built : built.until && built.until < base ? 'The end date is before the first one.' : null;
  const save = () => { if (!err && typeof built !== 'string') onSave(built); };
  const d = parseDate(base);
  const nth = Math.ceil(d.getDate() / 7);
  return (
    <div className="rp" onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); save(); } }}>
      <div className="pop-h">Custom repeat</div>
      <div className="rp-row">
        <span className="rp-l">Every</span>
        <input ref={first} className="pin rp-n" inputMode="numeric" aria-label="Interval" value={every}
          onChange={(e) => setEvery(e.target.value.replace(/\D/g, '').slice(0, 2))} />
        <div className="seg sm" role="group" aria-label="Unit">
          {UNITS.map(([u, l]) => (
            <button key={u} className={r.freq === u ? 'on' : ''} aria-pressed={r.freq === u} onClick={() => up({ freq: u })}>{Number(every) > 1 ? l : l.slice(0, -1)}</button>
          ))}
        </div>
      </div>
      {r.freq === 'week' && !r.afterDone && (
        <div className="rp-days" role="group" aria-label="On these days">
          {WEEK.map((x) => (
            <button key={x} className={days.includes(x) ? 'on' : ''} aria-pressed={days.includes(x)} aria-label={DOW[x]} onClick={() => toggleDay(x)}>{DOW[x].slice(0, 2)}</button>
          ))}
        </div>
      )}
      {r.freq === 'month' && !r.afterDone && (
        <div className="rp-row">
          <span className="rp-l">On</span>
          <div className="seg sm" role="group" aria-label="Day of the month">
            <button className={r.monthBy !== 'weekday' ? 'on' : ''} aria-pressed={r.monthBy !== 'weekday'} onClick={() => up({ monthBy: 'date' })}>Day {d.getDate()}</button>
            <button className={r.monthBy === 'weekday' ? 'on' : ''} aria-pressed={r.monthBy === 'weekday'} onClick={() => up({ monthBy: 'weekday' })}>
              {nth >= 5 ? 'Last' : ['1st', '2nd', '3rd', '4th'][nth - 1]} {DOW[dow]}
            </button>
          </div>
        </div>
      )}
      <div className="rp-row">
        <span className="rp-l">Next one</span>
        <div className="seg sm" role="group" aria-label="Count from">
          <button className={!r.afterDone ? 'on' : ''} aria-pressed={!r.afterDone} onClick={() => up({ afterDone: false })}>On schedule</button>
          <button className={r.afterDone ? 'on' : ''} aria-pressed={!!r.afterDone} onClick={() => up({ afterDone: true })}>After done</button>
        </div>
      </div>
      <div className="rp-row">
        <span className="rp-l">Ends</span>
        <div className="seg sm" role="group" aria-label="Ends">
          {(['never', 'on', 'after'] as const).map((x) => (
            <button key={x} className={ends === x ? 'on' : ''} aria-pressed={ends === x} onClick={() => setEnds(x)}>{x === 'never' ? 'Never' : x === 'on' ? 'On date' : 'After'}</button>
          ))}
        </div>
      </div>
      {ends === 'on' && (
        <div className="rp-row"><span className="rp-l" />
          <input className="pin" type="date" aria-label="Last date" min={base} value={until} onChange={(e) => setUntil(e.target.value)} /></div>
      )}
      {ends === 'after' && (
        <div className="rp-row"><span className="rp-l" />
          <input className="pin rp-n" inputMode="numeric" aria-label="Number of times" value={count} onChange={(e) => setCount(e.target.value.replace(/\D/g, '').slice(0, 4))} />
          <span className="rp-l">times</span></div>
      )}
      <div className={`rp-sum ${err ? 'err' : ''}`} role="status">{err ?? describe(built as Repeat, base)}</div>
      <div className="rp-foot">
        <button className="btn-ghost sm" onClick={onBack}>Back</button>
        <button className="go sm" disabled={!!err} onClick={save}>Save</button>
      </div>
    </div>
  );
}
