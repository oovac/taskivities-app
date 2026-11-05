// "Update available" for admins. Each instance is deployed by its own team, so the app compares the version it was
// built from (vite.config.ts) with the latest release on GitHub (UPDATE_REPO, default taskivities/taskivities-app).
// The admin's browser asks GitHub, at most every 6 hours, and remembers the answer: the Worker can't, because Workers
// share outgoing addresses and GitHub limits unauthenticated requests per address. Nothing about the team is sent.
import { S, set } from './store';

export const APP_VERSION = __APP_VERSION__;
export const APP_COMMIT = __APP_COMMIT__;

export interface Release { version: string; url: string; publishedAt: string | null }
interface Cached { repo: string; at: number; latest: Release | null }

const KEY = 'tv:update';
const SEEN = 'tv:update-seen';
/** How long an answer from GitHub is reused before asking again. */
const CHECK_EVERY = 6 * 3600e3;

const parts = (v: string) => v.replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
/** Is `a` a newer version than `b`? ("v0.2.0" vs "0.1.3") */
export function isNewer(a: string, b: string) {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

function read(): Cached | null {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null') as Cached | null; } catch { return null; }
}

/** Checks for a newer release (admins only). `force`: ask GitHub now rather than using the remembered answer. */
export async function checkForUpdate(force = false) {
  const repo = S().updateRepo;
  if (!repo || S().me?.role !== 'admin') { set({ update: null }); return; }
  let cached = read();
  if (force || !cached || cached.repo !== repo || Date.now() - cached.at > CHECK_EVERY) {
    set({ updateChecking: true });
    try {
      const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } });
      // 404: the repository has no releases yet.
      if (r.ok || r.status === 404) {
        const j = r.ok ? ((await r.json()) as { tag_name?: string; html_url?: string; published_at?: string }) : null;
        const latest = j?.tag_name ? { version: j.tag_name, url: j.html_url || `https://github.com/${repo}/releases`, publishedAt: j.published_at ?? null } : null;
        cached = { repo, at: Date.now(), latest };
        localStorage.setItem(KEY, JSON.stringify(cached));
      }
    } catch {
      /* offline or GitHub unreachable: try again next time */
    } finally {
      set({ updateChecking: false });
    }
  }
  const latest = cached?.repo === repo ? cached.latest : null;
  set({ latestRelease: latest, updateCheckedAt: cached?.at ?? null, update: latest && isNewer(latest.version, APP_VERSION) ? latest : null });
}

/** The dot on the avatar shows until the admin has looked at this version's notice. */
export const updateSeen = (version: string) => localStorage.getItem(SEEN) === version;
export function markUpdateSeen(version: string) {
  localStorage.setItem(SEEN, version);
  set({ updateSeenTick: Date.now() });
}
