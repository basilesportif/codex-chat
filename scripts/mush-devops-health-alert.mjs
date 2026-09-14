#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DEFAULT_COOLDOWN_MINUTES,
  DEFAULT_REMEDIATION_TIMEOUT_SEC,
  MAX_CONSECUTIVE_FAILURES,
  MAX_REMEDIATION_TARGETS_PER_RUN,
  OUTCOMES,
  beginRemediationAttempt,
  clearRecoveredBackends,
  detectGpuRemediationTargets,
  finalizeRemediationAttempt,
  formatRemediationReport,
  gpuBackendEnumerationIsTrustworthy,
  previewRedacted,
  readRemediationState,
  redactSecrets,
  runGpuRemediation,
  shouldAttemptRemediation,
  writeRemediationState,
} from "./lib/gpu-remediation.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REMEDIATION_STATE_PATH = path.join(REPO_ROOT, "data/state/mush_devops_remediation.json");
/**
 * Dedupe ledger for BENIGN Vast SSH-port renumbering (see `collectBenignDriftNotices`). Lives next
 * to the remediation state and follows the same conventions: JSON, versioned, atomically replaced.
 */
export const VAST_DRIFT_NOTICE_STATE_PATH = path.join(
  REPO_ROOT,
  "data/state/mush_devops_vast_drift_notices.json",
);
/** Hard ceiling on ledger entries so a pathological producer cannot grow the file without bound. */
export const MAX_DRIFT_NOTICE_ENTRIES = 32;
/** Comparison classes emitted by mush-devops `scripts/vast/vast-drift.js --json`. */
export const DRIFT_CLASS_BENIGN = "ssh-port-renumber";
export const DRIFT_CLASS_UNEXPECTED = "unexpected";

const DEFAULT_HOST = "tim@89.167.72.52";
const DEFAULT_REMOTE_DIR = "/home/tim/pkg/mush/mush-devops";
const DEFAULT_TIMEOUT_SEC = 240;
const DEFAULT_LOW_BALANCE_THRESHOLD = 5;
const NO_TARGET_ERROR = "No health check target could be derived from stack.json.";

async function main() {
  const options = parseCliOptions(process.argv.slice(2), process.env);
  const host = process.env.MUSH_DEVOPS_SSH_HOST || DEFAULT_HOST;
  const remoteDir = process.env.MUSH_DEVOPS_REMOTE_DIR || DEFAULT_REMOTE_DIR;
  const timeoutSec = parsePositiveNumber(process.env.MUSH_DEVOPS_TIMEOUT_SEC, DEFAULT_TIMEOUT_SEC);
  const lowBalanceThreshold = parsePositiveNumber(
    process.env.MUSH_DEVOPS_LOW_BALANCE_THRESHOLD,
    DEFAULT_LOW_BALANCE_THRESHOLD,
  );

  const remoteCommand = [
    `cd ${shellQuote(remoteDir)}`,
    "set -a",
    "{ [ ! -f .env ] || . ./.env; }",
    "set +a",
    `node scripts/full-health-check.js --json --low-balance-threshold ${shellQuote(String(lowBalanceThreshold))}`,
  ].join(" && ");

  const run = await runCommand(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=20",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=2",
      host,
      remoteCommand,
    ],
    timeoutSec * 1000,
  );

  const payload = parseJsonOutput(run.stdout);
  if (!payload.ok) {
    printCommandFailure({ host, remoteDir, timeoutSec, run, reason: payload.error });
    process.exit(run.exitCode || 1);
  }

  const findings = collectFindings(payload.value, { lowBalanceThreshold });

  // Auto-remediation must never take the plain alert down with it: a bug here degrades to a
  // short "auto-remediation itself failed" note appended to the findings Tim would have gotten
  // anyway.
  let remediationSection = "";
  try {
    remediationSection = await runRemediationPhase({
      payload: payload.value,
      options,
      host,
      remoteDir,
    });
  } catch (error) {
    remediationSection = formatRemediationReport([
      {
        target: null,
        outcome: OUTCOMES.error,
        message: `auto-remediation wrapper failed: ${redactSecrets(preview(error instanceof Error ? error.message : String(error)))}`,
      },
    ]);
  }

  if (findings.length === 0 && !remediationSection) {
    process.exit(0);
  }

  const alert = formatAlert({ checkedAt: payload.value.checkedAt, host, remoteDir, findings });
  console.log(remediationSection ? `${alert}\n${remediationSection}` : alert);
}

/**
 * Interpret the safety switches. Remediation is OFF by default: arming it is an explicit opt-in
 * via MUSH_DEVOPS_AUTO_REMEDIATE=1/true/on/yes, so a fresh checkout (config/loops.json is
 * gitignored and does not travel with the repo) never restarts a production box on its own.
 * `--no-remediate` forces it off regardless of the env, and `--dry-run-remediation` keeps every
 * mutation (and the cooldown state write) off while still reporting what would have happened.
 */
