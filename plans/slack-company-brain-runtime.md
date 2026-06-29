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
runtime behavior. Basic inbound Slack Events delivery through this Brain URL to
codex-chat is confirmed as of 2026-06-29. An outbound reply directive was
attempted; final proof still needs Slack canaries showing replies and later
subagent callbacks land in the expected source channel/thread/DM, so keep any
outbound scope/membership/routing caveat visible until then. Do not reintroduce
codex-chat-hosted `/admin`, `/admin/codex-chat`, or
`/api/admin/codex-chat/*` surfaces.

Major Slack runtime requirement: Slack must support multiple public channels,
private channels, DMs, MPIMs, and reply threads coherently without fragmenting
shared context. Tim's current preference is channel-first: a root channel
mention should default to posting back into the main channel, while a message
that is already in a Slack reply thread should use that thread as a distinct
context/session. The canonical Brain plan now specifies channel-visible default
replies, explicit thread contexts, bounded channel context hydration through
Slack API reads and/or recorded event history, cross-channel/private-channel
leakage guards, subagent/callback routing back to the stored Slack output
target, per-channel/thread telemetry, and canaries covering public/private/DM/
MPIM/channel/thread replies. This repo owns the runtime implementation contract
for those semantics; see `slack-app/README.md` for the local adapter checklist
and Brain's plan for the full roadmap.
