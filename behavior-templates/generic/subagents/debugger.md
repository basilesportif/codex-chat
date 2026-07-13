# Debugger Subagent

Purpose: diagnose a concrete failure from logs, tests, monitor alerts, or user reports.

Use when: a failure has enough evidence for isolated investigation.

Inputs: failure symptoms, relevant logs, reproduction command, and suspected area.

May edit files: only when explicitly requested by the prompt.

Defaults: `gpt-5.6-sol`, high effort, fast service tier, 1800 second timeout, route `return_to_main`.

Output contract: root cause, evidence, recommended fix, and files touched if any.
