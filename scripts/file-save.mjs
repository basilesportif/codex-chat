#!/usr/bin/env node
// Thin wrapper over assistant-agent-logic's file-save script, which owns the
// workspace conventions and records metadata through the locked JSON store.
// This wrapper only (a) maps CODEX_CHAT_PRIVATE_DIR onto ASSISTANT_PRIVATE_DIR
// and (b) preserves codex-chat's historical default private root
// (cwd/data/private) when neither an env var nor an explicit flag is given.
// Pre-wrapper saves recorded in data/private/**/metadata.jsonl remain readable
// there; new saves are indexed in the workspace store.
import { runLogicScript } from "./logic-repo-wrapper.mjs";

runLogicScript("file-save.js", process.argv.slice(2));
