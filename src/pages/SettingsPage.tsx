import { useRef, useState } from 'react';
import { isAdmin } from '../../shared/rules';
import { resetLogo, uploadLogo } from '../actions';
import { logoUrl } from '../brand';
import { LogoMark } from '../components/ui';
import { useStore } from '../store';

const MAX_KB = 256;

/** Checks the file in the browser first (the server checks again): SVG only, and it must actually draw. */
async function readSvg(file: File): Promise<string> {
  if (!/\.svg$/i.test(file.name) && file.type !== 'image/svg+xml') throw new Error('Only SVG files are supported.');
  if (file.size > MAX_KB * 1024) throw new Error(`The logo must be under ${MAX_KB} KB.`);
  const text = await file.text();
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (doc.querySelector('parsererror') || doc.documentElement.nodeName.toLowerCase() !== 'svg') throw new Error("That file isn't a valid SVG.");
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
  try {
    await new Promise<void>((ok, fail) => {
      const img = new Image();
      img.onload = () => ok();
      img.onerror = () => fail(new Error("That SVG can't be displayed. Try exporting it again."));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
  return text;
}

export function SettingsPage() {
  const s = useStore();
  const file = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!isAdmin(s.me!)) return <div className="empty-sec">Only admins can change settings.</div>;
  const { customLogo, logoVersion } = s.settings;

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setErr(null);
    setBusy(true);
    try {
      setErr(await uploadLogo(await readSvg(f)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Upload failed.');
    } finally {
      setBusy(false);
      if (file.current) file.current.value = '';
    }
  };

  return (
    <>
      <div className="phead">
        <div>
          <div className="h1 team-h">Settings</div>
          <div className="sub">These apply to everyone on the team. Only admins can change them.</div>
        </div>
      </div>
      <section className="sec">
        <div className="sec-h"><h2>Logo</h2><span className="cnt">{customLogo ? 'Custom' : 'Built-in'}</span></div>
        <div className="card set-card">
          <div className="set-prev" aria-label="Preview">
            <div className="sp-head"><LogoMark version={logoVersion} />taskivities</div>
            <div className="sp-tab"><img src={logoUrl(logoVersion)} alt="" />Taskivities<span className="x">×</span></div>
          </div>
          <div className="set-body">
            <p>Shown in the header, on the sign-in page and as the browser tab icon. <b>SVG only</b>, up to {MAX_KB} KB. A square logo works best.</p>
            <div className="set-actions">
              <button className="btn-primary" data-act="logo-upload" disabled={busy} onClick={() => file.current?.click()}>
                {busy ? 'Uploading…' : customLogo ? 'Replace logo…' : 'Upload SVG logo…'}
              </button>
              {customLogo && <button className="btn-ghost" data-act="logo-reset" disabled={busy} onClick={() => { setErr(null); void resetLogo(); }}>Use the built-in logo</button>}
            </div>
            {err && <div className="set-err" role="alert">{err}</div>}
            <input ref={file} type="file" accept=".svg,image/svg+xml" hidden aria-hidden="true" tabIndex={-1}
              onChange={(e) => void pick(e.target.files?.[0])} />
          </div>
        </div>
      </section>
    </>
  );
}
