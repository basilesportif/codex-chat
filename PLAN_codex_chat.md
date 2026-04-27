# codex-chat Technical Architecture Plan

## 1. Purpose and Scope

`codex-chat` is a long-running local service that connects a Telegram bot to a warm Codex agent. The service owns transport, persistence, scheduling, process supervision, file handling, and routing. Codex owns reasoning, coding, and agentic work.

The project should be designed as a service wrapper around the Codex CLI, not as a reimplementation of Codex. The key architectural boundary is a `CodexClient` interface that hides the exact process protocol. The first implementation should use the best available Codex CLI process interface and keep a fallback path for older or less stable interfaces.

Core capabilities:

- Receive and send Telegram messages, images, documents, and voice messages.
- Keep one main Codex instance warm for normal user interaction.
- Dispatch subagents through `codex exec` child processes.
- Load behavior from a project-controlled prompts, skills, and code directory.
- Sync cron entries from `loops.json`.
- Start or attach to long-running monitored processes from `monitors.json`.
- Transcribe Telegram voice input.
- Persist enough state to recover cleanly after service restarts.

## Confirmed Decisions

The following decisions have been confirmed by Tim and supersede any conflicting guidance below. Where the body of the plan still describes the older choice, treat this section as authoritative.

1. **Persistence**: JSON files on disk. SQLite is no longer used for state. Replace any SQLite references in later sections with the equivalent JSON file store.
2. **Telegram library**: `grammY` — confirmed.
3. **Main Codex transport**: `codex app-server` (WebSocket) — confirmed as the primary transport. The fallback adapters remain documented but are not the target.
4. **Auto-restart on Codex crash**: The service must detect crashes of the main Codex process and the app-server, automatically restart them, and notify the operator via the bot's own Telegram chat (not just systemd logs).
5. **Service health monitoring**: Health and lifecycle events (startup, restart, crash, recovery failure) must be reported as Telegram messages from the bot itself, in addition to any structured logging.
6. **Sandbox**: `danger-full-access` is the default for both the main session and subagents. This is a personal VPS dedicated to this service, so the broader sandbox modes are intentional.
7. **Sessions**: Single shared Codex session for all authorized users. There is one Codex conversation total. Per-user isolation is not implemented in the first version.
8. **Subagent access**: Subagents have the same access as the main agent (no read-only or sandbox restrictions by default).
9. **Missed loop runs**: Durable-only. Loops marked `durable: true` may persist their schedule; missed runs are not replayed from the spool on restart for any loop. Spooling is removed from scope for non-durable loops.
10. **Monitors**: Attach to a process if it is already running; start it if it is not. Both behaviors are required from the same monitor definition.
11. **Transcription**: Provider is configurable. OpenAI is the default. Voice messages are always auto-transcribed and forwarded to Codex — no manual trigger or caption command is needed. Whether an OpenAI API key is required, or whether `codex exec` can perform the transcription itself, is **TBD pending research** (the sole remaining open question).
12. **Loop default routing**: `return_to_main` — loop events feed back to the warm main Codex session. The behavior pack's `AGENTS.md` determines how Codex handles each loop result. The default codex-chat behavior pack will ship with an `AGENTS.md` that covers common loop event handling.
13. **Monitor remediation**: Pattern matches are routed to the main Codex session by default (`send_to_main`). A pattern may additionally specify a `command` pre-action that runs automatically before the event is sent to Codex (e.g. a lightweight remediation script). Codex then decides what to tell the user. `telegram_notify` is no longer the default action type — `send_to_main` replaces it. `run_command` is an optional pre-action that fires first when specified.
14. **Default behavior pack**: The behavior pack ships with a default `AGENTS.md` for codex-chat that provides sensible out-of-the-box behavior covering: loop event handling, monitor alert handling, voice message handling, and image handling. Users can customize or replace this file to change how the main agent behaves.

Non-goals for the first implementation:

- Multi-tenant hosting for unrelated users.
- Building a public SaaS bot platform.
- Replacing Telegram with a general chat abstraction before the Telegram path works.
- Replacing cron with an internal scheduler. Internal scheduling can be useful later, but the requirement is Unix cron sync.

## 2. Recommended Tech Stack

### Runtime and Language

Use Node.js 24 LTS with TypeScript.

Rationale:

- The service is I/O-heavy: Telegram polling/webhooks, subprocess streaming, WebSocket/stdio protocol handling, and filesystem events.
- TypeScript gives strong enough typing for config schemas, Codex protocol adapters, and directive parsing without adding much build complexity.
- The current local Codex CLI exposes TypeScript bindings generation for `codex app-server`, which fits a TypeScript host.
- The Telegram ecosystem has mature TypeScript bot libraries.

### Package and Build

- Package manager: `pnpm` or `npm`. Prefer `pnpm` if starting from scratch.
- Module format: ESM.
- Compiler: `tsc`.
- Dev runner: `tsx` for local development.
- Production entrypoint: compiled `dist/main.js`.
- Validation: `zod`.
- Logging: `pino`.
- CLI flags: `commander` or `yargs`.
- Persistence: JSON files on disk. State is held in a small set of well-defined JSON documents (see Section 10) loaded at startup and atomically rewritten on change. SQLite is intentionally not used.
- Telegram: `grammY` (confirmed).
- WebSocket client: `ws` if the Codex app-server path is used.
- PTY fallback: `node-pty` only if needed for a CLI interactive fallback.
- Cron validation: `cron-parser`.
- File watching: `chokidar` if hot reload is needed.
- Audio probing/conversion: `ffmpeg` as an optional external dependency.
- Transcription provider: OpenAI audio transcription API by default, abstracted behind `Transcriber`.

### Process Model

Run one main `codex-chat` Node.js process under systemd. That process supervises:

- One persistent main Codex process.
- Zero or more short-lived Codex subagent processes.
- Zero or more monitor child processes.
- Optional local helper commands for transcription conversion, screenshots, or other configured hooks.

Use a single JSON-file state store and a local file store under `data/`.

## 3. High-Level Architecture

Suggested top-level modules:

