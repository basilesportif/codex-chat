# Assistant-Claude Integration Plan

This document is the cutover runbook for moving Tim's personal assistant capabilities from the current `assistant-claude` Claude Code workspace into `codex-chat`.

The desired end state is:

1. `codex-chat` is the only Telegram-facing assistant.
2. Codex/OpenAI is the reasoning engine.
3. The existing assistant-claude scripts, data files, and workspace sync flow remain available on the production server.
4. The Claude Code session can be shut down after smoke tests pass.

The assistant-claude repository and `~/.assistant-claude/workspace/` are not present on this dev server, so exact script names and environment variable names from that repo must be verified during Phase 2 with `find`, `rg`, and smoke tests. This plan uses the known architecture and known skill areas: Composio calendar/email, todos, CRM, reminders, betting, finance, Whoop, Telegram account reading, and persistent loops.

## Current Codex-Chat Facts

- Production host: `178.104.208.141`
- Production user: `tim`
- `codex-chat` workspace: `/home/tim/pkg/tim/codex-chat`
- Main config: `config/codex-chat.toml`
- Behavior pack: `behavior/AGENTS.md`
- Loops config: `config/loops.json`
- Runtime env file created by service install: `/home/tim/.config/codex-chat/env`
- Systemd user service: `codex-chat.service`
- Telegram mode: polling bot
- `opsChatId`: `253768951`
- Codex model: `gpt-5.5`
- Codex transport: `codex app-server` over local WebSocket

## Phase 1: Prerequisites

### 1. Install Runtime Tools On Prod

Log in to prod:

```bash
ssh tim@178.104.208.141
```

Install or verify the required tools:

```bash
node --version
bun --version
pnpm --version
git --version
codex --version
```

Required minimums from `codex-chat/package.json`:

- Node.js `>=24`
- Bun `>=1.3.0`
- pnpm `10.18.3` or compatible
- Codex CLI with `app-server` support

Install Bun if missing:

```bash
curl -fsSL https://bun.sh/install | bash
exec "$SHELL" -l
```

Install pnpm if missing:

```bash
corepack enable
corepack prepare pnpm@10.18.3 --activate
```

Install Composio tooling if the assistant scripts call the Composio CLI:

```bash
npm install -g composio-core
composio --version
```

If the CLI package name has changed, install the package required by the cloned assistant-claude repo and document it in that repo's local setup notes.

### 2. Configure Codex Authentication

`codex-chat` starts `codex app-server`; Codex CLI auth should be configured for user `tim` before enabling the service.

```bash
codex login
codex app-server --help
```

The current `codex-chat` process intentionally does not pass `OPENAI_API_KEY` into the spawned Codex app-server process. Treat the Codex CLI login/profile as the primary Codex auth path unless the implementation is changed.

### 3. Populate `/home/tim/.config/codex-chat/env`

Create or update the env file:

```bash
mkdir -p /home/tim/.config/codex-chat
chmod 700 /home/tim/.config/codex-chat
nano /home/tim/.config/codex-chat/env
chmod 600 /home/tim/.config/codex-chat/env
```

Minimum required keys:

```bash
TELEGRAM_BOT_TOKEN=...
OPENAI_API_KEY=...
```

`TELEGRAM_BOT_TOKEN` is used by the polling bot. `OPENAI_API_KEY` is used by `codex-chat` voice transcription.

Assistant capability keys to add after checking the cloned assistant-claude scripts:

```bash
# Composio / Google calendar / Gmail
COMPOSIO_API_KEY=...
COMPOSIO_ENTITY_ID=...
COMPOSIO_CONNECTED_ACCOUNT_ID=...

# Betting / odds data, if used by scripts
ODDS_API_KEY=...

# Finance / banking, exact provider depends on assistant-claude scripts
PLAID_CLIENT_ID=...
PLAID_SECRET=...
PLAID_ENV=...

# Whoop, exact token flow depends on assistant-claude scripts
WHOOP_CLIENT_ID=...
WHOOP_CLIENT_SECRET=...
WHOOP_REDIRECT_URI=...
WHOOP_ACCESS_TOKEN=...
WHOOP_REFRESH_TOKEN=...
```

Verify exact names from assistant-claude after cloning:

```bash
cd /home/tim/pkg/tim/assistant-claude
rg -n "process\.env|Deno\.env|os\.environ|COMPOSIO|PLAID|WHOOP|ODDS|TELEGRAM|OPENAI" scripts config
```

