# OpenRouter-backed subagent setup

This is the operational path for the first multi-provider MVP. It does not store provider secrets in this repository.

## Brain setup flow

1. Open Brain admin at `https://brain.decisive-outcomes.com/admin`.
2. Go to **OpenRouter**.
3. Enter the OpenRouter API key. Brain writes it as `OPENROUTER_API_KEY` in the local codex-chat env file and only reports presence afterward.
4. Enter the OpenRouter model slug to use for subagent defaults, for example `anthropic/claude-sonnet-4.5`.
5. Leave the Codex profile as `openrouter`, model provider as `openrouter`, and service tier mode as `omit` unless you have verified a different mapping.
6. Optionally set the subagent backend env override to `codex_app_server` for the planned app-server smoke path. Leaving it blank preserves the current backend setting.
7. Confirm the write. Brain updates:
   - codex-chat env keys such as `OPENROUTER_API_KEY`, `CODEX_CHAT_SUBAGENTS_DEFAULT_MODEL`, `CODEX_CHAT_SUBAGENTS_DEFAULT_CODEX_PROFILE`, and provider allowlists;
   - local codex-chat config under `[subagents]` with the same non-secret provider/profile defaults;
   - user-level `$CODEX_HOME/openrouter.config.toml` with OpenRouter base URL, `wire_api = "chat"`, and `env_key = "OPENROUTER_API_KEY"`.
8. Go to **Deploy / Restart**, run **plan**, then confirm **restart** for `codex-chat.service`.

Brain never displays the OpenRouter key value in settings responses, confirmation dialogs, audit records, or page refreshes.

## Codex profile caveat

Codex provider and auth config must live in user-level Codex config/profile files, not in project `.codex/config.toml`. Brain writes a local user-level profile like this:

```toml
# ~/.codex/openrouter.config.toml -- managed by Brain; no API key value here
model = "anthropic/claude-sonnet-4.5"
model_provider = "openrouter"
model_reasoning_effort = "medium"

[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
wire_api = "chat"
env_key = "OPENROUTER_API_KEY"
env_key_instructions = "Set OPENROUTER_API_KEY in the codex-chat service environment."
```

## Test dispatch after restart

After the restart, ask codex-chat to dispatch a test subagent on the configured OpenRouter model, e.g.:

> Dispatch an implementer subagent as an OpenRouter smoke test using `codexProfile: "openrouter"`, `modelProvider: "openrouter"`, model `anthropic/claude-sonnet-4.5`, `effort: "medium"`, and `serviceTierMode: "omit"`. Have it run one safe read-only command and return a concise result.

The resulting subagent status/artifacts should show the selected `codexProfile`, `modelProvider`, model, effort, and service-tier mode without exposing `OPENROUTER_API_KEY`.