- `ConfigLoader`: loads config file, environment variables, and CLI overrides.
- `StateStore`: JSON-file persistence with atomic writes and lightweight schema versioning.
- `FileStore`: stores Telegram downloads, generated files, screenshots, transcripts, and job artifacts.
- `TelegramGateway`: receives Telegram updates and sends Telegram responses.
- `MessageRouter`: converts Telegram events into internal tasks.
- `CodexMainSession`: owns the persistent Codex process and the serialized main-agent turn queue.
- `SubagentManager`: launches `codex exec` workers, collects output, and routes results.
- `BehaviorPack`: resolves prompts, skills, subagent profiles, and code references.
- `LoopSync`: reads `loops.json`, diffs crontab, and installs managed cron entries.
- `LoopRunner`: command invoked by cron to enqueue loop events.
- `MonitorManager`: starts or attaches to configured monitored processes.
- `DirectiveParser`: parses structured control directives emitted by the main agent.
- `OutboundRouter`: decides how Codex, subagent, loop, and monitor outputs are sent to Telegram.
- `ServiceSupervisor`: startup/shutdown orchestration, health checks, and signal handling.

Internal data flow:

1. Telegram update arrives.
2. `TelegramGateway` validates the sender against the allowlist.
3. `MessageRouter` normalizes the update into a `UserEvent`.
4. Attachments are downloaded into `FileStore`; voice files are transcribed.
5. The normalized event is queued to `CodexMainSession`.
6. `CodexMainSession` sends one turn at a time to the warm main Codex process.
7. Assistant output is streamed or finalized.
8. `DirectiveParser` extracts any service-control directives.
9. `OutboundRouter` sends text/images/files to Telegram and/or triggers subagents.
10. Subagent, loop, and monitor events may be fed back into the main session or sent directly to Telegram, depending on routing policy.

## 4. Persistent Main Codex Instance

### Confirmed Adapter: `codex app-server`

The local Codex CLI exposes:

- `codex app-server --listen ws://IP:PORT`
- `codex app-server generate-ts --out <DIR>`
- `codex app-server generate-json-schema --out <DIR>`

This is the **confirmed** primary main-agent transport. The fallback and last-resort adapters below are documented for completeness but are not the target architecture for the first version.

Startup:

1. Build Codex arguments from service config:
   - `--model <model>`
   - `--profile <profile>` if configured
   - `--sandbox <mode>`
   - `--ask-for-approval <policy>`
   - `--cd <workspace>`
   - repeated `--add-dir <path>`
   - repeated `--config key=value` for model effort and other Codex config overrides
2. Spawn:
   - `codex app-server --listen ws://127.0.0.1:<port> ...`
3. Connect the service to the local WebSocket endpoint.
4. Create or resume one main Codex session.
5. Persist the Codex session ID to the JSON state store.
6. Bootstrap the session with behavior-pack instructions.

The service should generate protocol bindings during development or build:

```bash
codex app-server generate-ts --experimental --out src/generated/codex-app-server
```

Do not spread generated protocol details throughout the codebase. Wrap them in:

```ts
interface CodexClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<CodexHealth>;
  sendTurn(input: CodexTurnInput): AsyncIterable<CodexEvent>;
  resume(sessionId: string): Promise<void>;
}
```

### Fallback Adapter: `codex exec resume --json`

If app-server proves too unstable, implement a fallback that resumes a persisted Codex session per turn:

```bash
codex exec resume <session-id> --json --output-last-message <file> -
```

This is less warm than a persistent process, but keeps conversation continuity and provides a robust JSONL event stream. It should be treated as compatibility mode, not the target architecture.

### Last-Resort Adapter: Interactive CLI Through PTY

Only use a PTY adapter if the app-server and `exec resume --json` paths cannot satisfy the warm-session requirement. If needed, spawn:

```bash
codex --no-alt-screen --model <model> --cd <workspace>
```

Then drive it with `node-pty`.

Risks:

- Terminal UI output is less stable than a structured protocol.
- Parsing assistant turns from a TUI is brittle.
- Recovering after crashes is harder.

Keep this adapter behind the same `CodexClient` interface so it can be removed later.

### Main-Session Serialization

The main Codex instance should process one turn at a time. Telegram users can send messages concurrently, but the service should serialize them through a queue:

- `pending`: received but not sent to Codex.
- `running`: active turn.
- `completed`: final assistant response processed.
- `failed`: failed permanently.
- `cancelled`: cancelled by operator/user.

If multiple authorized users are allowed, the initial implementation should still use one global main-session queue. This matches the "one Codex instance" requirement and avoids concurrent context corruption. The service can add per-user sessions later if needed.

### Keep-Alive and Health

Keep-alive should verify process health without polluting the Codex conversation.

Recommended checks:

- Child process exists and has not exited.
- App-server WebSocket responds to protocol ping or lightweight status request.
- Main session ID is known.
- Last event timestamp is not stale while a turn is running.

Do not send dummy user prompts as keep-alives unless there is no other health probe available.

On main Codex or app-server crash:

1. Mark the active turn as interrupted.
2. Restart the Codex process (and the app-server, if it exited) with the same config. This auto-restart is required, not optional — the service must self-heal these processes.
3. Resume the persisted session if possible.
4. Requeue the interrupted turn only if it is safe and idempotent.
5. Send a Telegram message from the bot to the owner chat describing what happened and the recovery outcome (`crashed and restarted cleanly`, `crashed and resume failed`, etc.). This is in addition to systemd logs and applies to every crash/restart event, not only permanent failures.

Crash detection should cover:

- Child process exit (non-zero, signal, or unexpected zero).
- App-server WebSocket disconnect that does not reconnect within a short window.
- Health probe failures past a configured threshold.

Each detection path feeds the same restart-and-notify routine.

### Startup Behavior Injection

The service should not hard-code agent behavior in TypeScript except for safety-critical protocol rules. Instead, it should assemble a behavior pack from disk and provide it to the main Codex session at startup.

Bootstrap prompt shape:

```text
You are the main codex-chat agent for this service.
Read and follow the behavior pack rooted at: <behaviorDir>
Primary behavior file: <behaviorDir>/AGENTS.md
Available skill files: <behaviorDir>/skills/*/SKILL.md
Available subagent profiles: <behaviorDir>/subagents/*.md

When you need the service to perform an external action, emit only a valid
codex-chat directive block matching the documented JSON schemas.
```

Persist a behavior-pack hash. On restart, if the hash changed, send a short behavior-refresh turn to the main session.

## 5. Service-Control Directives

The main Codex process needs a reliable way to ask the service to send images, dispatch subagents, notify users, or perform other service-owned actions.

