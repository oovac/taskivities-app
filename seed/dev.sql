-- Local sample data (dates are relative to today, so it never goes stale).
-- Load with: npm run db:seed:local   ·   Sign in locally at /auth/dev-login?email=jordan@example.com

INSERT INTO users (id, email, name, color, role, status, added_at) VALUES
  ('u_jordan', 'jordan@example.com', 'Jordan Lee',  '#4F46E5', 'admin',  'active',  '2026-09-01T09:00:00Z'),
  ('u_tom',    'tom@example.com',    'Tom Becker',  '#2E90FA', 'admin',  'active',  '2026-09-01T09:00:00Z'),
  ('u_priya',  'priya@example.com',  'Priya Shah',  '#DB2777', 'member', 'active',  '2026-09-03T09:00:00Z'),
  ('u_arjun',  'arjun@example.com',  'Arjun Mehta', '#0E9384', 'member', 'active',  '2026-09-03T09:00:00Z'),
  ('u_sara',   'sara@example.com',   'Sara Lopez',  '#E8590C', 'member', 'active',  '2026-09-10T09:00:00Z'),
  ('u_kenji',  'kenji@example.com',  'Kenji Noda',  '#7A5AF8', 'member', 'active',  '2026-10-14T09:00:00Z'),
  ('u_maya',   'maya.chen@example.com', '',         '#9E77ED', 'member', 'invited', '2026-11-03T09:00:00Z'),
  ('u_lena',   'lena@acmecorp.example', '',         '#15B79E', 'member', 'invited', '2026-11-04T09:00:00Z');

INSERT INTO projects (id, name, color, description, created_at) VALUES
  ('p_web',  'Website Redesign', '#2E90FA', 'Redesign of the public marketing site: page layouts, copy, imagery, SEO and accessibility. Not the mobile app or the blog. Task titles usually start with the page, e.g. "Pricing: update FAQ".', '2026-09-01T09:00:00Z'),
  ('p_app',  'Mobile App',       '#7A5AF8', 'The iOS and Android app: features, bugs, releases (TestFlight / Play), and the API work the app depends on. Crash reports and app-store tasks belong here.', '2026-09-01T09:00:00Z'),
  ('p_mkt',  'Q4 Marketing',     '#F79009', 'Campaigns running October–December: newsletter, social calendar, ad spend and the launch event. Ongoing brand work goes to Website Redesign.', '2026-09-01T09:00:00Z'),
  ('p_ops',  'Operations',       '#12B76A', 'Internal running of the company: office, equipment, vendors, contracts, hiring logistics and the team offsite. Nothing customer-facing.', '2026-09-01T09:00:00Z'),
  ('p_acme', 'Acme Corp',        '#06AED4', 'Client engagement with Acme Corp: estimates, SOWs, deliverables and calls. Lena (lena@acmecorp.example) is the client contact. Anything billable to Acme belongs here.', '2026-09-01T09:00:00Z');

INSERT INTO project_members (user_id, project_id) VALUES
  ('u_priya','p_web'), ('u_priya','p_app'), ('u_priya','p_acme'),
  ('u_arjun','p_app'), ('u_arjun','p_web'), ('u_arjun','p_acme'),
  ('u_sara','p_mkt'),  ('u_sara','p_web'),  ('u_sara','p_acme'),
  ('u_kenji','p_app'), ('u_kenji','p_ops'),
  ('u_maya','p_mkt'),  ('u_lena','p_acme');

