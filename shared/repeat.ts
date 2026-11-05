// Repeat rules for repeating tasks, shared by the Worker (which creates the next copy) and the app
// (which shows upcoming copies as previews). Dates are plain YYYY-MM-DD, like due dates.
import { DOW, MONS, addDays, diffDays, parseDate, toDate, weekStart } from './dates';

export type Freq = 'day' | 'week' | 'month' | 'year';

export interface Repeat {
  freq: Freq;
  /** Every N days / weeks / months / years. */
  every: number;
  /** Weekly: which weekdays (0 = Sunday … 6 = Saturday). */
  days?: number[];
  /** Monthly: the same date (the 15th) or the same weekday position (the 2nd Tuesday, the last Friday). */
  monthBy?: 'date' | 'weekday';
  /** Count from the day it was finished instead of following a schedule ("7 days after done"). */
  afterDone?: boolean;
  /** Last possible date (inclusive). */
  until?: string | null;
  /** Total number of copies. */
  count?: number | null;
}

/** What the app gets about a task's series (see TASK_COLS in worker/lib.ts). */
export interface SeriesInfo {
  id: string;
  rule: Repeat;
  /** The date the schedule counts from (first copy, or the open copy when the rule last changed). */
  anchor: string;
  active: boolean;
  /** Copies used so far (created or skipped), for `count`. */
  made: number;
  /** Defaults for future copies. */
  assigneeId: string;
  title: string;
}

const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && toDate(parseDate(s)) === s;