Initial implementation: parse fenced JSON directives from assistant output.

Directive block format:

````markdown
```codex-chat
{
  "version": 1,
  "actions": [
    {
      "type": "dispatch_subagent",
      "idempotencyKey": "investigate-failing-build-2026-04-27",
      "profile": "debugger",
      "prompt": "Investigate the failing build logs in data/files/...",
      "route": "return_to_main",
      "timeoutSec": 1800
    }
  ]
}
```
````

Directive rules:

- Validate with Zod or JSON Schema.
- Ignore invalid directives, but feed the validation error back to the main agent.
- Strip directive blocks from user-facing Telegram messages unless explicitly configured otherwise.
- Require `idempotencyKey` for side-effecting actions.
- Store every action in the JSON state store before executing it.
- Make route explicit.

Supported first-version action types:

- `send_text`: send text to a Telegram chat.
- `send_image`: send a local image path or known file ID.
- `send_document`: send a local file path.
- `dispatch_subagent`: start a `codex exec` child.
- `cancel_job`: cancel a running subagent or monitor command.
- `notify_owner`: send operational status to owner chat.
- `enqueue_main`: enqueue a synthetic event back to the main Codex session.

Future improvement: expose these actions as a Codex MCP server toolset so the main agent can call structured tools instead of emitting directive JSON. The directive approach is simpler for the first implementation and works with any text-based Codex interface.

## 6. Subagent Dispatch

### Execution Model

Subagents are short-lived Codex CLI executions launched by the service:

```bash
codex exec \
  --json \
  --output-last-message <artifactDir>/last-message.md \
  --model <model> \
  --cd <workspace> \
  --sandbox <mode> \
  --ask-for-approval never \
  --config model_reasoning_effort="<effort>" \
  -
```

The prompt is written to stdin. Images are passed with repeated `--image <file>` when needed.

Use `spawn`, not shell interpolation, for command execution. Place the child in its own process group so cancellation can terminate the whole tree.

### Subagent Profiles

Subagent profiles live in the behavior pack:

```text
behavior/
  subagents/
    researcher.md
    debugger.md
    implementer.md
    reviewer.md
```

Each profile should define:

- Purpose.
- When to use it.
- Inputs it expects.
- Output contract.
- Whether it may edit files.
- Default model and effort overrides.
- Default timeout.
- Default routing behavior.

Example dispatch prompt assembly:

```text
<profile contents>

Task:
<main-agent requested task>

Context:
- Workspace: <workspace>
- Relevant files: <paths>
- Attachments: <file paths>

Output contract:
Return a concise final answer. Include changed files if you edited anything.
```

### Output Collection

For every subagent job, store:

- Job ID.
- Parent Telegram update/message ID.
- Parent main-session turn ID.
- Profile.
- Prompt file path.
- Started/completed timestamps.
- Exit code and signal.
- JSONL event log.
- Stderr log.
- Last-message file.
- Referenced artifacts.

The JSONL event stream should be parsed into normalized events:

- `agent_message_delta`
- `tool_call_started`
- `tool_call_completed`
- `file_changed`
- `final_message`
- `error`

If the JSON event schema changes, store raw JSONL anyway. The parser can be adjusted without losing logs.

### Result Routing

Routing is part of the dispatch request:

- `return_to_main`: feed the final subagent result back into the warm main Codex instance. This is the safest default because the main agent can decide what to tell the user.
- `send_to_user`: send the final result directly to the originating Telegram chat.
- `send_progress_and_return`: send short progress updates to Telegram, then return the final output to the main agent.
- `silent`: store the result only. Useful for maintenance loops.

If the route is `return_to_main`, enqueue a synthetic event:

```json
{
  "source": "subagent",
  "jobId": "job_...",
  "profile": "debugger",
  "status": "completed",
  "resultPath": "data/subagents/job_.../last-message.md"
}
```

### Concurrency and Limits

Configurable controls:

- `subagents.maxConcurrent`: default 2.
- `subagents.defaultTimeoutSec`: default 1800.
- `subagents.maxTimeoutSec`: default 7200.
- `subagents.maxPromptBytes`: prevent accidental huge prompts.
- `subagents.allowedProfiles`: optional allowlist.

When at capacity, new subagent jobs remain queued. Telegram `/jobs` should show running and queued work.

### Cancellation

Support cancellation from:

- Telegram command: `/cancel <jobId>`.
- Main-agent directive: `cancel_job`.
- Service shutdown.

Implementation:

1. Send `SIGTERM` to the child process group.
2. Wait grace period.
3. Send `SIGKILL` if still running.
4. Mark job `cancelled`.
5. Notify route target.

## 7. Telegram Integration

### Bot API Access

Use `grammY` as the Telegram Bot API client.

Two transport modes:

- Long polling: default. Best for a local personal service, easy first-run setup, no public HTTPS endpoint required.
- Webhook: optional. Useful for hosted deployments with a stable HTTPS endpoint.

Config chooses one:

```toml
[telegram]
mode = "polling" # "polling" or "webhook"
```

### First-Run Bot Setup

First-run setup should be terminal-driven because the bot token and allowlist are sensitive.

Flow:

1. If no bot token is configured, print BotFather setup instructions.
2. Ask the operator to set `TELEGRAM_BOT_TOKEN` or paste once into the local terminal.
3. Store only non-secret config by default. If storing a token locally is allowed, write it to a `0600` secrets file.
4. Start the bot in pairing mode if the allowlist is empty.
5. Generate a one-time pairing code in the terminal.
6. The operator sends `/pair <code>` to the bot from Telegram.
7. The service records the numeric Telegram `user.id` and optionally the `chat.id`.
8. Pairing mode closes.

Do not authorize by username alone. Usernames can change. Numeric Telegram user IDs should be the primary identity.

### Allowlist

Config:

```toml
[telegram.allowlist]
userIds = [123456789]
chatIds = [123456789]
adminUserIds = [123456789]
```

Policy:

- Deny by default.
- Allow if `from.id` is in `userIds` and, if `chatIds` is non-empty, the chat is also allowed.
- Admin-only commands require `adminUserIds`.
- Log denied attempts with user ID, chat ID, username, and timestamp.
- Never pass denied messages to Codex.

### Message Types

Supported inbound types:

- Text messages.
- Photo messages.
- Image documents.
- Voice messages.
- Audio files if transcription is enabled.
- Captions on media.

