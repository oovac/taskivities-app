# Taskivities

A team's week at a glance: everyone records their daily tasks against a project. Tasks can be assigned or transferred to anyone on the project, every change is kept in an append-only history, overdue tasks roll into today until someone finishes or moves them, and every open browser updates on its own.

The design reference is [`docs/wireframes.html`](docs/wireframes.html). Open it in a browser.

## Stack

| Part | What |
|---|---|
| App | React 19 + TypeScript, built with Vite, served as static assets by the Worker |
| API | One Cloudflare Worker using [Hono](https://hono.dev) (`worker/`) |
| Database | Cloudflare D1 (SQLite). Schema in `migrations/` |
| Sign-in | Google OAuth (code + PKCE), handled in the Worker, with HttpOnly session cookies stored in D1 |
| Live updates | The browser polls `/api/sync?since=<version>` every 10s (every 60s when the tab is hidden) |
| AI assistants | Remote MCP server at `/mcp` (Streamable HTTP) on the same Worker: Cloudflare's `agents` SDK (`McpAgent`, one Durable Object per session) behind `@cloudflare/workers-oauth-provider` (OAuth 2.1 + dynamic client registration, tokens in KV) |

```
worker/   index.ts (routes + OAuth provider) · auth.ts (Google + sessions) · api.ts (REST: tasks, sync) · tasks.ts (task rules shared by REST and MCP)
          mcp.ts (MCP tools) · oauth.ts (/authorize consent page for assistants) · admin.ts (people, projects, settings) · settings.ts (logo) · lib.ts
shared/   types, date helpers and rules used by both the Worker and the app
src/      React app: pages/ (Tasks, Projects, Team, Settings, Login), components/, actions.ts (all writes), keyboard.ts, focus.ts
migrations/ (0001 schema, 0002 time zones, 0003 repeating tasks, 0004 settings)   seed/dev.sql (local sample data)
scripts/tenant.mjs (per-instance deploys)   tenants/ (each instance's Cloudflare IDs; only example.env is committed)
```

## Rules the code enforces

- **Every task has a project, a due date, an assignee and a priority.** The columns are `NOT NULL`, and the API rejects any attempt to clear them.
- **"Today" is each person's own today.** The browser sends its time zone with every request (`x-tz`), and the server uses it for rollover, the "can't be due in the past" check, and the day a task counts as done. It's also saved on the person, so their AI assistant uses the same zone. `TEAM_TZ` is only a fallback for someone who hasn't opened the app yet.
- **Rollover is computed, never stored.** An open task with a past due date is shown on today, and "days late" keeps counting (`shared/rules.ts → shownOn`). There's no nightly job.
- **Repeating tasks** (`shared/repeat.ts`, `worker/tasks.ts`):
  - **Repeating is set when a task is created.** Afterwards the rule can be changed or stopped, but a normal task can't be turned into a repeating one, and stopping can't be undone.
  - A `series` row holds the rule (daily, weekly on chosen days, monthly by date or by "2nd Tuesday", yearly, every N, optional "after done", end date or count) and the defaults for future copies. Each copy is an ordinary task with its own history and a `series_id`.
  - **One open copy at a time.** Marking a copy done inserts the next one in the same D1 batch, guarded by "no open copy in this series", so two people finishing it at once can't create two. There's no scheduled job.
  - Missed dates aren't piled up: an unfinished copy rolls over like any task, and the next copy always lands after today.
  - **Skip** moves the open copy to the next scheduled date. Reopening a finished copy leaves the next copy in place.
  - Edits to the open copy (title, notes, priority, project, assignee) carry forward to future copies, except a transfer marked "just this one". Date moves only affect that copy.
  - The week views show upcoming copies as faint previews, calculated in the browser and never saved.
- **History is append-only.** Every write updates `tasks` and inserts into `task_events` in the same D1 batch, and database triggers refuse any `UPDATE` or `DELETE` on `task_events`.
- **Roles:**
  - Admins see every project and are the only ones who manage people and projects.
  - Members see only the projects they're on.
  - A task's assignee must always be on that task's project.
- **Settings** (admins only, the **Settings** page, stored in the `settings` table):
  - **Logo:** SVG only, up to 256 KB. Used in the top bar, on the sign-in page and as the browser tab icon; "Use the built-in logo" goes back to the default. Every change is in the audit log, and everyone's app picks it up on its next poll.
  - Uploads are checked in the browser and again on the server: no scripts, event handlers, embedded HTML, DOCTYPEs or links to outside files. `/logo.svg` is also served with a locked-down `Content-Security-Policy` (`sandbox`, no scripts), so even opening it directly can't run anything.
- **Sign-in:** only email addresses added by an admin can sign in. On a brand-new install, the **first person to sign in becomes the admin** (the check is one atomic insert, so only one person can win). The optional `ADMIN_EMAILS` secret names addresses that are always let in as admins, which is useful for getting back in if you lock yourself out.
- **Writes come only from the app's own pages:** they need the same origin plus a custom header, and the session cookie is `SameSite=Lax`. The one exception is `/mcp`, which takes an OAuth bearer token instead (see below).
- **One set of task rules.** The REST API and the MCP tools both call `worker/tasks.ts` (`createTask`, `applyPatch`), so visibility, "assignee must be on the project" and "no past due dates" can't diverge.

## AI assistants (MCP)

The Worker serves a remote MCP server at `https://<your-app-host>/mcp`. In Claude, add it as a custom connector with that URL; other MCP clients take the same URL. The client registers itself, the person signs in with the same Google account (or is already signed in), and approves the assistant on a consent page at `/authorize`. From then on **the assistant acts as that person**: it sees only what they see, follows the same rules, and every change it makes is written to the task history with `task_events.via` set to the client's registered name (shown as "via Claude").

| Tool | What it does |
|---|---|
| `list_projects()` | Your projects: name, description, color, and who can be assigned there. The descriptions tell the assistant where tasks belong |
| `list_tasks(user?, project?, from?, to?, status?)` | Tasks by the day the app shows them on, with the same rollover rule (`shownOn`): "today" includes carried-over tasks. Defaults to today; at most 92 days |
| `create_task(title, project, due_date, assignee, priority, notes?, repeat?)` | All five main fields required. The tool description includes the project descriptions, so the assistant can pick the project without asking. `repeat` makes it a repeating task |
| `update_task(id, title?, notes?, project?, due_date?, priority?, status?, repeat?, stop_repeating?, skip?)` | Only the fields given change; `status: "open"` reopens. On a repeating task, can change, stop or skip the repeat |
| `complete_task(id)` | Marks it done today; for a repeating task, returns the new copy as `next_copy` |
| `transfer_task(id, to, note?, this_only?)` | The new assignee must be on the task's project. `this_only` leaves future copies of a repeating task with the current person |
| `project_day(project, date)` | What got finished in a project that day (by priority, then due date), plus what's still open |

People and projects are given by name (or email, or "me"), not ids. Access is checked on every call, so removing someone or taking them off a project applies to their assistant at once. Access tokens last an hour; a connection lasts a year from approval, after which the person signs in again. Removing a person (or setting them inactive) cuts their assistant off immediately.

## Run it locally

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:reset:local     # creates the local D1 database and loads the sample data
npm run dev                # http://localhost:5173
```

Open http://localhost:5173/login and use **Local development sign-in**, for example `jordan@example.com` (admin) or `sara@example.com` (member). This route only works when `DEV_LOGIN=1` is set and the request comes from localhost. Google isn't needed locally unless you want to try the real sign-in.

Useful commands: `npm run typecheck` · `npm run build` · `npm run db:migrate:local`. Local development uses `wrangler.jsonc` as it is (placeholder IDs, data under `.wrangler/state`); it doesn't need a `tenants/` file.

**Trying the MCP server locally.** With `npm run dev` running, start the MCP Inspector with `npx @modelcontextprotocol/inspector`, choose *Streamable HTTP*, enter `http://localhost:5173/mcp` and connect. It opens the consent page; if you aren't signed in, use the local development sign-in there and you'll come back to it. Changes made through the Inspector show up in the app's history as "via MCP Inspector" (or whatever name the client registered with). Local OAuth data lives in the local KV under `.wrangler/state`.

## Deploy to Cloudflare

The same code deploys to as many **instances** as you like, for example one per team or client. Each instance is its own Worker with its own database, so teams never see each other's data.

What makes an instance is a small file, `tenants/<instance>.env`, which is **not committed** (`.gitignore` keeps everything in `tenants/` out except `tenants/example.env`). `wrangler.jsonc` holds only what every instance shares, plus placeholder IDs for local development, so a plain `wrangler deploy` fails rather than deploying somewhere by accident.

| Value in `tenants/<instance>.env` | What it is | Where to get it |
|---|---|---|
| `WORKER_NAME` | The Worker; the app lives at `https://<WORKER_NAME>.<your-subdomain>.workers.dev` | You choose it (lowercase, numbers, dashes). Your subdomain is under *Workers & Pages* in the dashboard |
| `D1_DATABASE_NAME`, `D1_DATABASE_ID` | The instance's database | Printed by `npx wrangler d1 create <name>`; for an existing one, `npx wrangler d1 list` |
| `OAUTH_KV_ID` | Where AI assistant sign-ins are stored | Printed by `npx wrangler kv namespace create <name>`; for an existing one, `npx wrangler kv namespace list` |
| `TEAM_TZ` (optional) | Fallback time zone, e.g. `Europe/London` | Any "TZ identifier" from the [tz database list](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones) |
| `CUSTOM_DOMAINS` (optional) | e.g. `tasks.acme.com` | A domain (zone) in the same Cloudflare account |
| `WORKERS_DEV` (optional) | `false` to serve only on the custom domains | |
| `CLOUDFLARE_ACCOUNT_ID` (optional) | Needed when your login can reach several accounts | `npx wrangler whoami` |
| `CLOUDFLARE_PROFILE` (optional) | A different Cloudflare login for this instance (e.g. a client's own account) | Create one with `npx wrangler auth create <name>`; list them with `npx wrangler auth list` |

[`tenants/example.env`](tenants/example.env) explains each value in more detail. Secrets (the Google client) are never in the file: they're stored encrypted in Cloudflare, per Worker.

### A new instance

1. **Sign in to Cloudflare:** `npx wrangler login`
2. **Create its database and KV namespace, and the file:**
   ```bash
   npm run tenant -- create acme --tz Europe/London
   ```
   This creates the D1 database `taskivities-acme` and the KV namespace `taskivities-acme-oauth`, and writes `tenants/acme.env` with their IDs. Options: `--name <worker-name>` (default `taskivities-<instance>`), `--domain tasks.acme.com`, `--account <account id>`, `--profile <login profile>` (to create them in an account under another Cloudflare login).
   (Or create them yourself as the table above says, copy `tenants/example.env` to `tenants/acme.env` and fill it in.)
3. **Create a Google OAuth client** at [console.cloud.google.com](https://console.cloud.google.com): *APIs & Services → Credentials → Create credentials → OAuth client ID*.
   - Type: **Web application**.
   - Authorized redirect URIs: `https://<WORKER_NAME>.<your-subdomain>.workers.dev/auth/callback` (and `https://<custom domain>/auth/callback` for each custom domain), plus `http://localhost:5173/auth/callback` if you also use it locally.
   - Consent screen: *Internal* if everyone is in your Google Workspace. Otherwise use *External* and publish it, since external people such as clients are added by email. Scopes: `openid`, `email`, `profile`.
   - One client can serve several instances: add each instance's redirect URI to it.
4. **Add the secrets** (you paste each value when asked):
   ```bash
   npm run tenant -- secret acme GOOGLE_CLIENT_ID
   ```
   ```bash
   npm run tenant -- secret acme GOOGLE_CLIENT_SECRET
   ```
   Optional: `ADMIN_EMAILS` (comma-separated addresses that are always let in as admins).
5. **Deploy:**
   ```bash
   npm run deploy -- acme
   ```
   This creates or updates the database tables, builds the app, and deploys it to that instance's Worker. The MCP Durable Object and custom domains are set up on the first deploy.
6. **Sign in right away:** on an empty install the first person to sign in becomes the admin. Add your team on the **Team** page, and upload your logo on the **Settings** page.
7. **Connect an assistant:** in Claude, add a custom connector with `https://<your-app-host>/mcp` and sign in. Nothing else to configure: assistants sign in through the same Google client.

### Day to day

| Command | Does |
|---|---|
| `npm run deploy -- <instance>` | Migrate the database, build, deploy. Add `--dry-run` to build and check without deploying |
| `npm run tenant -- list` | Lists the instances in `tenants/` |
| `npm run db:migrate:remote -- <instance>` | Only the database migrations |
| `npm run tenant -- secret <instance> <NAME>` | Sets a secret on that instance's Worker |
| `npm run tenant -- wrangler <instance> <args…>` | Any other wrangler command for that instance, e.g. `tail` for live logs |

With a single file in `tenants/`, the instance name can be left out. `TENANT=acme npm run deploy` works too. The script writes each instance's full config to `.wrangler/tenants/<instance>.json` (git-ignored) and runs everything against it; see `scripts/tenant.mjs`.

Deploying to every instance after a code change is one command per instance; the database migrations run first each time, so instances can't end up on a newer app with an older database.

`DEV_LOGIN` is never set in production, so the development sign-in route returns 404 there.

## Not built yet

- **A list of connected assistants** in the app, with a way to disconnect them. For now a connection ends after a year, when the person is removed, or when an admin deletes its grant from the `OAUTH_KV` namespace.
- **Invite emails.** Admins currently share the link themselves.
- **Archiving projects** from the UI. The column exists, but there's no button yet.
- **Automated tests.** So far everything has been checked by hand in the browser and with the API.
