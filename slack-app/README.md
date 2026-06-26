# Codex Chat Slack App

This directory is the installable Slack application surface for the Phase 2
`codex-chat` Slack adapter. It is product configuration, not a throwaway test
fixture: the manifest declares the bot, OAuth scopes, Events API subscriptions,
and request path that deliver Slack workspace/team/app/channel/user/thread/event
metadata into `src/slack.ts`.

Secrets are never stored here. Use placeholders in committed templates and keep
real signing secrets and tokens in the service environment.

## Files

- `manifest.json` — Slack app manifest template for the HTTP Events API adapter.
- `install-metadata.example.json` — non-secret metadata to capture after a real
  workspace install; copy it to a private location and fill in workspace/app/bot
  IDs for operations or future migrations.
- `codex-chat.slack.example.toml` — codex-chat config fragment that enables the
  Slack adapter and names the env vars used for secrets.
- `.env.example` — local/deployment env names for Slack secrets and adapter
  enablement.
- `scripts/validate-manifest.mjs` — dependency-free validation for this app
  surface's manifest and metadata template.

## Adapter mapping

Slack sends signed HTTP Events API requests to the manifest's
`settings.event_subscriptions.request_url`. `ApiGateway` receives those requests
at `config.slack.eventsPath` (default `/api/slack/events`) and calls
`normalizeSlackEventCallback` in `src/slack.ts`.

The Phase 2 adapter currently supports:

| Slack app surface | codex-chat behavior |
| --- | --- |
| `app_mention` in public channels | Starts/resumes a thread-scoped Slack conversation and strips the bot mention. |
| `message.im` | Starts/resumes a DM conversation. |
| `message.mpim` | Starts/resumes a MPIM conversation. |
| `message.groups` | Starts/resumes a private-channel conversation/thread when the bot is a member. |
| `chat:write` | Sends final text back through `SlackGateway.sendText` using the runtime `OutputTarget`. |

The normalized runtime event carries Slack IDs and timestamps in both shared
runtime objects and Slack-specific metadata, including team/workspace ID,
enterprise ID when present, app ID, event ID/time, channel ID/type, user ID, bot
user ID when present in authorizations, message timestamp, and thread timestamp.
These fields feed `ActorContext`, `OutputTarget`, `ConversationKey`, temporary
source-conversation grants, and audit/correlation IDs.

## Install/update the Slack app

1. Choose the public HTTPS origin that reaches this codex-chat deployment, for
   example a reverse proxy or tunnel. Its request path must match
   `/api/slack/events` unless you also change `CODEX_CHAT_SLACK_EVENTS_PATH` and
   `[slack].eventsPath`.
2. Copy `manifest.json` and replace
   `https://YOUR-CODEX-CHAT-HOST.example.com/api/slack/events` with the real
   HTTPS Events API URL.
3. In Slack, create or update the app from the manifest, then install it to the
   workspace.
4. Copy the app's **Signing Secret** and **Bot User OAuth Token** into the
   codex-chat service environment as `SLACK_SIGNING_SECRET` and
   `SLACK_BOT_TOKEN`. Do not commit the values.
5. Enable the adapter with `CODEX_CHAT_SLACK_ENABLED=true` or the `[slack]`
   config in `codex-chat.slack.example.toml`.
6. Invite the bot to any private channels where `message.groups` events should
   be delivered. Public-channel interaction starts with an app mention.
7. Capture non-secret install metadata by copying
   `install-metadata.example.json` to a private ops location and filling in the
   installed workspace/app/bot IDs and rollout channels.
8. Run `node slack-app/scripts/validate-manifest.mjs` before committing manifest
   changes.

## Scopes and events

Required bot scopes for the current adapter:

- `app_mentions:read` — receive channel mentions.
- `chat:write` — post replies through the normalized `OutputTarget`.
- `im:history`, `mpim:history`, `groups:history` — receive message events for
  DMs, MPIMs, and private channels.
- `im:read`, `mpim:read`, `groups:read` — resolve/read conversation membership
  metadata associated with those surfaces when Slack provides it or future
  bounded metadata calls are enabled.

Subscribed bot events:

- `app_mention`
- `message.im`
- `message.mpim`
- `message.groups`

Slash commands and interactive components are intentionally not enabled for the
Phase 2 HTTP Events API adapter. Future phases can add command routes, Socket
Mode, buttons, progress-message interactivity, or richer Slack read/write tools
without exposing raw tokens to the main Codex prompt or subagents.
