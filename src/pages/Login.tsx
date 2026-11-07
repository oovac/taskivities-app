import { useEffect, useState } from 'react';
import { I, LogoMark } from '../components/ui';

const GLOGO = (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>
);

const MSLOGO = (
  <svg width="18" height="18" viewBox="0 0 23 23" aria-hidden="true">
    <rect x="1" y="1" width="10" height="10" fill="#F25022" />
    <rect x="12" y="1" width="10" height="10" fill="#7FBA00" />
    <rect x="1" y="12" width="10" height="10" fill="#00A4EF" />
    <rect x="12" y="12" width="10" height="10" fill="#FFB900" />
  </svg>
);

const readCookie = (name: string) => {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
};

const MESSAGES: Record<string, string> = {
  cancelled: 'Sign-in was cancelled. Try again when you\'re ready.',
  expired: 'That sign-in link expired. Please try again.',
  google: "Google didn't complete the sign-in. Please try again.",
  workos: "The email sign-in didn't complete. Please try again.",
  microsoft: "Microsoft didn't complete the sign-in. Please try again.",
  unverified: "That account's email address isn't verified.",
};

/** Which sign-in methods this instance has set up (WorkOS is optional), and the team's name and wordmark. */
type Methods = { google: boolean; workos: boolean; microsoft?: boolean; name?: string; wordmark?: string | null };

export function Login() {
  const params = new URLSearchParams(location.search);
  const error = params.get('error');
  // Set when an AI assistant's sign-in (/authorize) sent the person here first.
  const next = params.get('next');
  const nextQs = next ? `next=${encodeURIComponent(next)}` : '';
  const [denied] = useState(() => {
    const v = readCookie('tv_denied');
    if (v) document.cookie = 'tv_denied=; Max-Age=0; Path=/';
    return v;
  });
  const [devEmail, setDevEmail] = useState('jordan@example.com');
  // null while loading, so an instance without Google doesn't flash its button.
  const [methods, setMethods] = useState<Methods | null>(null);
  useEffect(() => {
    const fallback: Methods = { google: true, workos: false };
    fetch('/auth/methods').then((r) => (r.ok ? r.json() : fallback)).then((m: Methods) => {
      setMethods(m);
      if (m.name) document.title = m.name;
    }).catch(() => setMethods(fallback));
  }, []);
  const q = nextQs ? `?${nextQs}` : '';
  return (
    <div className="app">
      <div className="signin">
        <div className="si-card">
          <LogoMark big />
          {methods?.wordmark
            ? <h1 className="si-wordmark"><img src={`/wordmark.svg?v=${encodeURIComponent(methods.wordmark)}`} alt={methods.name || 'Taskivities'} /></h1>
            : <h1>{methods ? methods.name || 'Taskivities' : '\u00a0'}</h1>}
          <p>Your team's week, at a glance.</p>
          {error === 'no_access' && (
            <div className="si-msg" role="alert">
              {denied ? <><b>{denied}</b> doesn't</> : "That account doesn't"} have access to {methods?.name || 'Taskivities'}. Ask an admin to add this address (or enable it again, if it was disabled), or sign in with the one they added.
            </div>
          )}
          {error && MESSAGES[error] && <div className="si-msg" role="alert">{MESSAGES[error]}</div>}
          {methods?.microsoft && <a className="gbtn" href={`/auth/microsoft${q}`}>{MSLOGO} Continue with Microsoft</a>}
          {methods?.google && <a className="gbtn" href={`/auth/login${q}`}>{GLOGO} Continue with Google</a>}
          {methods?.workos && <a className="gbtn" data-act="signin-email" href={`/auth/workos${q}`}>{I.mail(18)} Continue with email</a>}
          <div className="si-foot">Only people an admin has added can sign in.</div>
          {import.meta.env.DEV && (
            <div className="si-dev">
              <div className="lbl">Local development sign-in</div>
              <form onSubmit={(e) => { e.preventDefault(); location.href = `/auth/dev-login?email=${encodeURIComponent(devEmail)}${nextQs ? `&${nextQs}` : ''}`; }}>
                <input value={devEmail} onChange={(e) => setDevEmail(e.target.value)} aria-label="Email to sign in as" />
                <button type="submit">Sign in</button>
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