Every environment variable read by a script that Codex will call must either be present in `/home/tim/.config/codex-chat/env` or loaded by the script from the assistant workspace.

### 4. Set Up GitHub SSH Access On Prod

Verify whether prod can already access GitHub:

```bash
ssh -T git@github.com
```

If not configured:

```bash
ssh-keygen -t ed25519 -C "tim@codex-chat-prod" -f /home/tim/.ssh/id_ed25519
cat /home/tim/.ssh/id_ed25519.pub
```

Add the public key to GitHub with access to:

- `basilesportif/codex-chat`
- the private `assistant-claude` repo
- the workspace data remote, if separate

Then test:

```bash
ssh -T git@github.com
git ls-remote git@github.com:basilesportif/codex-chat.git
git ls-remote git@github.com:<owner>/assistant-claude.git
```

## Phase 2: Repo Setup On Prod

### 1. Clone Or Update `assistant-claude`

Use a stable path that can be referenced from `codex-chat` behavior and loop definitions:

```bash
mkdir -p /home/tim/pkg/tim
cd /home/tim/pkg/tim
git clone git@github.com:<owner>/assistant-claude.git assistant-claude
cd assistant-claude
git status
```

If the repo already exists:

```bash
cd /home/tim/pkg/tim/assistant-claude
git pull --ff-only
```

Install repo dependencies according to the repo's package files. Start with:

```bash
ls
find . -maxdepth 2 -type f \( -name package.json -o -name bun.lockb -o -name pnpm-lock.yaml -o -name requirements.txt -o -name pyproject.toml \) -print
```

Then run the relevant install commands. Examples:

```bash
pnpm install
bun install
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

Use only the commands that match the repo.

### 2. Create The Workspace Directory

Create the assistant workspace expected by the existing scripts:

```bash
mkdir -p /home/tim/.assistant-claude/workspace
mkdir -p /home/tim/.assistant-claude/workspace/data
mkdir -p /home/tim/.assistant-claude/workspace/tasks
mkdir -p /home/tim/.assistant-claude/workspace/logs
chmod 700 /home/tim/.assistant-claude
```

Expected data files include:

- `workspace/data/todos.json`
- `workspace/data/crm.json`
- `workspace/data/reminders.json`
- `workspace/data/bets.json`
- finance data files used by `config/skills/finance.md`
- Whoop cache/token/metrics files used by `config/skills/whoop.md`
- `workspace/tasks/loops.json`

After sync, validate that required files exist:

```bash
find /home/tim/.assistant-claude/workspace -maxdepth 3 -type f | sort
```

### 3. Sync Workspace Data From The Current Assistant Machine

From the machine that currently hosts the Claude Code assistant workspace, push data to prod with `rsync`:

```bash
rsync -avz --delete \
  /home/tim/.assistant-claude/workspace/ \
  tim@178.104.208.141:/home/tim/.assistant-claude/workspace/
```

If direct SSH from that machine to prod is unavailable, use an intermediate tarball:

```bash
cd /home/tim/.assistant-claude
tar czf assistant-workspace-$(date +%Y%m%d-%H%M%S).tgz workspace
scp assistant-workspace-*.tgz tim@178.104.208.141:/home/tim/
```

Then on prod:

```bash
cd /home/tim/.assistant-claude
tar xzf /home/tim/assistant-workspace-*.tgz
chmod -R go-rwx /home/tim/.assistant-claude
```

### 4. Set Up Workspace Git Remote

If the assistant workspace is already a git repo, preserve it:

```bash
cd /home/tim/.assistant-claude/workspace
git status
git remote -v
```

If it is not yet a repo but should auto-sync data, initialize it and add the private remote:

```bash
cd /home/tim/.assistant-claude/workspace
git init
git remote add origin git@github.com:<owner>/<assistant-workspace-data-repo>.git
git add data tasks
git commit -m "workspace: sync assistant data"
git push -u origin main
```

Add a sync script if assistant-claude does not already provide one:

```bash
cat >/home/tim/.assistant-claude/workspace/sync.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd /home/tim/.assistant-claude/workspace
git pull --rebase --autostash
git add data tasks
if ! git diff --cached --quiet; then
  git commit -m "workspace: autosync $(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi
