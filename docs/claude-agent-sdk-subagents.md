# Claude Agent SDK subagent backend

`claude_agent_sdk` is the opt-in child-agent backend for running codex-chat subagents through the Anthropic Claude Agent SDK instead of Codex. It is intended for local, Tim-owned use with Claude subscription OAuth only.

## Enablement and auth

1. Verify Claude Code is installed and new enough:
   - `claude --version`
   - Opus 4.8 requires Claude Code v2.1.154 or later.
   - Fable 5 requires Claude Code v2.1.170 or later.
   - Sonnet 5 requires Claude Code v2.1.197 or later.
   - Claude Code v2.1.200 or later validates Agent SDK `setModel()` strings; this machine tested with v2.1.201.
2. Verify subscription OAuth without printing secrets:
   - preferred: `claude auth login`, which stores local `~/.claude/.credentials.json` credentials;
   - alternate: `claude setup-token`, then provide `CLAUDE_CODE_OAUTH_TOKEN` to the service environment.
3. Set `[subagents.claude].enabled = true`. Then route jobs to Claude one of three ways:
   - **per dispatch (primary)**: include `backend: "claude_agent_sdk"` (alias `"claude"`) in a `dispatch_subagent` directive — routes only that job, leaving the configured/override default untouched;
   - runtime override: `agent backend claude` flips the default for all new/queued jobs (canary/recovery lever);
   - config: `subagents.backend = "claude_agent_sdk"` makes Claude the configured default.

Do not configure this backend with API keys. codex-chat strips Anthropic API keys, Bedrock/Vertex/Foundry/gateway provider env vars, OpenRouter/Codex provider keys, OpenAI transcription keys, and Slack/ingest secrets before starting Claude SDK children. Readiness requires either local Claude OAuth credentials or `CLAUDE_CODE_OAUTH_TOKEN`; non-OAuth auth sources are rejected.

## Current Claude model strings and aliases

Use full model IDs in codex-chat dispatches and config examples when pinning behavior. Claude Code aliases are convenient interactively, but aliases can update over time.

| Purpose | Full Claude API / Agent SDK model string | Claude Code alias notes |
| --- | --- | --- |
| Most capable generally available model | `claude-fable-5` | `fable`; `best` uses Fable 5 when available, otherwise latest Opus. Fable may trigger safety fallback for some cyber/bio requests. |
| Complex agentic coding / enterprise work | `claude-opus-4-8` | `opus` currently resolves to Opus 4.8 on the Anthropic API. This is the recommended pinned string for Opus 4.8 subagent canaries. |
| Daily coding / speed-intelligence balance | `claude-sonnet-5` | `sonnet` currently resolves to Sonnet 5 on the Anthropic API. |
| Fast, efficient work | `claude-haiku-4-5-20251001` | alias `claude-haiku-4-5`; Claude Code alias `haiku`. |

Anthropic's current model-ID convention for Claude 4.6 and later uses dateless pinned IDs such as `claude-opus-4-8` and `claude-sonnet-5`; they are fixed model snapshots, not evergreen pointers. Older pre-4.6 aliases such as `claude-haiku-4-5` resolve to dated snapshots.

## codex-chat dispatch semantics

- `backend: "claude_agent_sdk"` in a `dispatch_subagent` directive routes that single job to Claude. Aliases `"claude"`, `"claude_code"`, and `"claude-agent-sdk"` normalize to the canonical kind. Jobs without a `backend` field use the configured/override default. Explicitly routed queued jobs keep their backend when the runtime override changes.
- `model` is passed through to the Claude Agent SDK unchanged. For Opus 4.8, dispatch with `model: "claude-opus-4-8"`; for Fable 5, dispatch with `model: "claude-fable-5"`.
- `effort` maps to the Claude SDK `effort` option for `low`, `medium`, `high`, and `xhigh`.
- `effort: "none"` or `"minimal"` disables Claude thinking. Do not use those with `claude-fable-5`, because Fable 5 has always-on adaptive thinking and rejects explicit disabled thinking. Prefer `high` for most Fable work and `xhigh` only for the most capability-sensitive workloads.
- Claude has no Codex `serviceTier` equivalent. codex-chat records the requested tier for observability. When `serviceTier: "fast"` and `[subagents.claude].fastMode = true`, codex-chat passes Claude Code fast-mode settings when the installed SDK supports them; otherwise tier is ignored.
- `codexProfile` and `modelProvider` are Codex-provider concepts; the service **rejects** a Claude-routed dispatch that includes them. `serviceTierMode` is resolved for observability only.
- The backend is steerable while its SDK streaming input session is active; `agent steer <ref> <text>` enqueues a follow-up user message in the same Claude session.

## Low-risk canary pattern

Use a no-tool prompt and write outputs only under the job artifact directory:

```json
{
  "backend": "claude_agent_sdk",
  "model": "claude-opus-4-8",
  "effort": "medium",
  "serviceTier": "fast",
  "claude": {
    "enabled": true,
    "permissionMode": "plan",
    "allowedTools": [],
    "settingSources": [],
    "fastMode": true
  }
}
```

Prompt: `Low-risk canary only. Do not edit files and do not use tools. Reply with exactly: CLAUDE_BACKEND_OPUS_4_8_CANARY_OK`.

Record the artifact directory, `events.jsonl`, `last-message.md`, the exact model string, Claude Code version, SDK package version, and whether the SDK initialization account reported first-party subscription OAuth. Do not print tokens, credential contents, or API key values.

## Primary references

- Anthropic model overview: `https://platform.claude.com/docs/en/about-claude/models/overview`
- Anthropic model IDs and versioning: `https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions`
- Claude Code model configuration: `https://code.claude.com/docs/en/model-config`
- Claude Agent SDK TypeScript reference: `https://docs.anthropic.com/en/docs/claude-code/sdk/sdk-typescript`
