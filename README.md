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