git push
EOF
chmod +x /home/tim/.assistant-claude/workspace/sync.sh
```

If secrets or tokens are stored under the workspace, do not push them. Move secrets into `/home/tim/.config/codex-chat/env` or an untracked private file and update scripts accordingly.

## Phase 3: Codex-Chat Behavior Configuration

### 1. Update `behavior/AGENTS.md`

`codex-chat` loads `behavior/AGENTS.md` into the persistent Codex session at startup. Add a section that makes the assistant-claude tools discoverable and gives Codex a stable operating contract.

Recommended section:

```markdown
## Personal Assistant Tools

The assistant-claude repo is available at `/home/tim/pkg/tim/assistant-claude`.
The assistant workspace is available at `/home/tim/.assistant-claude/workspace`.

Use the assistant-claude skill files as operational documentation:

- `/home/tim/pkg/tim/assistant-claude/config/skills/composio.md`
- `/home/tim/pkg/tim/assistant-claude/config/skills/todo.md`
- `/home/tim/pkg/tim/assistant-claude/config/skills/crm.md`
- `/home/tim/pkg/tim/assistant-claude/config/skills/reminders.md`
- `/home/tim/pkg/tim/assistant-claude/config/skills/betting.md`
- `/home/tim/pkg/tim/assistant-claude/config/skills/finance.md`
- `/home/tim/pkg/tim/assistant-claude/config/skills/whoop.md`
- `/home/tim/pkg/tim/assistant-claude/config/skills/messaging.md`
- `/home/tim/pkg/tim/assistant-claude/config/skills/loops.md`

