#!/usr/bin/env node
// Stress-test data: a big team with about 1,000 tasks over two and a half months, with notes, comments, checklists,
// attachments, followers and effort. Writes seed/stress.sql; every date is relative to the day it's loaded
// (date('now', …)), so the data always sits around "today".
//
//   node scripts/stress-seed.mjs [tasks=1000] [people=24]   → writes seed/stress.sql
//   npm run db:stress:local                                 → wipes the local database and loads it
//
// Sign in locally as jordan@example.com (an admin) to see everything, or as any member (e.g. ava@example.com).
// Attachments all point at two sample files that db:stress:local puts in the local R2 bucket.
import { writeFileSync } from 'node:fs';

const N_TASKS = Number(process.argv[2]) || 1000;
const N_PEOPLE = Number(process.argv[3]) || 24;
const PAST = 50; // days back
const AHEAD = 25; // days ahead

// A fixed seed, so the same data comes out every time.
let seed = 20261106;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const chance = (p) => rnd() < p;
const sample = (xs, n) => [...xs].sort(() => rnd() - 0.5).slice(0, n);
const q = (s) => (s === null || s === undefined ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
/** A timestamp `days` from now, at `hours` into that day (UTC). */
const ts = (days, hours = 9) => `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${days} days', 'start of day', '+${hours * 60 | 0} minutes')`;
const day = (days) => `date('now', '${days} days')`;

// ---------- people ----------
const FIRST = ['Jordan', 'Ava', 'Ben', 'Chloe', 'Diego', 'Elena', 'Farah', 'Gabe', 'Hana', 'Ivan', 'Jun', 'Kira', 'Liam', 'Mei', 'Noah', 'Omar',
  'Pia', 'Quinn', 'Ravi', 'Sofia', 'Theo', 'Uma', 'Victor', 'Wen', 'Xena', 'Yusuf', 'Zoe', 'Aria', 'Bo', 'Cleo'];
const LAST = ['Lee', 'Patel', 'Garcia', 'Kim', 'Novak', 'Rossi', 'Haddad', 'Silva', 'Tanaka', 'Petrov', 'Chen', 'Okafor', 'Murphy', 'Wong',
  'Schmidt', 'Aziz', 'Larsen', 'Reyes', 'Iyer', 'Costa', 'Moreau', 'Nair', 'Duarte', 'Li', 'Kovac', 'Demir', 'Brooks', 'Ng', 'Berg', 'Sato'];
const COLORS = ['#4F46E5', '#2E90FA', '#DB2777', '#0E9384', '#E8590C', '#7A5AF8', '#12B76A', '#F79009', '#06AED4', '#D92D20', '#6172F3', '#EE46BC'];
const people = Array.from({ length: N_PEOPLE }, (_, i) => {
  const first = FIRST[i % FIRST.length];
  return {
    id: i === 0 ? 'u_jordan' : `su_${i}`,
    name: `${first} ${LAST[i % LAST.length]}`,
    email: i === 0 ? 'jordan@example.com' : `${first.toLowerCase()}${i >= FIRST.length ? i : ''}@example.com`,
    color: COLORS[i % COLORS.length],
    role: i < 3 ? 'admin' : 'member',
  };
});
const admins = people.filter((p) => p.role === 'admin');

// ---------- projects ----------
const PROJECTS = [
  ['sp_web', 'Website Redesign', '#2E90FA', 'The public marketing site: pages, copy, imagery, SEO and accessibility.', null, 0],
  ['sp_app', 'Mobile App', '#7A5AF8', 'The iOS and Android app: features, bugs, releases and the API it depends on.', 'fibo', 0],
  ['sp_api', 'Platform API', '#0E9384', 'Backend services, the public API, data migrations and performance.', 'fibo', 1],
  ['sp_mkt', 'Q4 Marketing', '#F79009', 'Campaigns for October to December: newsletter, social, ads and the launch event.', 'tshirt', 0],
  ['sp_ops', 'Operations', '#12B76A', 'Running the company: office, equipment, vendors, contracts and hiring logistics.', null, 0],
  ['sp_acme', 'Acme Corp', '#06AED4', 'Client work for Acme Corp: estimates, deliverables and calls. Billable.', 'time', 1],
  ['sp_globex', 'Globex Rollout', '#D92D20', 'Rolling the product out to Globex: onboarding, training, integrations. Billable.', 'time', 0],
  ['sp_support', 'Customer Support', '#6172F3', 'Escalated tickets, bug reproduction and help-centre articles.', 'tshirt', 0],
];
const members = new Map(PROJECTS.map(([id]) => [id, new Set(admins.map((a) => a.id))]));
for (const p of people.filter((x) => x.role === 'member')) for (const [id] of sample(PROJECTS, int(2, 4))) members.get(id).add(p.id);

// ---------- task text ----------
const VERBS = ['Draft', 'Review', 'Fix', 'Update', 'Ship', 'Plan', 'Write', 'Test', 'Design', 'Migrate', 'Audit', 'Prepare', 'Clean up', 'Investigate', 'Document', 'Schedule', 'Refactor', 'Estimate'];
const THINGS = {
  sp_web: ['pricing page', 'homepage hero', 'blog template', 'footer links', 'SEO metadata', 'case study page', 'contact form', 'nav accessibility', 'image compression', 'cookie banner'],
  sp_app: ['login flow', 'push notifications', 'offline mode', 'settings screen', 'onboarding', 'crash on Android 14', 'TestFlight build', 'dark mode icons', 'deep links', 'app store screenshots'],
  sp_api: ['rate limiting', 'sessions table', 'webhook retries', 'search index', 'billing export', 'audit log', 'API docs', 'slow report query', 'token rotation', 'backup restore drill'],
  sp_mkt: ['newsletter', 'launch event invites', 'ad budget', 'social calendar', 'partner co-marketing', 'webinar deck', 'press kit', 'landing page copy', 'customer quotes', 'email nurture flow'],
  sp_ops: ['laptop refresh', 'office Wi-Fi', 'vendor contracts', 'offsite venue', 'payroll calendar', 'insurance renewal', 'access badges', 'expense policy', 'IT inventory', 'new-hire kits'],
  sp_acme: ['revised estimate', 'SOW amendment', 'weekly status call', 'logo exports', 'discovery notes', 'invoice for October', 'design review', 'handover doc', 'QA sign-off', 'training session'],
  sp_globex: ['SSO setup', 'data import', 'admin training', 'integration test', 'rollout plan', 'kickoff deck', 'success metrics', 'support handover', 'pilot feedback', 'go-live checklist'],
  sp_support: ['ticket #4821', 'refund request', 'help article on exports', 'bug repro for sync', 'SLA report', 'macro for billing', 'escalation review', 'FAQ update', 'churn interview', 'feedback triage'],
};
const NOTES = [
  'Context is in the thread from last week. Keep it short and link the doc.',
  'Blocked until we hear back from legal. Check again Thursday.',
  'Use the v3 template. The old one has the wrong logo.',
  'Customer asked for this twice; please prioritise if it slips again.',
  'Numbers are in the shared sheet, tab "Q4". Double-check the totals before sending.',
  'Pair with design on this one. Figma link is in the project description.',
  'Steps:\n1. Reproduce on staging\n2. Capture logs\n3. Write up what you find',
  'Low effort, but it unblocks two other tasks.',
  'Agreed in standup: ship the simple version first, iterate after feedback.',
  'See https://example.com/spec for the full spec.',
];
const COMMENTS = ['On it.', 'Pushed a first pass, have a look when you can.', 'Can we move this to next week?', 'Done on my side, waiting for review.',
  'Looks good to me.', 'I left a few notes in the doc.', 'This is bigger than it looked. Splitting it up.', 'Thanks! Merged.',
  'Who owns the follow-up?', 'Customer confirmed it works now.', 'Blocked on access, asked IT.', '+1, let\'s keep the scope tight.',
  'Moved the call to Thursday.', 'Attached the latest version.', 'Can you take a quick look before EOD?'];
const CHECK = ['Draft', 'Review with team', 'Get sign-off', 'Update the doc', 'Notify stakeholders', 'Write tests', 'Deploy to staging', 'Check on mobile',
  'Send to client', 'Archive old version', 'Book the room', 'Confirm budget'];
const FILES = [['notes.pdf', 'application/pdf', 'stress/sample.pdf', 40213], ['screenshot.png', 'image/png', 'stress/sample.png', 18342],
  ['spec-v2.pdf', 'application/pdf', 'stress/sample.pdf', 40213], ['mockup.png', 'image/png', 'stress/sample.png', 18342],
  ['contract.pdf', 'application/pdf', 'stress/sample.pdf', 40213]];
const effortFor = (type) => (type === 'time' ? `time:${pick([15, 30, 45, 60, 90, 120, 180, 240, 360])}` : type === 'fibo' ? `fibo:${pick([1, 2, 3, 5, 8, 13])}` : `tshirt:${pick(['XS', 'S', 'M', 'L', 'XL'])}`);

// ---------- tasks and their history ----------
const tasks = [], events = [], checks = [], files = [], follows = [];
let ev = 0;
const E = (task, actor, type, at, o = {}) => events.push([`se_${++ev}`, task, actor, o.via ?? null, type, o.from ?? null, o.to ?? null, o.note ?? null, at]);
for (let i = 1; i <= N_TASKS; i++) {
  const id = `st_${i}`;
  const [pid, , , , effort, required] = pick(PROJECTS);
  const team = [...members.get(pid)];
  const assignee = pick(team);
  const createdBy = chance(0.55) ? assignee : pick(team);
  const due = int(-PAST, AHEAD);
  const created = Math.max(-PAST - 10, due - int(1, 14));
  const doneChance = due < -7 ? 0.9 : due < 0 ? 0.7 : due === 0 ? 0.3 : 0.05;
  const done = chance(doneChance);
  const doneOn = done ? Math.min(0, due + int(-2, 2)) : null;
  const doneDay = doneOn === null ? null : Math.max(doneOn, created);
  const prio = pick([1, 2, 2, 3, 3, 3, 3, 3, 4, 4]);
  const title = `${pick(VERBS)} ${pick(THINGS[pid])}`;
  const notes = chance(0.4) ? pick(NOTES) : '';
  const eff = effort && (done ? chance(required ? 1 : 0.7) : chance(0.35)) ? effortFor(effort) : null;
  tasks.push({ id, title, notes, pid, assignee, createdBy, due, prio, done, doneDay, created, eff });

  E(id, createdBy, 'created', ts(created, int(8, 17)), { to: `json_object('assignee', '${assignee}', 'due', date('now', '${due} days'), 'priority', ${prio}, 'project', '${pid}')` });
  if (createdBy !== assignee) E(id, createdBy, 'transferred', ts(created, 17.5), { from: createdBy, to: assignee, note: chance(0.3) ? 'Can you take this one?' : null });
  if (chance(0.12)) E(id, pick(team), 'priority_changed', ts(created, 12), { from: '3', to: String(prio), via: chance(0.3) ? 'Claude' : null });
  const nComments = chance(0.45) ? int(1, 6) : 0;
  const last = doneDay ?? Math.min(0, due);
  for (let c = 0; c < nComments; c++) {
    const d = int(created, Math.max(created, last));
    E(id, pick(team), 'comment', ts(d, 9 + c * 0.7 + rnd()), { note: pick(COMMENTS) });
  }
  if (eff) E(id, assignee, 'effort_set', ts(doneDay ?? created, 16), { to: eff });
  if (chance(0.3)) {
    const n = int(2, 7);
    for (let k = 0; k < n; k++) {
      const ticked = done || chance(0.4);
      checks.push([`sc_${i}_${k}`, id, CHECK[(i + k) % CHECK.length], ticked ? 1 : 0, k + 1, createdBy, ts(created, 10), ticked ? assignee : null, ticked ? ts(Math.min(0, last), 11) : null]);
    }
  }
  if (chance(0.15)) {
    for (let k = 0, n = int(1, 3); k < n; k++) {
      const [name, type, key, size] = pick(FILES);
      files.push([`sa_${i}_${k}`, id, key, name, size, type, pick(team), ts(int(created, Math.max(created, last)), 12 + k)]);
      E(id, files.at(-1)[6], 'attached', ts(int(created, Math.max(created, last)), 12 + k), { to: name });
    }
  }
  if (chance(0.2)) for (const u of sample(team.filter((u) => u !== assignee && u !== createdBy), int(1, 2))) follows.push([id, u, ts(created, 13)]);
  if (done) E(id, assignee, 'done', ts(doneDay, int(10, 18)));
}

// ---------- SQL ----------
const out = [];
const chunked = (head, rows) => { for (let i = 0; i < rows.length; i += 200) out.push(`${head} VALUES\n${rows.slice(i, i + 200).join(',\n')};`); };
out.push(`-- Stress-test data: ${N_TASKS} tasks, ${N_PEOPLE} people, ${PROJECTS.length} projects, from ${PAST} days ago to ${AHEAD} days ahead.`,
  '-- Generated by scripts/stress-seed.mjs (do not edit by hand). Load with: npm run db:stress:local');
chunked('INSERT INTO users (id, email, name, color, role, status, added_at)',
  people.map((p) => `(${q(p.id)}, ${q(p.email)}, ${q(p.name)}, ${q(p.color)}, ${q(p.role)}, 'active', ${ts(-PAST - 20)})`));
chunked('INSERT INTO projects (id, name, color, description, effort, effort_required, created_at)',
  PROJECTS.map(([id, name, color, desc, effort, req]) => `(${q(id)}, ${q(name)}, ${q(color)}, ${q(desc)}, ${q(effort)}, ${req}, ${ts(-PAST - 20)})`));
chunked('INSERT INTO project_members (user_id, project_id)',
  [...members].flatMap(([pid, set]) => [...set].filter((u) => people.find((p) => p.id === u).role === 'member').map((u) => `(${q(u)}, ${q(pid)})`)));
chunked('INSERT INTO tasks (id, title, notes, project_id, assignee_id, created_by, assigned_by, due_date, priority, status, done_at, done_on, done_by, created_at, updated_at, version, effort)',
  tasks.map((t) => `(${q(t.id)}, ${q(t.title)}, ${q(t.notes)}, ${q(t.pid)}, ${q(t.assignee)}, ${q(t.createdBy)}, ${q(t.createdBy)}, ${day(t.due)}, ${t.prio}, ` +
    `${t.done ? "'done'" : "'open'"}, ${t.done ? ts(t.doneDay, 15) : 'NULL'}, ${t.done ? day(t.doneDay) : 'NULL'}, ${t.done ? q(t.assignee) : 'NULL'}, ` +
    `${ts(t.created, 8)}, ${ts(t.done ? t.doneDay : t.created, 15)}, 1, ${q(t.eff)})`));
chunked('INSERT INTO task_events (id, task_id, actor_id, via, type, from_value, to_value, note, at)',
  events.map(([id, task, actor, via, type, from, to, note, at]) =>
    `(${q(id)}, ${q(task)}, ${q(actor)}, ${q(via)}, ${q(type)}, ${q(from)}, ${to?.startsWith?.('json_object') ? to : q(to)}, ${q(note)}, ${at})`));
chunked('INSERT INTO checklist_items (id, task_id, text, done, position, created_by, created_at, updated_at, done_by, done_at)',
  checks.map(([id, task, text, d, pos, by, at, doneBy, doneAt]) => `(${q(id)}, ${q(task)}, ${q(text)}, ${d}, ${pos}, ${q(by)}, ${at}, ${at}, ${q(doneBy)}, ${doneAt ?? 'NULL'})`));
chunked('INSERT INTO attachments (id, task_id, key, name, size, type, uploaded_by, uploaded_at)',
  files.map(([id, task, key, name, size, type, by, at]) => `(${q(id)}, ${q(task)}, ${q(key)}, ${q(name)}, ${size}, ${q(type)}, ${q(by)}, ${at})`));
chunked('INSERT INTO task_followers (task_id, user_id, following, added_by, at)', follows.map(([t, u, at]) => `(${q(t)}, ${q(u)}, 1, ${q(u)}, ${at})`));
out.push("UPDATE meta SET value = 1 WHERE key = 'version';", "UPDATE meta SET value = value + 1 WHERE key = 'directory_version';");
writeFileSync(new URL('../seed/stress.sql', import.meta.url), out.join('\n\n') + '\n');
console.log(`seed/stress.sql: ${people.length} people, ${PROJECTS.length} projects, ${tasks.length} tasks (${tasks.filter((t) => t.done).length} done), ` +
  `${events.length} history entries (${events.filter((e) => e[4] === 'comment').length} comments), ${checks.length} checklist items, ${files.length} attachments, ${follows.length} followers.`);
