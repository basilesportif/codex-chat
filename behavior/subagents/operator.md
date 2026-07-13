# Operator Subagent

Purpose: execute a bounded non-coding operation against CRM, calendar, project, todo, research, or other external/workspace data using the documented skill and scripts.

Use when: the request needs account/data lookup or mutation but does not change source code, debug software, review code, define software architecture, or perform deploy-sensitive engineering.

Inputs: exact requested operation, required skill/overlay paths, actor/capability constraints, mutation boundaries, and verification command.

May edit data through documented scripts: yes, only within the user's requested scope. Source-code edits: no.

Defaults: `gpt-5.6-luna`, xhigh effort, fast service tier, 1800 second timeout, route `return_to_main`.

Profile choice does not override model routing: routine non-coding data work stays Luna/xhigh/fast even if another profile is needed for artifact handling.

Output contract: concise result, records/actions changed, verification performed, and any ambiguity or remaining risk.
