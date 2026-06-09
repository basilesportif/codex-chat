# Audio Ingestion Status and Reconciliation Plan

Date: 2026-06-09

## Scope

This file preserves the current audio-ingestion work without trying to finish or redeploy it. The authoritative source checkout is `tim@89.167.72.52:/home/tim/pkg/tim/codex-chat` on `main`. The legacy production/deploy checkout recorded in repo-registry is `tim@178.104.208.141:~/pkg/tim/codex-chat` with service `codex-chat.service`.

Do **not** restart or deploy codex-chat to chase this feature until the deployed drift described below has been reconciled into the authoritative source repo.

## Implemented in the dirty deployment drift

The in-progress implementation seen from the deployment work added a local HTTP audio ingestion surface:

- Endpoint: `POST /api/ingest/audio`.
- Observed local probe URL: `http://127.0.0.1:49346/api/ingest/audio`.
- Upload shape: `multipart/form-data` with an MP3 file in form field `file` (`audio/mpeg`, `.mp3`).
- Authentication:
  - `Authorization: Bearer <key>`, or
  - `X-CodexChat-Ingest-Key: <key>`.
- Auth environment variable: `CODEXCHAT_INGEST_API_KEYS`.
  - Intended format: comma/newline-separated keys, optionally `label:secret`.
  - Labels/key fingerprints may be logged; raw secrets must not be logged or committed.
- Optional metadata fields included `source`, `device`, `title`, `recorded_at`, `client_request_id`, `notes`, and `prompt`.
- Prompt metadata behavior:
  - `prompt` is post-transcription handling metadata/instructions for codex-chat.
  - It is stored with the ingestion record and sent to the main message-handling layer with the transcript.
  - It is not an OpenAI/Whisper transcription prompt; transcription still uses the existing `[transcription]` config and optional `transcription.promptPath`.
- Data paths used by the drift included audio files under `data/files/audio-ingest` and ingestion state under `data/state/audio_ingestions`.
- The implementation was general-purpose; it should not assume Soundcore-specific behavior.

## Verified so far

Known verification from the previous deployment artifact:

- `codex-chat.service` was restarted in that context.
- An unauthenticated `POST` probe to `http://127.0.0.1:49346/api/ingest/audio` returned `401`, confirming that a process was listening locally and enforcing auth at that moment.
- Recorded verification window: 2026-06-09T15:47:01Z to 2026-06-09T15:47:11Z.
- Recorded service checkout commit for that probe: `e7fbcb4`.

This is **not** a complete end-to-end validation. It does not prove authenticated upload, transcription, prompt delivery into the main Codex turn, public reachability, restart safety, or source/deploy reproducibility.

## Current live/dirty state

- The authoritative dev checkout is clean source-of-truth code and does not contain the audio ingestion endpoint implementation.
- Audio ingestion is only partially operational as uncommitted deployment drift in the live/deploy checkout.
- That drift is at risk of being lost or changed by any normal pull, build, restart, or deploy flow.
- The endpoint appears local-only: bound/probed on `127.0.0.1:49346`. There is no committed public reverse-proxy or external route plan in source.
- There is no committed key-generation CLI. Operators must create a high-entropy secret manually and store it only in the service env file as `CODEXCHAT_INGEST_API_KEYS`; do not paste raw keys into tickets, chat, logs, or git.

## Missing before this should become durable

1. Reconcile the deployed diff into the authoritative dev checkout by copying/reviewing the deployed changes, not by blindly restarting or pulling over them.
2. Secret audit the diff and artifacts before committing; include env var names only, never raw API keys.
3. Add/confirm unit tests for:
   - missing/invalid auth returns `401`,
   - MP3 upload acceptance and size/type rejection,
   - idempotency via `client_request_id`,
   - `prompt` metadata persistence and delivery to the main message-handling layer.
4. Add an explicit operator doc for generating/provisioning `CODEXCHAT_INGEST_API_KEYS` without introducing a raw key into git/logs.
5. Decide whether the endpoint remains loopback-only or gets a trusted reverse-proxy/private-network exposure.
6. Run an authenticated smoke test with a non-secret throwaway key and small MP3, then rotate/remove the test key.
7. Only after source is reconciled and committed, deploy through the normal source-to-deploy flow and verify health plus `401` on unauthenticated probe.

## Safe next steps

1. Freeze the deploy checkout: do not restart/deploy unless needed for an unrelated incident.
2. Capture a patch from the deploy checkout over SSH, reviewing only non-secret file contents and env-file metadata.
3. Apply the patch to the authoritative dev checkout in a feature branch.
4. Run tests/build locally on the dev host.
5. Commit the reconciled endpoint source, push, then perform the normal deploy/restart.
6. After deployment, verify:
   - service health,
   - unauthenticated `POST /api/ingest/audio` returns `401`,
   - authenticated MP3 upload transcribes and delivers the transcript plus `prompt` metadata to codex-chat.

Until those steps are complete, treat audio ingestion as an experimental live drift, not a durable feature.
