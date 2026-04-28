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

- Config: `config/codex-chat.toml`
- Loops: `config/loops.json`
- Monitors: `config/monitors.json`
- Behavior pack: `behavior/AGENTS.md`
- JSON state: `data/state/`
- Telegram downloads: `data/files/`
- Subagent artifacts: `data/subagents/`


## Server bootstrap skill

The behavior pack includes `behavior/skills/setup-server/SKILL.md`, a deployment workflow for bootstrapping a fresh Ubuntu/Debian server for `codex-chat`. It covers creating a non-root deploy user, SSH hardening, UFW/fail2ban, generating an `ed25519` GitHub key, installing Bun/Node/Codex CLI, cloning/building this repo, configuring Telegram/OpenAI secrets, and installing the systemd user service.

## Example: three-repo assistant architecture

`codex-chat` is intentionally independent of any one assistant logic/data layout. It can run on top of different behavior packs, data stores, and workflow repositories. This deployment uses a three-repo architecture:

- `codex-chat` — Telegram/Codex runtime service. It receives Telegram messages, sends immediate acknowledgements, runs Codex, dispatches subagents, executes loops/monitors, and returns replies.
- `assistant-agent-logic` — reusable assistant logic: skills, prompts, helper scripts, setup/migration tooling, and Repo Registry runtime code.
- `assistant-agent-data` — private/user-owned workspace data: todos, instructions, Repo Registry state, task definitions, and durable assistant state.

In this architecture, `codex-chat` supplies the runtime while `assistant-agent-logic` supplies reusable workflows and `assistant-agent-data` supplies user-specific state. Other deployments can replace the logic and data layers while keeping `codex-chat` as the Telegram/Codex service.

The canonical documentation for this deployment's repo relationships lives in `assistant-agent-data` at `docs/assistant-system-architecture.md`.

