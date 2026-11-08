// A task added in the app shows at once, under a temporary id, while the server makes it. Anything done to it in the
// meantime (tick it, move it, open it) is sent once the real id is known: requests wait on `realId()`.

const waiting = new Map<string, Promise<string>>();
const toReal = new Map<string, string>();
const toTemp = new Map<string, string>();
const failed = new Set<string>();

/** A temporary id (`prefix` + a random part), and how to settle it once the server answers. */
export function newTemp(prefix = '') {
  const id = `${prefix}tmp-${crypto.randomUUID()}`;
  let done!: (real: string) => void, fail!: (e: unknown) => void;
  const p = new Promise<string>((res, rej) => { done = res; fail = rej; });
  p.catch(() => {}); // nobody may be waiting
  waiting.set(id, p);
  return {
    id,
    done: (real: string) => { toReal.set(id, real); toTemp.set(real, id); waiting.delete(id); done(real); },
    fail: (e: unknown) => { failed.add(id); waiting.delete(id); fail(e); },
  };
}

/** The id to send to the server: waits for a task that's still being made (throws if making it failed). */
export async function realId(id: string): Promise<string> {
  const w = waiting.get(id);
  if (w) return w;
  if (failed.has(id)) throw new Error("That task wasn't added.");
  return toReal.get(id) ?? id;
}
/** The id a task has now in the app (its real one once made). */
export const liveId = (id: string) => toReal.get(id) ?? id;
/** The temporary id a task had, if it was added here. */
export const tempOf = (id: string) => toTemp.get(id);
/** Still being made (no real id yet). */
export const isMaking = (id: string) => waiting.has(id);
/** Making it failed: it's gone. */
export const isDropped = (id: string) => failed.has(id);
