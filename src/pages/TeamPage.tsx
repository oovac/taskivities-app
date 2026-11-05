import { useRef } from 'react';
import { fmt } from '../../shared/dates';
import { EMAIL_RE, isAdmin } from '../../shared/rules';
import { DESCRIPTION_MAX, PROJECT_COLORS, type Role } from '../../shared/types';
import { addPeople, openPop, saveProject } from '../actions';
import { activeSelector, focusLater } from '../focus';
import { S, set, useStore, type ProjEdit, type State } from '../store';
import { displayName, people } from '../util';
import { Avatar, I } from '../components/ui';

const openIn = (s: State, u: string, p?: string) =>
  Object.values(s.tasks).filter((t) => t.assigneeId === u && t.status === 'open' && (!p || t.projectId === p)).length;

export function openProjEdit(id: string | null) {
  const s = S();
  const p = id ? s.projects[id] : null;
  set({
    projEdit: {
      id, name: p?.name ?? '', color: p?.color ?? PROJECT_COLORS[Object.keys(s.projects).length % PROJECT_COLORS.length],
      description: p?.description ?? '',
      members: id ? people(s).filter((u) => !isAdmin(u) && u.projects.includes(id)).map((u) => u.id) : [],
      err: null, returnSel: activeSelector(),
    },
  });
  focusLater('#pe-name');
}

