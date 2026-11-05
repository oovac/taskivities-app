// Admin-only: people, roles, project access, projects, app settings.
import { Hono } from 'hono';
import { EMAIL_RE } from '../shared/rules';
import { DESCRIPTION_MAX, PROJECT_COLORS, USER_COLORS, type Role } from '../shared/types';
import { checkSvg, saveLogo } from './settings';
import {
  type AppEnv, type ProjectRow, type UserRow, CURRENT_VERSION, auditStmt, bad, bumpDirectory, bumpVersion, conflict, eventStmt,
  forbidden, getUser, memberProjects, notFound, nowIso, uid,
} from './lib';

export const admin = new Hono<AppEnv>();

admin.use('*', async (c, next) => {
  if (c.get('viewer').role !== 'admin') throw forbidden('Only admins can do that.');
  await next();
});

const activeAdmins = async (db: D1Database) =>
  (await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status != 'removed'").first<{ n: number }>())!.n;
const openTasksIn = async (db: D1Database, userId: string, projectId?: string) =>
  (await db
    .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE assignee_id = ? AND status = 'open'${projectId ? ' AND project_id = ?' : ''}`)
    .bind(...(projectId ? [userId, projectId] : [userId]))
    .first<{ n: number }>())!.n;
const existingProjects = async (db: D1Database) =>
  new Set((await db.prepare('SELECT id FROM projects WHERE archived = 0').all<{ id: string }>()).results.map((r) => r.id));

// ---------- people ----------
admin.post('/users', async (c) => {
  const v = c.get('viewer');
  const db = c.env.DB;
  const b = await c.req.json<{ emails?: string[]; role?: Role; projects?: string[] }>();
  const emails = [...new Set((b.emails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (!emails.length) throw bad('Enter at least one email address.');
  const invalid = emails.filter((e) => !EMAIL_RE.test(e));
  if (invalid.length) throw bad(`Not a valid email: ${invalid.join(', ')}`);
  const role: Role = b.role === 'admin' ? 'admin' : 'member';
  const known = await existingProjects(db);
  const projects = role === 'admin' ? [] : [...new Set(b.projects ?? [])].filter((p) => known.has(p));
  if (role === 'member' && !projects.length) throw bad('Pick at least one project for a member.');

  const stmts: D1PreparedStatement[] = [];
  const added: string[] = [];
  const skipped: string[] = [];
  const now = nowIso();
  for (const email of emails) {
    const existing = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<UserRow>();
    if (existing && existing.status !== 'removed') { skipped.push(email); continue; }
    const id = existing?.id ?? uid();
    if (existing) {
      // Someone removed earlier is added back as a fresh invite.
      stmts.push(db.prepare("UPDATE users SET role = ?, status = 'invited', added_by = ?, added_at = ? WHERE id = ?").bind(role, v.id, now, id));
      stmts.push(db.prepare('DELETE FROM project_members WHERE user_id = ?').bind(id));
    } else {
      stmts.push(
        db.prepare("INSERT INTO users (id, email, name, color, role, status, added_by, added_at) VALUES (?, ?, '', ?, ?, 'invited', ?, ?)")
          .bind(id, email, USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)], role, v.id, now),
      );
    }
    for (const p of projects) stmts.push(db.prepare('INSERT OR IGNORE INTO project_members (user_id, project_id) VALUES (?, ?)').bind(id, p));
    stmts.push(auditStmt(db, v.id, 'user_added', id, { email, role, projects }));
    added.push(email);
  }
  if (stmts.length) await db.batch([...stmts, bumpDirectory(db)]);
  return c.json({ added, skipped });
});

admin.patch('/users/:id', async (c) => {
  const v = c.get('viewer');
  const db = c.env.DB;
  const id = c.req.param('id');
  const u = await getUser(db, id);
  if (!u || u.status === 'removed') throw notFound('Person not found.');
  const b = await c.req.json<{ role?: Role; projects?: string[] }>();
  const stmts: D1PreparedStatement[] = [];
  let role = u.role;

  if (b.role && b.role !== u.role) {
    if (id === v.id) throw forbidden("You can't change your own role.");
    if (u.role === 'admin' && (await activeAdmins(db)) <= 1) throw conflict("Can't demote the last admin.");
    role = b.role;
    stmts.push(db.prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, id));
    stmts.push(auditStmt(db, v.id, 'role_changed', id, { from: u.role, to: role }));
  }

  if (role === 'member' && (b.projects || u.role === 'admin')) {
    const known = await existingProjects(db);
    const current = await memberProjects(db, id);
    let wanted = b.projects ? [...new Set(b.projects)].filter((p) => known.has(p)) : current;
    if (u.role === 'admin' && !b.projects) {
      // Demoted admins keep access to wherever they still have open work.
      const { results } = await db.prepare("SELECT DISTINCT project_id FROM tasks WHERE assignee_id = ? AND status = 'open'").bind(id).all<{ project_id: string }>();
      wanted = [...new Set([...current, ...results.map((r) => r.project_id)])];
    }
    if (!wanted.length) throw bad('A member needs at least one project.');
    for (const p of current.filter((p) => !wanted.includes(p))) {
      const n = await openTasksIn(db, id, p);
      if (n) throw conflict(`${u.name || u.email} still has ${n} open task${n > 1 ? 's' : ''} in that project. Transfer them first.`);
      stmts.push(db.prepare('DELETE FROM project_members WHERE user_id = ? AND project_id = ?').bind(id, p));
    }
    for (const p of wanted.filter((p) => !current.includes(p))) {
      stmts.push(db.prepare('INSERT OR IGNORE INTO project_members (user_id, project_id) VALUES (?, ?)').bind(id, p));
    }
    stmts.push(auditStmt(db, v.id, 'projects_changed', id, { from: current, to: wanted }));
  }
  if (stmts.length) await db.batch([...stmts, bumpDirectory(db)]);
  return c.json({ ok: true });
});

/** Remove someone. Their open tasks go to `transferTo` first, in the same batch, each transfer logged. */
admin.delete('/users/:id', async (c) => {
  const v = c.get('viewer');
  const db = c.env.DB;
  const id = c.req.param('id');
  const u = await getUser(db, id);
  if (!u || u.status === 'removed') throw notFound('Person not found.');
  if (id === v.id) throw forbidden("You can't remove yourself.");
  if (u.role === 'admin' && (await activeAdmins(db)) <= 1) throw conflict("Can't remove the last admin.");
  const { results: open } = await db.prepare("SELECT id, project_id FROM tasks WHERE assignee_id = ? AND status = 'open'").bind(id).all<{ id: string; project_id: string }>();
  const to = c.req.query('transferTo');
  const stmts: D1PreparedStatement[] = [];
  const now = nowIso();
  if (open.length) {
    if (!to) throw bad(`They have ${open.length} open tasks. Choose who gets them.`);
    const target = await getUser(db, to);
    if (!target || target.status !== 'active' || to === id) throw bad('Choose an active person.');
    if (target.role !== 'admin') {
      const theirs = new Set(await memberProjects(db, to));
      if (open.some((t) => !theirs.has(t.project_id))) throw bad(`${target.name || target.email} isn't on all of those projects.`);
    }
    stmts.push(bumpVersion(db));
    // Their repeating tasks keep going, with the same person.
    stmts.push(db.prepare('UPDATE series SET assignee_id = ?, updated_at = ? WHERE assignee_id = ? AND active = 1').bind(to, now, id));
    for (const t of open) {
      stmts.push(db.prepare(`UPDATE tasks SET assignee_id = ?, assigned_by = ?, updated_at = ?, version = ${CURRENT_VERSION} WHERE id = ?`).bind(to, v.id, now, t.id));
      stmts.push(eventStmt(db, { taskId: t.id, actorId: v.id, type: 'transferred', from: id, to, note: `${u.name || u.email} was removed from the team`, at: now }));
    }
  }
  stmts.push(db.prepare("UPDATE users SET status = 'removed' WHERE id = ?").bind(id));
  stmts.push(db.prepare('DELETE FROM project_members WHERE user_id = ?').bind(id));
  stmts.push(db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id));
  stmts.push(auditStmt(db, v.id, 'user_removed', id, { transferred: open.length, to: to ?? null }));
  stmts.push(bumpDirectory(db));
  await db.batch(stmts);
  return c.json({ ok: true, transferred: open.length });
});

