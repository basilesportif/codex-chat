# Plan: Multi-provider/model support for codex-chat

Date: 2026-06-29  
Scope: planning only; no runtime code changes in this commit.

## Research summary

### Current codex-chat architecture

- The main runtime owns one long-lived `codex app-server` child process in `AppServerCodexClient.start()` and connects over a localhost WebSocket. It launches `codex app-server --listen ws://<host>:<port>`, appends `codex.extraConfig`, and currently adds `features.fast_mode=true` when `codex.serviceTier = "fast"` (`src/codex.ts:185-190`).
- Main thread creation/resume passes `model`, `serviceTier`, `cwd`, approval/sandbox, and a small `config` object containing `model_reasoning_effort`; it persists the resulting app-server thread id under `codex.mainSessionName` with model/tier/effort metadata (`src/codex.ts:488-522`, `src/codex.ts:530-559`). Main turn starts pass `model`, `serviceTier`, and `effort` again (`src/codex.ts:464-472`).
- Employee runtime reuses the same main app-server connection, but creates separate non-ephemeral threads with per-Employee `model` and `effort`; it does not currently carry a provider/profile dimension (`src/codex.ts:348-377`, `src/codex.ts:415-421`, `src/config.ts:74-94`, `docs/employees.md:12-18`).
- Subagents have two backends:
  - `codex_exec`: spawns `codex exec --json --output-last-message ... --model <model>`, strips duplicate `model_reasoning_effort` from global `extraConfig`, adds the job effort and Fast tier config, and only applies one global `codex.profile` if set (`src/subagent-backends.ts:135-157`).
  - `codex_app_server`: spawns a per-job `codex app-server`, starts an ephemeral thread, then starts a turn. It passes job `model`, `serviceTier`, `effort`, but does not pass or launch with a per-job Codex config profile/provider today (`src/subagent-backends.ts:233-240`, `src/subagent-backends.ts:368-393`).
- Configuration currently models only model/effort/tier at codex, subagent, and employee levels. There is no `provider`, `modelProvider`, or profile selector per subagent/Employee beyond a global `codex.profile` string. Env overrides cover `CODEX_CHAT_CODEX_MODEL`, `CODEX_CHAT_CODEX_EFFORT`, `CODEX_CHAT_CODEX_SERVICE_TIER`, and `CODEX_CHAT_SUBAGENTS_BACKEND`, but not profile/provider-specific fields (`src/config.ts:103-134`, `src/config.ts:376-438`).
- Child process env sanitation always strips `OPENAI_API_KEY` and configured transcription/Slack/ingest secrets, while leaving other env vars inherited unless explicitly stripped. That means future provider keys such as `OPENROUTER_API_KEY` would currently be inherited by Codex children if present, which is useful for provider auth but should be treated as a secret in log/redaction policy (`src/env.ts:1-43`).
- Directive schema requires `dispatch_subagent` to include `model`, `effort`, and `serviceTier`; there is no provider/profile field yet (`src/directives.ts:31-48`). Service status/detail already displays model/effort/tier, so UI/status additions can extend that pattern (`src/service.ts:1002-1060`).
- Tests already cover model/effort/tier persistence, Fast service tier propagation, duplicate `model_reasoning_effort` filtering, app-server-backed subagent dispatch/steering, directives preserving `serviceTier`, and Employee model/effort display (`src/__tests__/subagents.test.ts`, `src/__tests__/subagent-backends.test.ts`, `src/__tests__/directives.test.ts`, `src/__tests__/employees.test.ts`).

### Current Codex CLI/app-server docs and generated schema

