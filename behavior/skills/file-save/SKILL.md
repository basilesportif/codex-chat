# File Save Skill (codex-chat)

Use this skill when Tim asks to save, keep, file, archive, or attach an uploaded file/PDF/document from the current codex-chat conversation ("save this PDF", "save this to Decisive Outcomes", "attach this to Bill Pate").

**The authoritative workflow, privacy rules, flag reference, and natural-language mapping live in the assistant-agent-logic skill doc — read it first:**

```
{{LOGIC_REPO}}/config/skills/file-save.md
```

`scripts/file-save.mjs` and `scripts/file-list.mjs` in this repo are thin wrappers over that repo's `scripts/file-save.js` / `scripts/file-list.js` (same flags), so the commands documented there apply verbatim; invoke the `.mjs` wrappers from the codex-chat repo root.

## codex-chat deltas (only differences from the canonical doc)

- **Env mapping:** `CODEX_CHAT_PRIVATE_DIR` is honored here — the wrapper maps it onto `ASSISTANT_PRIVATE_DIR` for the underlying script.
- **Default private root:** when no env var or `--private-root`/`--private-dir` is given, the wrapper preserves codex-chat's historical default of `data/private/` under the repo root.
- **Historical saves:** files saved before 2026-07-04 recorded metadata in `data/private/**/metadata.jsonl`; new saves are indexed in the workspace store (which `file-list` reads). Check the old jsonl only if a pre-July-2026 save is missing from `file-list` output.
- **Source selection (Telegram attachments):** if the current message has exactly one attachment and Tim says "this", save that attachment; with multiple, use the one Tim names or ask. Use the attachment metadata from the event prompt (`original_name`, `mime_type`, `size_bytes`, `received_at`, chat/message ids) to fill the corresponding flags. Never ask for Telegram download URLs; attachments are already local paths.

## Reply

After a successful save, reply briefly with the recorded title/label and saved private path. Do not summarize PDF contents unless Tim asks for analysis.
