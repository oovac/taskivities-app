import { useState } from 'react';
import { LogoMark } from '../components/ui';

const GLOGO = (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
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
  unverified: "That Google account's email isn't verified.",
};

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
  return (
    <div className="app">
      <div className="signin">
        <div className="si-card">
          <LogoMark big />
          <h1>Taskivities</h1>
          <p>Your team's week, at a glance.</p>
          {error === 'no_access' && (
            <div className="si-msg" role="alert">
              {denied ? <><b>{denied}</b> doesn't</> : "That Google account doesn't"} have access to Taskivities. Ask an admin to add this address, or sign in with the one they added.
            </div>
          )}
          {error && MESSAGES[error] && <div className="si-msg" role="alert">{MESSAGES[error]}</div>}
          <a className="gbtn" href={`/auth/login${nextQs ? `?${nextQs}` : ''}`} style={{ textDecoration: 'none', color: 'inherit' }}>{GLOGO} Continue with Google</a>
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
