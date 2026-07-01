# Main-loop model/provider switching

`codex-chat` already supports changing the main-loop Codex app-server model at
process startup through config or env overrides. The running service reads these
once when `codex-chat.service` starts, so changing them requires a restart to
spawn a new Codex app-server and start/resume the main thread with the selected
model/provider.

## Env knobs

These env vars override `[codex]` in `config/codex-chat.toml` for the main loop
only:

- `CODEX_CHAT_CODEX_MODEL` — main-loop model slug, e.g. `gpt-5.5` or
  `z-ai/glm-5.2`.
- `CODEX_CHAT_CODEX_PROFILE` — Codex CLI profile, e.g. `openrouter`; empty uses
  the normal Codex/OpenAI subscription profile.
- `CODEX_CHAT_CODEX_MODEL_PROVIDER` — app-server `thread/start` provider id,
  e.g. `openrouter`; empty uses the Codex default provider.
- `CODEX_CHAT_CODEX_SERVICE_TIER` — `fast` or `standard`.
- `CODEX_CHAT_CODEX_SERVICE_TIER_MODE` — `auto`, `always`, or `omit`. Use
  `omit` for non-OpenAI providers such as OpenRouter.

Rollback to the default Codex/OpenAI subscription is:

```bash
CODEX_CHAT_CODEX_MODEL=gpt-5.5
CODEX_CHAT_CODEX_PROFILE=
CODEX_CHAT_CODEX_MODEL_PROVIDER=
CODEX_CHAT_CODEX_SERVICE_TIER=fast
CODEX_CHAT_CODEX_SERVICE_TIER_MODE=auto
```

OpenRouter GLM 5.2 is:

```bash
CODEX_CHAT_CODEX_MODEL=z-ai/glm-5.2
CODEX_CHAT_CODEX_PROFILE=openrouter
CODEX_CHAT_CODEX_MODEL_PROVIDER=openrouter
CODEX_CHAT_CODEX_SERVICE_TIER=fast
CODEX_CHAT_CODEX_SERVICE_TIER_MODE=omit
```

OpenRouter still requires `OPENROUTER_API_KEY` in the service env and a
user-level Codex profile such as `$CODEX_HOME/openrouter.config.toml` with the
OpenRouter provider definition. Do not store API keys in repo config.

## Main loop vs subagents

These `CODEX_CHAT_CODEX_*` settings affect only the main codex-chat loop.
Subagent provider defaults/allowlists are controlled separately by
`CODEX_CHAT_SUBAGENTS_*` env vars and the `[subagents]` config section. Changing
main-loop selectors should not change subagent defaults or provider override
behavior.