export function parseCliOptions(argv = [], env = {}) {
  const args = Array.isArray(argv) ? argv.map((value) => String(value)) : [];
  const dryRun = args.includes("--dry-run-remediation");
  const autoRemediate =
    !args.includes("--no-remediate") && parseBooleanFlag(env.MUSH_DEVOPS_AUTO_REMEDIATE, false);
  return {
    autoRemediate,
    dryRun,
    cooldownMinutes: parsePositiveNumber(env.MUSH_DEVOPS_REMEDIATION_COOLDOWN_MIN, DEFAULT_COOLDOWN_MINUTES),
    remediationTimeoutSec: parsePositiveNumber(
      env.MUSH_DEVOPS_REMEDIATION_TIMEOUT_SEC,
      DEFAULT_REMEDIATION_TIMEOUT_SEC,
    ),
    gatewaySshOverride: String(env.MUSH_DEVOPS_GPU_GATEWAY_SSH || "").trim() || null,
  };
}

export function parseBooleanFlag(value, fallback) {
  if (value == null || String(value).trim() === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(normalized)) return false;
  if (["1", "true", "on", "yes"].includes(normalized)) return true;
  return fallback;
}

/**
 * Detect the "GPU box's remote-inference died" signature, apply the safety switches, the cooldown
 * and the circuit breaker, run the restart, persist state, and render the report section.
 * Returns "" when nothing matched.
 *
 * Every side effect is injectable so the whole path can be unit tested without ssh or the real
 * state file; the defaults are the production wiring.
 */