// ---------- projects ----------
interface ProjectBody { name?: string; color?: string; description?: string; members?: string[] }

async function validateProject(db: D1Database, b: ProjectBody, selfId?: string) {
  const name = (b.name ?? '').trim();
  if (!name) throw bad('Give the project a name.');
  if (name.length > 80) throw bad('Project names can be at most 80 characters.');
  const dup = await db.prepare('SELECT id FROM projects WHERE name = ? COLLATE NOCASE AND archived = 0 AND id != ?').bind(name, selfId ?? '').first();
  if (dup) throw conflict('Another project already has that name.');
  const color = b.color && PROJECT_COLORS.includes(b.color) ? b.color : PROJECT_COLORS[0];
  const description = (b.description ?? '').trim();
  if (description.length > DESCRIPTION_MAX) throw bad(`Descriptions can be at most ${DESCRIPTION_MAX} characters.`);
  return { name, color, description };
}

admin.post('/projects', async (c) => {
  const v = c.get('viewer');
  const db = c.env.DB;
  const b = await c.req.json<ProjectBody>();
  const p = await validateProject(db, b);
  const id = uid();
  const stmts = [
    db.prepare('INSERT INTO projects (id, name, color, description, archived, created_at) VALUES (?, ?, ?, ?, 0, ?)').bind(id, p.name, p.color, p.description, nowIso()),
    ...(b.members ?? []).map((u) => db.prepare("INSERT OR IGNORE INTO project_members (user_id, project_id) SELECT id, ? FROM users WHERE id = ? AND role = 'member' AND status != 'removed'").bind(id, u)),
    auditStmt(db, v.id, 'project_created', id, p),
    bumpDirectory(db),
  ];
  await db.batch(stmts);
  return c.json({ id }, 201);
});