- Codex profile selection is now file-based: `codex --profile name` loads `~/.codex/config.toml` and overlays `~/.codex/name.config.toml`; profile files use top-level keys, not `[profiles.name]`, and Codex 0.134+ no longer supports legacy `[profiles.*]` or top-level `profile = "name"` selectors. Source: `/tmp/openai-docs-cache/codex-manual.md:2095-2124`.
- Config precedence is CLI flags/`-c`, trusted project `.codex/config.toml`, selected profile file, user config, system config, then defaults. Source: `/tmp/openai-docs-cache/codex-manual.md:2714-2739`.
- Project `.codex/config.toml` cannot override provider/profile/auth-sensitive keys. Codex ignores project-local `openai_base_url`, `model_provider`, `model_providers`, `profile`, `profiles`, telemetry, and notification keys; provider settings must live in user/system config/profile files. Source: `/tmp/openai-docs-cache/codex-manual.md:2175-2190`.
- Custom Codex model providers define base URL, wire API, auth env key/headers, and optional command-backed auth. Reserved provider IDs are `openai`, `ollama`, and `lmstudio`; use `openai_base_url` only when redirecting the built-in OpenAI provider, otherwise use `[model_providers.<id>]` plus `model_provider = "<id>"`. Source: `/tmp/openai-docs-cache/codex-manual.md:2167-2169`, `/tmp/openai-docs-cache/codex-manual.md:2243-2291`, `/tmp/openai-docs-cache/codex-manual.md:2337-2359`.
- App-server `thread/start` and `thread/resume` support `modelProvider` as well as `model` and `serviceTier`, but generated Codex 0.142.0 schema shows `turn/start` supports `model`, `serviceTier`, and `effort` only; it does **not** include `modelProvider`. Command inspected: `codex app-server generate-json-schema --out <tmp>` and `ThreadStartParams` / `ThreadResumeParams` / `TurnStartParams` in `<tmp>/codex_app_server_protocol.v2.schemas.json`.
- App-server lifecycle docs confirm `thread/start`, `thread/resume`, `turn/start`, `turn/steer`, and `turn/interrupt`; turn optional fields override model/personality/cwd/sandbox policy and more for that turn/subsequent turns. Source: `/tmp/openai-docs-cache/codex-manual.md:8532-8540`.
- `codex app-server` WebSocket transport is experimental/unsupported; local loopback listeners are appropriate, non-loopback listeners need auth. Source: `/tmp/openai-docs-cache/codex-manual.md:8382-8427`.
- OpenRouter official docs say OpenRouter exposes an OpenAI-compatible API at `https://openrouter.ai/api/v1`, with Chat Completions at `/chat/completions`, API-key auth via `Authorization: Bearer <OPENROUTER_API_KEY>`, and optional attribution headers (`HTTP-Referer`, `X-OpenRouter-Title`, or SDK `appTitle`). Models are addressed by OpenRouter model slugs such as `openai/gpt-5.1`, `anthropic/claude-sonnet-4.5`, or provider-qualified variants from the model catalog. Sources: OpenRouter Quickstart, Authentication, and Models docs consulted 2026-06-29.
- OpenRouter provider routing is request-body driven via `provider` preferences such as `order`, `only`, `ignore`, `allow_fallbacks`, `require_parameters`, `data_collection`, quantization/sort filters, and `zdr`; Codex provider profiles can choose OpenRouter as the upstream but codex-chat should not try to embed arbitrary per-request routing until the Codex wire layer exposes safe pass-through config for those fields. Sources: OpenRouter Provider Routing docs consulted 2026-06-29.
- OpenRouter supports tool/function calling only for models that advertise the feature. Its model pages/API expose supported parameters; when routing across providers, `require_parameters` can force a provider that supports all requested parameters. MVP smoke tests must therefore use a model slug with tool support and verify at least one Codex tool command path, not only a plain text completion. Sources: OpenRouter Tool Calling, Supported Parameters, and Provider Routing docs consulted 2026-06-29.
- OpenRouter has a beta OpenAI-compatible Responses API but documents it as stateless; each request must provide its full input context and tool-call outputs, so Codex's stateful app-server thread semantics should start with `wire_api = "chat"` unless a specific Responses-profile smoke test proves compatibility. Source: OpenRouter Responses API Beta docs consulted 2026-06-29.
- OpenRouter prompt-cache/sticky routing can be account/model/conversation keyed, and docs describe optional `session_id` for sticky routing. Current Codex provider config and codex-chat dispatch state do not expose a first-class OpenRouter `session_id`, so MVP should not depend on sticky routing for correctness. Source: OpenRouter Prompt Caching docs consulted 2026-06-29.
- OpenRouter service tiers are provider/model dependent top-level `service_tier` request values such as `flex` and `priority`, which do not map directly to codex-chat's current OpenAI Fast-tier behavior. MVP should default to omitting Codex `serviceTier`/`features.fast_mode` for explicit OpenRouter profiles unless an operator has verified and mapped the selected model/provider tier. Source: OpenRouter Service Tiers docs consulted 2026-06-29.
- Chosen first OpenRouter smoke-test models as of 2026-06-29: primary `z-ai/glm-5.2`; backup `qwen/qwen3-coder`. `z-ai/glm-5.2` is preferred because OpenRouter advertises tool, structured-output, and reasoning/reasoning-effort parameters, a 1M context window, long-horizon agentic/coding positioning, and current pricing of $0.95 input / $3 output per 1M tokens. `qwen/qwen3-coder` is the cheaper backup at $0.22 input / $1.80 output per 1M tokens with tool and structured-output support, but the smoke test should keep context modest because pricing/provider limits vary past large contexts and it does not advertise the same reasoning controls. Source: OpenRouter model pages/API consulted 2026-06-29.