export async function runRemediationPhase({
  payload,
  options,
  host,
  remoteDir,
  statePath = REMEDIATION_STATE_PATH,
  exec = runCommand,
  now = () => Date.now(),
  remediate = runGpuRemediation,
  readState = readRemediationState,
  writeState = writeRemediationState,
}) {
  const httpCheck = Array.isArray(payload?.results)
    ? payload.results.find((result) => result?.key === "http")
    : null;
  // Did this run actually see the backends? Nothing may be inferred from silence.
  const enumerationTrustworthy = gpuBackendEnumerationIsTrustworthy(httpCheck);
  const detected = detectGpuRemediationTargets(httpCheck, {
    gatewaySshOverride: options.gatewaySshOverride,
  });

  const notes = [];
  if (options.dryRun) {
    notes.push("Dry run: nothing on the GPU boxes or in the cooldown state file was modified.");
  }

  // The gate state is also needed for the auto-recovery reset below, which runs even when this
  // run detected nothing at all.
  let state = null;
  if (options.autoRemediate) {
    state = await readState(statePath);

    // CIRCUIT-BREAKER AUTO-RECOVERY: a backend that is carrying a failure streak but is healthy in
    // this run recovered on its own, so its breaker is closed again.
    //
    // This requires POSITIVE evidence: a backend absent from an enumeration we actually received is
    // positively healthy, but an enumeration we never received tells us nothing. Without that gate
    // a gateway-level outage (ECONNREFUSED, timeout, non-JSON body) produces an empty detected list
    // and would silently re-arm every open breaker — buying the box three more automated restarts
    // with zero evidence that anything recovered. Never in dry-run mode, which must not write state.
    if (enumerationTrustworthy && !options.dryRun) {
      const recovery = clearRecoveredBackends(
        state,
        detected.map((target) => target.backendId),
      );
      if (recovery.changed) {
        try {
          await writeState(statePath, recovery.state);
          state = recovery.state;
        } catch (error) {
          notes.push(
            `Could not clear the auto-remediation failure counter for ${recovery.cleared.join(", ")} in ${statePath}: ${errorText(error)}.`,
          );
        }
      }
    }
  }

  if (detected.length === 0) return "";

  if (!options.autoRemediate) {
    return formatRemediationReport(
      detected.map((target) => ({
        target,
        outcome: OUTCOMES.skippedDisabled,
        message:
          "auto-remediation is disabled (MUSH_DEVOPS_AUTO_REMEDIATE is not set to 1/true/on, or --no-remediate was passed); restart remote-inference manually.",
      })),
      notes,
    );
  }

  // CORRELATED-FAILURE GUARD: with only two GPU boxes, more than one unhealthy backend in the same
  // run means the shared upstream (gateway, network, Vast) is the likelier cause than two
  // independent per-box crashes. Restarting even one box would be action without evidence, and the
  // cap of MAX_REMEDIATION_TARGETS_PER_RUN=1 means we could never fix both anyway. Alert only.
  if (detected.length > MAX_REMEDIATION_TARGETS_PER_RUN) {
    return formatRemediationReport(
      detected.map((target) => ({
        target,
        outcome: OUTCOMES.skippedCorrelated,
        message:
          `${detected.length} GPU backends (${detected.map((entry) => entry.backendId).join(", ")}) went unhealthy at ` +
          `the same time. Simultaneous failures point at an upstream or gateway-level cause rather than independent ` +
          `per-box crashes, so auto-remediation was skipped entirely and no box was restarted. Investigate the ` +
          `gateway, the network path and Vast.ai before restarting anything by hand.`,
      })),
      notes,
    );
  }

  const target = detected[0];
  const cooldownMs = options.cooldownMinutes * 60 * 1000;
  const gate = shouldAttemptRemediation(state, target.backendId, now(), cooldownMs);

  if (!gate.allowed && gate.reason === "circuit-open") {
    return formatRemediationReport(
      [
        {
          target,
          outcome: OUTCOMES.skippedCircuitOpen,
          message:
            `MANUAL INTERVENTION NEEDED: auto-remediation is suspended for ${target.backendId} after ` +
            `${gate.consecutiveFailures} consecutive failed attempts (limit ${MAX_CONSECUTIVE_FAILURES}); the last one ` +
            `at ${gate.lastAttemptAt} ended "${gate.lastOutcome || "unknown"}". Restarting it again automatically ` +
            `would just repeat a fix that demonstrably does not work. The suspension clears by itself once the ` +
            `backend is healthy again in a later check, or immediately if you reset/remove ${statePath}.`,
        },
      ],
      notes,
    );
  }

  if (!gate.allowed) {
    return formatRemediationReport(
      [
        {
          target,
          outcome: OUTCOMES.skippedCooldown,
          message:
            `auto-remediation skipped: the last attempt at ${gate.lastAttemptAt} ended "${gate.lastOutcome || "unknown"}" ` +
            `and the ${options.cooldownMinutes}-minute cooldown runs until ${gate.retryAfter}. Restart remote-inference manually if this is urgent.`,
        },
      ],
      notes,
    );
  }

  const runRemediation = async () => {
    try {
      const results = await remediate({
        targets: [target],
        exec,
        jumpHost: host,
        remoteDir,
        dryRun: options.dryRun,
        timeoutSec: options.remediationTimeoutSec,
      });
      return (
        (Array.isArray(results) ? results : []).find(Boolean) || {
          target,
          outcome: OUTCOMES.error,
          message: "auto-remediation returned no result for this backend.",
        }
      );
    } catch (error) {
      return {
        target,
        outcome: OUTCOMES.error,
        message: `auto-remediation crashed: ${preview(errorText(error))}`,
      };
    }
  };

  if (options.dryRun) {
    return formatRemediationReport([await runRemediation()], notes);
  }

  // ORDERING: the cooldown marker is written BEFORE the box is touched, so a crash mid-restart
  // still blocks a rapid repeat on the next run. If that write fails we fail CLOSED and never
  // restart, because an unrecorded restart could repeat every few minutes.
  const startedAt = new Date(now()).toISOString();
  const startedState = beginRemediationAttempt(state, target.backendId, startedAt);
  try {
    await writeState(statePath, startedState);
  } catch (error) {
    return formatRemediationReport(
      [
        {
          target,
          outcome: OUTCOMES.error,
          message:
            `auto-remediation did not run: the cooldown marker could not be written to ${statePath} ` +
            `(${errorText(error)}). Restarting without a recorded cooldown risks a restart loop, so nothing was ` +
            `touched. Fix the state file, or restart remote-inference manually.`,
        },
      ],
      notes,
    );
  }

  const result = await runRemediation();

  // The restart already happened: its outcome is reported no matter what the final write does.
  try {
    await writeState(
      statePath,
      finalizeRemediationAttempt(startedState, target.backendId, result.outcome, new Date(now()).toISOString()),
    );
  } catch (error) {
    notes.push(
      `The result above is real, but the auto-remediation state file ${statePath} could not be updated ` +
        `(${errorText(error)}). The in-progress marker written before the restart still holds the cooldown, ` +
        `so the next run will not restart this backend immediately.`,
    );
  }

  return formatRemediationReport([result], notes);
}

function errorText(error) {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

export function parsePositiveNumber(value, fallback) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ exitCode, signal, stdout, stderr, timedOut });
    });
  });
}

function parseJsonOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { ok: false, error: "Command produced no JSON output." };
  }

  for (const candidate of jsonCandidates(trimmed)) {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch (_error) {
      // Try the next candidate.
    }
  }

  return { ok: false, error: "Command output was not valid JSON." };
}

function jsonCandidates(value) {
  const candidates = [value];
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start >= 0 && end > start) {
    candidates.push(value.slice(start, end + 1));
  }
  return candidates;
}