Before using a capability, read its skill file and prefer the existing scripts in `/home/tim/pkg/tim/assistant-claude/scripts`.
Do not rewrite workspace JSON by hand unless the skill explicitly documents that as the expected interface.
Use the scripts for calendar, email, reminders, todos, CRM, betting, finance, and Whoop.
Treat `/home/tim/.assistant-claude/workspace/data` and `/home/tim/.assistant-claude/workspace/tasks` as the source of truth for personal assistant data.
After data-changing operations, run the workspace sync command.
```

Then restart the service or start a new Codex thread so the behavior pack is reloaded.

### 2. Point Codex At The Assistant Scripts

The safest first integration is script reuse: let Codex inspect skill docs and invoke the existing assistant-claude scripts through shell commands.

After cloning the repo, inventory scripts:

```bash
cd /home/tim/pkg/tim/assistant-claude
find scripts -maxdepth 3 -type f | sort
rg -n "calendar|gmail|email|todo|crm|reminder|bet|finance|whoop|telegram|loop" scripts config/skills
```

Create a small local index file if useful:

```bash
cd /home/tim/pkg/tim/assistant-claude
find scripts -maxdepth 3 -type f | sort > /home/tim/.assistant-claude/workspace/scripts-index.txt
```

Codex should use absolute paths in commands from the `codex-chat` session, for example:

```bash
cd /home/tim/pkg/tim/assistant-claude
./scripts/<script-name> --help
```

Do not duplicate assistant data in `codex-chat/data`. `codex-chat/data` is for bot state, logs, files, and subagent artifacts; assistant personal data stays in `/home/tim/.assistant-claude/workspace`.

### 3. Environment Available To Codex

`codex-chat.service` loads `/home/tim/.config/codex-chat/env`. The main Codex session and assistant scripts inherit that environment from the service process unless a child spawn explicitly removes a variable.

After editing the env file:

```bash
systemctl --user daemon-reload
systemctl --user restart codex-chat.service
systemctl --user status codex-chat.service
```

Verify from an injected Codex turn:

```bash
cd /home/tim/pkg/tim/codex-chat
bun dist/main.js --config config/codex-chat.toml inject "Check whether the assistant integration environment is present without printing secret values."
```

The agent should confirm presence/absence only; it must not print secret values.

### 4. Configure Loops In `config/loops.json`

`codex-chat` loops are cron-backed. Each loop can send a prompt into the main Codex session or run a command and feed the output back to Codex.

Target loops:

- `reminder-check`: every 15 minutes
- `health-check`: every 15 minutes
- `workspace-sync`: every 15 minutes
- `calendar-check`: every 10 minutes

Start with prompt loops if exact script names are still being verified. This keeps Codex in control and allows it to read the assistant-claude skill files before taking action:

```json
{
  "version": 1,
  "namespace": "codex-chat",
  "defaults": {
    "timezone": "Etc/UTC",
    "timeoutSec": 1800,
    "route": "return_to_main",
    "lock": true
  },
  "loops": [
    {
      "id": "reminder-check",
      "enabled": true,
      "description": "Check due reminders and notify Tim when needed.",
      "schedule": "*/15 * * * *",
      "type": "prompt",
      "prompt": "Run the assistant reminder check. Use /home/tim/pkg/tim/assistant-claude/config/skills/reminders.md and the existing assistant-claude scripts. Notify Tim only for due reminders or failures.",
      "route": "return_to_main",
      "notifyOnFailure": true,
      "durable": true
    },
    {
      "id": "health-check",
      "enabled": true,
      "description": "Check codex-chat and assistant workspace health.",
      "schedule": "*/15 * * * *",
      "type": "prompt",
      "prompt": "Run a quiet health check for codex-chat, assistant-claude scripts, Composio connectivity, and workspace data access. Report only failures or material warnings.",
      "route": "return_to_main",
      "notifyOnFailure": true
    },
    {
      "id": "workspace-sync",
      "enabled": true,
      "description": "Sync assistant workspace data.",
      "schedule": "*/15 * * * *",
      "type": "command",
      "command": "/home/tim/.assistant-claude/workspace/sync.sh",
      "args": [],
      "cwd": "/home/tim/.assistant-claude/workspace",
      "route": "return_to_main",
      "notifyOnFailure": true
    },
    {
      "id": "calendar-check",
      "enabled": true,
      "description": "Check calendar for upcoming items that require Tim's attention.",
      "schedule": "*/10 * * * *",
      "type": "prompt",
      "prompt": "Run the assistant calendar check. Use /home/tim/pkg/tim/assistant-claude/config/skills/composio.md and the existing assistant-claude scripts. Notify Tim only for relevant upcoming calendar items, conflicts, or failures.",
      "route": "return_to_main",
      "notifyOnFailure": true
    }
  ]
}
```

If the assistant repo has reliable direct commands, convert prompt loops to command loops after smoke testing. Example:

```json
{
  "id": "reminder-check",
  "enabled": true,
  "description": "Check due reminders and notify Tim when needed.",
  "schedule": "*/15 * * * *",
  "type": "command",
  "command": "/home/tim/pkg/tim/assistant-claude/scripts/reminders/check-due",
  "args": [],
  "cwd": "/home/tim/pkg/tim/assistant-claude",
  "route": "return_to_main",
  "notifyOnFailure": true,
  "durable": true
}
```

Validate and install loop cron entries:

```bash
cd /home/tim/pkg/tim/codex-chat
bun dist/main.js --config config/codex-chat.toml loop validate
bun dist/main.js --config config/codex-chat.toml loop sync
crontab -l
```

Run loops manually before relying on cron:

```bash
bun dist/main.js --config config/codex-chat.toml loop run health-check
bun dist/main.js --config config/codex-chat.toml loop run workspace-sync
bun dist/main.js --config config/codex-chat.toml loop run calendar-check
bun dist/main.js --config config/codex-chat.toml loop run reminder-check
```

## Phase 4: Telegram Transition

The current assistant-claude session reads Telegram through a `plugin:telegram` MCP integration. `codex-chat` reads Telegram through the bot API in polling mode. There must only be one active reader for Tim's operational assistant messages.

### 1. Confirm Codex-Chat Bot Ownership

`config/codex-chat.toml` already sets:

```toml
[telegram]
mode = "polling"
opsChatId = 253768951

