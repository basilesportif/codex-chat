# Assistant-Claude Integration Plan

This document is the runbook for integrating Tim's personal assistant capabilities into `codex-chat`.
It is a historical integration plan, not the canonical behavior specification
for the running assistant.

For current image generation and editing behavior, use `behavior/AGENTS.md`,
`behavior/directives.md`, and `behavior/subagents/implementer.md` as the source
of truth.

## Architecture

Two systems:

1. **assistant-claude** — Claude Code session on Tim's local machine. Scripts for calendar, email, CRM, reminders, todos, betting, finance, Whoop. Workspace data at `~/.assistant-claude/workspace/` (synced to GitHub as a git repo).
2. **codex-chat** — Telegram bot on prod (`178.104.208.141`), routes messages to OpenAI Codex (gpt-5.5).

The integration approach: clone assistant-claude on prod, clone the workspace data git repo on prod, copy secrets via rsync, and point Codex at the scripts via `addDirs` and a behavior file.

**No decommission phase needed.** Tim will simply stop messaging the old assistant-claude session. It can keep running harmlessly.

---

## Phase 1: One-Time Setup on Prod

Run these from Tim's local machine via SSH relay.

### Copy repos to prod

Prod has no GitHub SSH key, so we rsync directly from the assistant machine (see below).

### Copy secrets and repos

The assistant machine can SSH directly to prod. Run from the assistant machine:

```bash
# Create directories
ssh tim@178.104.208.141 "mkdir -p /home/tim/pkg/tim/assistant-claude /home/tim/.assistant-claude/workspace"

# Rsync assistant-claude scripts (no git history needed)
rsync -avz --exclude='.git' --exclude='node_modules' /home/tim/pkg/tim/assistant-claude/ tim@178.104.208.141:/home/tim/pkg/tim/assistant-claude/

# Rsync workspace data including .git (preserves git remote for future syncs)
rsync -avz /home/tim/.assistant-claude/workspace/ tim@178.104.208.141:/home/tim/.assistant-claude/workspace/
```

> **Status: Done.** All files are already on prod as of 2026-04-27.

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