/**
 * Turn a full-health-check payload into alert findings.
 *
 * `options.driftNoticeStatePath` / `readDriftNoticeState` / `writeDriftNoticeState` / `now` exist so
 * the benign-drift debounce ledger can be pointed at a temp file in tests; production uses the
 * defaults (`VAST_DRIFT_NOTICE_STATE_PATH` and the real synchronous, atomic file helpers).
 */
export function collectFindings(payload, options = {}) {
  const lowBalanceThreshold = parsePositiveNumber(
    options.lowBalanceThreshold,
    DEFAULT_LOW_BALANCE_THRESHOLD,
  );

  if (!payload || !Array.isArray(payload.results)) {
    return ["Health check output was missing the expected results array."];
  }

  const findings = [];
  const checks = new Map(payload.results.map((result) => [result.key, result]));

  collectHttpFindings(checks.get("http"), findings);
  collectVastStatusFindings(checks.get("vastStatus"), findings, lowBalanceThreshold);
  collectVastBalanceFallbackFindings(payload, checks, findings, lowBalanceThreshold);
  collectVastDriftFindings(checks.get("vastDrift"), findings, {
    driftNoticeStatePath: options.driftNoticeStatePath,
    readDriftNoticeState: options.readDriftNoticeState,
    writeDriftNoticeState: options.writeDriftNoticeState,
    now: options.now,
  });
  collectCaddyFindings(checks.get("caddyDrift"), findings);

  for (const check of payload.results) {
    if (["http", "vastStatus", "vastDrift", "caddyDrift"].includes(check.key)) continue;
    if (isSkippedCheck(check)) continue;
    if (Number(check.exitCode) !== 0) {
      findings.push(`${check.label || check.key || "Check"} failed: ${preview(check.stderr || check.stdout)}`);
    }
  }

  return findings;
}

/**
 * A check the remote health runner deliberately skipped (for example when vast.ai DNS
 * cannot be resolved, so the Vast API is unreachable for reasons outside our control).
 * Skipped checks are informational, never actionable, and must not raise an alert.
 */
export function isSkippedCheck(check) {
  if (!check) return false;
  return (
    check.status === "skipped" ||
    check.parsed?.skipped === true ||
    check.parsed?.status === "skipped"
  );
}

function collectHttpFindings(check, findings) {
  if (!check) {
    findings.push("HTTP health check did not run.");
    return;
  }

  if (!check.parsed || !Array.isArray(check.parsed.results)) {
    if (Number(check.exitCode) !== 0) {
      findings.push(`HTTP health failed: ${preview(check.stderr || check.stdout)}`);
    }
    return;
  }

  for (const result of check.parsed.results) {
    if (result.status === "healthy" || result.status === "skipped") continue;
    if (result.error === NO_TARGET_ERROR) continue;

    findings.push(formatHttpFinding(result));
  }
}

function collectVastStatusFindings(check, findings, lowBalanceThreshold) {
  if (!check) {
    findings.push("Vast status check did not run.");
    return;
  }

  if (isSkippedCheck(check)) return;

  if (!check.parsed) {
    if (Number(check.exitCode) !== 0) {
      findings.push(`Vast status failed: ${preview(check.stderr || check.stdout)}`);
    }
    return;
  }

  const lowBalance = formatLowBalanceFinding(check.parsed, lowBalanceThreshold);
  if (lowBalance) {
    findings.push(lowBalance);
    return;
  }

  if (check.parsed.healthy === false) {
    const balance = Number.isFinite(parseFiniteNumber(check.parsed.balance))
      ? ` balance ${formatMoney(check.parsed.balance)}.`
      : "";
    findings.push(`Vast status failing:${balance || ` ${preview(check.stderr || check.stdout)}`}`);
  } else if (Number(check.exitCode) !== 0) {
    findings.push(`Vast status exited ${check.exitCode}: ${preview(check.stderr || check.stdout)}`);
  }
}

function collectVastBalanceFallbackFindings(payload, checks, findings, lowBalanceThreshold) {
  if (findings.some((finding) => finding.startsWith("Vast balance low:"))) return;

  // When the Vast status check was skipped (Vast API unreachable) any balance figure we
  // still have lying around is stale, so do not synthesize a low-balance alert from it.
  if (isSkippedCheck(checks.get("vastStatus"))) return;

  const candidates = [
    payload.vastAi,
    checks.get("http")?.parsed?.vastAi,
    ...payload.results.filter((result) => !isSkippedCheck(result)).map((result) => result.parsed?.vastAi),
  ];
  for (const candidate of candidates) {
    const lowBalance = formatLowBalanceFinding(candidate, lowBalanceThreshold);
    if (lowBalance) {
      findings.push(lowBalance);
      return;
    }
  }
}

