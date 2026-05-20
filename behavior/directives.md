# codex-chat Directive Schema

Directive blocks use fenced JSON with language `codex-chat`. The service parses the block, validates each action, stores it in JSON state, strips the block from Telegram text, and executes the action.

Every action should include an `idempotencyKey` when it can produce a side effect.

Common examples:

```codex-chat
{
  "version": 1,
  "actions": [
    {
      "type": "send_image",
      "idempotencyKey": "send-home-screenshot-2026-04-27",
      "chatId": 123456789,
      "path": "data/artifacts/screenshots/home.png",
      "caption": "Current screenshot"
    }
  ]
}
```

Do not use the main loop to call built-in imagegen for user image generation or editing requests. Dispatch an `implementer` subagent; for edits, include the source local paths in `images`. The subagent must use imagegen, copy the selected output from `/home/tim/.codex/generated_images` into an allowed temporary path under `data/artifacts/generated-images/...` or another codex-chat data artifact root, and return the staged path, caption, and send directive. Original `/home/tim/.codex/generated_images` files may remain unless the user explicitly asks to delete them.

For subagent routing, use `model: "gpt-5.5"` with `effort: "medium"` for mechanical, well-scoped code/docs edits with clear instructions and low blast radius. Use `effort: "high"` for normal research, repo inspection, and non-trivial analysis. Use `effort: "xhigh"` for risky, ambiguous, debugging, architecture, multi-step, cross-module, deploy-sensitive, or high-stakes tasks.

```codex-chat
{
  "version": 1,
  "actions": [
    {
      "type": "dispatch_subagent",
      "idempotencyKey": "generate-image-2026-05-15",
      "profile": "implementer",
      "prompt": "Use imagegen for the requested image. Copy the selected output into data/artifacts/generated-images/<slug>/<file>.png, leave the original /home/tim/.codex/generated_images file in place unless explicitly asked to delete it, and return the staged path, caption, and a send_image directive with deleteAfterSend true.",
      "route": "return_to_main",
      "summary": "Generate requested image",
      "timeoutSec": 3600,
      "model": "gpt-5.5",
      "effort": "medium"
    }
  ]
}
```

After the subagent returns a staged copy, send that staged copy with Telegram cleanup enabled:

```codex-chat
{
  "version": 1,
  "actions": [
    {
      "type": "send_image",
      "idempotencyKey": "send-generated-pink-giraffe-2026-05-15",
      "path": "data/artifacts/generated-images/pink-giraffe/pink-giraffe.png",
      "caption": "Pink giraffe",
      "deleteAfterSend": true
    }
  ]
}
```

`deleteAfterSend` is required for disposable staged generated-image copies. When true and `path` is used, the service deletes the validated local file after Telegram accepts the upload; failed sends leave the file in place for inspection or retry. Do not use `deleteAfterSend` for user uploads, durable artifacts, or original files under `/home/tim/.codex/generated_images`.

```codex-chat
{
  "version": 1,
  "actions": [
    {
      "type": "dispatch_subagent",
      "idempotencyKey": "investigate-monitor-web-error",
      "profile": "debugger",
      "prompt": "Investigate the monitor context at data/logs/monitors/web/context.log",
      "route": "return_to_main",
      "summary": "Investigate web monitor error",
      "timeoutSec": 1800,
      "model": "gpt-5.5",
      "effort": "high"
    }
  ]
}
```


Simple data visualization, map, report, chart, table, calculator, one-off scratch page, small tool, Google Maps-style static page, and other functional static HTML/CSS/JS page requests for `me.galebach.com` / `codex-chat-web` should be routed to an `implementer` subagent with the generated webpage skill. Use `generated-web-page`, not `web-page-design`, unless Tim explicitly asks for a serious visual redesign, design system, or real site design:

