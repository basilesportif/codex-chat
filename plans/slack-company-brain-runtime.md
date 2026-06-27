# Slack/company-brain runtime roadmap moved to Brain

Date: 2026-06-27
Status: pointer / repository boundary

The canonical Slack/company-brain control-plane and roadmap document now lives
in the Brain repo:

```text
/home/tim/pkg/tim/brain/plans/slack-company-brain-runtime.md
```

Brain is the external app/admin control plane. The active deployment for this
conversation is `tim-main-brain` on `codex-chat-assistant-1`
(`178.104.208.141`) with admin UI at
`https://brain.decisive-outcomes.com/admin`. Brain owns deployment-specific
settings for the Brain service, codex-chat path/env/config/service,
`assistant-agent-logic`, and the private workspace.

`codex-chat` remains the internal runtime/adapter/engine. This repo owns the
Slack adapter implementation, signed Events API verification/ack/queueing,
Telegram adapter, audio ingest, subagents, loops, monitors, runtime
capabilities, and the no-secret Slack manifest contract under `slack-app/`.

The public Slack Events URL is:

```text
https://brain.decisive-outcomes.com/api/slack/events
```

Brain/Caddy reverse-proxies that raw request to codex-chat's internal
`/api/slack/events` handler so codex-chat can verify Slack signatures and own
runtime behavior. Do not reintroduce codex-chat-hosted `/admin`,
`/admin/codex-chat`, or `/api/admin/codex-chat/*` surfaces.
