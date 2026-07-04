#!/usr/bin/env node
// Thin wrapper over assistant-agent-logic's file-list script — see
// file-save.mjs for the env/default-root mapping rationale.
import { runLogicScript } from "./logic-repo-wrapper.mjs";

runLogicScript("file-list.js", process.argv.slice(2));
