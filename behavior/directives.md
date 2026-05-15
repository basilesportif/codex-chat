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

For `dispatch_subagent`, callers must include `summary`, `model`, and `effort`. The schema rejects dispatch actions missing any of those fields. The service sends a visible dispatch status with those values and records them on the subagent job so `agents` / `subagents` output shows which model and effort were used.

Subagent callbacks with an origin Telegram chat/message are not allowed to be silent. A `return_to_main` callback should produce a visible `send_text`, `send_image`, `send_document`, or clean-text reply for the original message. If the main turn produces no user-facing output, the runtime sends the subagent result directly as a safety fallback.
