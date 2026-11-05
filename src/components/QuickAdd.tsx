import { useLayoutEffect, useRef } from 'react';
import { rel } from '../../shared/dates';
import { PRIORITIES } from '../../shared/types';
import { describe } from '../../shared/repeat';
import { createTask, defaultDraftDate, openPop } from '../actions';
import { S, set, useStore } from '../store';
import { draftEffective, firstName } from '../util';
import { Avatar, I, PrioIcon } from './ui';

const setDraft = (p: Partial<ReturnType<typeof S>['draft']>) => set((s) => ({ draft: { ...s.draft, ...p } }));

export function QuickAdd() {
  const s = useStore();
  const d = s.draft;
  const { projectId, assigneeId } = draftEffective(s);
  const open = d.open || !!d.title || !!d.notes;
  const box = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const me = s.me!;
  const who = s.users[assigneeId];
  const project = projectId ? s.projects[projectId] : undefined;
  const due = d.dueDate || defaultDraftDate(s);

  useLayoutEffect(() => {
    const el = notesRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 240) + 'px';
  }, [d.notes, open]);

  const collapseIfIdle = () =>
    setTimeout(() => {
      const a = document.activeElement;
      if (box.current?.contains(a) || document.querySelector('.pop')?.contains(a) || S().pop?.mode === 'qa') return;
      const dd = S().draft;
      if (!dd.title.trim() && !dd.notes.trim()) setDraft({ open: false });
    }, 0);

  const submit = async () => {
    if (!S().draft.title.trim()) {
      box.current?.classList.remove('shake');
      void box.current?.offsetWidth;
      box.current?.classList.add('shake');
      titleRef.current?.focus();
      return;
    }
    if (await createTask()) titleRef.current?.focus();
  };

  const placeholder = open ? 'Task title' : assigneeId === me.id ? 'Add a task…' : `Add a task for ${firstName(who)}…`;

  return (
    <div className={`qa ${open ? 'open' : ''}`} id="qa" ref={box}
      onFocus={() => !S().draft.open && setDraft({ open: true })} onBlur={collapseIfIdle}
      onMouseDown={() => !S().draft.open && setDraft({ open: true })}>
      <div className="qa-top">
        <span className="plus">{I.plus()}</span>
        <input id="qa-input" ref={titleRef} placeholder={placeholder} autoComplete="off" aria-label="Task title" value={d.title}
          onChange={(e) => setDraft({ title: e.target.value, open: true })}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } }} />
        <button className="go qa-go-c" data-act="add" onClick={() => void submit()}>Add</button>
      </div>
      <div className="qa-more">
        <textarea id="qa-notes" ref={notesRef} rows={2} placeholder="Notes (optional): details, links, context" aria-label="Notes"
          value={d.notes} onChange={(e) => setDraft({ notes: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); } }} />
        <div className="qa-foot">
          <div className="chips">
            <button className="chip" data-act="qa-proj" onClick={(e) => openPop({ type: 'proj', mode: 'qa' }, e.currentTarget)}>
              <i style={{ background: project?.color }} />{project?.name ?? 'No project'}
            </button>
            <button className="chip" data-act="qa-date"
              onClick={(e) => openPop({ type: 'move', mode: 'qa', ids: [], month: due.slice(0, 8) + '01' }, e.currentTarget)}>
              {I.cal()}{rel(due, s.today)}
            </button>
            <button className="chip" data-act="qa-repeat" title="Repeat" aria-label={d.repeat ? `Repeats: ${describe(d.repeat, due)}` : 'Repeat'}
              onClick={(e) => openPop({ type: 'repeat', mode: 'qa' }, e.currentTarget)}>
              {I.refresh(13)}{d.repeat && describe(d.repeat, due)}
            </button>
            <button className="chip" data-act="qa-prio" title="Priority (start the title with ! for High, !! for Urgent)"
              onClick={(e) => openPop({ type: 'prio', mode: 'qa' }, e.currentTarget)}>
              <PrioIcon p={d.priority} />{PRIORITIES[d.priority].name}
            </button>
            <button className="chip" data-act="qa-who" onClick={(e) => openPop({ type: 'assign', mode: 'qa' }, e.currentTarget)}>
              <Avatar user={who} size={18} />{assigneeId === me.id ? 'Me' : firstName(who)}
            </button>
          </div>
          <span className="qa-hint"><kbd>Tab</kbd> notes · <kbd>⌘</kbd><kbd>Enter</kbd> add</span>
          <button className="btn-ghost sm" data-act="qa-cancel"
            onClick={() => { setDraft({ title: '', notes: '', open: false }); (document.activeElement as HTMLElement | null)?.blur(); }}>Cancel</button>
          <button className="go" data-act="add-task" onClick={() => void submit()}>Add task</button>
        </div>
      </div>
    </div>
  );
}
