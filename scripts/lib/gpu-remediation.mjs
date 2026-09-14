/**
 * Automatic remediation for the Vast.ai GPU boxes whose `remote-inference` service dies after a
 * container restart, which surfaces in the Mush DevOps health check as an unhealthy
 * `gpu-gateway/<backend>` entry on the Remote Inference HTTP check.
 *
 * Everything in this module is pure except for the small state-file helpers and
 * `runGpuRemediation`, which takes its command runner (`exec`) and clock as injected
 * dependencies so it can be unit tested without touching production hosts.
 *
 * SECURITY: the gateway's /admin/backends response embeds the live gateway API key, and this
 * script's stdout is delivered verbatim to Telegram. Every captured remote output MUST be passed
 * through `redactSecrets()` before it can reach alert text or a log line.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const BACKEND_UNHEALTHY_PREFIX = "Enabled backend(s) unhealthy:";
export const DEFAULT_COOLDOWN_MINUTES = 45;
export const DEFAULT_REMEDIATION_TIMEOUT_SEC = 180;
/**
 * CORRELATED-FAILURE GUARD (the live cap).
 *
 * At most ONE backend may be auto-remediated per run, and when more than one GPU backend is
 * unhealthy in the same run nothing is remediated at all (see `OUTCOMES.skippedCorrelated`).
 *
 * Rationale: there are only two GPU boxes, so "2 unhealthy" means "all of them unhealthy", which
 * is far more likely to be an upstream cause (gateway down, network, Vast-side outage) than two
 * independent per-box crashes in the same minute. Restarting even one box on a correlated failure
 * is action without evidence, and restarting both would take 100% of inference capacity down.
 * Alerting only is strictly recoverable: Tim can still restart by hand in a minute.
 */
export const MAX_REMEDIATION_TARGETS_PER_RUN = 1;
/** Circuit breaker: stop auto-remediating a backend after this many consecutive failed attempts. */
export const MAX_CONSECUTIVE_FAILURES = 3;
export const REDACTED = "[redacted]";

export const OUTCOMES = Object.freeze({
  selfRecovered: "self-recovered",
  succeeded: "succeeded",
  partial: "partial",
  failed: "failed",
  inProgress: "in-progress",
  skippedCooldown: "skipped-cooldown",
  skippedDisabled: "skipped-disabled",
  skippedCircuitOpen: "skipped-circuit-open",
  skippedCorrelated: "skipped-correlated-failure",
  skippedMismatch: "skipped-target-mismatch",
  dryRun: "dry-run",
  error: "error",
});

/**
 * Outcomes that did not mutate anything, so they must not start a cooldown window and must not
 * count against the circuit breaker.
 *
 * `in-progress` is deliberately NOT in this set: it is the marker written just BEFORE a restart,
 * so it must hold the cooldown door shut if the process dies mid-restart.
 */
const NON_COOLDOWN_OUTCOMES = new Set([
  OUTCOMES.selfRecovered,
  OUTCOMES.skippedCooldown,
  OUTCOMES.skippedDisabled,
  OUTCOMES.skippedCircuitOpen,
  OUTCOMES.skippedCorrelated,
  OUTCOMES.skippedMismatch,
  OUTCOMES.dryRun,
]);

/** Outcomes that prove the backend is healthy again, so the failure streak resets. */
const FAILURE_STREAK_RESET_OUTCOMES = new Set([OUTCOMES.succeeded, OUTCOMES.selfRecovered]);

/** Verbatim contents of /root/start-remote-inference.sh as it exists on a healthy GPU box. */
export const START_SCRIPT_CONTENT = `#!/bin/bash
set -euo pipefail
cd /root/pkg/remote-inference
source "$HOME/.local/bin/env"
source .venv/bin/activate
exec remote-inference
`;

