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
      "timeoutSec": 1800,
      "model": "gpt-5.5",
      "effort": "high"
    }
  ]
}
```
