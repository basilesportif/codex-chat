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
codex-chat loop status
codex-chat monitors validate
codex-chat employees list
codex-chat employees status <id>
codex-chat employees start <id>
codex-chat employees steer <id> <query>
codex-chat employees propose <id> steer <proposal text>
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
- Employee runtime root: `data/employees/`
- Employee runtime state/proposals: `data/state/employees/`
- Disposable generated-image staging: `data/artifacts/generated-images/`

## Audio Ingestion API

`POST /api/ingest/audio` accepts authenticated `multipart/form-data` uploads
for transcription. The endpoint is general-purpose (not Soundcore-specific) and
currently accepts MP3 files sent as form field `file` with content type
`audio/mpeg` and a `.mp3` filename.

Auth:

- `Authorization: Bearer <key>`, or
- `X-CodexChat-Ingest-Key: <key>`

Set `CODEXCHAT_INGEST_API_KEYS` in the service environment. Values are
comma/newline-separated; optional labels use `label:secret` (for example
`iphone:...`). Labels or hashed key fingerprints may appear in logs, but raw
keys are not logged. Setting this env var auto-enables the local HTTP API;
otherwise enable `[api]` in config and provide keys.

To create a key, generate a high-entropy random secret on the server (for
example with `openssl rand -base64 32`), store only `label:secret` in the
systemd environment file (`~/.config/codex-chat/env`, mode `0600`), and restart
`codex-chat.service`. Give the raw secret to the caller exactly once over a
secure channel; do not paste it into logs, Git, or chat transcripts. Operators
can rotate by replacing the secret in `CODEXCHAT_INGEST_API_KEYS` and
restarting the service.

Optional form metadata fields: `source`, `device`, `title`, `recorded_at`,
`client_request_id`, `notes`, `prompt`, and `transcription_mode`.
`transcription_mode` may be `regular` (default) or `diarize`; `diarize` uses
OpenAI `gpt-4o-transcribe-diarize` and returns speaker segments when available.
Reusing the same
`client_request_id` with the same authenticated key returns the existing
`ingestion_id` when possible instead of creating another transcription.

`prompt` is a general-purpose post-transcription instruction for codex-chat
(for example, “summarize this into action items”). It is stored with the
ingestion record and delivered to the main AI/message-handling layer alongside
the transcript so the assistant can decide what to do. It is **not** passed to
OpenAI as the model transcription prompt; transcription still uses the
existing `[transcription]` config and optional `transcription.promptPath`.

Size limit: `CODEXCHAT_AUDIO_INGEST_MAX_MB` (default `100`). Transcription uses
the existing `[transcription]` config and `OPENAI_API_KEY`.

If an MP3 upload arrives without a caller `prompt`/context, the main assistant
is instructed not to assume any source-specific workflow (including Soundcore)
and to ask what to do with the transcript unless metadata clearly establishes
intent.

Example:

```bash
curl -X POST "https://YOUR_CODEXCHAT_HOST/api/ingest/audio" \
  -H "Authorization: Bearer $CODEXCHAT_INGEST_API_KEY" \
  -F "file=@recording.mp3;type=audio/mpeg" \
  -F "source=soundcore" \
  -F "device=soundcore-work" \
  -F "title=Soundcore Recording" \
  -F "transcription_mode=regular" \
  -F "prompt=Summarize this recording into action items."
```

Response shape:

```json
{
  "ingestion_id": "ing_...",
  "status": "completed",
  "transcription": {
    "status": "completed",
    "mode": "regular",
    "text": "..."
  }
}
```

Unauthenticated requests return `401 {"error":"unauthorized"}`. Invalid/missing
files return JSON errors such as `missing_file`, `unsupported_file_type`, or
`file_too_large`.

iOS Shortcuts: use “Get Contents of URL”, method `POST`, request body “Form”,
add the selected MP3 as field `file`, set its MIME type to `audio/mpeg`, and add
the Authorization header above. Add metadata fields as text form fields.

## Service Commands

