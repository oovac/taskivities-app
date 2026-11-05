import { closeHelp } from '../actions';
import { I } from './ui';

const G = ({ title, rows }: { title: string; rows: [string, string][] }) => (
  <div className="hk-g">
    <h4>{title}</h4>
    {rows.map(([keys, desc]) => (
      <div className="hk-r" key={desc}>
        <span>{desc}</span>
        <span className="hk-k">
          {keys.split(' / ').map((alt, i) => (
            <span key={alt} style={{ display: 'contents' }}>
              {i > 0 && <i>or</i>}
              {alt.split(' ').map((k) => <kbd key={k}>{k}</kbd>)}
            </span>
          ))}
        </span>
      </div>
    ))}
  </div>
);

export function HelpSheet() {
  return (
    <>
      <div className="backdrop" onClick={closeHelp} />
      <div className="help" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <div className="help-h">
          <b>Keyboard shortcuts</b><span className="muted">Press <kbd>?</kbd> anytime</span>
          <button className="icon-btn help-close" aria-label="Close" onClick={closeHelp}>{I.x()}</button>
        </div>
        <div className="help-b">
          <G title="Move around" rows={[['↑ ↓ / J K', 'Previous / next task'], ['← → / H L', 'Previous / next day (board)'], ['Enter', 'Open the task'], ['Tab', 'Next control'], ['Esc', 'Close panel or menu']]} />
          <G title="Selected task" rows={[['X / Space', 'Done / not done'], ['D', 'Change date'], ['⇧ ← ⇧ →', 'One day earlier / later'], ['T', 'Transfer to someone'], ['R', 'Change repeat (repeating)'], ['S', 'Skip this copy (repeating)'], ['1 2 3 4', 'Urgent · High · Normal · Low'], ['E', 'Rename']]} />
          <G title="Anywhere" rows={[['N', 'New task'], ['V', 'Today → Week → Board'], ['P', 'Switch person (or project)'], ['[ ]', 'Previous / next week (or day)'], ['G T / G P / G U / G S', 'Go to Tasks / Projects / Team / Settings'], ['⌘ Z', 'Undo']]} />
          <G title="Menus & calendar" rows={[['↑ ↓', 'Choose an option'], ['← → ↑ ↓', 'Pick a day in the calendar'], ['Enter', 'Select'], ['Type', 'Search people'], ['Esc', 'Back without changing']]} />
        </div>
      </div>
    </>
  );
}
