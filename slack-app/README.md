# Codex Chat Slack app runtime contract

This directory contains the codex-chat-owned, no-secret Slack runtime contract:
the Slack manifest template, non-secret metadata schema, adapter config
examples, and manifest helper scripts. Human-facing Slack administration lives
in Brain; this repo stays focused on runtime contracts and adapter behavior.

## Key files

- [`manifest.json`](./manifest.json) — committed Slack app manifest template
  with placeholder Events API URL.
- [`install-metadata.example.json`](./install-metadata.example.json) —
  non-secret workspace/app/bot metadata template for private Brain/ops records.
- [`codex-chat.slack.example.toml`](./codex-chat.slack.example.toml) — example
  codex-chat config fragment for enabling the Slack adapter.
- [`.env.example`](./.env.example) — environment variable names for Slack
  secrets and adapter enablement; real values belong only in private service env.
- [`scripts/render-manifest.mjs`](./scripts/render-manifest.mjs) — render a
  deploy-ready manifest from the template without secrets.
- [`scripts/render-remote-manifest.sh`](./scripts/render-remote-manifest.sh) —
  SSH-friendly wrapper that pulls, renders, validates, and prints manifest JSON.
- [`scripts/validate-manifest.mjs`](./scripts/validate-manifest.mjs) — validate
  the Slack manifest and install metadata template.
- `src/slack-manifest.ts` — TypeScript source of truth for manifest
  rendering/validation used by scripts and tests.

## Runtime mapping

Slack sends signed HTTP Events API requests to the manifest's
`settings.event_subscriptions.request_url`. `ApiGateway` receives those requests
at `config.slack.eventsPath` (default `/api/slack/events`) and calls
`normalizeSlackEventCallback` in `src/slack.ts`.

The adapter currently supports:

| Slack app surface | codex-chat behavior |
| --- | --- |
| `app_mention` in public channels | Starts/resumes a thread-scoped Slack conversation and strips the bot mention. |
| `message.im` | Starts/resumes a DM conversation. |
| `message.mpim` | Starts/resumes a MPIM conversation. |
| `message.groups` | Starts/resumes a private-channel conversation/thread when the bot is a member. |
| `chat:write` | Sends final text back through `SlackGateway.sendText` using the runtime `OutputTarget`. |

The normalized runtime event carries Slack IDs and timestamps in shared runtime
objects and Slack-specific metadata, including team/workspace ID, enterprise ID
when present, app ID, event ID/time, channel ID/type, user ID, bot user ID when
present in authorizations, message timestamp, and thread timestamp. These fields
feed `ActorContext`, `OutputTarget`, `ConversationKey`, temporary
source-conversation grants, and audit/correlation IDs.

## Manifest contract

Required bot scopes for the current adapter:

- `app_mentions:read`
- `chat:write`
- `im:history`, `mpim:history`, `groups:history`
- `im:read`, `mpim:read`, `groups:read`

Subscribed bot events:

- `app_mention`
- `message.im`
- `message.mpim`
- `message.groups`

The committed manifest keeps a placeholder Events API URL. Brain renders the
manifest with the deployment's public Events URL before a human installs or
updates the Slack app. Slash commands, shortcuts, Socket Mode, and interactive
components are not part of this HTTP Events API contract.

## Secret boundary

Secrets are never stored here. `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN`
belong in the private runtime service environment. Brain may write those values
as write-only env entries and may call the no-secret renderer scripts from a
selected codex-chat checkout, but codex-chat does not serve a human Slack
administration UI.