Telegram messages that match service commands bypass Codex and return
immediately. `loops` (alias: `loop status`) prints a readable numbered summary
with configured/enabled/disabled counts plus each loop's enabled state,
schedule/timezone, type/route, lock/durable settings, empty-output flag when
set, and next/last run when available.

## Subagent Backend Flag

`subagents.backend` controls new subagent jobs:

- `codex_exec` is the production-safe default and preserves the historical
  `codex exec` child behavior.
- `codex_app_server` enables the experimental steerable app-server child
  backend for new jobs.

Telegram recovery path: send `agent backend exec` from an admin account. That
sets a persisted runtime override in `data/state/subagent_runtime.json` so new
and queued subagents use `codex_exec` even if config still says
`codex_app_server`. `agent backend` shows configured, override, and effective
backend. `agent backend config` clears the runtime override.

Running jobs are not changed by the backend command. Use `agent kill <ref>` for
any already-running bad child job, then dispatch again after rollback.

Use `agent status <ref>` for a mechanical snapshot of a subagent job. For app-server-backed running jobs, `agent steer <ref> <text>` can still send natural-language steering text to the child.

## Durable Employees

`[employees]` is a disabled-by-default feature flag for durable Employees: named,
directory-backed domain agents such as an email/calendar Employee. The current
runtime is intentionally minimal:

- config parsing supports `[employees.<id>]` with per-Employee `directory`,
  `enabled`, `profile`, `model`, `effort`, `startup`, `description`, warmup prompt/file,
  memory/compaction placeholders, and capabilities/ACL placeholders;
- state, proposal, and saved app-server thread metadata live under
  `data/state/employees/`;
- Employee-owned files should live only in the configured Employee directory
  (`data/employees/<id>` by default, or an absolute per-Employee path);
- when `[employees]` and the individual Employee are enabled, `employee start <id>`
  starts or resumes a non-ephemeral Codex app-server thread using
  `persistExtendedHistory`; saved `backendThreadId` values are resumed on
  service restart for running/`startup = "always"` Employees, and resume failure
  starts a fresh thread while recording `lastResumeError`;
- `employees`, `employee status <id>`, `employee start <id>`, `employee stop <id>`, and
  `employee steer <id> <text>` are service-level Telegram commands;
- `codex-chat employees list|status|start|stop|steer|propose` provides local CLI
  management; start/stop/steer are sent to the running service over IPC;
- every main Codex turn includes a compact `Available employees` snapshot so the
  main loop can see configured/running/resumable Employees and the service
  commands used to steer them;
- Employees can request child subagents only by emitting a
  `codex-chat-employee-service` envelope with `request_subagent`,
  `cancel_subagent`, or `steer_subagent`; the central SubagentManager remains
  the only component that starts, steers, cancels, and records those jobs;
- Employee child results are routed back to the owning Employee. If that runtime
  is not running or is busy, the result is stored under state and surfaced in
  `employee status <id>` instead of being dropped;
- no email/calendar account call, project/todo/CRM mutation, rich tool,
  autonomous scheduler, Git push, or compaction worker is implemented by this
  minimal runtime.

Regular subagents remain ephemeral by default: app-server subagents use
`ephemeral: true`, do not request extended history persistence, and are not
resumed after service restart.

## Active Subagent Snapshot and Steering

Every Codex turn includes a compact `Active subagent jobs` snapshot when there
are queued, running, or cancelling subagent jobs. The snapshot is intentionally
short and omits terminal history; use `agents detail` for active jobs plus the last 10 terminal jobs.

Each active line includes the short ref, full `job_...` id, status, profile,
backend, owner/result metadata, `steerable` boolean, elapsed and created times,
summary, model/effort, and origin Telegram chat/message ids when available.
Natural-language steering works from this context: the main loop emits
`steer_subagent` only when exactly one `steerable=true` non-Employee child job
matches the user's request. For `owner=employee:<id>` jobs, prefer steering the
Employee (`employee steer <id> <text>`) unless the user explicitly asks to
control that exact nested child.

## Browser Verification

`codex-chat` includes Playwright as a development dependency so subagents that
run from this workspace can do lightweight Chromium checks and screenshots when
they inspect or publish pages. After installing dependencies on a new host, run:

