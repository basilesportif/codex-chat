# File Save Skill

Use this skill when Tim asks to save, keep, file, archive, or attach an uploaded file/PDF/document from the current codex-chat conversation.

Common requests:

- "save this PDF"
- "save this"
- "save this to Decisive Outcomes"
- "save this as conference prospectus"
- "attach this to Bill Pate"

## Privacy Rules

- Default to private local storage under `data/private/documents/` unless `CODEX_CHAT_PRIVATE_DIR`, `ASSISTANT_PRIVATE_DIR`, or `BRAIN_PRIVATE_DIR` is set.
- Copy the source file; do not move/delete the original attachment path.
- Record metadata in `metadata.jsonl` next to the saved private files.
- Do not copy private user PDFs/documents into Brain source folders, assistant packs, generated page repos, or any public repo.
- Do not create public links or upload files elsewhere unless Tim explicitly asks for a separate share/publish action.
- The save script refuses destinations inside a git worktree unless the destination is ignored by git.

## Source Selection

- If the current message has exactly one file/document/PDF attachment and Tim says "this", save that attachment.
- If there are multiple attachments, use the one Tim names; otherwise ask which one.
- Use the attachment metadata shown in the event prompt when available: `original_name`, `mime_type`, `size_bytes`, `sha256`, `received_at`, `telegram chat_id`, and `telegram message_id`.
- Never ask for Telegram download URLs; attachments are already stored as local paths.

## Commands

Run from the codex-chat repo root.

```bash
node scripts/file-save.mjs --source "/path/to/uploaded/file.pdf"
```

With labels and event metadata:

```bash
node scripts/file-save.mjs \
  --source "/path/to/uploaded/file.pdf" \
  --original-filename "prospectus.pdf" \
  --mime-type "application/pdf" \
  --received-at "2026-05-22T12:34:56.000Z" \
  --source-chat "253768951" \
  --source-message "456" \
  --project "Decisive Outcomes" \
  --contact "Bill Pate" \
  --title "conference prospectus" \
  --note "Saved from Telegram" \
  --retention "keep until project closes"
```

Natural-language mapping:

- "save this PDF" → `--source <attachment-path>`
- "save this to Decisive Outcomes" → add `--project "Decisive Outcomes"`
- "save this as conference prospectus" → add `--title "conference prospectus"`
- "attach this to Bill Pate" → add `--contact "Bill Pate"`

List saved metadata:

```bash
node scripts/file-list.mjs
node scripts/file-list.mjs --project "Decisive Outcomes"
node scripts/file-list.mjs --contact "Bill Pate"
node scripts/file-list.mjs --query "conference prospectus"
```

## Reply

After a successful save, reply briefly with the recorded title/label and saved private path. Do not summarize PDF contents unless Tim asks for analysis.