Unsupported inbound types should receive a short response unless configured to ignore them.

Text normalization:

- Preserve user text exactly.
- Include Telegram metadata separately, not by mixing it into the text.
- Use message IDs to thread replies where possible.

### Telegram File Handling

Telegram file receive flow:

1. Inspect the update for `photo`, `document`, `voice`, or `audio`.
2. Select the best file candidate:
   - For `photo`, use the largest size returned by Telegram.
   - For `document`, require an allowed MIME type or extension.
   - For `voice`, expect OGG/Opus but do not rely only on extension.
3. Call `getFile`.
4. Download the file from Telegram.
5. Store it under `data/files/<yyyy>/<mm>/<dd>/<file_unique_id>/`.
6. Store metadata in the JSON state store.
7. Pass local file paths to Codex.

Example stored metadata:

```json
{
  "telegramFileId": "...",
  "telegramFileUniqueId": "...",
  "mimeType": "image/png",
  "kind": "image",
  "localPath": "data/files/2026/04/27/abc/original.png",
  "sha256": "...",
  "sizeBytes": 12345,
  "receivedFromUserId": 123456789
}
```

### Image Receive

Images should be passed to Codex as local files, not as Telegram URLs. Telegram URLs contain the bot token and should not be exposed unnecessarily.

For the main Codex session:

- App-server adapter: pass attachments through the protocol if supported.
- `exec resume` fallback: pass repeated `--image <path>`.
- PTY fallback: save the image and include a clear local path in the prompt; use `--image` only when starting/resuming through a CLI command that supports it.

### Image Send

The service should send images from explicit local paths or known Telegram file IDs.

Outbound image directive:

```json
{
  "type": "send_image",
  "chatId": 123456789,
  "path": "data/artifacts/screenshots/app-home.png",
  "caption": "Current app screenshot"
}
```

Implementation details:

- Use `sendPhoto` for normal images.
- Use `sendDocument` when image fidelity matters or Telegram compression should be avoided.
- Validate that the path is inside approved directories before sending.
- Support captions and reply-to message ID.
- Store Telegram response metadata so file IDs can be reused.

Generated images from `$imagegen` or similar Codex workflows should be copied into the service file store or workspace before sending. The service should not depend on temporary paths that may disappear.

### Audio Receive and Transcription

Voice receive flow:

1. Download Telegram voice file.
2. Store original audio in `FileStore`.
3. Probe with `ffprobe` if available.
4. If the transcription provider accepts the original format, send it directly.
5. Otherwise convert to a supported format with `ffmpeg`.
6. Store transcript text and provider metadata.
7. Enqueue a normal user event to Codex containing:
   - Transcript.
   - Original Telegram caption, if any.
   - Local audio path.
   - A note that the text came from transcription.

Transcription interface:

```ts
interface Transcriber {
  transcribe(input: {
    path: string;
    mimeType?: string;
    language?: string;
    prompt?: string;
  }): Promise<{
    text: string;
    durationSec?: number;
    provider: string;
    model: string;
    raw?: unknown;
  }>;
}
```

Voice transcription is always automatic — no manual trigger, caption command, or user action is required. Every voice message received from an authorized user is transcribed and forwarded to Codex without prompting the user.

Config should allow transcription to be disabled globally. If disabled, voice messages should be stored and acknowledged with a short "voice transcription is not enabled" response.

**TBD — pending research**: provider selection is configurable with OpenAI as the default, but it is not yet decided whether the default OpenAI path requires a separately configured `OPENAI_API_KEY`, or whether `codex exec` itself can perform the transcription using its existing credentials. The `Transcriber` interface above intentionally allows either implementation. Resolve this before finalizing Phase 5.

### Outbound Text Formatting

Default to plain text for safety.

Optional parse modes:

- `MarkdownV2`: requires escaping and is easy to get wrong.
- `HTML`: simpler than MarkdownV2 for basic formatting.

Chunk long messages to Telegram's current message-size limit through a central `TelegramChunker`. The chunker should avoid splitting inside code fences when possible.

## 8. Behavior Pack Directory

The behavior pack is the user-editable layer that controls how the main agent behaves.

Suggested structure:

```text
behavior/
  AGENTS.md
  router.md
  directives.md
  skills/
    imagegen/
      SKILL.md
    triage/
      SKILL.md
  prompts/
    daily-brief.md
    monitor-error.md
    voice-message.md
  subagents/
    researcher.md
    debugger.md
    implementer.md
    reviewer.md
  code/
    README.md
    helpers/
      summarize-log.ts
  schemas/
    directive.schema.json
```

`AGENTS.md` should be the main behavior entrypoint. It should define:

- The bot's role.
- Telegram response style.
- When to dispatch subagents.
- When to ask clarifying questions.
- What to do with images, voice messages, and monitor alerts.
- Safety boundaries.
- How to emit service directives.

**Default behavior pack**: codex-chat ships with a default `AGENTS.md` that provides sensible out-of-the-box behavior. The default covers:

- **Loop event handling**: how to interpret and respond to loop results fed back to the main session.
- **Monitor alert handling**: how to react to `send_to_main` monitor events, including when to investigate, dispatch a subagent, or notify the user.
- **Voice message handling**: how to respond to auto-transcribed voice input.
- **Image handling**: how to handle photos and documents received from authorized users.

Users can customize or replace `AGENTS.md` to change how the main agent behaves. The default is intentionally minimal and safe.

`router.md` should describe event-specific handling:

- Text from user.
- Image with caption.
- Image without caption.
- Voice transcript.
- Loop event.
- Monitor match.
- Subagent result.

`directives.md` documents the directive JSON schema in prose for the agent.

`skills/*/SKILL.md` follow the Claude Code style: each skill has a name, trigger rules, workflow, and output contract.

`subagents/*.md` define profile-specific instructions for `codex exec` child agents.

`code/` is for helper code the behavior pack can reference. It should not automatically execute arbitrary code. If a helper is executable, it should be called through an explicit directive or monitor action with config approval.

Behavior pack reload:

- On startup, compute a content hash.
- On SIGHUP or config reload, recompute hash.
- If changed, update internal cache and notify the main Codex session.
- Do not mutate existing Codex context silently; send a short behavior refresh event.

## 9. Configuration

Use one primary TOML file, plus JSON files for loops and monitors because those are explicitly required. All other persisted state lives in JSON files under `data/state/`.