[telegram.allowlist]
userIds = [253768951]
adminUserIds = [253768951]
```

Before cutover, verify the prod bot receives and answers messages:

```bash
cd /home/tim/pkg/tim/codex-chat
bun dist/main.js --config config/codex-chat.toml health --strict
```

Send a normal Telegram message to the bot:

```text
ping
```

Expected result: codex-chat replies from the bot account.

### 2. Disable Claude Code Telegram Access

Before starting full assistant loops in `codex-chat`, stop the Claude Code session's Telegram reader.

Options, in preferred order:

1. Disable or remove the `plugin:telegram` MCP server from the Claude Code session config.
2. Stop the Claude Code session entirely if it is no longer needed for parallel validation.
3. Revoke the Telegram plugin credentials or bot/user session token used by assistant-claude.
4. If the Claude session must remain open briefly for reference, leave it running without Telegram MCP access.

Verify no assistant-claude process is polling or reading Telegram:

```bash
ps aux | rg -i "claude|telegram|mcp" | rg -v rg
```

Also check the assistant-claude logs for Telegram activity and confirm they stop advancing after decommission:

```bash
find /home/tim/.assistant-claude/workspace/logs -type f -maxdepth 2 | sort
```

### 3. Do Not Run Two Bots Or Readers For The Same Workflow

During migration, it is acceptable to run assistant-claude scripts manually for validation. It is not acceptable to keep both systems reading and responding to Tim's normal Telegram messages.

The cutover checkpoint is:

- `codex-chat` polling is enabled.
- assistant-claude Telegram MCP access is disabled.
- Tim sends messages only to the codex-chat bot.
- `opsChatId` remains `253768951`.

## Phase 5: Testing And Cutover

### 1. Preflight Checks

On prod:

```bash
cd /home/tim/pkg/tim/codex-chat
git pull --ff-only
pnpm install
pnpm run build
bun dist/main.js --config config/codex-chat.toml health --strict --json
bun dist/main.js --config config/codex-chat.toml monitors validate
bun dist/main.js --config config/codex-chat.toml loop validate
```

Check service logs:

```bash
journalctl --user -u codex-chat.service -n 200 --no-pager
```

Check assistant repo scripts:

```bash
cd /home/tim/pkg/tim/assistant-claude
find scripts -maxdepth 3 -type f | sort
rg -n "TODO|FIXME|process\.env|COMPOSIO|WHOOP|PLAID|ODDS" scripts config/skills
```

### 2. Smoke Tests By Capability

Run each test from Telegram unless noted. The expected result should be either the correct user-facing answer or a clear error that identifies the missing credential/script.

#### Telegram / Codex

Prompt:

```text
What is your current working directory, model, and whether you can see /home/tim/pkg/tim/assistant-claude? Do not print secrets.
```

Pass criteria:

- Replies through codex-chat bot.
- Reports `/home/tim/pkg/tim/codex-chat` as main workspace.
- Confirms assistant-claude path exists.
- Does not print secrets.

#### Voice Transcription

Send a short voice message:

```text
Remind me this is a transcription smoke test, but do not create a real reminder.
```

Pass criteria:

- Voice is transcribed.
- Codex responds to the transcript.

#### Calendar

Prompt:

```text
Using the assistant calendar tools, list my next calendar event today. Do not modify anything.
```

Pass criteria:

- Codex reads `config/skills/composio.md`.
- Existing Composio/calendar script runs successfully.
- Output is concise and accurate.

#### Email

Prompt:

```text
Using the assistant email tools, summarize my latest unread email without marking anything read.
```

Pass criteria:

- Gmail/Composio credentials work.
- No email state is modified.

#### Todos

Prompt:

```text
Using the assistant todo tools, create a test todo named "codex-chat migration smoke test", then mark it complete.
```

Pass criteria:

- `workspace/data/todos.json` changes as expected.
- Workspace sync captures the change.
- The final visible todo list is not polluted with an active test item.

#### CRM

Prompt:

```text
Using the assistant CRM tools, find a contact by name that already exists and summarize the next action. Do not create or modify contacts.
```

Pass criteria:

- `workspace/data/crm.json` is readable.
- Script returns expected contact/business context.

#### Reminders

Prompt:

```text
Using the assistant reminder tools, create a reminder due in 2 minutes saying "codex-chat reminder smoke test", then let the reminder loop handle it.
```

Manual loop trigger:

```bash
cd /home/tim/pkg/tim/codex-chat
bun dist/main.js --config config/codex-chat.toml loop run reminder-check
```

Pass criteria:

- Reminder is stored in `workspace/data/reminders.json`.
- Due reminder notification is sent through codex-chat.
- Reminder is marked sent/done according to assistant-claude semantics.

#### Betting

Prompt:

```text
Using the assistant betting tools, show current open bets or a summary of tracked bets. Do not create a bet.
```

Pass criteria:

- `workspace/data/bets.json` is readable.
- Any odds provider key needed by scripts is present.

#### Finance

Prompt:

```text
Using the assistant finance tools, show a read-only account/balance summary. Do not initiate transfers or modify anything.
```

Pass criteria:

- Banking data scripts authenticate.
- Output is read-only and does not expose account numbers beyond the existing script's safe display rules.

#### Whoop

Prompt:

```text
Using the assistant Whoop tools, summarize my latest recovery/sleep/strain metrics.
```

Pass criteria:

- Whoop token flow works on prod.
- Latest metrics are available or the script provides a clear reauth instruction.

#### Workspace Sync

Manual loop:

```bash
cd /home/tim/pkg/tim/codex-chat
bun dist/main.js --config config/codex-chat.toml loop run workspace-sync
cd /home/tim/.assistant-claude/workspace
git status
```

Pass criteria:

- Sync completes without conflicts.
- Data changes are committed and pushed, or there is a clear no-op.

#### Calendar Loop

Manual loop:

```bash
cd /home/tim/pkg/tim/codex-chat
bun dist/main.js --config config/codex-chat.toml loop run calendar-check
```

Pass criteria:

- The loop reaches the main Codex session.
- It stays silent when nothing requires attention.
- It sends a concise Telegram notice when action is needed.

### 3. Cutover Procedure

1. Sync latest assistant workspace data from the current assistant machine to prod.
2. Stop assistant-claude Telegram MCP access.
3. Pull and build latest `codex-chat` on prod:

   ```bash
   cd /home/tim/pkg/tim/codex-chat
   git pull --ff-only
   pnpm install
   pnpm run build
   ```

4. Ensure env file is complete:

   ```bash
   test -s /home/tim/.config/codex-chat/env
   ```

5. Start or restart codex-chat:

   ```bash
   systemctl --user daemon-reload
   systemctl --user restart codex-chat.service
   systemctl --user status codex-chat.service
   ```

6. Validate runtime:

   ```bash
   cd /home/tim/pkg/tim/codex-chat
   bun dist/main.js --config config/codex-chat.toml health --strict --json
   bun dist/main.js --config config/codex-chat.toml loop validate
   ```

7. Install loop cron entries:

   ```bash
   bun dist/main.js --config config/codex-chat.toml loop sync
   crontab -l
   ```

8. Run smoke tests for Telegram, calendar, email, todos, reminders, CRM, betting, finance, Whoop, and workspace sync.
9. Keep assistant-claude repo available, but keep the Claude Code session stopped or disconnected from Telegram.
10. Monitor logs for the first 24 hours:

    ```bash
    journalctl --user -u codex-chat.service -f
    tail -f /home/tim/pkg/tim/codex-chat/data/logs/cron/*.log
    ```

## Phase 6: Decommission

### 1. Shut Down The Claude Code Session

After codex-chat passes smoke tests and has handled normal traffic for at least one day:

1. Stop the Claude Code session.
2. Confirm no assistant-claude Telegram MCP process is running.
3. Remove or disable any cron/systemd jobs from assistant-claude that duplicate codex-chat loops.
4. Leave assistant workspace data sync owned by codex-chat loops.

Verification:

```bash
ps aux | rg -i "claude|assistant-claude|plugin:telegram|mcp" | rg -v rg
crontab -l
systemctl --user list-units | rg -i "claude|assistant"
```

### 2. Keep The Repo For Reference

Keep `/home/tim/pkg/tim/assistant-claude` on prod for now. It remains the source of:

- Skill documentation
- Runnable scripts
- Historical implementation details
- Data migration reference

Do not keep an active Claude Code runtime attached to Telegram. The repo is a dependency/reference library until the scripts are either wrapped, ported, or replaced by native codex-chat implementations.

### 3. Future Hardening

After cutover is stable, consider these follow-up changes:

1. Add a first-class `assistantTools` section to `config/codex-chat.toml` that records the assistant repo path, workspace path, and sync command.
2. Add script wrappers in `codex-chat/bin/assistant-*` so loops do not depend on long prompt text.
3. Move stable assistant-claude scripts into a shared package or into `codex-chat` after their interfaces are understood.
4. Add redacted env validation for required assistant integrations.
5. Add loop-specific prompts under `behavior/prompts/` instead of embedding long prompt strings in `config/loops.json`.
6. Add smoke-test commands that exercise each assistant capability without requiring Telegram.

## Rollback Plan

If cutover fails:

1. Stop codex-chat loops:

   ```bash
   cd /home/tim/pkg/tim/codex-chat
   cp config/loops.json config/loops.json.disabled-backup
   # edit loops to enabled=false or empty loops
   bun dist/main.js --config config/codex-chat.toml loop sync
   ```

2. Stop codex-chat service if it is sending bad responses:

   ```bash
   systemctl --user stop codex-chat.service
   ```

3. Re-enable the assistant-claude Telegram MCP integration.
4. Sync workspace data back from prod to the previous assistant host if prod has newer data:

   ```bash
   rsync -avz tim@178.104.208.141:/home/tim/.assistant-claude/workspace/ /home/tim/.assistant-claude/workspace/
   ```

5. Record the failure mode in the codex-chat repo before trying cutover again.