export function TeamPage() {
  const s = useStore();
  if (!isAdmin(s.me!)) return <div className="empty-sec">Only admins can manage the team.</div>;
  const list = people(s).sort((a, b) => a.status.localeCompare(b.status) || Number(isAdmin(b)) - Number(isAdmin(a)) || displayName(a).localeCompare(displayName(b)));
  const admins = list.filter(isAdmin).length;
  const invited = list.filter((u) => u.status === 'invited').length;
  const projects = Object.values(s.projects).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <div className="phead">
        <div>
          <div className="h1 team-h">Team</div>
          <div className="sub">{list.length} people · {admins} admin{admins === 1 ? '' : 's'}{invited > 0 && ` · ${invited} invited`}</div>
        </div>
        <div className="weeknav">
          {!s.invite && (
            <button className="btn-primary" data-act="inv-open"
              onClick={() => { set({ invite: { emails: '', role: 'member', projects: [], err: null } }); focusLater('#inv-emails'); }}>
              {I.plus(14)} Add people
            </button>
          )}
        </div>
      </div>
      {s.invite && <InviteForm s={s} />}
      <section className="sec">
        <div className="card team">
          <div className="trow th"><div>Person</div><div>Role</div><div>Projects</div><div>Status</div><div /></div>
          {list.map((u) => {
            const me = u.id === s.me!.id;
            return (
              <div key={u.id} className={`trow ${s.flash['u:' + u.id] ? 'flash' : ''}`}>
                <div className="tp">
                  <Avatar user={u} size={32} />
                  <div>
                    <b>{displayName(u)}{me && <span className="you"> (you)</span>}</b>
                    <span title={u.timeZone ? `Time zone: ${u.timeZone}` : undefined}>
                      {u.status === 'invited' ? 'Not signed in yet' : u.email}
                      {u.status !== 'invited' && u.timeZone && ` · ${u.timeZone.split('/').pop()!.replace(/_/g, ' ')}`}
                    </span>
                  </div>
                </div>
                <div>
                  <button className="chip" data-act="urole" data-u={u.id} disabled={me} title={me ? "You can't change your own role" : undefined}
                    onClick={(e) => openPop({ type: 'urole', userId: u.id }, e.currentTarget)}>
                    {u.role === 'admin' ? 'Admin' : 'Member'} {!me && I.chev()}
                  </button>
                </div>
                <div className="tproj">
                  {u.role === 'admin' ? <span className="allp">All projects</span> : (
                    <button className="pbtn" data-act="uproj" data-u={u.id} aria-label={`Projects for ${displayName(u)}`}
                      onClick={(e) => openPop({ type: 'uproj', userId: u.id }, e.currentTarget)}>
                      {u.projects.map((p) => s.projects[p] && <span key={p} className="proj"><i style={{ background: s.projects[p].color }} />{s.projects[p].name}</span>)}
                      <span className="pedit">{I.chev()}</span>
                    </button>
                  )}
                </div>
                <div className="tstat">
                  {u.status === 'invited' ? <span className="st inv">Invited · {fmt(u.addedAt.slice(0, 10)).split(', ')[1]}</span> : <span className="st ok">Active</span>}
                </div>
                <div className="tact">
                  {!me && (
                    <button className="icon-btn" data-act="uremove" data-u={u.id} title="Remove from team" aria-label={`Remove ${displayName(u)}`}
                      onClick={(e) => openPop({ type: 'uremove', userId: u.id }, e.currentTarget)}>{I.trash()}</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <p className="fine">Admins see every project and manage people. Members see and work on tasks only in their projects, and can only assign tasks to people on the same project.</p>
      </section>
      <section className="sec">
        <div className="sec-h"><h2>Projects</h2><span className="cnt">who's on each one</span>
          <button className="link" style={{ marginLeft: 'auto' }} data-act="pe-new" onClick={() => openProjEdit(null)}>+ New project</button></div>
        <div className="card">
          {projects.map((p) => {
            const ppl = people(s).filter((u) => u.status === 'active' && !isAdmin(u) && u.projects.includes(p.id));
            return (
              <div key={p.id} className="prow">
                <i style={{ background: p.color }} />
                <div className="pname">
                  <b>{p.name}</b>
                  <span className="pdesc" title={p.description}>{p.description || <em>No description yet. AI assistants will guess what belongs here.</em>}</span>
                </div>
                <span className="avs">{ppl.map((u) => <Avatar key={u.id} user={u} size={22} />)}</span>
                <span className="n">{ppl.length} member{ppl.length === 1 ? '' : 's'} + admins</span>
                <span className="n">{Object.values(s.tasks).filter((t) => t.projectId === p.id && t.status === 'open').length} open</span>
                <button className="btn-ghost sm" data-act="pe-open" data-p={p.id} aria-label={`Edit ${p.name}`} onClick={() => openProjEdit(p.id)}>Edit</button>
              </div>
            );
          })}
          {!projects.length && <div className="prow"><span className="n">No projects yet. Create the first one.</span></div>}
        </div>
      </section>
      {s.projEdit && <ProjectEditor pe={s.projEdit} s={s} />}
    </>
  );
}

function InviteForm({ s }: { s: State }) {
  const inv = s.invite!;
  const ref = useRef<HTMLInputElement>(null);
  const upd = (p: Partial<NonNullable<State['invite']>>) => set((st) => ({ invite: st.invite ? { ...st.invite, ...p } : null }));
  const close = () => { set({ invite: null }); focusLater('[data-act="inv-open"]'); };
  const submit = async () => {
    const emails = [...new Set(inv.emails.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))];
    const bad = emails.filter((e) => !EMAIL_RE.test(e));
    if (!emails.length) { upd({ err: 'Enter at least one email address.' }); ref.current?.focus(); return; }
    if (bad.length) { upd({ err: `Not a valid email: ${bad.join(', ')}` }); ref.current?.focus(); return; }
    if (inv.role === 'member' && !inv.projects.length) { upd({ err: 'Pick at least one project for a member.' }); return; }
    upd({ busy: true, err: null });
    try {
      await addPeople(emails, inv.role, inv.projects);
      close();
    } catch (e) {
      upd({ busy: false, err: e instanceof Error ? e.message : 'Could not add.' });
    }
  };
  const setRole = (role: Role) => upd({ role, err: null });
  return (
    <div className="invite card" role="group" aria-label="Add people"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
      <label className="lbl" htmlFor="inv-emails">Email addresses</label>
      <input id="inv-emails" ref={ref} className="inv-in" placeholder="name@yourcompany.com, someone@client.com" autoComplete="off"
        value={inv.emails} onChange={(e) => upd({ emails: e.target.value, err: null })}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } }} />
      {inv.err && <div className="inv-err" role="alert">{inv.err}</div>}
      <div className="inv-grid">
        <div>
          <div className="lbl">Role</div>
          <div className="seg sm">
            <button className={inv.role === 'member' ? 'on' : ''} onClick={() => setRole('member')}>Member</button>
            <button className={inv.role === 'admin' ? 'on' : ''} onClick={() => setRole('admin')}>Admin</button>
          </div>
        </div>
        <div>
          <div className="lbl">Projects</div>
          {inv.role === 'admin' ? <div className="muted-s">Admins can see every project and manage the team.</div> : (
            <div className="pchips">
              {Object.values(s.projects).sort((a, b) => a.name.localeCompare(b.name)).map((p) => {
                const on = inv.projects.includes(p.id);
                return (
                  <button key={p.id} className={`pchip ${on ? 'on' : ''}`} aria-pressed={on}
                    onClick={() => upd({ err: null, projects: on ? inv.projects.filter((x) => x !== p.id) : [...inv.projects, p.id] })}>
                    <i style={{ background: p.color }} />{p.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <div className="inv-foot">
        <span className="muted-s">They sign in with Google using exactly this address. No one else can get in.</span>
        <button className="btn-ghost" onClick={close}>Cancel</button>
        <button className="btn-primary" disabled={inv.busy} onClick={() => void submit()}>{inv.busy ? 'Adding…' : 'Add'}</button>
      </div>
    </div>
  );
}

export function ProjectEditor({ pe, s }: { pe: ProjEdit; s: State }) {
  const isNew = !pe.id;
  const upd = (p: Partial<ProjEdit>) => set((st) => ({ projEdit: st.projEdit ? { ...st.projEdit, ...p } : null }));
  const close = () => { const r = pe.returnSel; set({ projEdit: null }); focusLater(r); };
  const save = async () => {
    if (!pe.name.trim()) { upd({ err: 'Give the project a name.' }); focusLater('#pe-name'); return; }
    upd({ busy: true, err: null });
    const err = await saveProject({ id: pe.id, name: pe.name.trim(), color: pe.color, description: pe.description.trim(), members: pe.members });
    if (err) { upd({ busy: false, err }); focusLater('#pe-name'); return; }
    set({ projEdit: null });
    focusLater(pe.id ? `[data-act="pe-open"][data-p="${pe.id}"]` : '[data-act="pe-new"]');
  };
  const members = people(s).filter((u) => !isAdmin(u));
  return (
    <>
      <div className="backdrop" onClick={close} />
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="pe-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.stopPropagation(); close(); }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (e.target as HTMLElement).id === 'pe-name')) { e.preventDefault(); void save(); }
        }}>
        <div className="help-h"><b id="pe-title">{isNew ? 'New project' : 'Edit project'}</b><span className="muted" />
          <button className="icon-btn" aria-label="Close" onClick={close}>{I.x()}</button></div>
        <div className="sheet-b">
          <label className="lbl" htmlFor="pe-name">Name</label>
          <input id="pe-name" className="inv-in" value={pe.name} placeholder="e.g. Website Redesign" autoComplete="off" onChange={(e) => upd({ name: e.target.value, err: null })} />
          {pe.err && <div className="inv-err" role="alert">{pe.err}</div>}
          <div className="lbl">Color</div>
          <div className="swatches" role="radiogroup" aria-label="Color">
            {PROJECT_COLORS.map((c) => (
              <button key={c} className={`sw ${c === pe.color ? 'on' : ''}`} style={{ ['--c' as string]: c }} role="radio" aria-checked={c === pe.color}
                aria-label={`Color ${c}`} onClick={() => upd({ color: c })} />
            ))}
          </div>
          <label className="lbl" htmlFor="pe-desc">Description <span className="muted">· read mainly by AI assistants</span></label>
          <textarea id="pe-desc" className="pe-desc" maxLength={DESCRIPTION_MAX} value={pe.description} onChange={(e) => upd({ description: e.target.value })}
            placeholder={'What work belongs here, what doesn\'t, and how tasks are usually named. For example: Redesign of the marketing site: pages, copy, imagery, SEO. Not the app or blog. Titles start with the page, e.g. "Pricing: update FAQ".'} />
          <div className="pe-help">
            <span>{I.bolt()} Assistants connected over MCP (like Claude) read this to decide which project a new task belongs in and what a project is about. People see it as a tooltip.</span>
            <span className="pe-count">{pe.description.length}/{DESCRIPTION_MAX}</span>
          </div>
          <div className="lbl">Members <span className="muted">· admins are on every project</span></div>
          <div className="pchips">
            {members.map((u) => {
              const on = pe.members.includes(u.id);
              const n = pe.id ? openIn(s, u.id, pe.id) : 0;
              const lock = on && !!pe.id && (n > 0 || u.projects.length === 1);
              return (
                <button key={u.id} className={`pchip ${on ? 'on' : ''}`} aria-pressed={on} disabled={lock}
                  title={lock ? (n > 0 ? 'Has open tasks here' : 'Needs at least one project') : undefined}
                  onClick={() => upd({ members: on ? pe.members.filter((x) => x !== u.id) : [...pe.members, u.id] })}>
                  <Avatar user={u} size={18} />{displayName(u)}
                </button>
              );
            })}
            {!members.length && <span className="muted-s">No members yet. Add people on this page first.</span>}
          </div>
        </div>
        <div className="inv-foot sheet-f">
          <span className="muted-s"><span className="kbd-i">⌘ Enter</span> to save</span>
          <button className="btn-ghost" onClick={close}>Cancel</button>
          <button className="btn-primary" disabled={pe.busy} onClick={() => void save()}>{pe.busy ? 'Saving…' : isNew ? 'Create project' : 'Save'}</button>
        </div>
      </div>
    </>
  );
}
