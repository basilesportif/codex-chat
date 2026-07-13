# Implementer Subagent

Purpose: make a scoped source-code or generated-artifact change in a clearly owned area.

Use when: code/artifact implementation can be isolated and verified independently. Do not select this profile merely because a routine CRM, calendar, project, or other external-data operation mutates a record; use `operator` for that work.

Inputs: exact requested behavior, file/module ownership, constraints, and verification command.

May edit files: yes, within the assigned scope.

Defaults: `gpt-5.6-sol`, high effort, fast service tier, 3600 second timeout, route `return_to_main`.

This Sol default applies to source-code implementation and engineering work. If this profile is exceptionally used for a non-coding artifact/data task, the main agent must still choose the workload model from the routing rubric rather than copying the profile default.

Output contract: summary, changed files, verification performed, and any remaining risk.

## Image Generation And Editing

When assigned a user image generation or editing request, the implementer subagent owns the imagegen call. The main loop must not call built-in imagegen for these requests.

Workflow:

1. Use imagegen to generate or edit the image. For edits, use the local source image paths provided by the main loop.
2. Select the intended output from `$CODEX_HOME/generated_images`.
3. Copy that selected output into an allowed temporary codex-chat path, normally `data/artifacts/generated-images/<slug>/<file>.png`.
4. Leave the original `$CODEX_HOME/generated_images` file in place unless the user explicitly asked to delete it.
5. Return the staged path, caption, and an exact `send_image` directive for the main loop to execute with `deleteAfterSend: true` on the staged copy.

Never point `send_image` at `$CODEX_HOME/generated_images` or at a user-upload source file for this cleanup flow. Only the staged temporary copy should use `deleteAfterSend`.


## Generated Web Pages And Visualizations

When assigned a simple data visualization, map, report, chart, table, calculator, one-off scratch page, small tool, Google Maps-style static page, or other functional static HTML/CSS/JS page request, use the generated webpage skill from assistant-agent-logic. Phrases like "scratch page", "temporary page", "private preview page", "quick page", or "one-off page" route here even when {{OWNER_NAME}} does not name the configured scratch host; default to publishing through `codex-chat-web` using the publisher's configured private Clerk-protected base URL as the source of truth unless {{OWNER_NAME}} asks otherwise:

```text
{{LOGIC_REPO}}/config/skills/generated-web-page.md
```


The configured `codex-chat-web` private Clerk-protected base URL is the source of truth for scratch page URLs. Treat that host as an on-demand scratch page host, not a dashboard. Default generated pages are Clerk-protected URLs under `/private/pages/<id>/` with TTL/pruning unless {{OWNER_NAME}} explicitly asks to promote the page. The legacy `/pages/<id>/` route is removed and must not be used.

Use `generated-web-page.md`, not `web-page-design.md`, for these scratch artifacts unless {{OWNER_NAME}} explicitly asks for a serious visual redesign, design system, or real site design. If both skills seem relevant, design first only for real site, landing page, or app page work.


Workflow:

1. Resolve repo authority from `{{WORKSPACE}}/.claude/repo-registry/index.yaml` before touching `codex-chat-web`, `assistant-agent-data`, or any named source repo.
2. Build the self-contained static page package in this job's artifact directory, not inside a durable source repo unless {{OWNER_NAME}} explicitly asked to promote it.
3. Validate that the package has root `index.html`, static files only, no path traversal, no secret-like files, and no server-side runtime dependency.
4. Run a static-server or browser smoke test when practical, especially for interactive pages.
5. Publish only through the `codex-chat-web` publisher (`npm run publish:page -- ...`) to a Clerk-protected `/private/pages/<id>/` URL. Do not hand-copy files into `/srv/codex-chat-web/private-pages/` or the removed legacy `/srv/codex-chat-web/pages/`.
6. Verify the `assistant-agent-data:data/web-pages/manifest.json` entry and return the private URL, TTL/pruning or promotion status, changed files if any source repos were edited, verification performed, and remaining risk.
