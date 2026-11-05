import { useState } from 'react';
import { closeConnect, toast } from '../actions';
import { I } from './ui';

type Client = 'claude' | 'code' | 'other';

const EXAMPLES = [
  "What's on my plate today?",
  'Add a task to Website Redesign: update the pricing FAQ, due Friday, high priority',
  'Move my overdue tasks to Monday',
  'What did the Acme Corp project finish yesterday?',
  'Transfer the newsletter task to Sara with a note that I\'m out tomorrow',
];

export function ConnectSheet() {
  const url = `${location.origin}/mcp`;
  const [client, setClient] = useState<Client>('claude');
  const codeCmd = `claude mcp add --transport http taskivities ${url}`;

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copied`);
    } catch {
      toast('Copy failed. Select the text and copy it manually.', undefined, true);
    }
  };

  return (
    <>
      <div className="backdrop" onClick={closeConnect} />
      <div className="sheet connect" role="dialog" aria-modal="true" aria-labelledby="cn-title">
        <div className="help-h">
          <b id="cn-title">Connect an AI assistant</b><span className="muted" />
          <button className="icon-btn cn-close" aria-label="Close" onClick={closeConnect}>{I.x()}</button>
        </div>
        <div className="sheet-b">
          <p className="cn-lead">
            Let Claude or another AI assistant read and update your tasks. It acts as <b>you</b>: it only sees your projects, follows the same
            rules, and every change it makes is marked <span className="via">via Claude</span> in the task's history.
          </p>

          <div className="lbl">Your connection address</div>
          <div className="cn-url">
            <code>{url}</code>
            <button className="btn-primary sm" data-act="copy-mcp" onClick={() => void copy(url, 'Address')}>Copy</button>
          </div>

          <div className="lbl" style={{ marginTop: 18 }}>Set it up in</div>
          <div className="seg sm" role="tablist" aria-label="Assistant">
            <button role="tab" aria-selected={client === 'claude'} className={client === 'claude' ? 'on' : ''} onClick={() => setClient('claude')}>Claude app</button>
            <button role="tab" aria-selected={client === 'code'} className={client === 'code' ? 'on' : ''} onClick={() => setClient('code')}>Claude Code</button>
            <button role="tab" aria-selected={client === 'other'} className={client === 'other' ? 'on' : ''} onClick={() => setClient('other')}>Other assistants</button>
          </div>

          {client === 'claude' && (
            <ol className="cn-steps">
              <li>In Claude (web or desktop app), open <b>Settings → Connectors</b>.</li>
              <li>Choose <b>Add custom connector</b>. Name it <b>Taskivities</b> and paste the address above.</li>
              <li>Click <b>Connect</b>. A Taskivities window opens: sign in with Google if asked, then click <b>Allow</b>.</li>
              <li>In a chat, turn on the Taskivities connector and ask away.</li>
            </ol>
          )}
          {client === 'code' && (
            <ol className="cn-steps">
              <li>In a terminal, run:
                <div className="cn-url cmd"><code>{codeCmd}</code>
                  <button className="btn-ghost sm" onClick={() => void copy(codeCmd, 'Command')}>Copy</button></div>
              </li>
              <li>Start Claude Code, type <code>/mcp</code>, pick <b>taskivities</b> and choose <b>Authenticate</b>.</li>
              <li>Your browser opens: sign in with Google if asked, then click <b>Allow</b>.</li>
            </ol>
          )}
          {client === 'other' && (
            <ol className="cn-steps">
              <li>Add a <b>remote MCP server</b> (Streamable HTTP) with the address above.</li>
              <li>It signs in with OAuth, so you don't need an API key. The assistant opens a browser window: sign in with Google, then click <b>Allow</b>.</li>
            </ol>
          )}

          <div className="lbl" style={{ marginTop: 18 }}>Things to ask</div>
          <ul className="cn-examples">
            {EXAMPLES.map((e) => (
              <li key={e}><button className="cn-ex" title="Copy" onClick={() => void copy(e, 'Prompt')}>“{e}”</button></li>
            ))}
          </ul>

          <div className="lbl" style={{ marginTop: 18 }}>What it can do</div>
          <p className="cn-small">
            List your projects (their descriptions tell it where tasks belong) and tasks; create tasks; change a task's date, priority, title,
            notes or project; mark tasks done; transfer them to someone on the same project; and summarize what a project finished on a day.
          </p>
          <p className="cn-small muted">
            A connection lasts a year, then you approve it again. If you're removed from the team or a project, your assistant loses that access
            immediately.
          </p>
        </div>
      </div>
    </>
  );
}
