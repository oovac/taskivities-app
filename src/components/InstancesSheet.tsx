// "Other instances" (account menu): connect other Taskivities instances to this app, so your tasks there show with
// yours and you work on them from here (src/sources.ts). Their notifications come through this instance.
import { useEffect, useState } from 'react';
import { toast } from '../actions';
import { focusLater } from '../focus';
import { connectInstance, connectedElsewhere, disconnectInstance, type SourceInfo } from '../sources';
import { set, type State } from '../store';
import { I } from './ui';

export const closeInstances = () => { set({ instancesOpen: false }); focusLater('[data-act="account"]'); };
const host = (url: string) => url.replace(/^https?:\/\//, '');
const STATUS: Record<SourceInfo['status'], string> = { ok: 'Connected', loading: 'Loading…', error: 'Not reachable right now', 'signed-out': 'Signed out there' };

export function InstancesSheet({ s }: { s: State }) {
  const prefill = typeof s.instancesOpen === 'string' ? s.instancesOpen : '';
  const [url, setUrl] = useState(prefill ? host(prefill) : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [elsewhere, setElsewhere] = useState<{ origin: string; user: string }[]>([]);

  useEffect(() => { void connectedElsewhere().then(setElsewhere).catch(() => {}); }, [s.sources.length]);

  const connect = async (target = url, reconnect = false) => {
    if (!target.trim()) { setErr('Give the address of the other instance.'); return; }
    setBusy(true); setErr('');
    try { await connectInstance(target, reconnect); } catch (e) { setErr(e instanceof Error ? e.message : "Couldn't connect."); setBusy(false); }
  };
  const remove = async (x: SourceInfo) => {
    await disconnectInstance(x.id);
    toast(`Disconnected ${x.name} on this device. Its tasks stay there, as they were.`);
  };

  return (
    <>
      <div className="backdrop" onClick={closeInstances} />
      <div className="sheet instances" role="dialog" aria-modal="true" aria-labelledby="in-title"
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); closeInstances(); } }}>
        <div className="help-h">
          <b id="in-title">Other instances</b><span className="muted" />
          <button className="icon-btn" aria-label="Close" onClick={closeInstances}>{I.x()}</button>
        </div>
        <div className="sheet-b">
          <p className="cn-lead">
            On other Taskivities instances too, like your team's at work? Connect them and work on everything from here: your tasks there show in
            your day, week and board, and you can do anything with them that you could there. Their notifications come to this app too.
          </p>

          {s.sources.length > 0 && (
            <div className="card in-list">
              {s.sources.map((x) => (
                <div key={x.id} className="in-row">
                  <i className="in-dot" style={{ background: x.color }} />
                  <div className="in-main">
                    <b>{x.name}</b>
                    <span>{host(x.origin)}{x.user ? ` · as ${x.user}` : ''} · <span className={x.status === 'ok' ? '' : 'in-err'}>{x.status === 'error' && x.error ? x.error : STATUS[x.status]}</span></span>
                  </div>
                  {x.status === 'signed-out' && <button className="btn-primary sm" onClick={() => void connect(x.origin, true)}>Reconnect</button>}
                  <a className="btn-ghost sm" href={x.origin} target="_blank" rel="noopener">Open</a>
                  <button className="btn-ghost sm" data-act="source-remove" onClick={() => void remove(x)}>Disconnect</button>
                </div>
              ))}
            </div>
          )}

          {elsewhere.length > 0 && (
            <>
              <div className="lbl" style={{ marginTop: 16 }}>Connected on another device</div>
              <div className="card in-list">
                {elsewhere.map((o) => (
                  <div key={o.origin} className="in-row">
                    <span className="in-key">{I.link(14)}</span>
                    <div className="in-main"><b>{host(o.origin)}</b><span>{o.user ? `As ${o.user}. ` : ''}Its notifications already come here. Connect this device to see its tasks.</span></div>
                    <button className="btn-primary sm" data-act="source-reconnect" disabled={busy} onClick={() => void connect(o.origin, true)}>Connect</button>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="in-add">
            <label className="lbl" htmlFor="in-url">Connect an instance</label>
            <input id="in-url" className="inv-in" placeholder="work.example.com" autoComplete="off" value={url} autoFocus={!!prefill}
              onChange={(e) => { setUrl(e.target.value); setErr(''); }} onKeyDown={(e) => { if (e.key === 'Enter') void connect(); }} />
            {err && <div className="inv-err" role="alert">{err}</div>}
            <div className="in-foot">
              <span className="muted-s">You'll sign in there and approve, then come back here.</span>
              <button className="btn-primary sm" data-act="source-connect" disabled={busy} onClick={() => void connect()}>{busy ? 'Opening…' : 'Connect'}</button>
            </div>
          </div>

          <p className="cn-small muted" style={{ marginTop: 18 }}>
            This device keeps the sign-in (connect each phone or computer once). It acts as you there, like an AI assistant you connect: it sees
            what you see and follows the same rules. To stop it, disconnect here, or revoke it on the other instance.
          </p>
        </div>
      </div>
    </>
  );
}
