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
export const MAX_TARGETS_PER_RUN = 2;
export const REDACTED = "[redacted]";

export const OUTCOMES = Object.freeze({
  selfRecovered: "self-recovered",
  succeeded: "succeeded",
  partial: "partial",
  failed: "failed",
  skippedCooldown: "skipped-cooldown",
  skippedDisabled: "skipped-disabled",
  dryRun: "dry-run",
  error: "error",
});

/** Outcomes that did not mutate anything, so they must not start a cooldown window. */
const NON_COOLDOWN_OUTCOMES = new Set([
  OUTCOMES.selfRecovered,
  OUTCOMES.skippedCooldown,
  OUTCOMES.skippedDisabled,
  OUTCOMES.dryRun,
]);

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

  if (!host) return { ok: false, error: `vast-drift output has no host for ${backendId}` };
  if (!sshPort) return { ok: false, error: `vast-drift output has no sshPort for ${backendId}` };

  return {
    ok: true,
    host,
    sshPort,
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
    state.backends[backendId] = {
      lastAttemptAt: typeof entry.lastAttemptAt === "string" ? entry.lastAttemptAt : null,
      lastOutcome: typeof entry.lastOutcome === "string" ? entry.lastOutcome : null,
      attempts: Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 0,
    };
  }
  return state;
}

/**
 * Cooldown gate. Only outcomes that actually mutated the box hold the door shut; a
 * `self-recovered` observation never blocks a later real restart.
 */
export function shouldAttemptRemediation(state, backendId, nowMs, cooldownMs) {
  const entry = normalizeRemediationState(state).backends[backendId];
  const base = { allowed: true, lastAttemptAt: null, lastOutcome: null, remainingMs: 0, retryAfter: null };
  if (!entry || !entry.lastAttemptAt) return base;

  const lastAttemptMs = Date.parse(entry.lastAttemptAt);
  const info = {
    ...base,
    lastAttemptAt: entry.lastAttemptAt,
    lastOutcome: entry.lastOutcome,
    attempts: entry.attempts,
  };
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
    remainingMs,
    retryAfter: new Date(lastAttemptMs + cooldown).toISOString(),
  };
}

/** Pure state transition: returns a new state object, never mutates the input. */
export function recordRemediationAttempt(state, backendId, outcome, nowIso) {
  const next = normalizeRemediationState(state);
  const previous = next.backends[backendId];
  next.backends[backendId] = {
    lastAttemptAt: String(nowIso),
    lastOutcome: String(outcome),
    attempts: (previous?.attempts ?? 0) + 1,
  };
  return next;
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

  let driftPayload = null;
  let driftError = null;
  try {
    const driftRun = await exec(
      "ssh",
      buildJumpSshArgs({ jumpHost, command: buildVastDriftCommand(remoteDir) }),
      clampTimeout(deadlineMs, now, 60000),
    );
    try {
      driftPayload = JSON.parse(driftRun.stdout.slice(driftRun.stdout.indexOf("{")));
    } catch {
      driftError = `vast-drift output was not valid JSON: ${previewRedacted(driftRun.stderr || driftRun.stdout, 200)}`;
    }
  } catch (error) {
    driftError = `vast-drift lookup failed: ${previewRedacted(error instanceof Error ? error.message : String(error), 200)}`;
  }

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
  const endpoint = resolveBackendEndpoint(driftPayload, target.backendId);
  if (!endpoint.ok) return failure(target, `could not resolve the live SSH endpoint: ${endpoint.error}`);

  const boxLabel = `${endpoint.host}:${endpoint.sshPort}`;
  plan.push(`resolved ${target.backendId} to root@${boxLabel} via vast-drift (${endpoint.source})`);

  const runOnBox = (remoteCommand, preferredMs) =>
    exec(
      "ssh",
      buildTwoHopSshArgs({
        jumpHost,
        target: `root@${endpoint.host}`,
        sshPort: endpoint.sshPort,
        remoteCommand,
      }),
      clampTimeout(deadlineMs, now, preferredMs),
    );

  // (b) pre-check: if the service already answers, do not touch anything.
  const probe = await runOnBox(buildLocalHealthProbeCommand(), 30000);
  const probeCode = probe.stdout.trim().slice(-3);
  if (probe.timedOut) {
    return failure(target, `could not reach root@${boxLabel} (ssh timed out during the health pre-check)`, { plan });
  }
  if (probeCode === "200") {
    return {
      target,
      outcome: OUTCOMES.selfRecovered,
      message: `${LOCAL_HEALTH_URL} on root@${boxLabel} already returns 200; no action taken.`,
      plan,
    };
  }
  if (probe.exitCode !== 0 && !probeCode) {
    return failure(
      target,
      `health pre-check over ssh to root@${boxLabel} failed: ${previewRedacted(probe.stderr || probe.stdout, 200)}`,
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
      message: `remote-inference restarted on root@${boxLabel}; the gateway reports ${target.backendId} healthy again.`,
      plan,
    };
  }

  return {
    target,
    outcome: OUTCOMES.partial,
    message:
      `remote-inference restarted on root@${boxLabel} and answers locally, but the gateway still reports ` +
      `${target.backendId} as ${gatewayStatus?.status || gatewayStatus?.error || "not healthy"}; verify shortly.`,
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
  [OUTCOMES.skippedCooldown]: "SKIPPED (cooldown)",
  [OUTCOMES.skippedDisabled]: "SKIPPED (disabled)",
  [OUTCOMES.dryRun]: "DRY RUN",
  [OUTCOMES.error]: "ERROR",
};

const OUTCOME_SUMMARIES = {
  [OUTCOMES.selfRecovered]: "the GPU box recovered on its own; nothing was changed.",
  [OUTCOMES.succeeded]: "remote-inference restarted; backend is healthy again.",
  [OUTCOMES.partial]: "restarted, gateway not yet healthy — verify shortly.",
  [OUTCOMES.failed]: "automatic restart did not fix the backend.",
  [OUTCOMES.skippedCooldown]: "auto-remediation skipped because of the cooldown window.",
  [OUTCOMES.skippedDisabled]: "auto-remediation is disabled.",
  [OUTCOMES.dryRun]: "no changes were made (dry run).",
  [OUTCOMES.error]: "auto-remediation itself failed.",
};

const NEEDS_ATTENTION = new Set([OUTCOMES.failed, OUTCOMES.partial, OUTCOMES.error, OUTCOMES.skippedCooldown]);

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
    const summary = result.message || OUTCOME_SUMMARIES[result.outcome] || "no details";
    lines.push(`Auto-remediation: ${describeTarget(result.target)}`);
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
