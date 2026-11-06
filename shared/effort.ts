// Effort: how a project measures the work in its tasks (migrations/0016_effort.sql). A project picks one preset type,
// or none; a task stores '<type>:<value>', so values of another type (after a move or a change) are kept but ignored.

export type EffortType = 'time' | 'tshirt' | 'fibo';

export const EFFORT_TYPES: Record<EffortType, { name: string; hint: string; values?: readonly string[] }> = {
  time: { name: 'Time spent', hint: 'Actual time, like 1h 30m' },
  tshirt: { name: 'T-shirt size', hint: 'XS, S, M, L, XL', values: ['XS', 'S', 'M', 'L', 'XL'] },
  fibo: { name: 'Story points', hint: 'Fibonacci: 1, 2, 3, 5, 8, 13, 21', values: ['1', '2', '3', '5', '8', '13', '21'] },
};
export const EFFORT_ORDER: EffortType[] = ['time', 'tshirt', 'fibo'];
export const isEffortType = (x: unknown): x is EffortType => typeof x === 'string' && x in EFFORT_TYPES;

/** The most time one task can record: 999 hours. */
export const TIME_MAX_MIN = 999 * 60;

/**
 * Reads a time someone typed: "1h 30m", "1h30", "90m", "1.5h", "1:30", or a plain number of hours ("2", "0.5").
 * Returns whole minutes, or null if it isn't a time (or is zero or too long).
 */
export function parseTime(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return null;
  let m: number | null = null;
  let r: RegExpMatchArray | null;
  if ((r = s.match(/^(\d+):([0-5]?\d)$/))) m = Number(r[1]) * 60 + Number(r[2]);
  else if ((r = s.match(/^(\d+(?:[.,]\d+)?)$/))) m = Number(r[1].replace(',', '.')) * 60;
  else if ((r = s.match(/^(?:(\d+(?:[.,]\d+)?) ?h(?:rs?|ours?)?)? ?(?:(\d+) ?m(?:in(?:ute)?s?)?)?$/)) && (r[1] || r[2]))
    m = (r[1] ? Number(r[1].replace(',', '.')) * 60 : 0) + (r[2] ? Number(r[2]) : 0);
  else if ((r = s.match(/^(\d+) ?h ?(\d+)$/))) m = Number(r[1]) * 60 + Number(r[2]);
  if (m === null || !Number.isFinite(m)) return null;
  m = Math.round(m);
  return m > 0 && m <= TIME_MAX_MIN ? m : null;
}

/** 90 → "1h 30m", 45 → "45m", 120 → "2h". */
export function fmtTime(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
}

/** The stored form of a value, or null if it isn't valid for the type. `raw`: minutes, a size or points (as typed). */
export function effortValue(type: EffortType, raw: string): string | null {
  if (type === 'time') {
    const n = /^\d+$/.test(raw.trim()) && raw.trim().length < 7 ? Number(raw.trim()) : null; // already minutes
    return n && n > 0 && n <= TIME_MAX_MIN ? `time:${n}` : null;
  }
  const v = raw.trim().toUpperCase();
  return EFFORT_TYPES[type].values!.includes(v) ? `${type}:${v}` : null;
}

/** What someone typed or picked ("1h 30m", "m", "5") as a stored value for the type, or null if it doesn't fit. */
export function effortFromInput(type: EffortType, input: string): string | null {
  if (type === 'time') { const m = parseTime(input); return m ? `time:${m}` : null; }
  return effortValue(type, input);
}

/** A stored value ('<type>:<value>') checked against what the project tracks now. Returns the value part, or null. */
export function effortFor(stored: string | null | undefined, type: EffortType | null | undefined): string | null {
  if (!stored || !type) return null;
  const i = stored.indexOf(':');
  return i > 0 && stored.slice(0, i) === type ? stored.slice(i + 1) : null;
}

/** For people: "1h 30m", "M", "5 pts". */
export function effortLabel(type: EffortType, value: string): string {
  if (type === 'time') return fmtTime(Number(value));
  if (type === 'fibo') return `${value} pt${value === '1' ? '' : 's'}`;
  return value;
}

/** Any stored value, for the history (which keeps its own type): "1h 30m", "M", "5 pts". */
export function storedEffortLabel(stored: string | null | undefined): string {
  if (!stored) return 'none';
  const i = stored.indexOf(':');
  const type = stored.slice(0, i);
  return isEffortType(type) ? effortLabel(type, stored.slice(i + 1)) : stored;
}

/**
 * A total for a set of tasks in a project of this type, or '' if none has a value.
 * Time and story points add up ("6h 15m", "21 pts"); sizes are counted ("2 S · 3 M · 1 L").
 */
export function effortTotal(type: EffortType, stored: (string | null | undefined)[]): string {
  const vals = stored.map((s) => effortFor(s, type)).filter((v): v is string => v !== null);
  if (!vals.length) return '';
  if (type === 'time') return fmtTime(vals.reduce((a, v) => a + Number(v), 0));
  if (type === 'fibo') { const n = vals.reduce((a, v) => a + Number(v), 0); return `${n} pt${n === 1 ? '' : 's'}`; }
  return EFFORT_TYPES.tshirt.values!.map((size) => [size, vals.filter((v) => v === size).length] as const)
    .filter(([, n]) => n).map(([size, n]) => `${n} ${size}`).join(' · ');
}