function formatLowBalanceFinding(status, lowBalanceThreshold) {
  const balance = parseFiniteNumber(status?.balance);
  if (!Number.isFinite(balance) || balance >= lowBalanceThreshold) return null;

  const hoursRemaining = parseFiniteNumber(status?.estimatedHoursRemaining);
  const hours = Number.isFinite(hoursRemaining)
    ? `, about ${Math.round(hoursRemaining)}h remaining`
    : "";
  return `Vast balance low: balance ${formatMoney(balance)} is below threshold ${formatMoney(lowBalanceThreshold)}${hours}.`;
}

/**
 * Vast drift findings.
 *
 * Two very different things arrive on this check:
 *
 *  - ACTIONABLE drift (`driftClass: "unexpected"`): the host moved, the service port moved, the SSH
 *    mode flipped, the instance identity does not match, ... Something is genuinely wrong and Tim is
 *    paged every run until it is fixed. No debounce, ever.
 *  - BENIGN drift (`driftClass: "ssh-port-renumber"`): Vast rebuilt the box and handed the same
 *    instance a new direct-SSH host port. stack.json wants reconciling, but nothing is broken. Paging
 *    every 15 minutes for that is pure noise, so it is debounced to ONE notice per rebuild event via
 *    a small state ledger (see `collectBenignDriftNotices`).
 *
 * `parsed.drifted` stays true for both, so it must never again be the thing that decides to alert.
 */
export function collectVastDriftFindings(check, findings, options = {}) {
  if (!check) {
    findings.push("Vast drift check did not run.");
    return;
  }

  if (isSkippedCheck(check)) return;

  if (!check.parsed) {
    if (Number(check.exitCode) !== 0) {
      findings.push(`Vast drift failed: ${preview(check.stderr || check.stdout)}`);
    }
    return;
  }

  const parsed = check.parsed;
  const comparisons = Array.isArray(parsed.comparisons) ? parsed.comparisons : [];

  // BACKWARD COMPATIBILITY: an older mush-devops (mid-rollout, or after a rollback) emits no
  // `actionableDrift` field at all. Version skew must never silently suppress drift, so fall back
  // to exactly the previous behavior: any drift alerts.
  if (parsed.actionableDrift === undefined) {
    if (parsed.drifted === true) {
      findings.push(formatActionableDriftFinding(comparisons.filter((comparison) => comparison?.drifted)));
    } else if (Number(check.exitCode) !== 0) {
      findings.push(`Vast drift exited ${check.exitCode}: ${preview(check.stderr || check.stdout)}`);
    }
    return;
  }

  const benign = [];
  const unexpected = [];
  for (const comparison of comparisons) {
    if (isBenignRenumber(comparison)) {
      // A benign classification we cannot key or whose new port is missing cannot be deduped
      // safely. Fail loud rather than invent an identity.
      if (benignNoticeIdentity(comparison)) benign.push(comparison);
      else unexpected.push(comparison);
      continue;
    }
    if (isUnexpectedDrift(comparison)) unexpected.push(comparison);
  }

  // Actionable drift wins outright: it fires unconditionally and a benign renumber is never allowed
  // to pad or obscure it. `unexpected.length > 0` is a deliberate belt-and-braces second trigger, so
  // a producer that drifts a comparison without flagging `actionableDrift` still pages.
  if (parsed.actionableDrift === true || unexpected.length > 0) {
    const reportable = unexpected.length > 0 ? unexpected : comparisons.filter((comparison) => comparison?.drifted);
    findings.push(formatActionableDriftFinding(reportable));
    return;
  }

  // The ledger is maintained even when nothing is benign in this run: rebuilding it from the current
  // benign set is exactly what prunes an instance that was reconciled (or vanished), so its next
  // rebuild raises a fresh notice instead of being suppressed forever.
  try {
    collectBenignDriftNotices(benign, findings, options);
  } catch (error) {
    // Bookkeeping must never cost us the signal, and must never crash the health check.
    for (const comparison of benign.slice(0, MAX_REPORTED_DRIFT_COMPARISONS)) {
      findings.push(
        `${formatBenignDriftNotice(comparison)} (Drift-notice bookkeeping failed: ${errorText(error)}; ` +
          `this notice may repeat until that is fixed.)`,
      );
    }
  }

  // The nonzero-exit fallback is deliberately skipped when a benign renumber explains the run: the
  // exit code (0 under the current contract, 1 under a producer that still exits on any drift) says
  // nothing the notice above does not already say, and repeating it every run would reinstate the
  // exact noise this debounce exists to remove.
  if (benign.length > 0) return;

  if (Number(check.exitCode) !== 0) {
    findings.push(`Vast drift exited ${check.exitCode}: ${preview(check.stderr || check.stdout)}`);
  }
}

const MAX_REPORTED_DRIFT_COMPARISONS = 5;

function formatActionableDriftFinding(comparisons) {
  const diffs = (Array.isArray(comparisons) ? comparisons : [])
    .slice(0, MAX_REPORTED_DRIFT_COMPARISONS)
    .map(formatDriftComparison);
  return ["Vast drift detected.", ...diffs].filter(Boolean).join(" ");
}