admin.patch('/projects/:id', async (c) => {
  const v = c.get('viewer');
  const db = c.env.DB;
  const id = c.req.param('id');
  const cur = await db.prepare('SELECT * FROM projects WHERE id = ? AND archived = 0').bind(id).first<ProjectRow>();
  if (!cur) throw notFound('Project not found.');
  const b = await c.req.json<ProjectBody>();
  const p = await validateProject(db, { name: b.name ?? cur.name, color: b.color ?? cur.color, description: b.description ?? cur.description }, id);
  const stmts: D1PreparedStatement[] = [db.prepare('UPDATE projects SET name = ?, color = ?, description = ? WHERE id = ?').bind(p.name, p.color, p.description, id)];
  if (b.members) {
    const { results } = await db.prepare('SELECT user_id FROM project_members WHERE project_id = ?').bind(id).all<{ user_id: string }>();
    const current = results.map((r) => r.user_id);
    for (const u of current.filter((u) => !b.members!.includes(u))) {
      const n = await openTasksIn(db, u, id);
      const user = await getUser(db, u);
      if (n) throw conflict(`${user?.name || user?.email} still has ${n} open task${n > 1 ? 's' : ''} here. Transfer them first.`);
      if ((await memberProjects(db, u)).length <= 1) throw conflict(`${user?.name || user?.email} needs at least one project.`);
      stmts.push(db.prepare('DELETE FROM project_members WHERE user_id = ? AND project_id = ?').bind(u, id));
    }
    for (const u of b.members.filter((u) => !current.includes(u))) {
      stmts.push(db.prepare("INSERT OR IGNORE INTO project_members (user_id, project_id) SELECT id, ? FROM users WHERE id = ? AND role = 'member' AND status != 'removed'").bind(id, u));
    }
  }
  stmts.push(auditStmt(db, v.id, 'project_updated', id, p), bumpDirectory(db));
  await db.batch(stmts);
  return c.json({ ok: true });
});

// ---------- app settings ----------
admin.put('/settings/logo', async (c) => {
  const b = await c.req.json<{ svg?: unknown }>();
  return c.json({ settings: await saveLogo(c.env.DB, c.get('viewer').id, checkSvg(b.svg)) });
});

admin.delete('/settings/logo', async (c) => c.json({ settings: await saveLogo(c.env.DB, c.get('viewer').id, null) }));