Default paths:

```text
config/codex-chat.toml
config/loops.json
config/monitors.json
data/state/                # JSON state store (see Section 10)
data/files/
data/subagents/
data/logs/
```

CLI precedence:

1. CLI flags.
2. Environment variables.
3. Config file.
4. Built-in defaults.

### Example `codex-chat.toml`

```toml
version = 1

[service]
name = "codex-chat"
workspace = "/home/tim/pkg/mush/codex-chat"
stateDir = "data"
logLevel = "info"
timezone = "Etc/UTC"

[codex]
binary = "codex"
transport = "app-server" # "app-server", "exec-resume", or "pty"
model = "gpt-5.4"
effort = "medium"
profile = ""
sandbox = "danger-full-access" # confirmed default: dedicated personal VPS
approvalPolicy = "never"
search = false
mainSessionName = "codex-chat-main"
startupTimeoutSec = 60
turnTimeoutSec = 3600
keepAliveSec = 60
extraConfig = [
  "model_reasoning_effort=\"medium\""
]
addDirs = []

[telegram]
mode = "polling"
botTokenEnv = "TELEGRAM_BOT_TOKEN"
parseMode = "plain"
pairingEnabledOnEmptyAllowlist = true
downloadMaxBytes = 52428800
sendProgressUpdates = true

[telegram.allowlist]
userIds = []
chatIds = []
adminUserIds = []

[behavior]
dir = "behavior"
entrypoint = "AGENTS.md"
reloadOnSighup = true

[subagents]
enabled = true
maxConcurrent = 2
defaultModel = ""
defaultEffort = "medium"
defaultTimeoutSec = 1800
maxTimeoutSec = 7200
artifactDir = "data/subagents"

[loops]
enabled = true
path = "config/loops.json"
namespace = "codex-chat"
runnerCommand = "codex-chat loop run"

[monitors]
enabled = true
path = "config/monitors.json"
maxRestartBackoffSec = 300

[files]
dir = "data/files"
artifactDir = "data/artifacts"
allowedSendRoots = [
  "data",
  "/home/tim/pkg/mush/codex-chat"
]

[transcription]
enabled = true
# Provider is configurable. OpenAI is the confirmed default.
# TBD — researching whether an OpenAI API key is required, or whether
# `codex exec` can perform the transcription itself. Treat `apiKeyEnv`
# as optional until that decision is made.
provider = "openai"
model = "gpt-4o-mini-transcribe"
apiKeyEnv = "OPENAI_API_KEY"
language = ""

[security]
redactSecretsInLogs = true
requireLocalFileForSend = true
allowShellActionsFromDirectives = false
```

### Config Validation

Validate all config at startup:

- Required paths exist or can be created.
- `codex.binary` resolves.
- Telegram token is available unless setup mode is running.
- Numeric allowlist IDs are valid integers.
- `behavior.entrypoint` exists.
- `loops.path` and `monitors.path` are valid if enabled.
- `codex.effort` is one of allowed effort values.
- `codex.sandbox` and approval policy are accepted by the installed Codex CLI.

Where possible, validate against the installed CLI at startup by checking `codex --help` and subcommand help. Fail fast if a configured flag is not available.

## 10. Persistence

Use JSON files on disk. SQLite is intentionally not used. The expected scale (one operator, one shared session, modest message and job volume) does not justify a relational store, and JSON files are easier to inspect, back up, and edit by hand on the VPS.

`StateStore` owns all reads and writes. It serializes writes per file, performs atomic replace via `write tmp then rename`, and keeps an in-memory cache for hot paths.

Suggested layout under `data/state/`:

```text
data/state/
  schema.json                 # { "version": 1 } — bumped on layout changes
  settings.json               # arbitrary key/value config snapshots
  telegram_users.json         # array keyed by user_id
  telegram_chats.json         # array keyed by chat_id
  codex_sessions.json         # main and named sessions, with codex_session_id, model, effort, behavior_hash
  monitors.json               # current monitor PIDs, status, restart counts
  messages/                   # append-only daily JSONL files of inbound/outbound messages
    2026-04-27.jsonl
  files/                      # one JSON file per stored Telegram/file artifact
    <fileId>.json
  turns/                      # one JSON file per main-session turn
    <turnId>.json
  jobs/                       # one JSON file per subagent job
    <jobId>.json
  loop_runs/                  # one JSON file per loop run
    <runId>.json
  monitor_events/             # append-only daily JSONL of monitor pattern hits
    2026-04-27.jsonl
  outbound_messages/          # one JSON file per outbound Telegram message
    <messageId>.json
```

Conventions:

- Top-level "registry" files (`telegram_users.json`, `telegram_chats.json`, `codex_sessions.json`, `monitors.json`, `settings.json`) are small and rewritten atomically on every change.
- Per-entity directories (`turns/`, `jobs/`, `loop_runs/`, `files/`, `outbound_messages/`) hold one JSON document per record so they can grow without rewrite contention.
- High-volume append-only streams (`messages/`, `monitor_events/`) use date-partitioned JSONL files.
- Schema versioning is handled by `data/state/schema.json` plus per-document migration helpers in `StateStore`. Migrations run on startup if the on-disk version is older than the code's expected version.
- Backups are a simple `tar` of `data/state/`.

Document shapes mirror what the SQLite tables would have held — for example `turns/<turnId>.json` carries `id, sessionId, source, status, input, outputText, startedAt, completedAt, error`. Each consumer module should depend only on its `StateStore` accessor, not on file paths, so the layout can evolve.

If remote hosting or multiple workers are added later, swap `StateStore` for a backend that supports concurrent writers; the rest of the service should not need to change.

## 11. Loops: Cron-Based Scheduled Tasks

### Goals

`loops.json` defines scheduled work. On service startup, `LoopSync` reconciles the user's crontab so the managed cron block matches `loops.json` exactly.

Cron should not call Codex directly in most cases. It should invoke a stable service CLI:

```bash
codex-chat loop run <loop-id>
```

The runner should enqueue work into the service through a local control socket. If the service is down, it should write a spool file under `data/spool/loops/` so the service can process it on next startup.

### `loops.json` Schema