-- id, title, project, assignee, created_by, assigned_by, due (days from today), priority, done
WITH s(id, title, project, assignee, created_by, assigned_by, due, priority, done, notes) AS (VALUES
  ('t01','Send revised estimate to Acme','p_acme','u_jordan','u_priya','u_arjun',-2,1,0,'Use the v3 rate card. Acme asked to split discovery into its own line item.'),
  ('t02','Fix login redirect loop on Safari','p_app','u_jordan','u_jordan','u_jordan',-1,3,0,''),
  ('t03','Book venue for team offsite','p_ops','u_jordan','u_tom','u_tom',-6,2,0,''),
  ('t04','Review homepage hero copy','p_web','u_jordan','u_sara','u_sara',0,3,0,''),
  ('t05','Write standup notes','p_ops','u_jordan','u_jordan','u_jordan',0,4,1,''),
  ('t06','Prepare sprint demo','p_app','u_jordan','u_jordan','u_jordan',1,2,0,''),
  ('t07','1:1 with Arjun: growth plan','p_ops','u_jordan','u_jordan','u_jordan',1,4,0,''),
  ('t08','Publish November newsletter','p_mkt','u_jordan','u_sara','u_sara',2,4,0,''),
  ('t09','Draft Q4 campaign brief','p_mkt','u_jordan','u_jordan','u_jordan',-2,3,1,''),
  ('t10','Update pricing page','p_web','u_jordan','u_jordan','u_jordan',-1,3,1,''),
  ('t11','Plan December release','p_app','u_jordan','u_jordan','u_jordan',6,4,0,''),
  ('t12','Checkout flow wireframes','p_web','u_priya','u_jordan','u_jordan',1,2,0,''),
  ('t13','Push notification spec','p_app','u_priya','u_jordan','u_jordan',2,3,0,''),
  ('t14','Migrate sessions table','p_app','u_arjun','u_jordan','u_jordan',-1,1,0,''),
  ('t15','API rate limiting','p_app','u_arjun','u_jordan','u_jordan',1,3,0,''),
  ('t16','December social calendar','p_mkt','u_sara','u_jordan','u_jordan',0,3,1,''),
  ('t17','Customer interview synthesis','p_web','u_priya','u_priya','u_priya',0,4,0,''),
  ('t18','Design QA for onboarding','p_app','u_priya','u_arjun','u_arjun',-1,2,0,''),
  ('t19','Brand color audit','p_web','u_priya','u_priya','u_priya',2,3,0,''),
  ('t20','Logo exports for Acme','p_acme','u_sara','u_priya','u_priya',1,2,0,''),
  ('t22','Load test checkout API','p_app','u_arjun','u_arjun','u_arjun',0,3,0,''),
  ('t23','Ad spend report','p_mkt','u_sara','u_sara','u_sara',1,3,0,''),
  ('t24','Laptop refresh orders','p_ops','u_tom','u_tom','u_tom',2,4,0,''),
  ('t25','Vendor contract renewal','p_ops','u_tom','u_tom','u_tom',-2,2,0,''),
  ('t26','Onboarding checklist for new hire','p_ops','u_kenji','u_kenji','u_kenji',1,3,0,''),
  ('t27','Hero image variants','p_web','u_sara','u_sara','u_sara',0,3,1,''),
  ('t28','Accessibility audit of main nav','p_web','u_priya','u_jordan','u_jordan',0,2,1,''),
  ('t29','Staging deploy for design review','p_web','u_arjun','u_priya','u_priya',0,1,1,''),
  ('t31','Crash fix on Android 14','p_app','u_arjun','u_arjun','u_arjun',0,1,1,''),
  ('t32','TestFlight build 1.8','p_app','u_kenji','u_kenji','u_kenji',-1,3,1,''),
  ('t35','Office Wi-Fi upgrade','p_ops','u_tom','u_tom','u_tom',0,2,1,''),
  ('t37','Copy review for pricing FAQ','p_web','u_arjun','u_sara','u_sara',0,4,1,'')
)
INSERT INTO tasks (id, title, notes, project_id, assignee_id, created_by, assigned_by, due_date, priority, status, done_at, done_on, done_by, created_at, updated_at, version)
SELECT id, title, notes, project, assignee, created_by, assigned_by,
       date('now', due || ' days'), priority,
       CASE done WHEN 1 THEN 'done' ELSE 'open' END,
       CASE done WHEN 1 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now', due || ' days', 'start of day', '+' || (9 + abs(random()) % 8) || ' hours') END,
       CASE done WHEN 1 THEN date('now', due || ' days') END,
       CASE done WHEN 1 THEN assignee END,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now', (due - 3) || ' days'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       1
FROM s;

-- History: created / transferred / done
INSERT INTO task_events (id, task_id, actor_id, via, type, from_value, to_value, note, at)
SELECT 'ec_' || id, id, created_by, NULL, 'created', NULL,
       json_object('assignee', CASE WHEN assigned_by = created_by THEN assignee_id ELSE created_by END, 'due', due_date, 'priority', priority, 'project', project_id),
       NULL, created_at FROM tasks;
INSERT INTO task_events (id, task_id, actor_id, via, type, from_value, to_value, note, at)
SELECT 'et_' || id, id, assigned_by, NULL, 'transferred', created_by, assignee_id,
       CASE id WHEN 't01' THEN 'Out Friday. Jordan has the latest numbers.' END,
       strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+1 day')
FROM tasks WHERE assigned_by != created_by;
INSERT INTO task_events (id, task_id, actor_id, via, type, from_value, to_value, note, at)
SELECT 'ed_' || id, id, done_by, NULL, 'done', NULL, NULL, NULL, done_at FROM tasks WHERE status = 'done';
-- A change made by an AI assistant over MCP
INSERT INTO task_events (id, task_id, actor_id, via, type, from_value, to_value, note, at)
VALUES ('ev_mcp', 't06', 'u_jordan', 'Claude', 'priority_changed', '3', '2', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day'));

UPDATE meta SET value = 1 WHERE key = 'version';
