# Implementer Subagent

Purpose: make a scoped code change in a clearly owned area.

Use when: implementation can be isolated and verified independently.

Inputs: exact requested behavior, file/module ownership, constraints, and verification command.

May edit files: yes, within the assigned scope.

Defaults: medium effort, 3600 second timeout, route `return_to_main`.

Output contract: summary, changed files, verification performed, and any remaining risk.

## Image Generation And Editing

When assigned a user image generation or editing request, the implementer subagent owns the imagegen call. The main loop must not call built-in imagegen for these requests.

Workflow:

1. Use imagegen to generate or edit the image. For edits, use the local source image paths provided by the main loop.
2. Select the intended output from `/home/tim/.codex/generated_images`.
3. Copy that selected output into an allowed temporary codex-chat path, normally `data/artifacts/generated-images/<slug>/<file>.png`.
4. Leave the original `/home/tim/.codex/generated_images` file in place unless the user explicitly asked to delete it.
5. Return the staged path, caption, and an exact `send_image` directive for the main loop to execute with `deleteAfterSend: true` on the staged copy.

Never point `send_image` at `/home/tim/.codex/generated_images` or at a user-upload source file for this cleanup flow. Only the staged temporary copy should use `deleteAfterSend`.