function isBenignRenumber(comparison) {
  if (!comparison || typeof comparison !== "object") return false;
  if (comparison.drifted === false) return false;
  return comparison.driftClass === DRIFT_CLASS_BENIGN;
}

/**
 * Anything that drifted and is not a confirmed benign renumber is unexpected — including a drifted
 * comparison carrying no `driftClass` at all, which is a producer bug we must not swallow.
 */
function isUnexpectedDrift(comparison) {
  if (!comparison || typeof comparison !== "object") return false;
  if (comparison.driftClass === DRIFT_CLASS_BENIGN) return false;
  if (comparison.driftClass === DRIFT_CLASS_UNEXPECTED) return true;
  return comparison.drifted === true;
}

/**
 * Identity of one benign rebuild event: the instance, plus the newly observed SSH port. A new port
 * is a new rebuild and earns one notice; the same port is the same event we already reported.
 */
function benignNoticeIdentity(comparison) {
  const rawId = comparison?.vastInstanceId ?? comparison?.logicalId;
  const key = String(rawId ?? "").trim();
  const sshPort = positiveInt(comparison?.actual?.sshPort);
  if (!key || sshPort == null) return null;
  return { key, sshPort };
}

/**
 * Emit at most ONE finding per rebuild event and keep the ledger honest.
 *
 * The ledger is rebuilt from scratch out of this run's benign set, which prunes two cases at once:
 * an instance that stopped reporting benign drift (someone ran `--update`, so a future rebuild must
 * alert again) and an instance that disappeared from the comparison list entirely.
 *
 * Failure modes all degrade to "alert once, loudly": an unreadable or corrupt ledger is treated as
 * empty (so the notice fires), and a failed write is reported inline (so Tim knows the notice may
 * repeat) rather than silently dropping drift.
 */
function collectBenignDriftNotices(benign, findings, options = {}) {
  const statePath = options.driftNoticeStatePath || VAST_DRIFT_NOTICE_STATE_PATH;
  const readState = options.readDriftNoticeState || readDriftNoticeState;
  const writeState = options.writeDriftNoticeState || writeDriftNoticeState;
  const nowIso = new Date(typeof options.now === "function" ? options.now() : Date.now()).toISOString();

  let previous = emptyDriftNoticeState();
  let readError = null;
  try {
    const read = readState(statePath);
    previous = normalizeDriftNoticeState(read?.state);
    readError = read?.error || null;
  } catch (error) {
    readError = errorText(error);
  }

  const next = emptyDriftNoticeState();
  const fresh = [];
  for (const comparison of benign) {
    const identity = benignNoticeIdentity(comparison);
    if (!identity) continue;
    const known = previous.notices[identity.key];
    const alreadyReported = Boolean(known) && known.sshPort === identity.sshPort;
    next.notices[identity.key] = {
      sshPort: identity.sshPort,
      logicalId: comparison?.logicalId ? String(comparison.logicalId) : null,
      reportedAt: alreadyReported ? known.reportedAt || nowIso : nowIso,
      lastSeenAt: nowIso,
    };
    if (!alreadyReported) fresh.push(comparison);
  }

  const capped = capDriftNoticeState(next);
  let writeError = null;
  if (readError || !driftNoticeStateEquals(previous, capped)) {
    try {
      writeState(statePath, capped);
    } catch (error) {
      writeError = errorText(error);
    }
  }

  if (fresh.length === 0) return;

  const notes = [];
  if (readError) {
    notes.push(
      `The drift-notice state file ${statePath} could not be read (${readError}), so this notice was raised ` +
        `rather than risk swallowing the drift; it has been rewritten from scratch.`,
    );
  }
  if (writeError) {
    notes.push(
      `The drift-notice state file ${statePath} could not be written (${writeError}), so this notice will ` +
        `repeat on every check until that is fixed.`,
    );
  }

  fresh.slice(0, MAX_REPORTED_DRIFT_COMPARISONS).forEach((comparison, index) => {
    const suffix = index === 0 && notes.length > 0 ? ` ${notes.join(" ")}` : "";
    findings.push(`${formatBenignDriftNotice(comparison)}${suffix}`);
  });
}

/**
 * Low-urgency, actionable-by-choice wording. It has to carry three things: this is expected Vast
 * churn, what actually changed, and why leaving it unreconciled still matters (deploy-systemd.sh
 * reads stack.json, not live Vast data, so it would dial the stale port).
 */
