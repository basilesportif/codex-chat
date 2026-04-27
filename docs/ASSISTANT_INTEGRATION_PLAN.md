# Assistant-Claude Integration Plan

This document is the runbook for integrating Tim's personal assistant capabilities into `codex-chat`.

## Architecture

Two systems:

1. **assistant-claude** — Claude Code session on Tim's local machine. Scripts for calendar, email, CRM, reminders, todos, betting, finance, Whoop. Workspace data at `~/.assistant-claude/workspace/` (synced to GitHub as a git repo).
2. **codex-chat** — Telegram bot on prod (`178.104.208.141`), routes messages to OpenAI Codex (gpt-5.5).

The integration approach: clone assistant-claude on prod, clone the workspace data git repo on prod, copy secrets via rsync, and point Codex at the scripts via `addDirs` and a behavior file.

**No decommission phase needed.** Tim will simply stop messaging the old assistant-claude session. It can keep running harmlessly.

---

## Phase 1: One-Time Setup on Prod

Run these from Tim's local machine via SSH relay.

### Clone the repos on prod

```bash
# Clone assistant-claude
ssh tim@178.104.208.141 "mkdir -p /home/tim/pkg/tim && git clone git@github.com:basilesportif/tim-assistant-claude.git /home/tim/pkg/tim/assistant-claude"

# Clone workspace data
ssh tim@178.104.208.141 "git clone git@github.com:basilesportif/tim-data-assistant-claude.git /home/tim/.assistant-claude/workspace"
```

### Copy secrets

```bash
rsync -avz /home/tim/.assistant-claude/workspace/.env tim@178.104.208.141:/home/tim/.assistant-claude/workspace/.env
```

### Verify Node is available on prod

```bash
ssh tim@178.104.208.141 "node --version && bun --version"
```

Node and bun are already available since codex-chat runs on the same host.

---

## Phase 2: codex-chat Config Changes

Already done in this commit:

- `codex.addDirs` set to `["/home/tim/pkg/tim/assistant-claude"]` in `config/codex-chat.toml` — makes the scripts visible to Codex.
- `behavior/assistant-claude.md` created — tells Codex how to use the scripts and where the data lives.

---

## Phase 3: Verify

Send a test message to the bot (or run directly):

```bash
# Todos
node /home/tim/pkg/tim/assistant-claude/scripts/todo-list.js

# Calendar
node /home/tim/pkg/tim/assistant-claude/scripts/calendar-today.js

# Reminders
node /home/tim/pkg/tim/assistant-claude/scripts/reminder-check.js
```

Expected: each script runs and returns data. If any fail, check that secrets are sourced:

```bash
set -a && source /home/tim/.assistant-claude/workspace/.env && set +a
node /home/tim/pkg/tim/assistant-claude/scripts/todo-list.js
```
