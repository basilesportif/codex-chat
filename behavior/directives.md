# codex-chat Directive Schema

Directive blocks use line-delimited sentinel JSON. The service parses the block, validates each action, stores it in JSON state, strips the block from Telegram text, and executes the action.

Use these marker lines exactly:

- `BEGIN CODEXCHAT DIRECTIVE V1`
- `END CODEXCHAT DIRECTIVE`

Legacy triple-backtick `codex-chat` fences are still accepted for old sessions, but new assistant output should use only the sentinel markers above. Do not invent or emit other directive markers.

Every action should include an `idempotencyKey` when it can produce a side effect.

Common examples:

BEGIN CODEXCHAT DIRECTIVE V1
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
END CODEXCHAT DIRECTIVE

BEGIN CODEXCHAT DIRECTIVE V1
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
END CODEXCHAT DIRECTIVE

For `dispatch_subagent`, callers must include `summary`, `model`, and `effort`. The schema rejects dispatch actions missing any of those fields. The service sends a visible dispatch status with those values and records them on the subagent job so `agents` / `subagents` output shows which model and effort were used.