function formatBenignDriftNotice(comparison) {
  const name = comparison?.logicalId ? String(comparison.logicalId) : "an unnamed instance";
  const instance =
    comparison?.vastInstanceId == null ? "" : ` (Vast instance ${comparison.vastInstanceId})`;
  const from = positiveInt(comparison?.expected?.sshPort);
  const to = positiveInt(comparison?.actual?.sshPort);
  const ports = from == null ? `a new SSH port ${to ?? "unknown"}` : `SSH port ${from} -> ${to ?? "unknown"}`;
  return (
    `Vast drift notice (low urgency, no action needed right now): ${name}${instance} came back from a Vast ` +
    `rebuild on ${ports}. Host, service port and direct SSH mode are all unchanged, so this is the expected ` +
    `Vast port churn rather than an incident. stack.json still records the old port, and deploy-systemd.sh ` +
    `reads stack.json instead of live Vast data, so a deploy would dial the stale port until it is reconciled: ` +
    `run "node scripts/vast/vast-drift.js --update" on the mush-devops box when convenient. Reported once per ` +
    `rebuild; later checks stay quiet until the port changes again.`
  );
}

// ---------------------------------------------------------------------------
// Benign drift notice ledger
//
// Schema (mirrors data/state/mush_devops_remediation.json's conventions):
//   { "version": 1,
//     "notices": {
//       "<vastInstanceId or logicalId>": {
//         "sshPort": 63530,            // the port this instance was last REPORTED on
//         "logicalId": "gpu-1",        // human label, informational only
//         "reportedAt": "<iso>",       // when the notice for this port fired
//         "lastSeenAt": "<iso>"        // last run that still saw this benign drift
//       } } }
//
// The dedupe key is effectively "<instance>:<sshPort>": an entry whose stored `sshPort` differs
// from the newly observed one is a NEW rebuild and gets a fresh notice.
// ---------------------------------------------------------------------------

export function emptyDriftNoticeState() {
  return { version: 1, notices: {} };
}

