# Changelog

What changed in each version of Taskivities, newest first. Each version's section becomes its
[GitHub release](https://github.com/taskivities/taskivities-app/releases) notes, and admins of every instance see
"Update available" in the app's account menu when a new one is published.

New changes go under **Unreleased** (see [AGENTS.md](AGENTS.md)). `npm version minor` (or `patch`/`major`) turns that
section into the new version's; `git push --follow-tags` publishes it.

## Unreleased

- **One switcher for people and projects:** the same list on Tasks and Projects, with people first on Tasks and projects first on Projects. It has a search box, jump buttons for big teams, and it scrolls instead of running off the screen, so the second section is always reachable.
- **Open by default when looking at someone else's work:** in another person's week and in a project's week every past day with something in it starts open (empty days stay folded), and a project's "Not finished" list starts open and stays that way when you switch projects. Your own week still folds past days away to keep it clean.

## v0.3.0 (2026-11-05)

- **Inbox:** a bell in the top bar lists what needs you: tasks given to you, comments on your tasks, and handovers, with a count of what's new. It works whether or not notifications are on, and on every device. It's read from the task history, so nothing extra is stored. **G I** opens it.
- **Followers:** follow a task to hear about its comments, when it's done or reopened, and when it's handed on, in notifications and the inbox. Creators follow their tasks, commenting follows a task, and you can add someone else on the project. **F** follows the selected task; assistants can use `follow_task`.

## v0.2.0 (2026-11-05)

The first published release: everything Taskivities does so far.

### Added
- **Tasks:** Today, Week and Board views of anyone's work you can see, with carried-over tasks, priorities, due dates, transfers with a note, and drag-and-drop on the board. Everything is keyboard-driven (press `?` for the shortcuts).
- **Projects:** the same Today, Week and Board views for a project, showing everyone's tasks in it, plus the day report with Copy summary. The picker at the top lists people and projects together, so switching keeps the same view.
- **Repeating tasks**, **comments**, **checklists** and **file attachments** (with an R2 bucket), all recorded in each task's permanent history.
- **Archive instead of delete** for tasks and projects: they leave every list and can be restored with their history.
- **People:** admins add people by email with a role and projects, and disable them instead of deleting them; disabled people keep their history and can be enabled again.
- **Sign-in** with Google, and optionally with an emailed code, Microsoft or passkeys through WorkOS AuthKit.
- **Invite emails** sent from an admin's own Gmail (send-only permission).
- **Notifications** on phones and computers (Web Push): tasks given to you, comments on your tasks, and an optional 8:00 summary. No outside service; keys are created on the first deploy.
- **AI assistants** connect over MCP (for example Claude) and act as the person who connected them, with every change marked in the history.
- **Webhooks** that turn requests from other services into tasks.
- **Branding:** your own logo, name or wordmark, and home-screen icon. Light and dark themes. Installs to a phone's home screen.
- **Update notices:** admins see "Update available" when a newer release is published, with the release notes and the commands to update.
- **Deploy many teams** from one codebase (`npm run tenant`, `npm run deploy`), and a public demo (`demo/`).