## Target design

### First MVP goal (must be explicit)

The first MVP is **not** full multi-provider support. It is the smallest docs-backed runtime refactor that lets codex-chat dispatch a single subagent on a different model through OpenRouter, using Codex App Server/Codex CLI profile selection, then lets the operator restart codex-chat and prove that dispatch succeeds.

Concrete MVP outcome:

1. Keep the main codex-chat loop on the existing OpenAI profile/model.
2. Configure an operator-owned Codex profile, for example `~/.codex/openrouter.config.toml`, that uses OpenRouter's OpenAI-compatible Chat Completions endpoint.
3. Extend only the subagent dispatch path enough to resolve `{codexProfile, modelProvider, model, effort, serviceTierMode}` per job.
4. For `codex_app_server` subagents, spawn the child `codex app-server --profile openrouter`, pass the OpenRouter `modelProvider` at `thread/start`, pass model/effort on thread/turn as currently supported, and omit OpenAI Fast tier fields for the OpenRouter job.
5. For `codex_exec` parity, pass `codex exec --profile openrouter --model <openrouter-model-slug>` and omit Fast tier fields unless explicitly allowed.
6. Persist and display the selected Codex profile/provider/model in subagent job metadata and artifacts without logging secret values.
7. After code is deployed, restart codex-chat and run one smoke dispatch that requests an OpenRouter model different from the main model.

This MVP is complete only when a real subagent launched through codex-chat reports successful completion on an OpenRouter model slug and its artifacts/status make the selected model/profile/provider auditable.

### Principles

1. Keep codex-chat provider-agnostic. codex-chat should select a Codex CLI profile/provider/model; Codex CLI should own provider auth, wire API, model catalog, and per-provider request details.
2. Treat provider selection as dispatch/thread/process-level state, not a mid-turn toggle. The current app-server schema supports provider at `thread/start`/`thread/resume`, not `turn/start`; switching providers for app-server-backed work should start/resume a different thread or different app-server process.
3. **Critical requirement:** provider/model selection must be overridable per individual subagent dispatch, not only per subagent profile/default. Profiles and defaults are convenience routing policy; the dispatch contract must still be able to request an allowed `codexProfile`, `modelProvider`, `model`, `effort`, and service-tier behavior for one specific job.
4. Prefer Codex profiles for non-OpenAI providers. Because project `.codex/config.toml` cannot define provider auth or select profiles, operator-owned `$CODEX_HOME/*.config.toml` files are the correct place for OpenRouter/Anthropic/open-model provider config.
5. Preserve existing behavior by default: the main loop remains OpenAI/Fast/gpt-5.5 for now. The first implementation should pilot alternate providers/models on subagents, where each dispatch is isolated and independently observable, before changing the main long-lived loop.
6. Plan main-loop provider/model switching as a later startup-time configuration feature. Main-loop provider/model changes should be explicit config/env changes followed by a codex-chat restart/new main app-server thread, not an ad hoc runtime toggle inside the current thread.
7. Brain should become the UI/control plane for model-provider defaults and overrides for both the main loop and subagents because it can already edit codex-chat config/env and orchestrate restarts. codex-chat remains the runtime enforcement layer for allowlists and per-dispatch resolution.
8. Never store provider API keys in codex-chat TOML/state/artifacts. Only store provider IDs, profile names, and env var names if necessary.

### Proposed codex-chat config shape

Add a small provider/profile dimension without duplicating Codex's full provider schema:

```toml
[codex]
# Existing fields stay valid.
model = "gpt-5.5"
effort = "medium"
serviceTier = "fast"
# New: profile used when launching the main app-server process.
profile = ""               # existing field, but make it actively used by app-server launch
# New: optional app-server thread provider override; empty means use Codex profile/default.
modelProvider = ""         # maps to app-server modelProvider on thread/start/resume
# Optional: whether to include serviceTier in app-server requests. Default preserves current behavior.
serviceTierMode = "auto"   # auto | always | omit

[subagents]
defaultModel = ""
defaultEffort = "medium"
defaultServiceTier = "fast"
defaultProfile = ""       # Codex CLI profile for child backend process; empty => codex.profile
defaultModelProvider = "" # app-server thread provider override; empty => selected profile/default
allowProviderOverride = false
# Critical: these defaults are not the only selection surface. An individual
# dispatch may request codexProfile/modelProvider/model/serviceTierMode when
# overrides are enabled and the requested values pass the allowlists below.
allowedProfiles = []       # existing behavior-profile allowlist; keep separate from Codex config profiles
allowedCodexProfiles = []  # new optional allowlist for Codex CLI profiles
allowedModelProviders = [] # new optional allowlist for provider IDs

[employees]
defaultModel = "gpt-5.5"
defaultEffort = "medium"
defaultProfile = ""
defaultModelProvider = ""

[employees.email-calendar]
model = "gpt-5.5"
effort = "high"
profile = "email-calendar"       # current behavior/profile; consider renaming later if ambiguous
codexProfile = "openrouter"      # new Codex CLI profile
modelProvider = "openrouter"     # optional app-server override
serviceTier = ""                 # optional; omit for providers that ignore or reject OpenAI tiers
```

Naming note: current `profile` means behavior/subagent/Employee role in some places and Codex CLI profile in `codex.profile`. To reduce confusion, new per-agent fields should use `codexProfile` for Codex CLI config profiles and keep `profile` for behavior profiles. The top-level `[codex].profile` can remain for compatibility but should be documented as Codex CLI profile.

### Operator-owned Codex profile examples

These examples belong in `$CODEX_HOME`, not in this repo's project `.codex/config.toml`.

OpenRouter via OpenAI-compatible Chat Completions:

```toml
# ~/.codex/openrouter.config.toml
model = "z-ai/glm-5.2"
model_provider = "openrouter"
model_reasoning_effort = "medium"
# service_tier intentionally unset unless verified against the selected model/provider.

[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
wire_api = "chat"
env_key = "OPENROUTER_API_KEY"
env_key_instructions = "Set OPENROUTER_API_KEY in the service environment."
# Optional non-secret attribution headers if desired:
# http_headers = { "HTTP-Referer" = "https://brain.decisive-outcomes.com", "X-OpenRouter-Title" = "codex-chat" }
```

OpenRouter Responses beta, only after a real smoke test with the selected model/tooling:

```toml
# ~/.codex/openrouter-responses.config.toml
model = "openai/gpt-5.5"
model_provider = "openrouter-responses"

[model_providers.openrouter-responses]
name = "OpenRouter Responses beta"
base_url = "https://openrouter.ai/api/v1"
wire_api = "responses"
env_key = "OPENROUTER_API_KEY"
```

Future direct Anthropic/open models:

- Direct Anthropic should not be hardcoded into codex-chat unless Codex CLI grows a native Anthropic provider or the operator supplies an OpenAI-compatible proxy. Until then, use OpenRouter (model IDs such as `anthropic/...`) or a private proxy profile.
- Local/open models should use Codex's OSS/local provider modes (`ollama`, `lmstudio`, or another OpenAI-compatible provider profile) and should usually omit service tier.

## MVP implementation sequence

This sequence intentionally stops before main-loop provider switching, Employee pools, Brain UI work, or arbitrary provider routing.

1. **Codex profile prerequisite**
   - Operator creates `~/.codex/openrouter.config.toml` on the service account, not in repo `.codex/config.toml`, because Codex ignores provider/profile/auth-sensitive keys from project config.
   - Service environment contains `OPENROUTER_API_KEY`; docs/examples must show only the env var name, never a value.
   - Manual preflight outside codex-chat; run the primary first, then the backup only if the primary is unavailable or fails for provider/model reasons:
     ```bash
     codex --profile openrouter exec --model z-ai/glm-5.2 "Reply with: openrouter ok"
     codex --profile openrouter exec --model qwen/qwen3-coder "Reply with: openrouter backup ok"
     ```

2. **Config/schema additions, default no-op** — implemented 2026-06-29 in codex-chat/Brain for subagent profile/provider plumbing; live OpenRouter smoke still requires key entry and codex-chat restart.
   - Add optional subagent config fields: `defaultCodexProfile`, `defaultModelProvider`, `serviceTierMode`, `allowProviderOverride`, `allowedCodexProfiles`, and `allowedModelProviders`.
   - Add optional dispatch/job fields: `codexProfile`, `modelProvider`, and `serviceTierMode`. Existing dispatches must remain valid and unchanged.
   - MVP config should set `allowedCodexProfiles = ["openrouter"]`, `allowedModelProviders = ["openrouter"]`, and `serviceTierMode = "omit"` for OpenRouter smoke jobs.

