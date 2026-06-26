# Telegram Runtime Baseline

Date: 2026-06-25
Purpose: Phase 0 protection for the Slack/company-brain runtime plan. This file inventories current Telegram-shaped seams that later phases must preserve or wrap behind adapter-neutral runtime types before refactoring.

## Behavior that must not regress

- A Telegram user message receives an immediate service-side 👀 reaction before Codex reasoning, state recording completion, or queue processing.
- Allowed Telegram users/chats are controlled by config/state allowlists; deploy and subagent-backend mutation commands additionally require Telegram admin status.
- Service-level Telegram commands bypass Codex and reply to the originating chat/message: `help`, `logs`/`introspect`, `agents`/`subagents`/`sub`, `agent status`, `agent kill`, `agent steer`, `agent backend`, `employees`, `loops`, and deploy/update commands.
- Normal user-originated Telegram events are queued by chat, persisted while queued/running, and reply/failure notifications target the original Telegram chat/message.
- `send_text`, `send_image`, and `send_document` directives default to the origin Telegram chat and reply to the origin message when the directive targets the same chat.
- Subagent dispatch status is sent to the origin Telegram message. `return_to_main` subagent completions and direct-fallback failures reply to the original Telegram chat/message when origin metadata exists.
- Active subagent and Employee snapshots are injected before user content so natural-language steering can be routed without treating user text as status metadata.
- Telegram reply/quote/external-reply metadata is rendered as inert reference context before user content; quoted commands are not instructions.
- Telegram audio handling preserves current semantics: diarization requests from caption/reply/previous message trigger trusted service-side diarization and dispatch a subagent; regular/uncontexted MP3 transcripts stay on the normal main-loop path and ask for intent when needed.
- Telegram media sends retry without reply parameters when Telegram reports that the reply target no longer exists; generated-image staged files are deleted only after successful Telegram upload when `deleteAfterSend` is set.

## Telegram-shaped types and seams to wrap in later phases

| Area | Current Telegram-shaped contract | Later adapter-neutral target |
|---|---|---|
| Inbound event envelope (`src/types.ts`) | `UserEvent.source`, `chatId`, `userId`, `username`, `messageId`, `reply`, `attachments`, `metadata` are shaped around Telegram and synthetic service events. | Wrap into `ActorContext`, `OutputTarget`, `RunContext`, and adapter metadata while preserving existing fields during migration. |
| Reply context (`src/types.ts`, `src/telegram.ts`) | `TelegramReplyContext` and nested same-chat, external-reply, quote, story, poll/checklist IDs mirror Telegram message structures. | Store as surface-specific inbound metadata rendered as inert context. |
| Telegram adapter (`src/telegram.ts`) | `TelegramGateway` owns Grammy `Context`/`Message` ingestion, allowlist pairing, immediate reactions, file downloads, audio decisions, and Telegram send/retry helpers. | Keep as Telegram adapter over shared inbound/outbound runtime interfaces. |
| State (`src/state.ts`) | `RecordedTelegramMessage`, `telegram_users.json`, `telegram_chats.json`, and recent Telegram-message lookup support pairing, allowlists, reply/audio context, and restart recovery. | Move identity/chat records into actor/conversation/capability state with migration compatibility. |
| Service supervisor (`src/service.ts`) | Supervisor constructs `TelegramGateway`, handles Telegram command parsing, queues by `chatId`, formats `telegram chat_id/user_id/message_id`, and sends Telegram notices directly. | Route through conversation sessions, progress sinks, and `OutputTarget` renderers. |
| Directives (`src/directives.ts`, `src/service.ts`) | `send_text`, `send_image`, `send_document`, and `react` carry optional `chatId`/`messageId`; missing chat defaults to Telegram origin. | Surface-neutral output events with Telegram renderer compatibility. |
| Subagents (`src/subagents.ts`, `src/types.ts`) | Jobs persist `originChatId`/`originMessageId`; status output uses Telegram command strings for cancel/steer/status. | Jobs should be owned by `{conversationSessionId, runId, checklistItemId}` with output target metadata. |
| Behavior prompt (`behavior/AGENTS.md`) | Prompt describes one shared Codex agent behind Tim's Telegram bot and Telegram-specific directive expectations. | Update only after runtime wrappers exist; preserve current Telegram UX until a surface-neutral prompt can express equivalent behavior. |
| Config (`src/config.ts`, `config/codex-chat.example.toml`) | Telegram bot token env, mode, allowlist, ops chat, pairing, parse mode, and download limits are first-class config. | Keep Telegram adapter config, but move authorization semantics into explicit capabilities. |

## Baseline test coverage

Current and added tests protecting this baseline include:

- `src/__tests__/telegram.test.ts`: allowlist/reply extraction, immediate receipt reaction, audio transcription decisions, Telegram send retry/delete behavior.
- `src/__tests__/service.test.ts`: queue/restart/timeout notices, inert reply-context prompt rendering, active subagent and Employee prompt snapshots, directive reply defaults, subagent return/failure routing, diarized-vs-regular audio routing.
- `src/__tests__/introspect.test.ts`: service-level command parsing and Telegram command interception for help, agents/subagents, kill, steer, status, and backend rollback.
- `src/__tests__/directives.test.ts`: directive schemas including Telegram-oriented send/react fields and `serviceTier` preservation.
- `src/__tests__/telegram-baseline.test.ts`: Phase 0 smoke assertions tying the documented baseline to current prompt formatting, command bypass, Fast main-loop and subagent defaults, including the narrow standard-mode exception.
