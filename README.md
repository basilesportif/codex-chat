# codex-chat

Telegram-driven Codex instance with subagent support.

## Quick Start

```bash
pnpm install
pnpm run build
cp .env.example .env
export TELEGRAM_BOT_TOKEN=your-bot-token-here
export OPENAI_API_KEY=your-openai-api-key-here
bun dist/main.js setup
bun dist/main.js start
```

`setup` creates local runtime config from committed examples when files are
missing: `config/codex-chat.toml`, `config/loops.json`, and
`config/monitors.json`. Those runtime files are intentionally gitignored; edit
the local copies for deployment-specific paths, allowlists, loops, and monitors.

If `telegram.allowlist` is empty, `start` prints a one-time `/pair <code>` command. Send that command to the bot from Telegram to authorize your numeric Telegram user ID and chat ID.

## CLI

```bash
codex-chat start --config config/codex-chat.toml
codex-chat setup
codex-chat health --json
codex-chat loop sync
codex-chat loop run <id>
codex-chat monitors validate
codex-chat service install --user
codex-chat jobs list
```

## Runtime Paths

- Config: `config/codex-chat.toml` from `config/codex-chat.example.toml`
- Loops: `config/loops.json` from `config/loops.example.json`
- Monitors: `config/monitors.json` from `config/monitors.example.json`
- Behavior pack: `behavior/AGENTS.md`
- JSON state: `data/state/`
- Telegram downloads: `data/files/`
- Subagent artifacts: `data/subagents/`

## Child Vocab SRS JSON backups

The repo includes a small app-level backup script for `child-vocab-srs` data:

```bash
DATA_DIR=/root/var/child-vocab-srs/data pnpm run backup:child-vocab-srs
```

The script reads `/etc/child-vocab-srs.env` by default and lets process env
vars override file values. `DATA_DIR` is required and must contain `app.json`.
`BACKUP_DIR` is optional and defaults to
`/root/var/child-vocab-srs/backups`.

Each run validates `DATA_DIR/app.json` with `JSON.parse`, hashes that file, and
only writes a new `child-vocab-srs-<timestamp>-<hash>.tar.gz` snapshot when the
hash changes. The backup directory also gets `latest.sha256` and
`latest-backup.json`. Common temp files and temp directories are excluded from
the tarball.

Example systemd timer:

```ini
# /etc/systemd/system/child-vocab-srs-backup.service
[Unit]
Description=Back up child-vocab-srs JSON data

[Service]
Type=oneshot
EnvironmentFile=-/etc/child-vocab-srs.env
ExecStart=/usr/bin/node /home/tim/pkg/tim/codex-chat/scripts/child-vocab-srs-backup.mjs
```

```ini
# /etc/systemd/system/child-vocab-srs-backup.timer
[Unit]
Description=Run child-vocab-srs JSON backups every 15 minutes

[Timer]
OnCalendar=*:0/15
Persistent=true
Unit=child-vocab-srs-backup.service

[Install]
WantedBy=timers.target
```

Restore check:

```bash
mkdir -p /tmp/child-vocab-srs-restore
tar -xzf /root/var/child-vocab-srs/backups/<backup>.tar.gz -C /tmp/child-vocab-srs-restore
node -e 'JSON.parse(require("node:fs").readFileSync("/tmp/child-vocab-srs-restore/app.json", "utf8"))'
```

## Main-loop routing policy

The warm main Codex loop is intentionally narrow. It should only handle
extremely direct deterministic operations: simple acknowledgements,
service-level commands, direct todo/project state mutations or listing through
existing scripts, and trivial local lookups that require no interpretation.

README edits, documentation edits, code changes, repo inspection, calendar or
email lookup, research, debugging, architecture, multi-step work, ambiguous
work, and external-data lookup must dispatch a subagent with explicit
`summary`, `model`, and `effort`.

The service does not enforce this policy by keyword-blocking final main-loop
replies. The main Codex loop must choose the route up front, then either reply
directly or emit a `dispatch_subagent` directive. Service-level guardrails are
reserved for malformed directive blocks, leaked directive fragments, and other
transport safety cases.

## Voice Transcription Prompt and Dictionary

Voice and audio transcription can use an OpenAI transcription prompt file for
names, project terms, preferred spellings, and lightweight cleanup guidance. Set
`transcription.promptPath` in `config/codex-chat.toml` to the file path. The
service chooses that path at startup, then reads the file fresh for every
transcription, so edits to the prompt/dictionary file do **not** require
restarting `codex-chat`.

The recommended deployment file is:

```text
/home/tim/.assistant-claude/workspace/instructions/prompts/voice-transcription.md
```

Example file contents:

```md
Use this as transcription vocabulary and correction guidance. Preserve the
speaker's meaning. Prefer the spellings and replacements below when audio is
ambiguous. Remove filler words.

USER DICTIONARY:
- GPT-5.5
- Codex
- xhigh
- Telegram.md → TELEGRAM.md
- Mosh → Mush
- Derek White → Derrick White
```

If `promptPath` is unset, missing, empty, or unreadable, transcription runs
without a prompt. Keep secrets out of this file: it is sent to OpenAI with each
voice/audio transcription request.

## Server bootstrap skill

The behavior pack includes `behavior/skills/setup-server/SKILL.md`, a deployment workflow for bootstrapping a fresh Ubuntu/Debian server for `codex-chat`. It covers creating a non-root deploy user, SSH hardening, UFW/fail2ban, generating an `ed25519` GitHub key, installing Bun/Node/Codex CLI, cloning/building this repo, configuring Telegram/OpenAI secrets, and installing the systemd user service.

## Example: three-repo assistant architecture

`codex-chat` is intentionally independent of any one assistant logic/data layout. It can run on top of different behavior packs, data stores, and workflow repositories. This deployment uses a three-repo architecture:

- `codex-chat` — Telegram/Codex runtime service. It receives Telegram messages, sends immediate acknowledgements, runs Codex, dispatches subagents, executes loops/monitors, and returns replies.
- `assistant-agent-logic` — reusable assistant logic: skills, prompts, helper scripts, setup/migration tooling, and Repo Registry runtime code.
- `assistant-agent-data` — private/user-owned workspace data: todos, instructions, Repo Registry state, task definitions, and durable assistant state.

In this architecture, `codex-chat` supplies the runtime while `assistant-agent-logic` supplies reusable workflows and `assistant-agent-data` supplies user-specific state. Other deployments can replace the logic and data layers while keeping `codex-chat` as the Telegram/Codex service.

The canonical documentation for this deployment's repo relationships lives in `assistant-agent-data` at `docs/assistant-system-architecture.md`.
