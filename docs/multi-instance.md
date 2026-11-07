# One app, several instances

How Taskivities lets one person use several instances (say their team's at work and their own) from one app,
while every **server stays single-tenant**. Read this before changing anything in `src/sources.ts`,
`src/router.ts`, `worker/v1.ts`, `worker/relay.ts`, or how notifications are sent.

## The idea

```
                     ┌──────────────────────── your browser ────────────────────────┐
                     │  The app (served by your home instance)                        │
                     │                                                                │
                     │   home: cookie session ──► /api/*       other: OAuth token ──► /v1/*
                     └──────────┬─────────────────────────────────────────┬───────────┘
                                │ same origin                             │ cross-origin (CORS)
                                ▼                                         ▼
                   ┌─────────────────────────┐              ┌─────────────────────────┐
                   │ Home instance           │              │ Other instance (work)   │
                   │ one team, one database  │◄─ relay ─────│ one team, one database  │
                   │ + relays for its people │  (notices)   │ + push_relays           │
                   └─────────────────────────┘              └─────────────────────────┘
```

- **The servers are single-tenant.** Each instance knows only its own people, projects and tasks. No instance
  stores another's data, fetches it on someone's behalf, or knows which other instances exist beyond a list of
  notification relays.
- **The front end is single- or multi-tenant, per person.** The app is served by your *home* instance (the one
  you sign in to normally). Connecting another instance makes the app a client of that one too: it signs in there
  as you and talks to it directly from the browser, with the same API the instance's own app uses.
- **The one server-to-server path is notifications**, and it only carries notices one way: an instance passes a
  person's notifications to a relay their home instance runs for them, which shows them on their devices.

Why not have the home server fetch other instances for you (an earlier design, PR #3)? It made every server a
multi-tenant proxy: it stored other instances' tokens, polled them, and needed its own API for a limited set of
changes. Doing it in the app keeps the servers simple, gives every feature for free (anything the API can do,
the app can do on any instance), and keeps updates as fast as the app's own sync.

## The pieces

### On every instance (server)

| Piece | Where | What it does |
|---|---|---|
| `/v1/*` | `worker/v1.ts` | The same routes as `/api/*`, authenticated by an OAuth access token instead of the session cookie. CORS allows any origin: a bearer token isn't an ambient credential (no cookies are read), so only its holder can use it. |
| Sign-in | `worker/oauth.ts`, `worker/index.ts` | The same OAuth provider, consent page and tokens as AI assistants (MCP). Apps register themselves (`/register`), sign in with PKCE, refresh with `/token`, and are revoked with RFC 7009 at `/token`. `/v1` checks tokens itself with `unwrapToken`, so the provider's `/mcp` resource (and existing assistant tokens) stay as they are. |
| `push_relays` | `worker/relay.ts` (`relayTargetRoutes`), `worker/push.ts` | Where else to send a person's notifications: the relays their home instances run for them. `deliver()` and the 8:00 summary send to relays as well as to this instance's push subscriptions. A relay answering 404/410 is forgotten. |

### On a home instance (server)

| Piece | Where | What it does |
|---|---|---|
| `relays` | `worker/relay.ts` (`relayRoutes`, `relayIn`) | One relay per person and connected instance, with who they are there (`remote_user`). Its secret is in its URL (`/relay/<id>.<secret>`); only the hash is kept. `POST /relay/…` takes a notice and sends it to the person's devices with **this** instance's push key, linking to `/?open=<instance>&task=<id>`. |
| One connection per instance | `POST /api/relays` | Refuses (409) a relay for an instance already connected as someone else, so the rule holds on every device. To switch, disconnect first. |
| Reconnect on a new device | `GET /api/relays` | Lists the instances someone connected, so a device that hasn't offers a one-tap connect. |

### In the app (front end)

| Piece | Where | What it does |
|---|---|---|
| Connections | `src/sources.ts` (`Conn`) | Per device, in `localStorage` (`tv:sources`): the instance, the app's client id there, the access and refresh tokens, and who you are there. |
| Ids | `nsId`, `feedParts`, `isFeed` | Another instance's ids become `f~<connection>~<their id>` in the store, so they never clash with this instance's. Your account there becomes **you** here (`feedDir.me` keeps who you are there). |
| Store | `applyFeedDir`, `feedDir` | Their people and projects sit in `s.users` / `s.projects` next to ours, marked `feed` (the instance's name). Their tasks sit in `s.tasks`. |
| Requests | `clientFor(id)`, `srcCall` | Every request about a task goes to the right server: `/api/tasks/<id>…` here or `/v1/tasks/<their id>…` there. Ids in bodies are translated out (`bodyOut`), and answers back in (`answerIn`). Tokens refresh themselves; a dead grant marks the connection "signed out". |
| Sync | `loadSources`, `syncSources`, `sourcesRange` | Each instance is loaded (`/v1/bootstrap`, `/v1/tasks`) and kept up (`/v1/sync`) on the same timer as this one. |
| Files | `attachmentBlob`, `uploadTarget` | A token can't go in `<img src>`, so files from another instance are fetched with the token and shown from memory; uploads go to the task's own instance. |
| Inbox | `sourcesInbox`, `sourcesMarkRead` | The newest page of each instance's inbox is mixed into the bell, each entry keeping whether it was seen there. |
| Connecting | `connectInstance`, `finishConnect` | Registers the app there, sends you to sign in and approve, swaps the code for tokens, checks who you approved as, creates the relay here and registers it there (and again on every load, so a dropped one comes back). |
| Addresses | `src/router.ts` | URLs carry another instance's ids as `<their id>@<host>`, so a link works on any device that connected that instance. |
| Lists | `localProjects`, `localUsers`, `personOn`, `sameSource`, `myProjectsEverywhere` | This instance's own lists (People & projects, menus, All projects) leave other instances out; pickers that may mix them check people against projects *within one instance*. |

## The flows

**Connecting** (account menu → Other instances → an address):
1. The app registers itself on the other instance once per device (`POST /register`, "Taskivities on <host>").
2. The browser goes there to sign in and approve (`/authorize`, PKCE), and comes back to `/oauth/done`.
3. The app swaps the code for tokens (`POST /token`) and asks who it signed in as (`/v1/bootstrap`). A reconnect
   as a different person is refused and that sign-in revoked.
4. Home creates the relay (`POST /api/relays`, refusing a second person); the app registers it there
   (`POST /v1/push-relays`). Then the instance loads and joins the sync.

**A notification:** something happens there → its `deliver()` sends to your devices it knows about *and* to your
relay → your home instance pushes it to your devices → clicking it opens `/?open=<instance>&task=<id>`, which the
router turns into the task, through the connection (or offers to connect this device).

**Disconnecting:** the app revokes the sign-in there, deletes the relay here (that instance then gets 410 and
forgets it), and drops the instance's data from the store.

## Rules for changing the code

1. **Keep the servers single-tenant.** A server never stores another instance's data or acts on it. If a feature
   seems to need that, do it in the app.
2. **New API routes:** mount a route module in both `worker/index.ts` (`/api/…`) and `worker/v1.ts` (`/v1/…`), so
   other instances' apps can use it too. Check access with the viewer, as always; `/v1` sets the same viewer.
3. **Requests about a task:** use `clientFor(id)` (or `srcCall`), never `` `/api/tasks/${id}` `` directly.
4. **New id fields:** if a request body or answer carries person, project or task ids, add them to `bodyOut` /
   `answerIn` / `taskIn` / `eventIn` in `src/sources.ts`, or ids will cross instances untranslated.
5. **This instance's lists** (admin pages, menus of this instance's projects or people, All projects) use
   `localProjects(s)` / `localUsers(s)`, never `Object.values(s.projects)` or `Object.values(s.users)`.
   Pickers that may mix instances use `personOn` / `sameSource`.
6. **Never parse ids yourself:** use `isFeed` / `feedParts` / `nsId`. Our ids contain `~`; URLs use `id@host`
   (`src/router.ts`).
7. **Reloading this instance's directory** must keep other instances' data (`applyFeedDir`, and
   `reloadDirectory` keeps tasks with `f~` ids), and must not reset a view of another instance's person or project.
8. **Notifications:** new kinds go through `deliver()` in `worker/push.ts`, which feeds relays too. Keep relay
   payloads to `title`, `body`, `tag`, `taskId`.
9. **Every instance must run a version with `/v1` and relays** for connecting to work. A missing `/register` or
   `/v1` is reported to the person as "needs Taskivities 0.6 or later".

## Security model

- **Who can do what:** a connection acts as the person who approved it, with exactly their access on that
  instance, enforced there. History records their changes as theirs.
- **Tokens** live in the browser (`localStorage`) of each connected device: an XSS bug in the app could read them.
  Access tokens last an hour; refresh tokens a year; disconnecting or revoking on the other instance ends them.
  Keep the app free of `dangerouslySetInnerHTML` with untrusted content.
- **Relays** are capability URLs (like webhooks): whoever holds the URL can show a notification on that person's
  devices, nothing more. They're rate-limited and removed on disconnect.
- **CORS** on `/v1` and the OAuth endpoints allows any origin, because nothing there relies on cookies.
- **Plain http** is only accepted between copies running on one computer (both on localhost / 127.0.0.1).

## Known limits

- **Per-device sign-in:** each device connects once. Disconnecting on one device doesn't disconnect another,
  though that device stops receiving the instance's notifications (the relay is gone).
- **One 8:00 summary per instance**, through the relay; home doesn't merge them yet.
- **Worker to Worker:** relays are server-to-server fetches; check them between two deployed instances (Cloudflare
  limits some same-account Worker fetches).
- **The demo** (`demo/`): anyone can connect it to their own instance, signing in there as one of its sample
  people. It doesn't register relays (everyone shares those people, so others' doings would reach your devices),
  and swaps uploads from `/v1` for its sample files, as it does for `/api`. Connections aren't meant to outlast its
  hourly reset (they may, since sign-ins are kept outside its database); reconnect if one stops working.

## Trying it locally

Two copies on one computer, with separate cookies (different hosts):

```bash
npm run dev -- --port 5173                     # home: http://localhost:5173
TASKIVITIES_WRANGLER_CONFIG=$PWD/.wrangler/tenants/local.demo.json \
  node_modules/.bin/vite --port 5174 --host 127.0.0.1   # another: http://127.0.0.1:5174 (the local demo)
```

Run `node demo/deploy.mjs dev` once first: it writes `.wrangler/tenants/local.demo.json` and migrates the demo's
local database (stop it, then start it as above so it listens on 127.0.0.1). Migrate the home database with
`npm run db:migrate:local`. Sign in to `127.0.0.1:5174` (`/auth/demo-login?as=jordan`), then in the home app open
Other instances and connect `http://127.0.0.1:5174`.
