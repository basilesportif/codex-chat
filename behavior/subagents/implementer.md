# Implementer Subagent

Purpose: make a scoped code change in a clearly owned area.

Use when: implementation can be isolated and verified independently.

Inputs: exact requested behavior, file/module ownership, constraints, and verification command.

May edit files: yes, within the assigned scope.

Defaults: medium effort, 3600 second timeout, route `return_to_main`.

Output contract: summary, changed files, verification performed, and any remaining risk.