3. **Resolver and validation**
   - Implement a single `resolveSubagentModelSpec()` path used by both subagent backends. Precedence: directive/job override -> subagent defaults -> current codex defaults.
   - Reject per-dispatch provider/profile overrides unless `allowProviderOverride` is enabled and the requested values pass allowlists.
   - When `modelProvider` is a non-empty non-OpenAI value and `serviceTierMode = "auto"`, treat it like `omit` for MVP unless explicit config says otherwise.

4. **Backend wiring**
   - `codex_app_server`: add `--profile <job.codexProfile>` when spawning the child app-server; include `modelProvider` in `thread/start`; do not include `modelProvider` in `turn/start` because the generated schema lacks that field.
   - `codex_exec`: add `--profile <job.codexProfile>` and keep `--model <job.model>`; prefer the profile's `model_provider` over `-c model_provider=...` unless an explicit override is needed and allowed.
   - Both backends must suppress `features.fast_mode=true` and omit `serviceTier` for OpenRouter jobs under `serviceTierMode = "omit"`.

5. **Observability**
   - Write `codexProfile`, `modelProvider`, `model`, `effort`, and effective service-tier mode to subagent `events.jsonl`, status/detail output, and state metadata.
   - Add redaction coverage for `OPENROUTER_API_KEY` by name if any env/log scrubbing code enumerates provider keys.

6. **Tests**
   - Unit tests prove default behavior is unchanged.
   - Resolver tests cover override allowed/rejected cases and service-tier omission for OpenRouter.
   - App-server backend tests assert spawn args include `--profile openrouter`, `thread/start` includes `modelProvider`, `turn/start` does not, and no Fast tier config is emitted.
   - Exec backend tests assert `--profile openrouter` and `--model <slug>` are passed and no Fast tier config is emitted.

7. **Deploy/restart/test (operator step after merge; do not run from this subagent)**
   - Restart command to run only after code changes are deployed by the main process/operator:
     ```bash
     systemctl --user restart codex-chat.service
     ```
   - Smoke dispatch request should use `subagents.backend = "codex_app_server"`, `codexProfile = "openrouter"`, `modelProvider = "openrouter"`, `model = "z-ai/glm-5.2"` first; if unavailable or failing for provider reasons, retry the same smoke with backup `model = "qwen/qwen3-coder"`, `serviceTierMode = "omit"`, and a trivial task such as writing a short final answer plus running one safe read-only command.

### MVP config example (no secrets)

```toml
# ~/.codex/openrouter.config.toml -- service account user-level profile
model = "z-ai/glm-5.2"
model_provider = "openrouter"
model_reasoning_effort = "medium"

[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
wire_api = "chat"
env_key = "OPENROUTER_API_KEY"
env_key_instructions = "Set OPENROUTER_API_KEY in the codex-chat service environment."
# Optional non-secret attribution headers, if the operator wants OpenRouter rankings/analytics:
# http_headers = { "HTTP-Referer" = "https://brain.decisive-outcomes.com", "X-OpenRouter-Title" = "codex-chat" }
```

```toml
# codex-chat config example after runtime support exists
[subagents]
backend = "codex_app_server"
defaultEffort = "medium"
defaultServiceTier = ""
defaultCodexProfile = ""
defaultModelProvider = ""
serviceTierMode = "auto"
allowProviderOverride = true
allowedCodexProfiles = ["openrouter"]
allowedModelProviders = ["openrouter"]
```

### MVP pass/fail criteria

Pass:

- `codex --profile openrouter exec --model <slug> "Reply ok"` succeeds under the same service account/environment.
- After restart, codex-chat can dispatch a `codex_app_server` subagent with `codexProfile=openrouter`, `modelProvider=openrouter`, and an OpenRouter model slug different from the main model.
- The child app-server command line includes `--profile openrouter`; `thread/start` includes `modelProvider: "openrouter"`; `turn/start` omits `modelProvider`; Fast tier config and `serviceTier` are omitted for the job.
- The subagent completes and artifacts/status show the selected profile/provider/model without exposing `OPENROUTER_API_KEY` or other secret values.

Fail/block:

- The service account cannot see `OPENROUTER_API_KEY` or the Codex profile file.
- The chosen OpenRouter slug lacks tool calling or rejects required Codex parameters.
- OpenRouter Responses beta is required for a selected model but fails Codex state/tool semantics; switch back to `wire_api = "chat"` or a different slug.
- codex-chat resumes an old OpenAI child thread instead of creating an OpenRouter-profile child thread.
- Any runtime log/artifact prints provider API key material.

