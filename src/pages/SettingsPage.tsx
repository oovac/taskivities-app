import { useEffect, useRef, useState } from 'react';
import { isAdmin } from '../../shared/rules';
import { connectGmail, createHook, disconnectGmail, loadHooks, openHook, resetIcon, resetLogo, uploadIcon, uploadLogo } from '../actions';
import { ICON_SIZES } from '../../shared/types';
import { hookStatus } from '../components/WebhookSheet';
import { logoUrl } from '../brand';
import { I, LogoMark, Wordmark } from '../components/ui';
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
            <div className="sp-head"><LogoMark version={logoVersion} /><Wordmark /></div>
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
      <AppIcon />
      <Webhooks />
      <section className="sec">
        <div className="sec-h"><h2>Invite emails</h2><span className="cnt">{s.gmail ? 'On' : 'Off'} · just for you</span></div>
        <div className="card set-card">
          <div className="set-body">
            {s.gmail ? (
              <p>When you add people, Taskivities emails them an invite from <b>{s.gmail.email}</b> through your Gmail. A copy is in your Sent folder, and replies come to you.</p>
            ) : (
              <p>Connect your Gmail and Taskivities emails people an invite from your address when you add them. Until then, you send them the sign-in link yourself.
                Google will ask you to allow <b>sending email</b> on your behalf: Taskivities can't read your mail.</p>
            )}
            <div className="set-actions">
              {s.gmail ? (
                <button className="btn-ghost" data-act="gmail-disconnect" onClick={() => void disconnectGmail()}>Disconnect Gmail</button>
              ) : (
                <button className="btn-primary" data-act="gmail-connect" onClick={() => connectGmail('/settings')}>{I.mail(14)} Connect Gmail</button>
              )}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

function Webhooks() {
  const s = useStore();
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { void loadHooks(); }, []);
  const add = async () => {
    if (!name.trim()) { setErr('Give it a name, like "GitHub issues".'); return; }
    try { await createHook(name.trim()); setName(''); setErr(null); } catch (e) { setErr(e instanceof Error ? e.message : 'Could not create it.'); }
  };
  return (
    <section className="sec">
      <div className="sec-h"><h2>Webhooks</h2><span className="cnt">Create tasks from other services</span></div>
      <div className="card hk-card">
        <p className="hk-intro">Give another service (GitHub, a form, Zapier, your own app…) an address to send requests to. A new webhook first collects a few
          sample requests; you click their fields to decide what each task says, then it goes live and every request becomes a task.</p>
        {s.hooks?.map((h) => {
          const [label, cls] = hookStatus(h);
          return (
            <div key={h.id} className="hk-item">
              <b>{h.name}</b>
              <span className={`hk-st ${cls}`}>{label}</span>
              <span className="muted-s">{h.lastReceivedAt ? `Last request ${new Date(h.lastReceivedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'No requests yet'}</span>
              <button className="btn-ghost sm" data-act="hook-open" onClick={() => openHook(h.id)}>Open</button>
            </div>
          );
        })}
        <div className="hk-new">
          <input className="pin" placeholder='New webhook name, e.g. "GitHub issues"' aria-label="New webhook name" value={name} maxLength={80}
            onChange={(e) => { setName(e.target.value); setErr(null); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void add(); } }} />
          <button className="btn-primary" data-act="hook-new" onClick={() => void add()}>{I.plus(14)} New webhook</button>
        </div>
        {err && <div className="set-err" role="alert">{err}</div>}
      </div>
    </section>
  );
}

/**
 * Resizes an uploaded image to each home-screen icon size (PNG). Non-square images are centred on white;
 * transparent areas become white too, since iPhones would show them as black.
 */
async function makeIcons(file: File): Promise<{ icons: Record<number, string>; small: boolean }> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Choose a PNG image (JPEG and WebP work too).');
  if (file.size > 10 * 1024 * 1024) throw new Error('That image is over 10 MB.');
  let img: ImageBitmap;
  try { img = await createImageBitmap(file); } catch { throw new Error("That image couldn't be read."); }
  const icons: Record<number, string> = {};
  for (const size of ICON_SIZES) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, size, size);
    g.imageSmoothingQuality = 'high';
    const scale = Math.min(size / img.width, size / img.height);
    const w = img.width * scale, h = img.height * scale;
    g.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    const blob = await new Promise<Blob>((ok, fail) => c.toBlob((b) => (b ? ok(b) : fail(new Error("That image couldn't be converted."))), 'image/png'));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    icons[size] = btoa(bin);
  }
  return { icons, small: Math.min(img.width, img.height) < 512 };
}

function AppIcon() {
  const s = useStore();
  const file = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { customIcon, iconVersion } = s.settings;
  const pick = async (f: File | undefined) => {
    if (!f) return;
    setErr(null); setNote(null); setBusy(true);
    try {
      const { icons, small } = await makeIcons(f);
      const e = await uploadIcon(icons);
      setErr(e);
      if (!e && small) setNote('That image is smaller than 512×512, so the icon may look a little soft. A larger square PNG works best.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Upload failed.');
    } finally {
      setBusy(false);
      if (file.current) file.current.value = '';
    }
  };
  return (
    <section className="sec">
      <div className="sec-h"><h2>App icon</h2><span className="cnt">{customIcon ? 'Custom' : 'Built-in'} · phone home screens</span></div>
      <div className="card set-card">
        <div className="set-prev icon-prev" aria-label="Preview">
          <div className="ip-phone">
            <img src={`/icons/180.png?v=${iconVersion}`} alt="" />
            <span>Taskivities</span>
          </div>
        </div>
        <div className="set-body">
          <p>Shown when someone adds Taskivities to their phone's home screen, and in app switchers. <b>A square PNG, 512×512 or larger</b>, works best.
            Phones round the corners themselves; transparent areas become white.</p>
          <div className="set-actions">
            <button className="btn-primary" data-act="icon-upload" disabled={busy} onClick={() => file.current?.click()}>
              {busy ? 'Uploading…' : customIcon ? 'Replace icon…' : 'Upload PNG icon…'}
            </button>
            {customIcon && <button className="btn-ghost" data-act="icon-reset" disabled={busy} onClick={() => { setErr(null); setNote(null); void resetIcon(); }}>Use the built-in icon</button>}
          </div>
          {err && <div className="set-err" role="alert">{err}</div>}
          {note && <div className="set-note" role="status">{note}</div>}
          <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden aria-hidden="true" tabIndex={-1} onChange={(e) => void pick(e.target.files?.[0])} />
        </div>
      </div>
    </section>
  );
}
