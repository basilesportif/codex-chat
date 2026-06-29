# Brain Slack app runtime contract

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

## Multi-channel and thread coherence requirements

The canonical requirements live in Brain's
`plans/slack-company-brain-runtime.md`; the runtime contract here must preserve
these adapter-owned behaviors:

- Channel context and thread conversations are distinct. Ambient Slack channel
  memory/summaries are keyed by `{enterpriseId?, teamId, channelId}` while live
  reply-thread sessions are keyed by `{enterpriseId?, teamId, channelId,
  threadTs}`. DMs key continuity by the DM conversation ID.
- A root channel app mention creates or resumes a thread by using
  `event.thread_ts ?? event.ts`; follow-up messages in that Slack thread resume
  the same `ConversationSession`.
- Thread replies use thread history by default. Bounded channel history or
  channel summaries are fetched only when the request needs channel context and
  effective grants permit it.
- DMs, MPIMs, public channels, and private channels must not share prompt
  history, summaries, subagent callbacks, or output targets unless an explicit
  capability-checked retrieval/export route authorizes that crossing.
- Every Slack-derived message, summary, artifact, subagent job, and callback
  needs source labels for team/channel/channel type/thread/message IDs so
  retrieval filters and outbound routing can prevent cross-channel leakage.
- `return_to_main`, `send_to_user`, progress, failure, and direct-fallback
  callbacks from Slack-originated work must carry the originating channel/thread
  or DM output target. Late callbacks after hibernation/restart must still land
  in the originating Slack thread/DM, not a global channel.
- Runtime telemetry should expose redacted channel/thread counters, session
  create/resume/hibernate/archive events, selected context source, capability
  denials, Slack Web API send result classes, and subagent callback routing for
  Brain's admin rollups.

Live canaries must cover public-channel root-to-thread continuity, follow-up
thread continuity, second-channel isolation, private-channel continuity and
private-to-public denial, DM continuity, MPIM/group DM continuity, subagent
callback routing to the originating thread/DM, and telemetry/audit linkage.

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

## Updating or reinstalling the Brain Slack app

Use Brain admin or this repo's renderer to produce the no-secret manifest, then
update Slack from that JSON:

1. Render the manifest with the Brain Events URL, for example:
   `node slack-app/scripts/render-manifest.mjs --base-url https://brain.decisive-outcomes.com --output brain.slack.manifest.json`.
2. In Slack, open <https://api.slack.com/apps>, choose the Brain app, then open
   **App Manifest**.
3. Paste or upload the rendered JSON, confirm the app display name is **Brain**
   and the request URL is exactly
   `https://brain.decisive-outcomes.com/api/slack/events`, then save changes.
4. Open **OAuth & Permissions** and click **Reinstall to Workspace** if Slack
   reports changed scopes/events.
5. Open **Event Subscriptions**, ensure events are enabled, verify the same
   Brain request URL, and save changes.

If an older **Codex Chat** Slack app still exists, leave it installed until the
Brain app has passed a live canary if you need rollback. Then remove it from
Slack under <https://api.slack.com/apps> → old **Codex Chat** app → **App Home**
or **OAuth & Permissions** → uninstall/remove from workspace, or delete/archive
that old app if it is no longer needed. Do not copy old tokens into git or docs;
write any new Brain app signing secret and bot token only to the private runtime
environment.