/** Coerce anything (including a corrupt file) into the documented shape. Never throws. */
export function normalizeDriftNoticeState(raw) {
  const state = emptyDriftNoticeState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return state;
  const notices = raw.notices;
  if (!notices || typeof notices !== "object" || Array.isArray(notices)) return state;

  for (const [key, entry] of Object.entries(notices)) {
    if (!key || !entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const sshPort = positiveInt(entry.sshPort);
    // An entry without a usable port can never suppress anything, so it is dropped rather than
    // kept as a half-record that might match "undefined === undefined" later.
    if (sshPort == null) continue;
    state.notices[key] = {
      sshPort,
      logicalId: typeof entry.logicalId === "string" ? entry.logicalId : null,
      reportedAt: typeof entry.reportedAt === "string" ? entry.reportedAt : null,
      lastSeenAt: typeof entry.lastSeenAt === "string" ? entry.lastSeenAt : null,
    };
  }
  return state;
}

/** Keep the most recently seen entries only, so the file cannot grow without bound. */
export function capDriftNoticeState(state, limit = MAX_DRIFT_NOTICE_ENTRIES) {
  const normalized = normalizeDriftNoticeState(state);
  const entries = Object.entries(normalized.notices);
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : MAX_DRIFT_NOTICE_ENTRIES;
  if (entries.length <= max) return normalized;

  entries.sort((a, b) => driftNoticeTimestamp(b[1]) - driftNoticeTimestamp(a[1]));
  const capped = emptyDriftNoticeState();
  for (const [key, entry] of entries.slice(0, max)) capped.notices[key] = entry;
  return capped;
}

function driftNoticeTimestamp(entry) {
  const parsed = Date.parse(entry?.lastSeenAt || entry?.reportedAt || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function driftNoticeStateEquals(left, right) {
  return (
    JSON.stringify(normalizeDriftNoticeState(left)) === JSON.stringify(normalizeDriftNoticeState(right))
  );
}

/**
 * Read the ledger. Returns `{state, error}`: a MISSING file is normal (no error), while a corrupt or
 * unreadable one degrades to empty state WITH an error, which makes the caller alert once and say so.
 * Synchronous on purpose — `collectFindings` is a synchronous pure-ish function and every caller and
 * test depends on that.
 */
export function readDriftNoticeState(filePath) {
  try {
    return { state: normalizeDriftNoticeState(JSON.parse(readFileSync(filePath, "utf8"))), error: null };
  } catch (error) {
    if (error && error.code === "ENOENT") return { state: emptyDriftNoticeState(), error: null };
    return { state: emptyDriftNoticeState(), error: errorText(error) };
  }
}

/** Atomic write (temp file + rename), matching `writeRemediationState`. Throws on failure. */
export function writeDriftNoticeState(filePath, state) {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(capDriftNoticeState(state), null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, filePath);
}

function positiveInt(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
}

/**
 * The Caddy config drift check emits one entry per load-balancer alias. Its raw stdout is a
 * verbose JSON document that leads with the healthy ("in-sync") aliases, so the generic
 * nonzero-exit fallback used to truncate the preview long before reaching the alias that
 * actually failed. Report the failing aliases by name instead.
 *
 * A missing check is legitimate here (the caddy checks are conditionally enabled remotely),
 * so absence never raises a finding.
 */
export function collectCaddyFindings(check, findings) {
  if (!check) return;
  if (isSkippedCheck(check)) return;

  if (!check.parsed || !Array.isArray(check.parsed.results)) {
    if (Number(check.exitCode) !== 0) {
      findings.push(`Caddy configuration state failed: ${preview(check.stderr || check.stdout)}`);
    }
    return;
  }

  let reported = 0;
  for (const result of check.parsed.results) {
    if (!result || result.status === "in-sync") continue;
    findings.push(formatCaddyFinding(result));
    reported += 1;
  }

  if (reported === 0 && Number(check.exitCode) !== 0) {
    findings.push(`Caddy configuration state failed: ${preview(check.stderr || check.stdout)}`);
  }
}

function formatCaddyFinding(result) {
  const target = formatCaddyAlias(result);

  if (result.status === "drift") {
    const diff = String(result.diff || "").trim();
    return `Caddy config drift on ${target}.${diff ? ` ${preview(diff)}` : ""}`;
  }

  const reason = result.reason ? `${result.reason} - ` : "";
  const error = String(result.error || "").trim() ? preview(result.error) : "no error detail";

  if (result.status === "indeterminate") {
    return `Caddy config state indeterminate for ${target}: ${reason}${error}`;
  }

  return `Caddy config state ${result.status || "unknown"} for ${target}: ${reason}${error}`;
}

function formatCaddyAlias(result) {
  const alias = result.alias || "unknown alias";
  return result.sshTarget ? `${alias} (${result.sshTarget})` : alias;
}

function formatHttpFinding(result) {
  const name = [result.componentName || result.componentId || "Unknown component", result.instance]
    .filter(Boolean)
    .join(" / ");
  const status = result.status || "unknown";
  const url = result.url ? ` at ${result.url}` : "";
  const httpStatus = result.httpStatus == null ? "" : ` HTTP ${result.httpStatus}.`;
  const time = result.responseTimeMs == null ? "" : ` ${result.responseTimeMs}ms.`;
  const error = result.error ? ` ${result.error}` : "";
  return `HTTP health ${status}: ${name}${url}.${httpStatus}${time}${error}`.replace(/\s+/g, " ").trim();
}

function formatDriftComparison(comparison) {
  const id = comparison.logicalId || comparison.vastInstanceId || "unknown instance";
  const diffs = Array.isArray(comparison.diffs) ? comparison.diffs.join("; ") : "drifted";
  return `${id}: ${diffs}`;
}

function formatMoney(value) {
  const parsed = parseFiniteNumber(value);
  return Number.isFinite(parsed) ? `$${parsed.toFixed(2)}` : "unknown";
}

function parseFiniteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
}

/**
 * Truncating BEFORE redacting used to let a secret that straddles the 500-character cutoff survive
 * as a partially intact prefix, so this delegates to the library helper, which redacts first and
 * only then truncates. Empty input still renders as "no details".
 */
function preview(value) {
  return previewRedacted(value || "", 500);
}

/**
 * SECURITY: the findings are the last unredacted path from remote output to Telegram —
 * `formatHttpFinding` interpolates `result.error`/`result.url` raw and `formatDriftComparison`
 * does the same for `comparison.diffs`, and the gateway body behind those errors embeds the live
 * gateway API key. The whole rendered block therefore goes through `redactSecrets()` once more.
 * Over-redaction is the desired failure mode: a mangled diagnostic beats a leaked key.
 *
 * The remediation section is NOT passed through here — `main()` concatenates it separately and
 * `formatRemediationReport` already redacts every line it emits.
 */
export function formatAlert({ checkedAt, host, remoteDir, findings }) {
  return redactSecrets(
    [
      "Mush DevOps health check alert",
      `Checked at: ${checkedAt || new Date().toISOString()}`,
      `Target: ${host}:${remoteDir}`,
      "",
      ...findings.map((finding) => `- ${finding}`),
    ].join("\n"),
  );
}

function printCommandFailure({ host, remoteDir, timeoutSec, run, reason }) {
  const status = run.timedOut
    ? `timed out after ${timeoutSec}s`
    : `exit ${run.exitCode ?? "unknown"}${run.signal ? `, signal ${run.signal}` : ""}`;
  const details = [
    `Mush DevOps health check command failed (${status}).`,
    `Target: ${host}:${remoteDir}`,
    `Reason: ${reason}`,
  ];
  if (run.stderr.trim()) details.push(`stderr: ${preview(run.stderr)}`);
  if (run.stdout.trim()) details.push(`stdout: ${preview(run.stdout)}`);
  console.error(details.join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Mush DevOps health check wrapper failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
