# Stability & Cleanup Plan — July 2026

Source: four-way audit (codex-chat concurrency, codex-chat cleanliness, assistant-agent-logic, cross-repo) approved by Tim on 2026-07-04. Repos: `/home/tim/pkg/tim/codex-chat` (A) and `/home/tim/pkg/tim/assistant-agent-logic` (B).

**Process:** work items in the order below. After each item (or bundle sub-item): run tests in the affected repo, commit there, and tick the checkbox here (committing the tick in A). Push both repos at each phase boundary. Restart the codex-chat service only at phase boundaries. If resuming after a crash: the checkboxes are the source of truth; `git log` in both repos confirms what landed.

## Phase 1 — data-loss / outage windows (codex-chat)

- [x] **1. Cancel-during-startJob resurrection** — `src/subagents.ts`: `startJob` awaits (ensureDir, readSubagentProfile, writeFile, saveJob) before `Object.assign(job, {status:"running"})`; a cancel in that window is overwritten and the job runs anyway. Re-check `job.status === "queued"` after awaits and abort on terminal status. Test: cancel while startJob is mid-await → job stays cancelled, backend.start never called.
- [x] **2. settleFromGrace races live steered turn** — `src/subagent-backends.ts`: after the initial `settled/closed` guard, `settleFromGrace` awaits appendEvent/writeFinalMessage; SDK activity during those awaits can't stop it → closes query mid-steered-turn. Add an activity generation counter bumped in `handleSdkMessage`; re-check `settled/closed` + generation after each await before settling. Test: activity arriving during the grace-settle's first await aborts the settle.
- [x] **3. Second Codex crash during restartCodex dropped** — `src/service.ts`: crash during the recovery tail early-returns on `restartingCodex` and nothing retries. Record a `crashDuringRestart` flag when the guard rejects a crash; after the restart loop finishes, if set (or health() fails), loop again (bounded). Test: simulated second crash triggers a second restart pass.
- [x] **4. Unhandled rejections in job lifecycle** — `src/subagents.ts`: `void child.finished.then(finishJob)` has no catch; finishJob/drain bodies await state writes uncaught. Add `.catch(log)` and try/catch so a transient FS error can't kill the process.
- [x] **5. State-store read-modify-write races** — `src/state.ts`: `setCodexSession`/`clearCodexSession`/`setSubagentBackendOverride`/`addTelegramIdentity` are unlocked RMW; route through `withJsonFileLock`.

**Phase 1 boundary: commit ticks, push A, restart service.**

## Phase 2 — data-loss windows (assistant-agent-logic)

- [ ] **9. Scripts bypassing transaction lock** — B `scripts/`: `urgent-email.js`, `urgent-message.js`, `dismiss-email.js`, `dismiss-message.js`, `flag-event.js`, `calendar-allowlist.js`, `calendar-check-invites.js`, `protonmail-send.js` do load()…await network…save() as separate lock acquisitions. Convert each RMW to `store.transaction()`; do network fetches outside, apply inside.
- [ ] **10. finance-sources atomic + no silent reset** — B `scripts/lib/finance-sources.js`, `finance-providers/plaid.js`: raw writeFileSync on Plaid tokens; corrupt file silently resets to empty. Use `writeJsonAtomic` + `withFileLock`; on parse failure preserve file as `.corrupt.<ts>` and throw labeled error.
- [ ] **11. WHOOP token refresh lock** — B `scripts/lib/whoop-auth.js`: serialize check-expiry→refresh→save under `withFileLock`; unique temp name via json-store helpers.
- [ ] **12. Misc atomic writes + corrupt-file handling** — B: `telegram-login.js` (messaging.yaml), `dictionary-deploy.js` via a new `writeFileAtomic` export; `json-store.js` load(): preserve corrupt file as `<name>.corrupt.<ts>` and throw a labeled error naming the preserved path.

**Phase 2 boundary: commit + push B, tick + push A.**

## Phase 3 — cross-repo contract

- [ ] **13. Fix stale refs in `behavior/assistant-claude.md`** — A: `todo-complete.js`, `calendar-today.js`, `calendar-week.js`, `whoop-today.js`, `docs/ASSISTANT_INTEGRATION_PLAN.md` don't exist. Replace the hand-copied script list with pointers to B's skill docs (source of truth per AGENTS.md Step 1).
- [ ] **14. Remove "read/write crm.json & bets.json directly via JSON"** — A `behavior/assistant-claude.md:19-20`: contradicts B's locking contract (`config/skills/crm.md`); route through B's scripts.
- [ ] **15. Behavior-pack reference validator** — A: add a vitest that greps `behavior/**/*.md` for `scripts/<name>.js` references and asserts each exists in B's `scripts/` (skip when B is absent, e.g. CI without the sibling checkout).
- [ ] **16. Fork/dup reconciliation (bundle — may defer parts)**
  - [ ] 16a. file-save: make A's `scripts/file-save.mjs`/`file-list.mjs` thin wrappers over B's scripts (B owns workspace conventions); collapse the two skill docs into one (A's SKILL.md points at B's).
  - [ ] 16b. setup-server: reduce A's `behavior/skills/setup-server/SKILL.md` to codex-chat deltas + "read B's doc first".
  - [ ] 16c. dispatch-rubric dedup: A `behavior/AGENTS.md` owns directive/tier mechanics; strip the restated rubric from B's `config/TELEGRAM.md`, `CLAUDE.md`, and per-skill boilerplate in `todo.md`/`projects.md`/`reminders.md`.
  - [ ] 16d. drop blanket `source workspace/.env` guidance in A `behavior/assistant-claude.md` (B scripts load env via `runtime-env.js`).
  - [ ] 16e. path parameterization: inject `{{LOGIC_REPO}}`/`{{WORKSPACE}}` in A's behavior loader from config instead of ~20 hardcoded absolute paths (incl. `src/subagents.ts:23` repo-registry path).