## Implementation phases

### Phase 1: Config and resolution only

- Extend Zod schemas and types with `modelProvider`, `serviceTierMode`, `codexProfile`, and allowlists.
- Add resolver helpers:
  - `resolveMainModelSpec()` => `{ model, effort, serviceTier?, modelProvider?, codexProfile? }`
  - `resolveSubagentModelSpec(input)` => merges per-dispatch directive/job overrides, subagent defaults, main defaults. Per-dispatch override support is required for `model`, `effort`, `serviceTier`, `serviceTierMode`, `codexProfile`, and `modelProvider`, subject to allowlists.
  - `resolveEmployeeModelSpec(definition)` => merges Employee definition/defaults.
- Validate allowlists before dispatch/start. If `allowProviderOverride = false`, reject directive-supplied provider/profile overrides and only use configured defaults.
- Persist `modelProvider` and `codexProfile` in `SubagentJob` and Employee thread state metadata so status/debug output and abandoned jobs remain explainable.
- Keep migration non-breaking: absent new fields parse as empty strings and behave exactly like today.

### Phase 2: Main app-server process and thread provider (planned after subagent pilot)

The main loop stays on OpenAI for the first implementation. This phase is a planned startup-time configuration path for later, after alternate-provider subagents have been piloted successfully.

- In `AppServerCodexClient.start()`, append `--profile <codex.profile>` when non-empty. This is the missing piece for provider/profile config to affect the main app-server process, but it should be enabled only as an explicit startup-time main-loop setting.
- Include `modelProvider` in main `thread/start`, `thread/resume`, and stored session metadata when configured.
- Include `serviceTier` only when `serviceTierMode` says to include it. Suggested behavior:
  - `always`: always send configured tier.
  - `omit`: never send tier.
  - `auto`: send for OpenAI/default provider or when tier is non-empty and provider is absent; omit for explicit non-OpenAI providers unless a provider-specific allowlist says otherwise.
- Session migration: if stored main session metadata differs in `{model, modelProvider, codexProfile, serviceTierMode}`, start a new app-server thread instead of resuming the old one, or require an explicit `codex.mainSessionName` change. This avoids accidentally resuming an OpenAI thread through an OpenRouter provider.

### Phase 3: Subagent backends

`codex_exec` backend:

- Add per-job/per-dispatch `codexProfile`, `modelProvider`, and `serviceTierMode` to `StartChildAgentInput`; do not limit provider/model selection to static subagent profiles.
- Build args as:
  - `codex exec --profile <job.codexProfile> ...` when present.
  - `--model <job.model>` remains a dedicated override.
  - Add `-c model_provider="<provider>"` only when a provider override is explicitly configured and allowed. Prefer profile selection over `-c` for provider auth because provider definitions live in user config/profile files.
- For non-OpenAI providers, omit Fast tier flags unless explicitly allowed; many third-party providers will ignore or reject OpenAI-specific service tiers.

`codex_app_server` backend:

- Spawn each child app-server with `--profile <job.codexProfile>` when present.
- Pass `modelProvider` to the child `thread/start` params. Do not attempt provider changes through `turn/start` because the current schema lacks that field.
- Keep per-job `model`, `effort`, and optional `serviceTier` on both thread and turn where supported.
- Record the selected profile/provider in `events.jsonl` and `app-server.log` metadata without printing any env secret values.

Launching subagents with different Codex profiles/models/providers:

1. Operator creates `~/.codex/openrouter.config.toml` with provider auth and model defaults.
2. codex-chat config sets either `subagents.defaultCodexProfile = "openrouter"` for all child jobs or a future route map/profile policy for selected behavior profiles.
3. `dispatch_subagent` can keep specifying behavior `profile`, task `model`, `effort`, and `serviceTier`; if provider/profile override is enabled, extend the directive schema with `codexProfile`, `modelProvider`, and `serviceTierMode`. This per-dispatch override path is critical and must not be deferred behind profile-only routing.
4. For app-server subagents, codex-chat starts a separate child `codex app-server --profile openrouter` so the child process has the provider config, then starts an ephemeral thread with the requested model/provider.

### Phase 4: Directives, behavior prompts, and routing defaults