export const REMOTE_INFERENCE_DIR = "/root/pkg/remote-inference";
export const START_SCRIPT_PATH = "/root/start-remote-inference.sh";
export const SERVICE_LOG_PATH = `${REMOTE_INFERENCE_DIR}/logs/service.log`;
export const TMUX_SESSION = "remote-inference";
export const LOCAL_HEALTH_URL = "http://127.0.0.1:8000/health";
export const GATEWAY_BACKENDS_URL = "http://127.0.0.1:3081/admin/backends";

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const SECRET_JSON_KEY = /("(?:[A-Za-z0-9_-]*(?:api[_-]?key|apikey|secret|token|password))"\s*:\s*")((?:[^"\\]|\\.)*)(")/gi;
const SECRET_ENV_LINE = /\b([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD))\s*=\s*("[^"\n]*"|'[^'\n]*'|\S+)/g;
const UUID_TOKEN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LONG_HEX_TOKEN = /\b[0-9a-f]{32,}\b/gi;

/**
 * Strip anything that looks like a credential out of captured remote output.
 * Deliberately over-redacts: a mangled diagnostic is always better than a leaked key.
 */
export function redactSecrets(value) {
  if (value == null) return "";
  let text = String(value);
  text = text.replace(SECRET_JSON_KEY, (_match, prefix, _secret, suffix) => `${prefix}${REDACTED}${suffix}`);
  text = text.replace(SECRET_ENV_LINE, (_match, key) => `${key}=${REDACTED}`);
  text = text.replace(UUID_TOKEN, REDACTED);
  text = text.replace(LONG_HEX_TOKEN, REDACTED);
  return text;
}

/** Collapse whitespace and truncate, mirroring the alert script's `preview` helper. */
export function previewRedacted(value, limit = 500) {
  const normalized = redactSecrets(value).replace(/\s+/g, " ").trim();
  if (!normalized) return "no details";
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

/** Keep the last `count` lines of a captured log, redacted. */
export function redactedTail(value, count = 20) {
  const lines = redactSecrets(value).split(/\r?\n/).filter((line) => line.trim() !== "");
  return lines.slice(-count);
}

// ---------------------------------------------------------------------------
// Shell quoting
// ---------------------------------------------------------------------------

/** POSIX single-quote a value for one shell layer. */
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/**
 * Quote a value that has to survive TWO shell parses without any enclosing quoting of its own,
 * which is what happens when a value is appended to an `ssh host ...` argument list: the local
 * shell strips one layer, ssh re-joins its arguments, and the remote shell strips the second.
 *
 * `buildTwoHopSshArgs` below deliberately does NOT need this, because spawn hands the outer
 * argument to the jump host's shell verbatim (no local shell), so the command is quoted exactly
 * once per hop. Keep both helpers: getting this wrong is the highest-risk part of the two-hop.
 */
export function shellQuoteNested(value) {
  return shellQuote(shellQuote(value));
}

/** `ssh <jumpHost> <command>` argv for the spawn-based runner (no local shell involved). */
export function buildJumpSshArgs({ jumpHost, command, connectTimeoutSec = 20 }) {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${Math.max(1, Math.round(connectTimeoutSec))}`,
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    String(jumpHost),
    String(command),
  ];
}

/**
 * Build the nested two-hop ssh invocation. ProxyJump does not work from this machine (publickey),
 * so the jump host runs its own `ssh` for the second hop. `remoteCommand` is quoted exactly once
 * here because spawn hands the outer argument to the jump host's shell verbatim.
 */
export function buildTwoHopSshArgs({
  jumpHost,
  target,
  sshPort = null,
  remoteCommand,
  connectTimeoutSec = 20,
  innerConnectTimeoutSec = 10,
}) {
  const portFlag = sshPort == null || sshPort === "" ? "" : `-p ${shellQuote(String(sshPort))} `;
  const innerCommand =
    `ssh -o BatchMode=yes -o ConnectTimeout=${Math.max(1, Math.round(innerConnectTimeoutSec))} ` +
    `-o StrictHostKeyChecking=accept-new ${portFlag}${shellQuote(String(target))} ${shellQuote(remoteCommand)}`;
  return buildJumpSshArgs({ jumpHost, command: innerCommand, connectTimeoutSec });
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const BACKEND_TUPLE = /([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\s*\(([^\s:()]+):(\d+)\)/g;
const SSH_TARGET = /ssh:\/\/(\S+)/;

function isGpuComponent(result) {
  if (!result) return false;
  if (result.componentId === "remote-inference") return true;
  return /gpu/i.test(String(result.componentName || ""));
}

function isGpuBackend(gatewayService, backendId) {
  return /^gpu-/i.test(String(gatewayService || "")) || /^gpu-/i.test(String(backendId || ""));
}

/** Pull the gateway SSH target out of an http result URL, e.g. "ssh://root@1.2.3.4 http://...". */
export function parseGatewaySshTarget(url, override = null) {
  const trimmedOverride = String(override || "").trim();
  if (trimmedOverride) return trimmedOverride;
  const match = SSH_TARGET.exec(String(url || ""));
  if (!match) return null;
  const target = match[1].replace(/[.,;]+$/, "").trim();
  return target || null;
}

/**
 * Find every GPU backend named by an "Enabled backend(s) unhealthy:" http finding.
 * Returns one entry per distinct backend id; non-GPU backends in the same finding are ignored.
 */
export function detectGpuRemediationTargets(check, options = {}) {
  const results = check?.parsed?.results;
  if (!Array.isArray(results)) return [];

  const targets = [];
  const seen = new Set();

  for (const result of results) {
    if (!result || typeof result !== "object") continue;
    if (result.status === "healthy" || result.status === "skipped") continue;

    const error = typeof result.error === "string" ? result.error : "";
    const index = error.indexOf(BACKEND_UNHEALTHY_PREFIX);
    if (index < 0) continue;

    const tail = error.slice(index + BACKEND_UNHEALTHY_PREFIX.length);
    const componentIsGpu = isGpuComponent(result);
    const gatewaySshTarget = parseGatewaySshTarget(result.url, options.gatewaySshOverride);

    BACKEND_TUPLE.lastIndex = 0;
    let match = BACKEND_TUPLE.exec(tail);
    while (match) {
      const [, gatewayService, backendId, address, port] = match;
      match = BACKEND_TUPLE.exec(tail);

      if (!isGpuBackend(gatewayService, backendId) && !componentIsGpu) continue;
      if (seen.has(backendId)) continue;
      seen.add(backendId);

      targets.push({
        componentId: result.componentId || null,
        componentName: result.componentName || null,
        gatewayService,
        backendId,
        address,
        port: Number(port),
        gatewaySshTarget,
      });
    }
  }

  return targets;
}

/**
 * Did this run actually OBSERVE the state of the GPU backends?
 *
 * The circuit-breaker auto-reset in `clearRecoveredBackends` infers "this backend recovered" from
 * "this backend was not named in this run's unhealthy list". That inference is only sound when the
 * gateway actually answered: a backend absent from an enumeration we received is positively
 * healthy, but an enumeration we never received tells us nothing at all.
 *
 * True only when a parsed http result array contains a GPU-component result that is either
 *   (a) `healthy` — the gateway answered and every enabled backend behind it is healthy; or
 *   (b) failing WITH a `BACKEND_UNHEALTHY_PREFIX` enumeration — the gateway answered and named
 *       exactly which backends are unhealthy, so every other backend is positively healthy.
 *
 * False for everything else: no parsed results array, no GPU-component result at all, a `skipped`
 * GPU result, or a GPU result that failed for a reason that is not an enumeration (ECONNREFUSED,
 * timeout, DNS failure, non-JSON body). Those all mean "we could not see the backends".
 */
export function gpuBackendEnumerationIsTrustworthy(check) {
  const results = check?.parsed?.results;
  if (!Array.isArray(results)) return false;

  for (const result of results) {
    if (!result || typeof result !== "object") continue;
    if (!isGpuComponent(result)) continue;
    if (result.status === "skipped") continue;
    if (result.status === "healthy") return true;
    const error = typeof result.error === "string" ? result.error : "";
    if (error.includes(BACKEND_UNHEALTHY_PREFIX)) return true;
  }

  return false;
}

/** Human label used in alert text, e.g. "gpu-gateway/gpu-1 (182.224.239.168:63571)". */
export function describeTarget(target) {
  const service = target?.gatewayService ? `${target.gatewayService}/` : "";
  const id = target?.backendId || "unknown-backend";
  const address = target?.address ? ` (${target.address}:${target.port ?? "?"})` : "";
  return `${service}${id}${address}`;
}

// ---------------------------------------------------------------------------
// Vast endpoint resolution
// ---------------------------------------------------------------------------

function firstNonEmptyString(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return null;
}

function firstPositiveInt(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed);
  }
  return null;
}

/**
 * Resolve the live SSH endpoint for a logical backend from `vast-drift.js --json` output.
 * Prefers the live Vast API values (`actual`), falling back to stack.json (`expected`).
 * Never invents a port: an unresolvable backend is a remediation failure, not a guess.
 */
export function resolveBackendEndpoint(driftPayload, backendId) {
  const comparisons = Array.isArray(driftPayload?.comparisons) ? driftPayload.comparisons : null;
  if (!comparisons) {
    return { ok: false, error: "vast-drift output did not contain a comparisons array" };
  }

  const match = comparisons.find(
    (comparison) => comparison && String(comparison.logicalId) === String(backendId),
  );
  if (!match) {
    return { ok: false, error: `vast-drift output has no instance matching ${backendId}` };
  }

  const actual = match.actual && typeof match.actual === "object" ? match.actual : null;
  const expected = match.expected && typeof match.expected === "object" ? match.expected : null;
  const host = firstNonEmptyString(actual?.host, expected?.host);
  const sshPort = firstPositiveInt(actual?.sshPort, expected?.sshPort);
  // The authoritative service port, used to cross-check the IP:port parsed out of alert text.
  const actualServicePort = firstPositiveInt(actual?.servicePort);
  const expectedServicePort = firstPositiveInt(expected?.servicePort);
  const servicePort = actualServicePort ?? expectedServicePort;

  if (!host) return { ok: false, error: `vast-drift output has no host for ${backendId}` };
  if (!sshPort) return { ok: false, error: `vast-drift output has no sshPort for ${backendId}` };

  return {
    ok: true,
    host,
    sshPort,
    servicePort,
    servicePortSource: servicePort == null ? null : actualServicePort != null ? "vast-api" : "stack.json",
    source: actual?.host && actual?.sshPort ? "vast-api" : "stack.json",
    vastInstanceId: match.vastInstanceId ?? actual?.vastInstanceId ?? null,
    instanceStatus: actual?.status ?? null,
  };
}

// ---------------------------------------------------------------------------
// Gateway backend health
// ---------------------------------------------------------------------------

/** Parse one backend entry out of the gateway's /admin/backends payload. */
export function parseBackendHealth(jsonText, backendId) {
  let parsed;
  try {
    parsed = JSON.parse(String(jsonText ?? ""));
  } catch {
    return { ok: false, error: "gateway /admin/backends response was not valid JSON" };
  }

  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.backends)
      ? parsed.backends
      : null;
  if (!list) {
    return { ok: false, error: "gateway /admin/backends response did not contain a backend list" };
  }

  const entry = list.find((item) => item && String(item.id) === String(backendId));
  if (!entry) {
    return { ok: false, error: `gateway /admin/backends response did not include backend ${backendId}` };
  }

  const status = entry.health?.status ?? entry.status ?? null;
  return {
    ok: true,
    healthy: status === "healthy",
    status: status ? String(status) : "unknown",
    enabled: entry.enabled !== false,
    consecutiveSuccesses: Number(entry.health?.consecutiveSuccesses ?? 0) || 0,
    consecutiveFailures: Number(entry.health?.consecutiveFailures ?? 0) || 0,
  };
}

// ---------------------------------------------------------------------------
// Cooldown state
// ---------------------------------------------------------------------------

export function emptyRemediationState() {
  return { version: 1, backends: {} };
}

/** Coerce anything (including corrupt state files) into the documented shape. Never throws. */
export function normalizeRemediationState(raw) {
  const state = emptyRemediationState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return state;
  const backends = raw.backends;
  if (!backends || typeof backends !== "object" || Array.isArray(backends)) return state;

  for (const [backendId, entry] of Object.entries(backends)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const attempts = Number(entry.attempts);
    const consecutiveFailures = Number(entry.consecutiveFailures);
    state.backends[backendId] = {
      lastAttemptAt: typeof entry.lastAttemptAt === "string" ? entry.lastAttemptAt : null,
      lastOutcome: typeof entry.lastOutcome === "string" ? entry.lastOutcome : null,
      attempts: Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 0,
      consecutiveFailures:
        Number.isFinite(consecutiveFailures) && consecutiveFailures > 0 ? Math.floor(consecutiveFailures) : 0,
    };
  }
  return state;
}

/**
 * Cooldown gate + circuit breaker. Only outcomes that actually mutated the box hold the cooldown
 * door shut; a `self-recovered` observation never blocks a later real restart. Once a backend has
 * failed `MAX_CONSECUTIVE_FAILURES` times in a row the breaker opens and stays open until the
 * backend recovers on its own (or an operator clears the state file).
 */
export function shouldAttemptRemediation(state, backendId, nowMs, cooldownMs) {
  const entry = normalizeRemediationState(state).backends[backendId];
  const base = {
    allowed: true,
    reason: null,
    lastAttemptAt: null,
    lastOutcome: null,
    consecutiveFailures: 0,
    remainingMs: 0,
    retryAfter: null,
  };
  if (!entry) return base;

  const info = {
    ...base,
    lastAttemptAt: entry.lastAttemptAt,
    lastOutcome: entry.lastOutcome,
    consecutiveFailures: entry.consecutiveFailures,
    attempts: entry.attempts,
  };

  if (entry.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    return { ...info, allowed: false, reason: "circuit-open" };
  }
  if (!entry.lastAttemptAt) return info;

  const lastAttemptMs = Date.parse(entry.lastAttemptAt);
  if (!Number.isFinite(lastAttemptMs)) return info;
  if (entry.lastOutcome && NON_COOLDOWN_OUTCOMES.has(entry.lastOutcome)) return info;

  const elapsed = Number(nowMs) - lastAttemptMs;
  const cooldown = Number(cooldownMs);
  if (!Number.isFinite(elapsed) || !Number.isFinite(cooldown) || cooldown <= 0) return info;
  if (elapsed >= cooldown) return info;

  const remainingMs = cooldown - elapsed;
  return {
    ...info,
    allowed: false,
    reason: "cooldown",
    remainingMs,
    retryAfter: new Date(lastAttemptMs + cooldown).toISOString(),
  };
}

/**
 * Preliminary state transition written BEFORE the box is touched: it starts the cooldown window
 * and charges the attempt against the circuit breaker, so a crash mid-restart cannot produce a
 * rapid repeat restart on the next run. Pure: returns a new state object.
 */
export function beginRemediationAttempt(state, backendId, nowIso) {
  const next = normalizeRemediationState(state);
  const previous = next.backends[backendId];
  next.backends[backendId] = {
    lastAttemptAt: String(nowIso),
    lastOutcome: OUTCOMES.inProgress,
    attempts: (previous?.attempts ?? 0) + 1,
    consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
  };
  return next;
}

/**
 * Final state transition written after the attempt resolved. Never double-increments `attempts`
 * (that already happened in `beginRemediationAttempt`); resets the failure streak when the
 * backend is healthy again, and rolls the streak increment back for outcomes that changed
 * nothing at all (skipped-*, dry-run).
 *
 * Pure: returns a new state object.
 */
export function finalizeRemediationAttempt(state, backendId, outcome, nowIso) {
  const next = normalizeRemediationState(state);
  const previous = next.backends[backendId];
  const outcomeText = String(outcome);
  const previousFailures = previous?.consecutiveFailures ?? 0;

  let consecutiveFailures = previousFailures;
  if (FAILURE_STREAK_RESET_OUTCOMES.has(outcomeText)) {
    consecutiveFailures = 0;
  } else if (NON_COOLDOWN_OUTCOMES.has(outcomeText)) {
    // Nothing was changed on the box, so the in-progress marker's increment is rolled back.
    consecutiveFailures = Math.max(0, previousFailures - 1);
  }

  next.backends[backendId] = {
    lastAttemptAt: String(nowIso),
    lastOutcome: outcomeText,
    attempts: previous?.attempts ?? 0,
    consecutiveFailures,
  };
  return next;
}

/**
 * Pure state transition: returns a new state object, never mutates the input.
 * Equivalent to a begin+finalize pair, kept for callers that record an attempt in one shot.
 */
export function recordRemediationAttempt(state, backendId, outcome, nowIso) {
  return finalizeRemediationAttempt(
    beginRemediationAttempt(state, backendId, nowIso),
    backendId,
    outcome,
    nowIso,
  );
}

/**
 * Auto-recovery reset for the circuit breaker: any backend carrying a failure streak that is NOT
 * in this run's unhealthy set has recovered on its own, so its streak is cleared. Without this the
 * breaker would stay open forever after three bad days.
 *
 * PRECONDITION: `unhealthyBackendIds` must come from an enumeration this run actually received
 * (see `gpuBackendEnumerationIsTrustworthy`). An empty list because the gateway was unreachable is
 * NOT evidence of health, and passing it here would silently re-arm every open breaker.
 *
 * Pure: returns `{state, cleared, changed}` and never mutates the input.
 */
export function clearRecoveredBackends(state, unhealthyBackendIds) {
  const next = normalizeRemediationState(state);
  const unhealthy = new Set(
    (Array.isArray(unhealthyBackendIds) ? unhealthyBackendIds : []).filter(Boolean).map(String),
  );
  const cleared = [];

  for (const [backendId, entry] of Object.entries(next.backends)) {
    if (unhealthy.has(backendId)) continue;
    if (!entry || entry.consecutiveFailures <= 0) continue;
    next.backends[backendId] = { ...entry, consecutiveFailures: 0 };
    cleared.push(backendId);
  }

  return { state: next, cleared, changed: cleared.length > 0 };
}

/** Read state from disk, degrading to empty state on any error. */
export async function readRemediationState(filePath) {
  try {
    return normalizeRemediationState(JSON.parse(await readFile(filePath, "utf8")));
  } catch {
    return emptyRemediationState();
  }
}

/** Atomic write (temp file + rename). */
export async function writeRemediationState(filePath, state) {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o755 });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, `${JSON.stringify(normalizeRemediationState(state), null, 2)}\n`, { mode: 0o644 });
  await rename(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Remote command construction
// ---------------------------------------------------------------------------

export function buildLocalHealthProbeCommand() {
  return `curl -s -m 5 -o /dev/null -w ${shellQuote("%{http_code}")} ${shellQuote(LOCAL_HEALTH_URL)} || true`;
}

export function buildLocalHealthPollCommand({ attempts = 9, intervalSec = 5 } = {}) {
  return [
    `for i in $(seq 1 ${Math.max(1, Math.round(attempts))}); do`,
    `code=$(curl -s -m 5 -o /dev/null -w ${shellQuote("%{http_code}")} ${shellQuote(LOCAL_HEALTH_URL)} || true);`,
    `if [ "$code" = "200" ]; then echo "RI-HEALTH:200"; exit 0; fi;`,
    `sleep ${Math.max(1, Math.round(intervalSec))};`,
    `done;`,
    `echo "RI-HEALTH:$code"; exit 1`,
  ].join(" ");
}

export function buildLogTailCommand(lines = 20) {
  return `tail -n ${Math.max(1, Math.round(lines))} ${shellQuote(SERVICE_LOG_PATH)} 2>/dev/null || true`;
}

export function buildGatewayBackendsCommand() {
  return `curl -s -m 5 ${shellQuote(GATEWAY_BACKENDS_URL)}`;
}

export function buildVastDriftCommand(remoteDir) {
  return [
    `cd ${shellQuote(remoteDir)}`,
    "set -a",
    "{ [ ! -f .env ] || . ./.env; }",
    "set +a",
    "node scripts/vast/vast-drift.js --json",
  ].join(" && ");
}

/**
 * Idempotent restart script executed on the GPU box.
 *
 * Deliberate constraints:
 *  - the start script is only written when missing;
 *  - the venv is NEVER recreated (a prior job wasted a multi-GB torch reinstall that way);
 *  - dependencies are installed only when the venv was just created or the entry point is absent;
 *  - the API key is checked for presence only, never printed, and never invented;
 *  - a stuck tmux session is killed before starting exactly one replacement.
 */
export function buildRemediationScript() {
  return `set -u
DIR=${shellQuote(REMOTE_INFERENCE_DIR)}
START=${shellQuote(START_SCRIPT_PATH)}
say() { echo "RI:$1"; }
fail() { echo "RI-FAIL:$1"; exit 1; }

if [ -f "$START" ]; then
  say "start-script:present"
else
  cat > "$START" <<'RI_START_EOF'
${START_SCRIPT_CONTENT.trimEnd()}
RI_START_EOF
  chmod +x "$START" || fail "start-script:chmod"
  say "start-script:created"
fi

cd "$DIR" || fail "repo-dir:missing"

if [ -f .env ] && grep -q '^API_KEY=.\\+' .env; then
  say "api-key:present"
else
  fail "api-key:missing"
fi

export PATH="$HOME/.local/bin:$PATH"
created_venv=0
if [ -d .venv ]; then
  say "venv:present"
else
  uv venv > /tmp/ri-remediation-venv.log 2>&1 || { tail -n 20 /tmp/ri-remediation-venv.log; fail "venv:create"; }
  created_venv=1
  say "venv:created"
fi

if [ "$created_venv" = "1" ] || [ ! -x .venv/bin/remote-inference ]; then
  uv pip install -e . > /tmp/ri-remediation-install.log 2>&1 || { tail -n 20 /tmp/ri-remediation-install.log; fail "deps:install"; }
  say "deps:installed"
else
  say "deps:present"
fi

mkdir -p logs || fail "logs-dir:create"

if tmux has-session -t ${shellQuote(TMUX_SESSION)} 2>/dev/null; then
  tmux kill-session -t ${shellQuote(TMUX_SESSION)} || fail "tmux:kill-stuck-session"
  say "tmux:killed-stuck-session"
fi

tmux new-session -d -s ${shellQuote(TMUX_SESSION)} ${shellQuote(`bash ${START_SCRIPT_PATH} >> ${SERVICE_LOG_PATH} 2>&1`)} || fail "tmux:start"
say "tmux:started"
say "done"`;
}

/** Parse the RI:/RI-FAIL: markers emitted by the remediation script. */
export function parseRemediationScriptOutput(stdout) {
  const steps = [];
  let failedStep = null;
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("RI:")) steps.push(trimmed.slice(3));
    else if (trimmed.startsWith("RI-FAIL:")) failedStep = trimmed.slice(8);
  }
  return { steps, failedStep, completed: steps.includes("done") && !failedStep };
}

const STEP_EXPLANATIONS = {
  "api-key:missing": `${REMOTE_INFERENCE_DIR}/.env has no non-empty API_KEY; run set-api-key.sh on the box (no key was invented)`,
  "repo-dir:missing": `${REMOTE_INFERENCE_DIR} is missing on the box`,
  "venv:create": "uv venv failed",
  "deps:install": "uv pip install -e . failed",
  "tmux:kill-stuck-session": "could not kill the stuck tmux session",
  "tmux:start": "could not start the remote-inference tmux session",
  "start-script:chmod": "could not chmod /root/start-remote-inference.sh",
  "logs-dir:create": "could not create the logs directory",
};

export function explainFailedStep(step) {
  if (!step) return null;
  return STEP_EXPLANATIONS[step] || `remediation step ${step} failed`;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clampTimeout(deadlineMs, now, preferredMs) {
  const remaining = deadlineMs - now();
  if (remaining <= 0) return 0;
  return Math.max(1000, Math.min(preferredMs, remaining));
}

function failure(target, message, extra = {}) {
  return { target, outcome: OUTCOMES.failed, message, ...extra };
}

/**
 * Connection-level ssh failures that justify ONE fresh re-resolution + retry.
 *
 * These are all "the TCP connection never got established" errors, which is exactly what a Vast
 * container restart looks like from the outside: the DNAT rule for the mapped SSH port disappears
 * from the shared machine IP while the container is down, and reappears (often on a NEW port) once
 * it comes back. Treating that single shot as terminal is what burned a circuit-breaker failure and
 * a 45-minute cooldown on 2026-09-13.
 *
 * Authentication failures are deliberately NOT in this set: "Permission denied" / "Host key
 * verification failed" mean we reached the box and it rejected us, which retrying cannot fix.
 */
const TRANSIENT_SSH_PATTERNS = [
  /no route to host/i,
  /connection refused/i,
  /connection timed out/i,
  /network is unreachable/i,
  /host is down/i,
  /connection closed by remote host/i,
  /kex_exchange_identification/i,
  /operation timed out/i,
  /port \d+: .*unreachable/i,
];

const TERMINAL_SSH_PATTERNS = [/permission denied/i, /host key verification failed/i];

/**
 * Minimum remaining budget (ms) below which the fresh re-resolution + retry is NOT attempted.
 *
 * Arithmetic against the default `timeoutSec = 180` window: the retry costs a second vast-drift
 * query (clamped to 60s, normally a few seconds) plus a second health probe (clamped to 30s), and
 * only then does the remediation proper start -- a restart script clamped to 120s followed by a
 * local health poll of `healthPollAttempts * healthPollIntervalSec + 20` = 65s at the defaults.
 * Because `clampTimeout` shrinks every later step to whatever is left, the previous 5s threshold
 * authorized a retry that could leave the restart script ~6s before ssh got SIGTERMed mid-script --
 * strictly worse than not retrying, since a half-run restart leaves tmux/venv state behind.
 * 90s is the floor at which a retry can still plausibly COMPLETE a remediation rather than merely
 * start one: a few seconds of drift query and probe still leave ~80s, which covers the restart
 * script's normal path (tmux start is seconds, not minutes) plus a truncated but real health poll.
 * Below that we decline the retry and report the original ssh error instead.
 */
const MIN_RERESOLVE_BUDGET_MS = 90_000;

/**
 * True when `run` (an exec result) failed at the connection level rather than at the application
 * or authentication level. Exported so the classification is directly unit-testable.
 */
export function isTransientSshFailure(run) {
  if (!run || typeof run !== "object") return false;
  if (run.timedOut) return true;
  if (run.exitCode === 0) return false;

  // An HTTP code in stdout means the remote command actually ran, so the ssh hop succeeded.
  // It has to look like an actual 3-digit code: any other stdout proves nothing about the hop.
  const httpCode = String(run.stdout ?? "").trim().slice(-3);
  if (/^\d{3}$/.test(httpCode)) return false;

  const text = `${String(run.stderr ?? "")}\n${String(run.stdout ?? "")}`;
  if (TERMINAL_SSH_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return TRANSIENT_SSH_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Run `vast-drift.js --json` on the devops box and parse it. Never throws: returns
 * `{payload, error}` where exactly one side is populated.
 */
async function fetchDriftPayload({ exec, jumpHost, remoteDir, deadlineMs, now }) {
  let payload = null;
  let error = null;
  try {
    const driftRun = await exec(
      "ssh",
      buildJumpSshArgs({ jumpHost, command: buildVastDriftCommand(remoteDir) }),
      clampTimeout(deadlineMs, now, 60000),
    );
    try {
      payload = JSON.parse(driftRun.stdout.slice(driftRun.stdout.indexOf("{")));
    } catch {
      error = `vast-drift output was not valid JSON: ${previewRedacted(driftRun.stderr || driftRun.stdout, 200)}`;
    }
  } catch (caught) {
    error = `vast-drift lookup failed: ${previewRedacted(caught instanceof Error ? caught.message : String(caught), 200)}`;
  }
  return { payload, error };
}

/**
 * Remediate each target in turn. `exec(command, args, timeoutMs)` must resolve to
 * `{exitCode, signal, stdout, stderr, timedOut}` (the alert script's `runCommand`).
 *
 * This function never throws: any unexpected error becomes an `error` outcome so the plain
 * health alert still gets delivered.
 */
export async function runGpuRemediation({
  targets,
  exec,
  jumpHost,
  remoteDir,
  dryRun = false,
  timeoutSec = DEFAULT_REMEDIATION_TIMEOUT_SEC,
  now = () => Date.now(),
  sleep = defaultSleep,
  healthPollAttempts = 9,
  healthPollIntervalSec = 5,
  gatewayPollAttempts = 4,
  gatewayPollIntervalMs = 8000,
} = {}) {
  const results = [];
  const pending = Array.isArray(targets) ? targets.filter(Boolean) : [];
  if (pending.length === 0) return results;

  const deadlineMs = now() + Math.max(10, timeoutSec) * 1000;

  const driftContext = { exec, jumpHost, remoteDir, deadlineMs, now };
  const { payload: driftPayload, error: driftError } = await fetchDriftPayload(driftContext);
  /**
   * A genuinely fresh, live vast-drift query, used at most once per target after a connection-level
   * ssh failure. The snapshot taken above can be minutes stale by the time a probe fails, and a
   * Vast container restart -- the very event this feature exists to handle -- moves the SSH port.
   */
  const reresolveDrift = () => fetchDriftPayload(driftContext);

  for (const target of pending) {
    try {
      results.push(
        await remediateOne({
          target,
          exec,
          jumpHost,
          dryRun,
          driftPayload,
          driftError,
          reresolveDrift,
          deadlineMs,
          now,
          sleep,
          healthPollAttempts,
          healthPollIntervalSec,
          gatewayPollAttempts,
          gatewayPollIntervalMs,
        }),
      );
    } catch (error) {
      results.push({
        target,
        outcome: OUTCOMES.error,
        message: `auto-remediation crashed: ${previewRedacted(error instanceof Error ? error.message : String(error), 200)}`,
      });
    }
  }

  return results;
}

async function remediateOne({
  target,
  exec,
  jumpHost,
  dryRun,
  driftPayload,
  driftError,
  reresolveDrift = null,
  deadlineMs,
  now,
  sleep,
  healthPollAttempts,
  healthPollIntervalSec,
  gatewayPollAttempts,
  gatewayPollIntervalMs,
}) {
  const plan = [];

  if (driftError) return failure(target, driftError);
  // Rebindable: a connection-level ssh failure below triggers ONE fresh re-resolution, and a Vast
  // container restart can legitimately move the host/sshPort of the very same instance.
  let endpoint = resolveBackendEndpoint(driftPayload, target.backendId);
  if (!endpoint.ok) return failure(target, `could not resolve the live SSH endpoint: ${endpoint.error}`);

  let boxLabel = `${endpoint.host}:${endpoint.sshPort}`;
  plan.push(`resolved ${target.backendId} to root@${boxLabel} via vast-drift (${endpoint.source})`);

  // Sanity check BEFORE any ssh: the IP:port in `target` came out of free-form alert text, while
  // `endpoint.servicePort` comes from the authoritative stack config / live Vast API. If they
  // disagree we may be about to restart the wrong box, so stop and hand it to a human.
  const targetPort = firstPositiveInt(target?.port);
  if (targetPort != null && endpoint.servicePort != null && targetPort !== endpoint.servicePort) {
    return {
      target,
      outcome: OUTCOMES.skippedMismatch,
      message:
        `target mismatch for ${target.backendId}: the alert text names port ${targetPort} but the authoritative ` +
        `config (${endpoint.servicePortSource}) says the service port is ${endpoint.servicePort}. That is a red flag ` +
        `that the target resolved from the alert may not be the box the config expects, so nothing was restarted. ` +
        `Check stack.json / vast-drift against the gateway backend list by hand.`,
      plan,
    };
  }
  if (endpoint.servicePort == null) {
    plan.push(
      `servicePort for ${target.backendId} could not be verified (vast-drift output carries no servicePort); ` +
        `proceeding without the alert-text cross-check`,
    );
  } else {
    plan.push(`servicePort ${endpoint.servicePort} (${endpoint.servicePortSource}) matches the alert target port`);
  }

  const makeRunOnBox = (resolved) => (remoteCommand, preferredMs) =>
    exec(
      "ssh",
      buildTwoHopSshArgs({
        jumpHost,
        target: `root@${resolved.host}`,
        sshPort: resolved.sshPort,
        remoteCommand,
      }),
      clampTimeout(deadlineMs, now, preferredMs),
    );
  let runOnBox = makeRunOnBox(endpoint);

  // (b) pre-check: if the service already answers, do not touch anything.
  let probe = await runOnBox(buildLocalHealthProbeCommand(), 30000);
  let probeCode = String(probe.stdout ?? "").trim().slice(-3);

  // (b2) ONE fresh re-resolution + retry on a connection-level failure. See `isTransientSshFailure`.
  let retryNote = "";
  // Appended to the SUCCESS-path messages too: a recovered port change is drift Tim must know about,
  // and `formatRemediationReport` does not render `plan` lines for succeeded/partial/selfRecovered.
  let portChangeNote = "";
  if (typeof reresolveDrift === "function" && isTransientSshFailure(probe)) {
    const sshError = probe.timedOut
      ? "ssh timed out during the health pre-check"
      : previewRedacted(probe.stderr || probe.stdout, 200);
    const staleLabel = boxLabel;
    const compound = (detail) =>
      `health pre-check over ssh to root@${staleLabel} failed: ${sshError}; ` +
      `a fresh vast-drift re-resolution to check for a changed SSH port also failed: ${detail}`;

    if (deadlineMs - now() <= MIN_RERESOLVE_BUDGET_MS) {
      return failure(
        target,
        `health pre-check over ssh to root@${staleLabel} failed: ${sshError}; there was no time budget left ` +
          `in the remediation window to re-resolve the SSH port against the live Vast API, so no retry was attempted.`,
        { plan },
      );
    }

    let fresh;
    try {
      fresh = await reresolveDrift();
    } catch (caught) {
      fresh = {
        payload: null,
        error: `vast-drift lookup failed: ${previewRedacted(caught instanceof Error ? caught.message : String(caught), 200)}`,
      };
    }
    // Graceful degradation: never silently fall back to the stale/expected endpoint.
    if (!fresh || fresh.error) {
      return failure(target, compound(fresh?.error || "vast-drift returned nothing"), { plan });
    }

    const freshEndpoint = resolveBackendEndpoint(fresh.payload, target.backendId);
    if (!freshEndpoint.ok) {
      return failure(target, compound(`could not resolve the live SSH endpoint: ${freshEndpoint.error}`), { plan });
    }

    // PROVENANCE GUARD: `resolveBackendEndpoint` falls back to stack.json's `expected` values when
    // the live Vast API carries no `actual` for this instance. On the retry path that fallback is
    // exactly the failure mode this feature exists to prevent: a stale port on a shared machine IP
    // (gpu-1 and gpu-2 both live on 182.224.239.168) can be a LIVE port belonging to a different
    // container, so acting on it risks restarting the wrong box. Only live data may be trusted here.
    if (freshEndpoint.source !== "vast-api") {
      return failure(
        target,
        `health pre-check over ssh to root@${staleLabel} failed: ${sshError}; a fresh vast-drift ` +
          `re-resolution returned no live Vast API data for ${target.backendId} (only stale stack.json ` +
          `config), so the current SSH port could not be confirmed; nothing was restarted rather than risk ` +
          `acting on a stale port that may now belong to a different container on the same machine IP.`,
        { plan },
      );
    }

    // Identity guard: a changed vastInstanceId means this is a DIFFERENT box, not a re-mapped one.
    const firstInstanceId = endpoint.vastInstanceId;
    const freshInstanceId = freshEndpoint.vastInstanceId;
    if (firstInstanceId != null && freshInstanceId != null && String(firstInstanceId) !== String(freshInstanceId)) {
      return {
        target,
        outcome: OUTCOMES.skippedMismatch,
        message:
          `instance identity for ${target.backendId} changed between the first vast-drift lookup ` +
          `(vastInstanceId ${firstInstanceId}) and the fresh re-resolution after a transient ssh failure ` +
          `(vastInstanceId ${freshInstanceId}), so the box answering for this backend may not be the one the ` +
          `alert named; nothing was restarted. Check vast-drift / stack.json against the gateway backend list by hand.`,
        plan,
      };
    }

    const freshLabel = `${freshEndpoint.host}:${freshEndpoint.sshPort}`;
    // Accepting a CHANGED endpoint requires POSITIVE identity, not merely the absence of a
    // mismatch: a null vastInstanceId on either side is not proof that this is the same box.
    if (freshLabel !== staleLabel && (firstInstanceId == null || freshInstanceId == null)) {
      const missingSide =
        firstInstanceId == null && freshInstanceId == null
          ? "neither the first vast-drift lookup nor the fresh re-resolution reported a vastInstanceId"
          : firstInstanceId == null
            ? "the first vast-drift lookup reported no vastInstanceId"
            : "the fresh re-resolution reported no vastInstanceId";
      return {
        target,
        outcome: OUTCOMES.skippedMismatch,
        message:
          `the SSH endpoint for ${target.backendId} changed from ${staleLabel} to ${freshLabel} between the ` +
          `first vast-drift lookup and the fresh re-resolution after a transient ssh failure, but ${missingSide}, ` +
          `so the box now answering at ${freshLabel} could not be positively confirmed as the same Vast ` +
          `instance; nothing was restarted. Check vast-drift / stack.json against the gateway backend list by hand.`,
        plan,
      };
    }
    if (freshLabel === staleLabel) {
      plan.push(
        `re-confirmed ${target.backendId} at root@${boxLabel} against the live Vast API after a transient ssh ` +
          `failure; the SSH port did not change`,
      );
      retryNote =
        `. The SSH port ${endpoint.sshPort} was re-confirmed against the live Vast API at retry time, so this is ` +
        `not a stale-port problem: the box itself was unreachable (the Vast container is likely down or rebooting).`;
    } else {
      plan.push(
        `re-resolved ${target.backendId} to root@${freshLabel} after a transient ssh failure (was ${staleLabel}); ` +
          `the Vast SSH port changed since the first lookup`,
      );
      if (
        endpoint.servicePort != null &&
        freshEndpoint.servicePort != null &&
        endpoint.servicePort !== freshEndpoint.servicePort
      ) {
        // After a real container restart the SSH port and the service port move together, so
        // re-applying the alert-text servicePort cross-check would block exactly this recovery.
        // The matching vastInstanceId settles identity more strongly than the alert text can.
        plan.push(
          `servicePort moved from ${endpoint.servicePort} to ${freshEndpoint.servicePort}; the alert-text ` +
            `cross-check is superseded by the matching vastInstanceId (${freshInstanceId ?? firstInstanceId})`,
        );
      }
      retryNote =
        `. The SSH port was re-resolved to ${freshEndpoint.sshPort} at retry time (was ${endpoint.sshPort}), ` +
        `and the box was still unreachable there.`;
      portChangeNote =
        ` Note: the Vast SSH port for ${target.backendId} moved from ${endpoint.sshPort} to ` +
        `${freshEndpoint.sshPort} during this run (stack.json may now be drifted; re-check it).`;
      endpoint = freshEndpoint;
      boxLabel = freshLabel;
      runOnBox = makeRunOnBox(freshEndpoint);
    }

    // At most once: straight-line, never a loop.
    probe = await runOnBox(buildLocalHealthProbeCommand(), 30000);
    probeCode = String(probe.stdout ?? "").trim().slice(-3);
  }

  if (probe.timedOut) {
    return failure(
      target,
      `could not reach root@${boxLabel} (ssh timed out during the health pre-check)${retryNote}`,
      { plan },
    );
  }
  if (probeCode === "200") {
    return {
      target,
      outcome: OUTCOMES.selfRecovered,
      message: `${LOCAL_HEALTH_URL} on root@${boxLabel} already returns 200; no action taken.${portChangeNote}`,
      plan,
    };
  }
  if (probe.exitCode !== 0 && !probeCode) {
    return failure(
      target,
      `health pre-check over ssh to root@${boxLabel} failed: ${previewRedacted(probe.stderr || probe.stdout, 200)}${retryNote}`,
      { plan },
    );
  }
  plan.push(`local ${LOCAL_HEALTH_URL} returned "${probeCode || "no response"}" (service is down)`);

  const gatewayProbe = await readGatewayHealth({ target, exec, jumpHost, deadlineMs, now });
  if (gatewayProbe) plan.push(`gateway reports backend ${target.backendId} as ${gatewayProbe.status}`);

  if (dryRun) {
    return {
      target,
      outcome: OUTCOMES.dryRun,
      message: `would restart remote-inference on root@${boxLabel} (ensure start script, reuse existing venv, verify API_KEY presence, kill any stuck tmux session, start one detached session, then poll local /health and the gateway).`,
      plan,
    };
  }

  // (c) idempotent restart.
  const restart = await runOnBox(buildRemediationScript(), 120000);
  const parsed = parseRemediationScriptOutput(restart.stdout);
  plan.push(...parsed.steps.map((step) => `remote step ${step}`));

  if (restart.timedOut) {
    return failure(target, `the restart script on root@${boxLabel} timed out`, {
      plan,
      failedStep: parsed.steps.at(-1) || null,
      logTail: redactedTail(restart.stdout, 20),
    });
  }
  if (parsed.failedStep || restart.exitCode !== 0) {
    const logTail = await readLogTail({ runOnBox });
    return failure(
      target,
      explainFailedStep(parsed.failedStep) ||
        `the restart script on root@${boxLabel} exited ${restart.exitCode}: ${previewRedacted(restart.stderr || restart.stdout, 200)}`,
      { plan, failedStep: parsed.failedStep, logTail },
    );
  }

  // (d) poll the local health endpoint.
  const healthPoll = await runOnBox(
    buildLocalHealthPollCommand({ attempts: healthPollAttempts, intervalSec: healthPollIntervalSec }),
    (healthPollAttempts * healthPollIntervalSec + 20) * 1000,
  );
  const localHealthy = /RI-HEALTH:200/.test(healthPoll.stdout);
  if (!localHealthy) {
    const logTail = await readLogTail({ runOnBox });
    return failure(
      target,
      `remote-inference was restarted on root@${boxLabel} but ${LOCAL_HEALTH_URL} never returned 200`,
      { plan, failedStep: "health:local", logTail },
    );
  }
  plan.push(`local ${LOCAL_HEALTH_URL} returned 200`);

  // (e) wait for the gateway to flip the backend healthy again.
  let gatewayStatus = null;
  for (let attempt = 0; attempt < Math.max(1, gatewayPollAttempts); attempt += 1) {
    const health = await readGatewayHealth({ target, exec, jumpHost, deadlineMs, now });
    gatewayStatus = health;
    if (health?.healthy) break;
    if (deadlineMs - now() <= gatewayPollIntervalMs) break;
    await sleep(gatewayPollIntervalMs);
  }

  if (gatewayStatus?.healthy) {
    return {
      target,
      outcome: OUTCOMES.succeeded,
      message:
        `remote-inference restarted on root@${boxLabel}; the gateway reports ${target.backendId} healthy ` +
        `again.${portChangeNote}`,
      plan,
    };
  }

  return {
    target,
    outcome: OUTCOMES.partial,
    message:
      `remote-inference restarted on root@${boxLabel} and answers locally, but the gateway still reports ` +
      `${target.backendId} as ${gatewayStatus?.status || gatewayStatus?.error || "not healthy"}; verify ` +
      `shortly.${portChangeNote}`,
    plan,
  };
}

async function readLogTail({ runOnBox }) {
  try {
    const run = await runOnBox(buildLogTailCommand(20), 25000);
    return redactedTail(run.stdout, 20);
  } catch {
    return [];
  }
}

async function readGatewayHealth({ target, exec, jumpHost, deadlineMs, now }) {
  if (!target.gatewaySshTarget) return null;
  try {
    const run = await exec(
      "ssh",
      buildTwoHopSshArgs({
        jumpHost,
        target: target.gatewaySshTarget,
        sshPort: null,
        remoteCommand: buildGatewayBackendsCommand(),
      }),
      clampTimeout(deadlineMs, now, 30000),
    );
    // SECURITY: run.stdout contains the live gateway API key. Only parsed booleans/status
    // strings escape this function; the raw body is never returned or logged.
    const parsed = parseBackendHealth(run.stdout, target.backendId);
    if (!parsed.ok) return { healthy: false, status: null, error: parsed.error };
    return parsed;
  } catch (error) {
    return {
      healthy: false,
      status: null,
      error: `gateway check failed: ${previewRedacted(error instanceof Error ? error.message : String(error), 120)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

const OUTCOME_LABELS = {
  [OUTCOMES.selfRecovered]: "SELF-RECOVERED",
  [OUTCOMES.succeeded]: "SUCCEEDED",
  [OUTCOMES.partial]: "PARTIAL",
  [OUTCOMES.failed]: "FAILED",
  [OUTCOMES.inProgress]: "IN PROGRESS",
  [OUTCOMES.skippedCooldown]: "SKIPPED (cooldown)",
  [OUTCOMES.skippedDisabled]: "SKIPPED (disabled)",
  [OUTCOMES.skippedCircuitOpen]: "SKIPPED (circuit open)",
  [OUTCOMES.skippedCorrelated]: "SKIPPED (correlated failure)",
  [OUTCOMES.skippedMismatch]: "SKIPPED (target mismatch)",
  [OUTCOMES.dryRun]: "DRY RUN",
  [OUTCOMES.error]: "ERROR",
};

const OUTCOME_SUMMARIES = {
  [OUTCOMES.selfRecovered]: "the GPU box recovered on its own; nothing was changed.",
  [OUTCOMES.succeeded]: "remote-inference restarted; backend is healthy again.",
  [OUTCOMES.partial]: "restarted, gateway not yet healthy — verify shortly.",
  [OUTCOMES.failed]: "automatic restart did not fix the backend.",
  [OUTCOMES.inProgress]: "a restart was started and its result was never recorded; verify the box by hand.",
  [OUTCOMES.skippedCooldown]: "auto-remediation skipped because of the cooldown window.",
  [OUTCOMES.skippedDisabled]: "auto-remediation is disabled.",
  [OUTCOMES.skippedCircuitOpen]:
    "auto-remediation is suspended for this backend after repeated failures; manual intervention required.",
  [OUTCOMES.skippedCorrelated]:
    "several GPU backends went unhealthy at once, which points upstream; nothing was restarted.",
  [OUTCOMES.skippedMismatch]:
    "the target port from the alert does not match the authoritative config; nothing was restarted.",
  [OUTCOMES.dryRun]: "no changes were made (dry run).",
  [OUTCOMES.error]: "auto-remediation itself failed.",
};

const NEEDS_ATTENTION = new Set([
  OUTCOMES.failed,
  OUTCOMES.partial,
  OUTCOMES.error,
  OUTCOMES.skippedCooldown,
  OUTCOMES.skippedCircuitOpen,
  OUTCOMES.skippedCorrelated,
  OUTCOMES.skippedMismatch,
]);

/**
 * Render the auto-remediation section appended after the normal findings.
 * Pure: every diagnostic it emits has already been redacted upstream.
 */
export function formatRemediationReport(results, notes = []) {
  const list = Array.isArray(results) ? results.filter(Boolean) : [];
  const noteLines = (Array.isArray(notes) ? notes : []).filter((note) => String(note || "").trim());
  if (list.length === 0 && noteLines.length === 0) return "";

  const lines = [""];
  if (list.some((result) => NEEDS_ATTENTION.has(result.outcome))) {
    lines.push("⚠️ MANUAL INTERVENTION REQUIRED");
  }

  for (const result of list) {
    const label = OUTCOME_LABELS[result.outcome] || String(result.outcome || "UNKNOWN").toUpperCase();
    // `result.message` can carry command output or a log tail, so it is redacted here even though
    // most producers already redact: this is the last gate before the text reaches Telegram.
    const summary = redactSecrets(result.message || OUTCOME_SUMMARIES[result.outcome] || "no details");
    lines.push(`Auto-remediation: ${redactSecrets(describeTarget(result.target))}`);
    lines.push(`  Result: ${label} — ${summary}`);

    if (result.outcome === OUTCOMES.dryRun || NEEDS_ATTENTION.has(result.outcome)) {
      for (const step of result.plan || []) lines.push(`  Step: ${redactSecrets(step)}`);
    }
    if (result.failedStep) lines.push(`  Failed step: ${redactSecrets(result.failedStep)}`);
    if (Array.isArray(result.logTail) && result.logTail.length > 0) {
      lines.push("  Last service.log lines:");
      for (const line of result.logTail) lines.push(`    ${redactSecrets(line)}`);
    }
  }

  for (const note of noteLines) lines.push(`Note: ${redactSecrets(note)}`);

  return lines.join("\n");
}
