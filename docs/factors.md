# Durable Factor Scaffold

Date: 2026-05-19

Factors are future durable, directory-backed Codex app-server workers for named
responsibilities. This repo currently implements only the safe scaffold needed
for a later email/calendar pilot.

## What exists now

- Config model under `[factors]` and `[factors.<id>]`.
- Per-Factor configurable directory, enabled flag, profile/model/effort,
  startup mode, warmup prompt/file, Git fields, memory and compaction policy
  placeholders, and capability/ACL placeholders.
- State/proposal persistence under `data/state/factors/<id>.json`.
- Telegram commands: `factors`, `factor status <id>`, `factor start <id>`,
  `factor stop <id>`, `factor steer <id> <text>`.
- CLI commands: `codex-chat factors list`, `codex-chat factors status <id>`,
  `codex-chat factors propose <id> <action> [text]`.

All start/stop/steer/warmup/compact operations are proposal-only in this pass.
They record intent in Factor state and do not start a runtime.

## Safety boundaries

- `factors.enabled = false` by default.
- No Factor app-server child process is spawned.
- No external email/calendar/account calls are implemented.
- No project, todo, CRM, calendar, or canonical assistant workspace mutation is
  performed by Factor code.
- Factor-owned files must live in the configured Factor directory. The service
  stores only runtime/proposal metadata under `data/state/factors/`.
- Raw logs and personal data persistence are disabled/conservative by default;
  the current fields are placeholders for a reviewed policy.

## Directory contract

A future Factor directory should follow this shape:

```text
<factor-dir>/
  AGENTS.md
  README.md
  factor.json
  state/
    current_state.md
    open_loops.md
    decisions.md
    runtime_briefing.md
  memory/
    people/
    organizations/
    projects/
  procedures/
    inbox_triage.md
    calendar_review.md
    contact_update.md
  logs/
    turns/
    events/
  compacted/
    durable_facts.md
    weekly_summary.md
  scratch/
```

The scaffold validates and reports missing paths but does not create or overwrite
Factor directory contents automatically.

## Before a real email/calendar pilot

1. Reuse the proven child `codex_app_server` backend model for Factor runtimes.
2. Add reviewed account connectors and explicit no-mutation/default-proposal
   behavior.
3. Define redaction, retention, delete/forget, and Git persistence policies.
4. Add runtime tests with fake app-server/account backends before any real
   external account calls.
5. Keep rollback simple: turn `factors.enabled = false` and restart the service.