Example:

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
      "id": "daily-brief",
      "enabled": true,
      "description": "Ask Codex for a daily repo and service brief.",
      "schedule": "15 9 * * *",
      "timezone": "Etc/UTC",
      "type": "prompt",
      "promptFile": "behavior/prompts/daily-brief.md",
      "route": "send_to_admins",
      "timeoutSec": 1800
    },
    {
      "id": "health-check",
      "enabled": true,
      "schedule": "*/15 * * * *",
      "type": "command",
      "command": "codex-chat",
      "args": ["health", "--json"],
      "cwd": "/home/tim/pkg/mush/codex-chat",
      "route": "store_only",
      "timeoutSec": 120
    }
  ]
}
```

Loop fields:

- `id`: stable identifier. Required.
- `enabled`: boolean. Required.
- `description`: optional human explanation.
- `schedule`: five-field cron expression. Required.
- `timezone`: optional. Applied through `CRON_TZ` if supported by the platform.
- `type`: `prompt`, `command`, or `dispatch_subagent`.
- `prompt`: inline prompt for `prompt` type.
- `promptFile`: prompt file path for `prompt` type.
- `command`: executable for `command` type.
- `args`: command arguments.
- `cwd`: working directory.
- `env`: environment overrides.
- `route`: `return_to_main` (default), `send_to_admins`, `store_only`, or `dispatch_subagent`. The default `return_to_main` feeds the loop result back to the warm main Codex session; the behavior pack's `AGENTS.md` determines how Codex handles it.
- `timeoutSec`: max run time.
- `lock`: prevent overlapping runs.
- `notifyOnFailure`: whether to notify admins on errors.
- `durable`: if true, missed runs while the service is down are spooled and replayed on restart. Default false. This is the only way a missed run is replayed — non-durable loops are skipped silently.

### Cron Sync Logic

On startup:

1. Read and validate `loops.json`.
2. Run `crontab -l`; treat "no crontab" as empty.
3. Locate the managed block:

```text
# BEGIN codex-chat managed loops
# ...
# END codex-chat managed loops
```

4. Generate desired cron lines for enabled loops.
5. Preserve all lines outside the managed block.
6. Replace the managed block with the generated block.
7. If the resulting crontab differs, install it with `crontab <tempfile>`.
8. Store the applied hash in the JSON state store.

Generated cron line pattern:

```cron
15 9 * * * CODEX_CHAT_CONFIG=/path/config.toml /usr/local/bin/codex-chat loop run daily-brief >> /path/data/logs/cron/daily-brief.log 2>&1
```

Use `flock` in the runner rather than relying on cron syntax:

```bash
flock -n data/locks/loop-daily-brief.lock codex-chat loop run daily-brief
```

The runner should:

- Load config.
- Validate the requested loop ID still exists and is enabled.
- Create a `loop_runs/<runId>.json` record.
- Acquire lock if configured.
- Send an event to the service through local IPC. If the service is down, drop the run unless the loop is marked `durable: true`; durable loops may write a spool entry under `data/spool/loops/` to be picked up on restart. Non-durable loops do not replay missed runs.
- Exit with a meaningful status code.

### Local IPC for Loop Runner

Use a Unix domain socket under `data/run/codex-chat.sock` on Unix.

Protocol can be newline-delimited JSON:

```json
{"type":"loop_run","loopId":"daily-brief","scheduledAt":"2026-04-27T09:15:00Z"}
```

The service accepts only local socket clients from the same user. If cross-user cron is required later, add token authentication.

## 12. Monitors

### Goals

Monitors watch long-running process output and trigger actions when regex patterns match.

Support three monitor source types:

- `managed_process`: service spawns and supervises the process. **Attach-or-start semantics**: on startup, the service checks for an existing process matching the monitor's identity (PID file under `data/run/monitors/<id>.pid` or a configured discovery command). If a live process is found, the monitor attaches to it (tailing logs and matching patterns); if not, the service starts it. This applies on every startup, not only the first run.
- `log_file`: service tails an existing log file.
- `journal`: service follows a systemd unit with `journalctl -fu`.

This distinction matters because a service cannot reliably read stdout from an arbitrary already-running process unless that process was launched under its control or writes to a readable log. For `managed_process` attach mode, the service relies on the monitored process writing to its configured log path so output can still be observed when the original stdout pipe is no longer available.

### `monitors.json` Schema

Example:

```json
{
  "version": 1,
  "monitors": [
    {
      "id": "web-dev-server",
      "enabled": true,
      "type": "managed_process",
      "command": "npm",
      "args": ["run", "dev"],
      "cwd": "/home/tim/pkg/mush/codex-chat",
      "env": {
        "NODE_ENV": "development"
      },
      "restart": {
        "policy": "on_failure",
        "maxRestarts": 20,
        "backoffSec": 5,
        "maxBackoffSec": 120
      },
      "output": {
        "lineBuffer": 500,
        "storeRaw": true
      },
      "patterns": [
        {
          "id": "vite-ready",
          "stream": "stdout",
          "regex": "Local:\\s+(https?://\\S+)",
          "debounceSec": 10,
          "action": {
            "type": "send_to_main",
            "promptFile": "behavior/prompts/monitor-ready.md",
            "includeRingBufferLines": 20
          }
        },
        {
          "id": "runtime-error",
          "stream": "both",
          "regex": "(Error|Exception|UnhandledPromiseRejection|EADDRINUSE)",
          "debounceSec": 30,
          "preAction": {
            "type": "run_command",
            "command": "scripts/collect-diagnostics.sh",
            "args": ["web-dev-server"],
            "timeoutSec": 10
          },
          "action": {
            "type": "send_to_main",
            "promptFile": "behavior/prompts/monitor-error.md",
            "includeRingBufferLines": 100
          }
        }
      ]
    }
  ]
}
```

Monitor fields:

- `id`: stable identifier.
- `enabled`: boolean.
- `type`: `managed_process`, `log_file`, or `journal`.
- `command` and `args`: for managed process.
- `path`: for log file.
- `unit`: for journal.
- `cwd`: working directory.
- `env`: environment overrides.
- `restart`: restart policy.
- `output`: buffering and persistence controls.
- `patterns`: regex hooks.

Pattern fields:

- `id`: stable identifier.
- `stream`: `stdout`, `stderr`, or `both`.
- `regex`: JavaScript regular expression string.
- `flags`: optional regex flags.
- `debounceSec`: suppress duplicate triggers.
- `cooldownSec`: optional longer suppression window after action.
- `includeRingBufferLines`: context line count.
- `action`: hook action.

Action types (`action.type`):

- `send_to_main`: **default action** — enqueue a monitor event to the warm main Codex instance. Codex decides what to tell the user.
- `dispatch_subagent`: start a subagent directly (without going through main first).
- `restart_monitor`: restart the managed process.

Optional pre-action (`preAction.type`):

- `run_command`: run a local command before the main action fires (e.g. a lightweight remediation or diagnostic script). The pre-action runs first; its output is captured and included in the event context sent to Codex. Disabled by default unless `security.allowShellActionsFromDirectives` is enabled or the command is explicitly allowlisted. The main `action` still fires after the pre-action completes (or times out).

Note: `telegram_notify` as a standalone action type is removed. Direct Telegram notification is now the responsibility of Codex (via directive) after it receives the `send_to_main` event, not the monitor subsystem.

### Process Supervision

For `managed_process`:

1. Spawn with `stdio: pipe`.
2. Place in a process group.
3. Stream stdout/stderr through line splitters.
4. Store a ring buffer in memory.
5. Optionally append raw output to `data/logs/monitors/<id>.log`.
6. Match regex patterns on each complete line.
7. Apply debounce and cooldown rules.
8. Execute hook action.
9. On exit, apply restart policy.

Restart policies:

- `never`
- `on_failure`
- `always`

Use exponential backoff with jitter. Reset backoff after a healthy runtime threshold.

### Monitor Event to Main Codex

Synthetic event shape:

```json
{
  "source": "monitor",
  "monitorId": "web-dev-server",
  "patternId": "runtime-error",
  "line": "UnhandledPromiseRejection...",
  "captures": ["UnhandledPromiseRejection"],
  "contextPath": "data/logs/monitors/web-dev-server/context-20260427T141500.log"
}
```

The behavior pack decides whether Codex should investigate, dispatch a subagent, or only notify the user.

### Avoiding Feedback Loops

Monitor hooks can create loops if Codex actions restart processes that trigger the same error repeatedly.

Controls:

- Pattern-level debounce.
- Monitor-level cooldown.
- Max actions per time window.
- Include previous trigger count in the event sent to Codex.
- Notify admins when a monitor is suppressed due to repeated triggers.

## 13. Service Management

### systemd Unit

Install a user-level service by default. System-level service can be supported later.

Example `~/.config/systemd/user/codex-chat.service`:

```ini
[Unit]
Description=codex-chat Telegram Codex service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/tim/pkg/mush/codex-chat
EnvironmentFile=%h/.config/codex-chat/env
ExecStart=/usr/bin/node /home/tim/pkg/mush/codex-chat/dist/main.js --config /home/tim/pkg/mush/codex-chat/config/codex-chat.toml
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal
NoNewPrivileges=true

