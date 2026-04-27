# Assistant Skills

The assistant-claude repo will be cloned at `/home/tim/pkg/tim/assistant-claude` (see docs/ASSISTANT_INTEGRATION_PLAN.md for setup). The workspace data lives at `/home/tim/.assistant-claude/workspace/`.

Scripts require env vars from `/home/tim/.assistant-claude/workspace/.env`. Always prefix script runs with:

```bash
set -a && source /home/tim/.assistant-claude/workspace/.env && set +a
```

## Available Scripts

Run these with `node <path>` from any directory:

- **Todos**: `node /home/tim/pkg/tim/assistant-claude/scripts/todo-list.js` — list todos; `scripts/todo-add.js`, `scripts/todo-complete.js`
- **Reminders**: `node /home/tim/pkg/tim/assistant-claude/scripts/reminder-check.js` — check due reminders; `scripts/reminder-add.js`
- **Calendar**: `node /home/tim/pkg/tim/assistant-claude/scripts/calendar-today.js` — today's events; `scripts/calendar-week.js`
- **Email**: `node /home/tim/pkg/tim/assistant-claude/scripts/email-actionable.js` — actionable emails across providers
- **CRM**: data at `~/.assistant-claude/workspace/data/crm.json`; read and write directly via JSON
- **Betting**: data at `~/.assistant-claude/workspace/data/bets.json`; read and write directly via JSON
- **Finance**: `node /home/tim/pkg/tim/assistant-claude/scripts/finance-balances.js`
- **Whoop**: `node /home/tim/pkg/tim/assistant-claude/scripts/whoop-today.js`

## Data Files

All JSON data lives at `~/.assistant-claude/workspace/data/`:

- `todos.json` — personal to-dos
- `reminders.json` — scheduled reminders
- `crm.json` — contacts and businesses
- `bets.json` — sports bet tracking
- `projects.json` — multi-step projects

## Workspace Sync

After any data change, sync to GitHub:

```bash
cd ~/.assistant-claude/workspace && git add -A && git commit -m "update" && git push
```

## Skill Docs

Full documentation for each capability is in the assistant-claude repo:

- `config/skills/todo.md`
- `config/skills/reminders.md`
- `config/skills/composio.md` — calendar and email via Composio
- `config/skills/crm.md`
- `config/skills/betting.md`
- `config/skills/finance.md`
- `config/skills/whoop.md`
