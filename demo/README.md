# Taskivities public demo

A separate folder: nothing in `worker/`, `shared/` or `src/` knows about it, and the app's own build and `npm run deploy` never include it. It's deployed with `demo/deploy.mjs`.

`demo/worker.ts` wraps the app's own Worker (`worker/index.ts`) without changing it:

- **Sign-in:** `/login` is a demo page: sign in as Jordan (admin) or Sara (member) from `seed/dev.sql`. No Google client needed. `/auth/login`, `/auth/microsoft`, `/auth/workos` and `/auth/gmail` are turned off.
- **Uploads:** anything uploaded is kept as `samples/sample.png` (images) or `samples/sample.pdf` (anything else), under the visitor's file name (`files.ts`). Nothing is stored: there's no R2 bucket, and a stand-in bucket serves the samples. AI assistants' attachments get the same treatment.
- **Logo and app icon uploads** are refused with a message.
- **Banner:** every app page gets a "Demo · resets every 8 hours · Run your own →" bar.
- **Notifications:** work as in the app. The first deploy creates the instance's push keys (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`) as secrets. Everyone shares the sample people, so a visitor who turns notifications on as Jordan hears about what other visitors do as Sara; the reset deletes every device, and a device signs up again the next time its visitor opens the demo. The morning summary doesn't run (the demo's Cron Trigger only resets).
- **Reset:** a Cron Trigger (`DEMO_RESET_CRON`, default `0 */8 * * *`: at 00:00, 08:00 and 16:00 UTC) empties every table, reloads `seed/dev.sql` (dates relative to today) and signs everyone out (`reset.ts`). The first sign-in on an empty database loads the sample too.

## Commands

```bash
node demo/deploy.mjs dev            # local demo on http://localhost:5174, with its own local database
node demo/deploy.mjs reset-local    # run the reset on the local demo
node demo/deploy.mjs demo --dry-run # build and check without deploying
node demo/deploy.mjs demo           # migrate, build, deploy (uses tenants/demo.env)
```

## First deploy

1. `npm run tenant -- create demo --domain demo.taskivities.com` (creates the D1 database and KV namespace and writes `tenants/demo.env`; skip the Google secrets it suggests). Clear `R2_BUCKET` there, or leave it: the demo ignores it.
2. Optional in `tenants/demo.env`: `DEMO_RESET_CRON=0 */8 * * *`.
3. `node demo/deploy.mjs demo`
4. In the Cloudflare dashboard, add a rate-limiting rule for the demo's host (Security → WAF → Rate limiting rules).

Never point this at an instance with real data: a reset deletes everything.

To change what uploads become, replace `samples/sample.png` or `samples/sample.pdf` (Vite bundles them into the Worker via `samples.ts`).

If the app changes, check what the demo relies on: the routes it intercepts (`/login`, `/auth/login`, `/auth/microsoft`, `/auth/workos`, `/auth/gmail`, the logo/icon settings and upload routes), the `sessions` table and `tv_session` cookie, the `attachments` table, the `.app` layout and colour variables (banner), and the table list in `reset.ts` (add new tables there).
