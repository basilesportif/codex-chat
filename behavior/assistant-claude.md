# Assistant Skills

The assistant-agent-logic repo is cloned at `/home/tim/pkg/tim/assistant-agent-logic`. The workspace data lives at `/home/tim/.assistant-claude/workspace/`.

**The skill docs in that repo are the source of truth** for every capability: which script to run, its flags, and the required workflow. Do not run scripts from memory or from this file alone — read the relevant skill doc first (see the list below), then run exactly what it documents.

Some scripts require env vars from `/home/tim/.assistant-claude/workspace/.env`. Load them in a subshell scoped to the single command — do not export the secrets file into your long-lived shell:

```bash
( set -a && source /home/tim/.assistant-claude/workspace/.env && set +a && node /home/tim/pkg/tim/assistant-agent-logic/scripts/<script>.js ... )
```

## Capabilities → skill docs

Run scripts with `node <absolute path>` from any directory. Script names and flags below are examples — the skill doc for each area lists the full, current set:

- **Todos** — `config/skills/todo.md` (e.g. `scripts/todo-list.js`, `scripts/todo-add.js`, `scripts/todo-delete.js`)
- **Reminders** — `config/skills/reminders.md` (e.g. `scripts/reminder-check.js`, `scripts/reminder-add.js`)
- **Calendar & Email** — `config/skills/composio.md` (e.g. `scripts/calendar-events.js`, `scripts/calendar-search.js`, `scripts/email-actionable.js`)
- **CRM** — `config/skills/crm.md` (e.g. `scripts/crm-view.js`, `scripts/crm-update-person.js`)
- **Betting** — `config/skills/betting.md` (e.g. `scripts/bet-list.js`, `scripts/bet-add.js`)
- **Finance** — `config/skills/finance.md` (e.g. `scripts/finance-balances.js`)
- **Whoop** — `config/skills/whoop.md` (e.g. `scripts/whoop-cycle.js`, `scripts/whoop-recovery.js`, `scripts/whoop-sleep.js`)

**Never read or write the workspace JSON data files (`crm.json`, `bets.json`, `todos.json`, …) directly.** The scripts hold cross-process file locks and write atomically; ad-hoc JSON edits race them and corrupt state. Every read and every mutation goes through the documented scripts.

## Data Files

All JSON data lives at `~/.assistant-claude/workspace/data/` (`todos.json`, `reminders.json`, `crm.json`, `bets.json`, `projects/` [directory: per-project JSON plus markdown notes, with a JSON index], …). These paths are for reference/debugging awareness only — access is always via scripts, per above.

## Workspace Sync

After any data change, sync to GitHub:

```bash
cd ~/.assistant-claude/workspace && git add -A && git commit -m "update" && git push
```

## Skill Docs

Full documentation for each capability is in the assistant-agent-logic repo:

- `config/skills/todo.md`
- `config/skills/reminders.md`
- `config/skills/composio.md` — calendar and email via Composio
- `config/skills/crm.md`
- `config/skills/betting.md`
- `config/skills/finance.md`
- `config/skills/whoop.md`
- `config/skills/web-page-design.md` - real site/page visual design, visual redesign, and design systems
- `config/skills/generated-web-page.md` - static scratch/temporary/private preview/quick/one-off pages, simple visualizations, maps, reports, charts, tables, calculators, and publishing; default these page requests through `codex-chat-web` using the configured private Clerk-protected base URL unless Tim asks otherwise
- `config/skills/secret-injection.md` - installing, rotating, uploading, or repairing API keys/env secrets on remote services; resolve the target from registry/deploy metadata and run SSH-based commands from Tim's local/control machine rather than asking Tim to first SSH into the server