**Phase 3 boundary: commit + push both, restart service (behavior pack changed).**

## Phase 4 — remaining races + cleanliness (codex-chat)

- [ ] **6. Employee turn serialization** — `src/employees.ts`: busy-check reads `stateFromDescriptor` which hardcodes `activeTurnId: undefined` (dead check); serialize turns per employee behind a promise chain; keep one canonical state object.
- [ ] **7. Filter Codex error notifications by turn** — `src/codex.ts:332,416`: `error` notifications broadcast into every active turn queue; filter by `turnId`/`threadId` when present.
- [ ] **8. Smaller race/leak fixes (bundle)**
  - [ ] 8a. `requestCancel`/`finishJob`: re-check terminal status after awaits (mislabeled outcomes, double terminal writes).
  - [ ] 8b. watchdog `turns/*.json` writes via `state.writeJson` instead of raw `writeFile` (service.ts:2087/2301/2392) + re-check status inside lock in closeTurn.
  - [ ] 8c. `setBackendOverride`: snapshot `[...this.queue]` before await-per-entry iteration.
  - [ ] 8d. Claude `steer()`: build message first; mutate `pendingUserTurns`/timer synchronously around push; roll back on throw.
  - [ ] 8e. app-server session: exit-after-`turnCompleted` settles `{code:0}` (job wrongly marked failed).
  - [ ] 8f. `StateStore.queues` unbounded growth: delete entry in `.finally` when tail.
- [ ] **17. Config defaults declared 3-4×** — `src/config.ts` + `DEFAULT_CLAUDE_SUBAGENT_CONFIG`: derive defaults from the zod schema (`configSchema.parse({})`, export claude sub-schema); verify deepMerge semantics with partial TOML tables.
- [ ] **18. Structural dedup (bundle)**
  - [ ] 18a. generic session-map backend base for CodexAppServer/ClaudeAgentSdk backend classes.
  - [ ] 18b. `startJob` consumes the queued job instead of rebuilding a 25-field literal; drop dead fallback.
  - [ ] 18c. move `jobOwnerType`/`jobResultTarget`/`resultTargetForRoute`/terminal-status predicates to one exported module; delete defensive casts of real methods (`shortRef`, state override methods).
  - [ ] 18d. one `compactText`/`inlineCode` util replacing six ad-hoc copies (service.ts, employees.ts).
  - [ ] 18e. parameterize fenced-block parser in directives.ts; reuse in employees.ts.
  - [ ] 18f. dead code: `SubagentManager.cancel()`, unexport `writeDefaultConfigIfMissing`, shared `normalizeRef`, mark `addJobs` test-only.
  - [ ] 18g. structured terminal results through `SubagentCallbacks` (delete the header-stripping regex in service.ts).
- [ ] **19. processEvent split + per-delta reparse fix** — `src/service.ts:1359-1511`: split into consumeCodexStream/executeParsedDirectives/closeTurn helpers; stop re-running `parseDirectives` on the full accumulated output per delta (scan appended tail for new complete fences).

**Phase 4 boundary: commit ticks, push A, restart service.**

## Phase 5 — cleanliness (assistant-agent-logic)

- [ ] **20. Script-layer consolidation (bundle)**
  - [ ] 20a. shared `scripts/lib/cli.js` `parseArgs` + `runMain` error-contract wrapper; migrate highest-traffic scripts first (full 64-script migration can trail).
  - [ ] 20b. move personal noise-filter senders from `scripts/lib/email-state.js` into workspace data (`dismissed-emails.json` seeds / noise-rules JSON).
  - [ ] 20c. delete dead scripts: `fix-football-events.js` (one-off, mutates a real calendar), `mercury-accounts.js`/`mercury-balances.js`/`mercury-transactions.js` (superseded by `finance-*.js --provider mercury`).
  - [ ] 20d. `defineStateStore` factory in `state-stores.js`; move inline store defs from `flag-event.js`/`protonmail-send.js` into lib.

**Phase 5 boundary: commit + push both. Done.**

## Deferred / not planned
- Merging the three `sanitize*ChildProcessEnv` variants (audit verdict: layering is security policy, not duplication).
- Attention-list mega-refactor of urgent/dismiss scripts beyond the transaction fix (L effort; revisit after 20a/20d land).