```codex-chat
{
  "version": 1,
  "actions": [
    {
      "type": "dispatch_subagent",
      "idempotencyKey": "generate-web-page-2026-05-15",
      "profile": "implementer",
      "prompt": "Use /home/tim/pkg/tim/assistant-agent-logic/config/skills/generated-web-page.md, not web-page-design.md, for simple data visualizations, maps, reports, charts, tables, calculators, or one-off scratch pages unless Tim explicitly asked for serious visual redesign, a design system, or real site design. Build the requested static page in the job artifact directory, validate it, treat me.galebach.com as an on-demand scratch page host rather than a dashboard, publish through codex-chat-web with npm run publish:page to an unlisted /pages/<id>/ URL, verify the assistant-agent-data manifest entry, and return the public URL with TTL/pruning or promotion status.",
      "route": "return_to_main",
      "summary": "Generate and publish webpage",
      "timeoutSec": 3600,
      "model": "gpt-5.5",
      "effort": "xhigh"
    }
  ]
}
```

For `dispatch_subagent`, callers must include `summary`, `model`, and `effort`. The schema rejects dispatch actions missing any of those fields. The service sends a visible dispatch status with those values and records them on the subagent job so `agents` / `subagents` output shows which model and effort were used.

Subagent callbacks with an origin Telegram chat/message are not allowed to be silent. A `return_to_main` callback should produce a visible `send_text`, `send_image`, `send_document`, or clean-text reply for the original message. If the main turn produces no user-facing output, the runtime sends the subagent result directly as a safety fallback.

`steer_subagent` can steer an already-running app-server-backed subagent without creating a new job:

```codex-chat
{
  "version": 1,
  "actions": [
    {
      "type": "steer_subagent",
      "idempotencyKey": "steer-<msgId>-1",
      "jobId": "job_...",
      "text": "New steering text"
    }
  ]
}
```

Jobs launched with the safe `codex_exec` backend are not steerable; the service reports that explicitly.

When a Codex turn prompt includes an `Active subagent jobs` snapshot, natural-language steering must use that snapshot. Emit `steer_subagent` only if exactly one non-Employee child job in the snapshot both matches the user's request and has `steerable=true`. If a matching job has `owner=employee:<id>`, steer the owning Employee with `employee steer <id> <text>` unless Tim explicitly asks to control that exact nested child. If no job or multiple jobs match, ask which job to steer or tell the user to run `agent steer <ref> <text>`. Use the full `job_...` id from the snapshot in the directive, not just the short ref.

For a natural-language status request like "how's the implementer doing?" or "get a status update from the subagent", if exactly one running steerable non-Employee child job matches from the snapshot, emit `steer_subagent` with text `STATUS: briefly report current progress, then continue` instead of writing a manual explanatory status report. The child must emit a standalone `STATUS: ...` line as soon as possible, then continue working. A subagent status-only `STATUS: ...` response is forwarded directly to the originating Telegram chat as an interim update; it does not complete the job, and the final result still returns normally. If Tim explicitly asks for mechanical status, or if zero/multiple jobs match, ask for clarification or tell Tim to use `agent status <ref>` / `subagent status <ref>`.

## Service-Level Subagent Commands

These Telegram commands are handled before Codex sees the message:

| Command | What the service does |
|---|---|
| `agents` | Active subagent status — running, cancelling, and queued jobs with cancel/steer refs. |
| `subagents (sub)` | Alias for `agents`. |
| `agents detail` | Active jobs plus the last 10 terminal jobs. |
| `agents <N>` | Active jobs plus last N terminal jobs. |
| `agent steer <id> <text>` | Steer a running app-server-backed subagent. |
| `subagent steer <id> <text>` | Alias for `agent steer`. |
| `agent backend` | Show configured, runtime override, and effective subagent backend. |
| `agent backend exec` | Recovery command: force new and queued subagents back to the safe `codex_exec` backend. |
| `agent backend app-server` | Opt in new and queued subagents to the app-server child backend. |
| `agent backend config` | Clear the runtime override and use the configured backend. |
| `agent ping` | Show automatic cooperative status ping setting for steerable app-server subagents. |
| `agent ping off` / `agent ping on` / `agent ping 3m` / `agent ping config` | Admin-only runtime override for automatic status pings; default is every 3 minutes. |