- Extend `dispatch_subagent` directive schema with optional `codexProfile`, `modelProvider`, and `serviceTierMode`. Keep them optional so existing behavior prompts/tests remain valid, but enforce allowlists before starting the job.
- Update `behavior/AGENTS.md` to describe default model/provider policy only after runtime supports it. Avoid asking the main model to choose arbitrary provider IDs unless allowlists are configured.
- Add safe routing defaults:
  - `researcher`/`reviewer`: default OpenAI or OpenRouter high-context profile if configured.
  - `implementer`/`debugger`: default current OpenAI profile unless OpenRouter/open-model tool behavior is validated.
  - Employee-owned child subagents inherit the Employee's `codexProfile`/`modelProvider` unless explicitly overridden and allowed.

### Phase 5: Employee support

- Add `codexProfile`, `modelProvider`, `serviceTier`, and `serviceTierMode` to Employee definitions.
- Because Employees currently run through the main app-server connection, there are two viable designs:
  1. **Short-term:** Employee `modelProvider` can vary only among providers already loaded in the main app-server config; pass it at Employee `thread/start`/`thread/resume`. `codexProfile` must match main process profile or be rejected.
  2. **Long-term:** run Employees on per-profile app-server pools keyed by `{codexProfile, modelProvider}`. This enables one Employee on OpenAI and another on OpenRouter/Anthropic without mixing process-level config.
- Prefer long-term pool design before serious multi-provider Employees; it matches the subagent architecture and avoids profile-state ambiguity.

### Phase 6: Documentation and operations

- Update `config/codex-chat.example.toml` and README with provider/profile examples that reference `$CODEX_HOME` files but do not include secrets.
- Coordinate with Brain so its admin UI becomes the operator-facing control plane for model-provider defaults: main-loop startup provider/model, subagent default provider/model/profile, per-dispatch override policy/allowlists, service-tier mode, env-key presence metadata, and the planned restart/apply flow. Brain may edit config/env and restart codex-chat; codex-chat should expose enough status/detail metadata for Brain to render the active selections and recent dispatch overrides.
- Add an operator checklist:
  - set provider API key in service env file;
  - ensure the key env var survives `sanitizeChildProcessEnv` only for Codex children that need it;
  - run `codex --profile openrouter debug models` or `codex --profile openrouter exec --model ... "say ok"` manually;
  - run codex-chat subagent smoke with `backend=codex_app_server` and a trivial prompt;
  - watch `agent status/detail` and artifact logs.