/** Checks and normalizes a rule from a client. Returns an error message for bad input. */
export function cleanRepeat(raw: unknown): Repeat | string {
  if (!raw || typeof raw !== 'object') return 'Invalid repeat rule.';
  const r = raw as Record<string, unknown>;
  const freq = r.freq;
  if (freq !== 'day' && freq !== 'week' && freq !== 'month' && freq !== 'year') return 'Repeat must be daily, weekly, monthly or yearly.';
  const every = r.every === undefined ? 1 : Number(r.every);
  if (!Number.isInteger(every) || every < 1 || every > 99) return 'Repeat interval must be between 1 and 99.';
  const out: Repeat = { freq, every };
  if (r.afterDone) out.afterDone = true;
  if (freq === 'week' && !out.afterDone && r.days !== undefined) {
    if (!Array.isArray(r.days) || !r.days.length || r.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return 'Pick at least one weekday.';
    out.days = [...new Set(r.days as number[])].sort();
  }
  if (freq === 'month' && !out.afterDone) out.monthBy = r.monthBy === 'weekday' ? 'weekday' : 'date';
  if (r.until != null && r.until !== '') {
    if (!isDay(r.until)) return 'Invalid end date.';
    out.until = r.until;
  }
  if (r.count != null && r.count !== '') {
    const n = Number(r.count);
    if (!Number.isInteger(n) || n < 1 || n > 1000) return 'Repeat count must be between 1 and 1000.';
    out.count = n;
  }
  return out;
}

const monthIndex = (d: Date) => d.getFullYear() * 12 + d.getMonth();
const daysIn = (y: number, m: number) => new Date(y, m + 1, 0).getDate();
/** 1–4 for "1st … 4th <weekday>", 5 for "last <weekday>". */
const nthOf = (d: Date) => Math.ceil(d.getDate() / 7);
const isLastOfMonth = (d: Date) => d.getDate() + 7 > daysIn(d.getFullYear(), d.getMonth());

/** Does date `d` fall on the schedule that started on `anchor`? (Not for afterDone rules.) */
export function onSchedule(r: Repeat, anchor: string, d: string): boolean {
  if (d < anchor) return false;
  const a = parseDate(anchor);
  const x = parseDate(d);
  switch (r.freq) {
    case 'day':
      return diffDays(d, anchor) % r.every === 0;
    case 'week': {
      const days = r.days?.length ? r.days : [a.getDay()];
      if (!days.includes(x.getDay())) return false;
      return (diffDays(weekStart(d), weekStart(anchor)) / 7) % r.every === 0;
    }
    case 'month': {
      if ((monthIndex(x) - monthIndex(a)) % r.every !== 0) return false;
      if (r.monthBy === 'weekday') {
        if (x.getDay() !== a.getDay()) return false;
        const n = nthOf(a);
        return n >= 5 ? isLastOfMonth(x) : nthOf(x) === n;
      }
      // The 31st falls back to the last day of shorter months.
      return x.getDate() === Math.min(a.getDate(), daysIn(x.getFullYear(), x.getMonth()));
    }
    case 'year':
      return (
        (monthIndex(x) - monthIndex(a)) % (12 * r.every) === 0 &&
        x.getDate() === Math.min(a.getDate(), daysIn(x.getFullYear(), x.getMonth()))
      );
  }
}

/** Adds one interval of the rule to a date (month ends clamp: Jan 31 + 1 month = Feb 28). */
function addInterval(r: Repeat, d: string): string {
  if (r.freq === 'day') return addDays(d, r.every);
  if (r.freq === 'week') return addDays(d, 7 * r.every);
  const x = parseDate(d);
  const months = r.freq === 'month' ? r.every : 12 * r.every;
  const y = x.getFullYear() + Math.floor((x.getMonth() + months) / 12);
  const m = (x.getMonth() + months) % 12;
  return toDate(new Date(y, m, Math.min(x.getDate(), daysIn(y, m))));
}

const LIMIT_DAYS = 366 * 12;

/**
 * The date of the next copy, or null when the series is over.
 * Schedule rules: the first scheduled date after `after`, and never before `notBefore` (missed dates are skipped, not piled up).
 * afterDone rules: one interval after `doneOn`.
 * `made` is how many copies have been used so far.
 */
export function nextDate(r: Repeat, anchor: string, after: string, notBefore: string, made: number, doneOn?: string): string | null {
  if (r.count != null && made >= r.count) return null;
  let next: string | null = null;
  if (r.afterDone) {
    next = addInterval(r, doneOn ?? after);
    if (next < notBefore) next = notBefore;
  } else {
    let d = addDays(after > addDays(notBefore, -1) ? after : addDays(notBefore, -1), 1);
    for (let i = 0; i < LIMIT_DAYS; i++, d = addDays(d, 1)) {
      if (r.until && d > r.until) return null;
      if (onSchedule(r, anchor, d)) { next = d; break; }
    }
  }
  if (!next || (r.until && next > r.until)) return null;
  return next;
}

/** The first scheduled date on or after `from` (used when a series starts). */
export const firstDate = (r: Repeat, from: string): string =>
  r.afterDone || onSchedule(r, from, from) ? from : nextDate(r, from, from, from, 0) ?? from;

/** Upcoming scheduled dates after `after`, up to `to` (for previews). Not for afterDone rules. */
export function upcoming(s: Pick<SeriesInfo, 'rule' | 'anchor' | 'made'>, after: string, to: string, max = 14): string[] {
  const out: string[] = [];
  if (s.rule.afterDone) return out;
  let d = after;
  let made = s.made;
  while (out.length < max) {
    const n = nextDate(s.rule, s.anchor, d, d, made);
    if (!n || n > to) break;
    out.push(n);
    d = n;
    made++;
  }
  return out;
}

const ord = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;
const FULL_DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const UNIT: Record<Freq, string> = { day: 'day', week: 'week', month: 'month', year: 'year' };

/** "Every Monday", "Every weekday", "Every 2 weeks on Mon, Thu", "Monthly on the 2nd Tuesday", "7 days after done" … */
export function describe(r: Repeat, anchor: string): string {
  const a = parseDate(anchor);
  const n = r.every;
  const every = (unit: string) => (n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`);
  let s: string;
  if (r.afterDone) s = `${n} ${UNIT[r.freq]}${n > 1 ? 's' : ''} after done`;
  else if (r.freq === 'day') s = every('day');
  else if (r.freq === 'week') {
    const days = r.days?.length ? r.days : [a.getDay()];
    const weekdays = days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d));
    if (n === 1 && weekdays) s = 'Every weekday';
    else if (n === 1 && days.length === 1) s = `Every ${FULL_DOW[days[0]]}`;
    else if (n === 1 && days.length === 7) s = 'Every day';
    else s = `${every('week')} on ${days.map((d) => DOW[d]).join(', ')}`;
  } else if (r.freq === 'month') {
    const on = r.monthBy === 'weekday'
      ? `the ${nthOf(a) >= 5 ? 'last' : ord(nthOf(a))} ${FULL_DOW[a.getDay()]}`
      : `the ${ord(a.getDate())}`;
    s = `${n === 1 ? 'Monthly' : every('month')} on ${on}`;
  } else s = `${n === 1 ? 'Yearly' : every('year')} on ${MONS[a.getMonth()]} ${a.getDate()}`;
  if (r.until) { const u = parseDate(r.until); s += ` · until ${MONS[u.getMonth()]} ${u.getDate()}`; }
  if (r.count) s += ` · ${r.count} time${r.count > 1 ? 's' : ''}`;
  return s;
}

/** The quick choices offered for a task due on `d`. */
export function presets(d: string): { label: string; rule: Repeat }[] {
  const x = parseDate(d);
  const dow = x.getDay();
  const list: { label: string; rule: Repeat }[] = [
    { label: 'Every day', rule: { freq: 'day', every: 1 } },
    { label: 'Every weekday', rule: { freq: 'week', every: 1, days: [1, 2, 3, 4, 5] } },
    { label: `Every ${FULL_DOW[dow]}`, rule: { freq: 'week', every: 1, days: [dow] } },
    { label: `Every 2 weeks on ${FULL_DOW[dow]}`, rule: { freq: 'week', every: 2, days: [dow] } },
    { label: `Monthly on the ${ord(x.getDate())}`, rule: { freq: 'month', every: 1, monthBy: 'date' } },
    { label: `Monthly on the ${nthOf(x) >= 5 ? 'last' : ord(nthOf(x))} ${FULL_DOW[dow]}`, rule: { freq: 'month', every: 1, monthBy: 'weekday' } },
    { label: `Yearly on ${MONS[x.getMonth()]} ${x.getDate()}`, rule: { freq: 'year', every: 1 } },
  ];
  return list;
}

const canon = (r: Repeat | null | undefined) =>
  r ? JSON.stringify(Object.entries(r).filter(([, v]) => v != null && v !== false).sort(([a], [b]) => a.localeCompare(b))) : 'null';
export const sameRule = (a: Repeat | null | undefined, b: Repeat | null | undefined) => canon(a) === canon(b);