[Install]
WantedBy=default.target
```

Commands:

```bash
systemctl --user daemon-reload
systemctl --user enable --now codex-chat.service
journalctl --user -u codex-chat.service -f
```

### Self-Notification via Telegram

systemd logs are not enough on their own. The bot itself must send Telegram messages to the owner chat for every notable lifecycle event so the operator gets a push notification on their phone:

- Service started (with version, behavior-pack hash, transport, sandbox, and current main session ID).
- Service shutting down (planned).
- Main Codex process or app-server crash detected.
- Auto-restart attempt (success or failure).
- Repeated crash within a short window (suppressed-but-flagged).
- Behavior pack reload.
- Loop or monitor entering a permanently failed state.

Implementation notes:

- These notifications are sent through the same `TelegramGateway` used for normal traffic, but on a dedicated "ops" code path that bypasses Codex.
- If Telegram itself is unreachable, the service falls back to logging the event with `severity=critical` and retries the notification with backoff once Telegram is reachable again.
- The owner/admin chat ID for ops messages is configured under `[telegram.allowlist]` (`adminUserIds`) plus an explicit `opsChatId` if set.

### Service CLI

The package should expose a `codex-chat` binary with subcommands:

```text
codex-chat start --config config/codex-chat.toml
codex-chat setup
codex-chat health --json
codex-chat loop sync
codex-chat loop run <id>
codex-chat monitors validate
codex-chat service install --user
codex-chat service uninstall --user
codex-chat jobs list
codex-chat jobs cancel <id>
```

### Shutdown

On SIGTERM/SIGINT:

1. Stop accepting Telegram updates.
2. Stop local IPC socket.
3. Mark active main turn as interrupted.
4. Terminate running subagents according to config:
   - default: terminate on shutdown.
   - optional: let complete with timeout.
5. Stop managed monitors.
6. Flush logs and the JSON state store (await pending atomic writes).
7. Exit.

### Logging

Use structured logs to stdout/stderr for systemd journal collection.

Log fields:

- `component`
- `event`
- `jobId`
- `turnId`
- `chatId`
- `userId`
- `monitorId`
- `loopId`
- `durationMs`
- `error`

Redact:

- Telegram bot token.
- OpenAI API key.
- Any configured secret env vars.
- Telegram file download URLs because they contain the bot token.

Large child-process logs should go to artifact files with pointers in structured logs.

## 14. Security Model

Trust boundaries:

- Telegram users are untrusted until allowlisted.
- Allowlisted users can influence Codex prompts.
- Behavior pack and config are trusted local files.
- Monitor and loop configs are trusted local files.
- Codex output is not trusted until directive validation passes.

Controls:

- Numeric Telegram allowlist.
- One-time pairing code for first-run authorization.
- Local-only app-server and IPC sockets.
- Path allowlists for outbound file sends.
- No shell interpolation for subprocess execution.
- Validate directive schemas.
- Idempotency keys for side effects.
- Configurable sandbox and approval policy for Codex.
- Secrets redaction.
- Store downloaded files in controlled directories.
- Size limits on Telegram downloads and prompts.
- Disable `run_command` directives by default.

Confirmed default Codex sandbox:

- Main session: `danger-full-access`.
- Subagents: `danger-full-access` (same access as the main agent — no per-profile restriction by default).
- Approval policy: `never` for non-interactive service mode, with the understanding that failures should return to the agent rather than hanging for approval.

This default is appropriate because the service runs on a personal VPS dedicated to this single workload. If the service is later deployed on a shared or sensitive machine, override the sandbox to `workspace-write` or stricter and require a dedicated Unix user with a constrained workspace.

## 15. Error Handling and Recovery

### Telegram Failures

- Retry transient send failures with exponential backoff.
- Store outbound messages before sending.
- Mark final status in the JSON state store.
- For repeated failures, notify admin through logs and stop retrying after a limit.

### Codex Main Failures

- Restart process.
- Resume session if possible.
- Requeue interrupted turn only if not already sent to Codex or if explicitly safe.
- Notify the originating Telegram chat when a turn fails permanently.

### Subagent Failures

- Capture exit code, signal, stderr, and partial JSONL.
- Route failure back according to job route.
- Do not hide failures from the main agent.

### Loop Failures

- Record failed run.
- Notify admins if `notifyOnFailure` is true.
- Preserve stdout/stderr artifacts.

### Monitor Failures

- Apply restart policy.
- Suppress restart storms with backoff.
- Notify admins if a monitor becomes permanently failed.

## 16. Testing Strategy

### Unit Tests

- Config parsing and precedence.
- Allowlist checks.
- Telegram update normalization.
- FileStore path generation and path traversal rejection.
- Directive parsing and validation.
- Cron block diff and generation.
- `loops.json` schema validation.
- `monitors.json` schema validation.
- Regex debounce/cooldown logic.
- Message chunking.

### Integration Tests

- Fake Telegram gateway with captured outbound messages.
- Fake Codex client that emits streaming events and directives.
- Fake `codex exec` process for subagent manager.
- Temporary crontab abstraction so cron sync can be tested without touching the real crontab.
- Monitor manager against a small test process that prints known lines.
- Loop runner spooling when the service IPC socket is unavailable.

### End-to-End Tests

Optional tests using a real Telegram test bot:

- Pairing.
- Text round trip.
- Image receive and send.
- Voice receive and transcription if credentials are available.
- Subagent dispatch from directive.

### Manual Verification Checklist

- `codex-chat setup` creates valid config.
- First authorized Telegram user can pair.
- Unauthorized user is denied.
- Text message reaches main Codex and response returns.
- Image is downloaded and visible to Codex.
- Voice message is transcribed and routed.
- `dispatch_subagent` directive launches `codex exec`.
- Subagent result returns to main or Telegram based on route.
- `loops.json` sync produces one managed crontab block.
- Monitor pattern match triggers the configured action.
- systemd restart recovers the service.

## 17. Implementation Phases

### Phase 1: Skeleton and Config

- Initialize TypeScript package.
- Add CLI entrypoint.
- Add config schema and sample config.
- Add the JSON state store with schema version handling and atomic writes.
- Add structured logging.
- Add health command.

### Phase 2: Telegram Text Path

- Implement `TelegramGateway` with long polling.
- Implement first-run pairing and allowlist.
- Implement text update normalization.
- Implement outbound plain-text sending and chunking.
- Use a fake `CodexClient` for early tests.

### Phase 3: Main Codex Session

- Implement app-server `CodexClient` adapter.
- Persist and resume main session ID.
- Implement turn queue.
- Implement behavior-pack bootstrap.
- Add fallback `exec resume --json` adapter if needed.

### Phase 4: Directives and Subagents

- Add directive schema and parser.
- Implement `SubagentManager` with `codex exec --json`.
- Add subagent profiles.
- Implement result routing.
- Add `/jobs` and `/cancel`.

### Phase 5: Files, Images, and Audio

- Implement Telegram file download.
- Implement image receive path into Codex.
- Implement image send directive.
- Implement transcription provider.
- Add file metadata persistence.

### Phase 6: Loops

- Add `loops.json` schema.
- Implement cron diff/sync.
- Implement loop runner and local IPC.
- Add spool fallback.
- Add loop run persistence.

### Phase 7: Monitors

- Add `monitors.json` schema.
- Implement managed process monitors.
- Implement log-file and journal monitors.
- Implement regex hooks and debounce.
- Add monitor event routing.

### Phase 8: Service Hardening

- Add systemd install command.
- Add restart recovery tests.
- Add log redaction.
- Add metrics or status summaries.
- Document operational playbooks.

## 18. Open Design Decisions

Resolved (see "Confirmed Decisions" near the top):

- `codex app-server` is the confirmed primary transport.
- All authorized Telegram users share one persistent Codex conversation.
- Default sandbox is `danger-full-access` for both the main session and subagents.
- Subagents have the same access as the main agent.
- Missed loop runs are durable-only; non-durable loops do not replay.
- Monitors attach to existing processes if running, start them if not.
- Persistence is JSON files, not SQLite.
- Telegram library is `grammY`.
- The bot self-notifies the operator over Telegram on lifecycle events and crashes.
- Loop default routing is `return_to_main`; behavior pack `AGENTS.md` handles loop results.
- Monitor default action is `send_to_main`; optional `preAction.run_command` fires first.
- Voice messages are always auto-transcribed and forwarded to Codex without any manual trigger.
- The behavior pack ships with a default `AGENTS.md` covering loops, monitors, voice, and images.

Still open / to revisit after a prototype:

- Whether service directives should be replaced by an MCP tool server.
- **Transcription credentials (TBD pending research)**: whether the OpenAI default path needs its own `OPENAI_API_KEY`, or whether `codex exec` can transcribe with its existing credentials.

## Clarifying Questions

All clarifying questions are resolved. See the "Confirmed Decisions" section near the top for authoritative answers. Summary:

1. Personal single-user bot scope; one shared session for all authorized users.
2. Single shared Codex conversation across users.
3. `codex app-server` is the confirmed primary transport.
4. Default sandbox: `danger-full-access` (dedicated personal VPS); approval policy: `never`.
5. Subagents have the same access as the main agent.
6. Durable-only replay of missed cron runs.
7. Monitors attach if a process is already running, start it if not.
8. Transcription provider is configurable, OpenAI by default. **TBD**: whether an explicit `OPENAI_API_KEY` is required or `codex exec` can transcribe natively. (Pending research — sole remaining open question.)
9. Loop default routing: `return_to_main`. The behavior pack's `AGENTS.md` determines how each loop result is handled.
10. Monitor pattern actions: `send_to_main` is the default action type. A pattern may additionally specify a `command` pre-action that runs automatically before the event reaches Codex. Codex then decides what to tell the user.
11. Voice transcription: always auto-transcribed and sent to Codex. No manual trigger or caption required.