```bash
pnpm exec playwright install chromium
```

Minimal smoke test:

```bash
pnpm exec node -e 'const { chromium } = require("playwright"); (async () => { const browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); await page.setContent("<main>ok</main>"); console.log(await page.textContent("main")); await browser.close(); })();'
```

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

User image generation and image-editing requests are also routed work. The
current canonical behavior lives in `behavior/AGENTS.md`,
`behavior/directives.md`, and `behavior/subagents/implementer.md`: dispatch an
`implementer` subagent, let it use imagegen, copy the selected output from
`/home/tim/.codex/generated_images` into an allowed temporary path under
`data/artifacts/generated-images/...`, then send that staged copy with
`deleteAfterSend: true`. The service deletes the staged copy only after
Telegram accepts the upload.

## Transcription Modes, Diarization, and Prompt Dictionary

Normal Telegram voice/audio transcription uses regular mode by default with
`transcription.model` (default `gpt-4o-transcribe`). Diarization is opt-in:
set `transcription_mode=diarize` on `/api/ingest/audio`, or send/reply with a
clear Telegram request such as “diarize this” before attaching an MP3. Diarize
mode uses `transcription.diarizeModel` (default
`gpt-4o-transcribe-diarize`), requests `response_format=diarized_json`, and
sets `chunking_strategy=auto`.

Official OpenAI docs/API schema as checked on 2026-06-10: `gpt-4o-transcribe`
and `gpt-4o-mini-transcribe` support prompts, but
`gpt-4o-transcribe-diarize` does **not** support `prompt`, `logprobs`, or
`timestamp_granularities[]`. The service therefore sends `promptPath` contents
only in regular mode and deliberately omits prompts in diarize mode.

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

If `promptPath` is unset, missing, empty, or unreadable, regular transcription
runs without a prompt. Keep secrets out of this file: it is sent to OpenAI with
each regular voice/audio transcription request, but not with diarization
requests.

## Server bootstrap skill

The behavior pack includes `behavior/skills/setup-server/SKILL.md`, a deployment workflow for bootstrapping a fresh Ubuntu/Debian server for `codex-chat`. It covers creating a non-root deploy user, SSH hardening, UFW/fail2ban, generating an `ed25519` GitHub key, installing Bun/Node/Codex CLI, cloning/building this repo, configuring Telegram/OpenAI secrets, and installing the systemd user service.

## Example: three-repo assistant architecture

`codex-chat` is intentionally independent of any one assistant logic/data layout. It can run on top of different behavior packs, data stores, and workflow repositories. This deployment uses a three-repo architecture:

- `codex-chat` — Telegram/Codex runtime service. It receives Telegram messages, sends immediate acknowledgements, runs Codex, dispatches subagents, executes loops/monitors, and returns replies.
- `assistant-agent-logic` — reusable assistant logic: skills, prompts, helper scripts, setup/migration tooling, and Repo Registry runtime code.
- `assistant-agent-data` — private/user-owned workspace data: todos, instructions, Repo Registry state, task definitions, and durable assistant state.

In this architecture, `codex-chat` supplies the runtime while `assistant-agent-logic` supplies reusable workflows and `assistant-agent-data` supplies user-specific state. Other deployments can replace the logic and data layers while keeping `codex-chat` as the Telegram/Codex service.

A separate web repo, `codex-chat-web`, lives at `tim@89.167.72.52:~/pkg/tim/codex-chat-web`. `me.galebach.com` is an on-demand static HTML/CSS/JS scratch page host, not a dashboard. `codex-chat-web` owns publisher/pruner/tooling and generic shared page-host code only; request-specific pages publish by default as unlisted `/pages/<id>/` URLs with TTL/pruning and stay out of git unless Tim explicitly promotes them. Durable page metadata belongs in `assistant-agent-data` at `data/web-pages/manifest.json`.

The canonical documentation for this deployment's repo relationships lives in `assistant-agent-data` at `docs/assistant-system-architecture.md`.