- Add redaction patterns for `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, and any configured `env_key` names if log scrubbing grows beyond current static stripping.

## Migration path

1. Land schema with defaults only; no behavior change.
2. Add provider/profile metadata to state while remaining backwards-compatible with old state files.
3. Add directive optional fields and behavior prompt updates for per-dispatch overrides, guarded by allowlists.
4. Pilot one OpenRouter subagent path with `codex_app_server` backend and `serviceTierMode = "omit"`, proving both configured defaults and one-off per-dispatch overrides.
5. Teach Brain to display/edit subagent provider defaults, override allowlists, and env-key presence, then apply via the existing config/env/restart control-plane workflow.
6. After the subagent proof window, enable startup-time main-loop provider/model switching: use top-level `codex.profile`, add `modelProvider` to main app-server thread/resume requests only when configured, and start a new main thread when model/provider/profile metadata changes.
7. After the main-loop startup path is proven, consider per-profile app-server pools for Employees/main alternate sessions.

Rollback remains simple: clear new profile/provider config, set `subagents.backend = "codex_exec"` or `agent backend exec`, and restart the service after code deploy. Existing OpenAI defaults remain unchanged.

## Test matrix

Unit/config:

- Default config parses with no new fields and equals current behavior.
- Env overrides still work; add env override tests only for top-level fields operators need immediately.
- `codexProfile`/`modelProvider` allowlists reject unknown values.
- Backward-compatible state load succeeds without provider/profile fields.

Main app-server:

- Spawn args include `--profile` only when `codex.profile` is non-empty.
- `thread/start` and `thread/resume` include `modelProvider` only when configured.
- Stored main session mismatch on model/provider/profile causes new thread or documented refusal.
- `serviceTierMode=omit` suppresses `serviceTier` and Fast `-c` where intended.

Subagent exec backend:

- Existing args unchanged by default.
- Per-job effort still replaces duplicate global `model_reasoning_effort`.
- `--profile <codexProfile>` appears for configured child jobs.
- Provider override uses `-c model_provider=...` only when allowed.
- Non-OpenAI service tier omission path is covered.

Subagent app-server backend:

- Child app-server spawn includes `--profile`.
- `thread/start` includes `modelProvider`; `turn/start` does not.
- Artifact metadata includes model/provider/profile/tier without secrets.
- Steering still works after provider/profile fields are added.

Directives/service UI:

- Old `dispatch_subagent` directives remain valid.
- New optional provider/profile fields are parsed, validated, shown in preview/status/detail, and persisted.
- Behavior prompt defaults do not cause arbitrary unapproved provider selection.

Employees:

- Employee list/status shows model/provider/profile.
- Short-term rejection path for Employee `codexProfile` different from main process is explicit, or long-term pool starts the right app-server.
- Employee-owned subagent inheritance is tested.

Manual smoke:

- OpenAI default main turn.
- OpenAI `codex_exec` subagent.
- OpenAI `codex_app_server` subagent.
- OpenRouter `codex exec --profile openrouter` outside codex-chat.
- OpenRouter `codex_app_server` subagent with trivial no-tool prompt.
- Optional OpenRouter tool-use prompt after confirming selected model supports tool/function calling.

## Risks and open issues

- **Provider switching in existing threads:** app-server `turn/start` lacks `modelProvider`; provider changes should be treated as new thread/process decisions.
- **Profile naming ambiguity:** codex-chat already uses `profile` for behavior subagents and `codex.profile` for Codex CLI profile. New config should use `codexProfile` anywhere both meanings are possible.
- **Project config restrictions:** provider definitions cannot live in repo `.codex/config.toml`; deployment docs must clearly point to `$CODEX_HOME` user/profile files.
- **Service tier compatibility:** Fast/flex tiers are OpenAI/Codex-catalog concepts. Third-party providers may ignore or reject them; make omission easy.
- **OpenRouter session/cache limitations:** Codex app-server preserves its own local thread history, but OpenRouter prompt-cache sticky routing is provider/account/model/conversation keyed and can use `session_id`. Codex provider config currently does not expose a codex-chat-level `session_id`, so cache behavior may depend on OpenRouter's derived conversation hash and may be less predictable for changing system/developer prompts, subagent preambles, or resumed threads. Response caching is separate and beta; do not rely on it for agent turns.
- **Wire API mismatch:** OpenRouter Chat Completions is stable and OpenAI-compatible; Responses is beta. Codex tool use, streaming, and reasoning metadata may differ by model/provider. Validate each profile/model before making it a default.
- **Secret handling:** New provider API keys should not be printed or stored. If codex-chat begins stripping all provider env keys by default, it must selectively pass the key to Codex child processes that need provider auth.
- **Model catalog:** Non-OpenAI provider model metadata may need `model_catalog_json` or manual config for context windows, reasoning effort, and service tiers.

## Decisions from Tim on 2026-06-29

1. Provider/model selection must be overridable per individual dispatch, not just per subagent profile. This is critical for the first runtime design.
2. The main loop stays on OpenAI for now. The first implementation should pilot subagents on different models/providers, while keeping startup-time configurable main-loop provider/model switching as a later planned phase.
3. Brain should become the UI/control plane for model-provider defaults and policies for the main loop and subagents, because Brain can already edit codex-chat config/env and restart codex-chat. codex-chat remains responsible for runtime validation, allowlist enforcement, dispatch metadata, and status/detail reporting.


## Step 1 implementation notes (2026-06-29)

Implemented the default-no-op infrastructure/config plumbing for OpenRouter-backed subagents:

- codex-chat now accepts per-dispatch `codexProfile`, `modelProvider`, and `serviceTierMode` on `dispatch_subagent` directives. Provider/profile overrides are rejected unless `subagents.allowProviderOverride` is true and requested values pass `allowedCodexProfiles` / `allowedModelProviders`.
- Both subagent backends receive the resolved Codex profile/provider/model spec per job. `codex_app_server` spawns with `--profile`, sends `modelProvider` only on `thread/start`, and omits `serviceTier` / Fast config when `serviceTierMode = "omit"`. `codex_exec` spawns with `--profile` and omits Fast config under the same mode.
- The main app-server launch now honors `[codex].profile`, optional `modelProvider`, and `serviceTierMode` for future startup-time provider switching while preserving current defaults.
- Generic child processes strip `OPENROUTER_API_KEY`; Codex child processes pass only configured provider API key env names through, so provider auth reaches Codex without being logged or embedded in repo config.
- Brain admin has an OpenRouter settings panel and API. It writes the OpenRouter key as a write-only env secret, writes non-secret codex-chat subagent defaults/allowlists, and creates the user-level `$CODEX_HOME/openrouter.config.toml` profile.
- Operator workflow is documented in `docs/openrouter-subagents.md`.

Not done in this step: no real OpenRouter key was required, no live OpenRouter subagent was launched, and codex-chat was not restarted by this subagent.
