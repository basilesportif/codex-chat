#!/usr/bin/env node
import { spawn } from "node:child_process";

const DEFAULT_HOST = "tim@89.167.72.52";
const DEFAULT_REMOTE_DIR = "/home/tim/pkg/mush/mush-devops";
const DEFAULT_TIMEOUT_SEC = 240;
const DEFAULT_LOW_BALANCE_THRESHOLD = 5;
const NO_TARGET_ERROR = "No health check target could be derived from stack.json.";

async function main() {
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

  const findings = collectFindings(payload.value);
  if (findings.length === 0) {
    process.exit(0);
  }

  console.log(formatAlert({ checkedAt: payload.value.checkedAt, host, remoteDir, findings }));
}

function parsePositiveNumber(value, fallback) {
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

function collectFindings(payload) {
  if (!payload || !Array.isArray(payload.results)) {
    return ["Health check output was missing the expected results array."];
  }

  const findings = [];
  const checks = new Map(payload.results.map((result) => [result.key, result]));

  collectHttpFindings(checks.get("http"), findings);
  collectVastStatusFindings(checks.get("vastStatus"), findings);
  collectVastDriftFindings(checks.get("vastDrift"), findings);

  for (const check of payload.results) {
    if (["http", "vastStatus", "vastDrift"].includes(check.key)) continue;
    if (Number(check.exitCode) !== 0) {
      findings.push(`${check.label || check.key || "Check"} failed: ${preview(check.stderr || check.stdout)}`);
    }
  }

  return findings;
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

function collectVastStatusFindings(check, findings) {
  if (!check) {
    findings.push("Vast status check did not run.");
    return;
  }

  if (!check.parsed) {
    if (Number(check.exitCode) !== 0) {
      findings.push(`Vast status failed: ${preview(check.stderr || check.stdout)}`);
    }
    return;
  }

  if (check.parsed.healthy === false) {
    const balance = formatMoney(check.parsed.balance);
    const threshold = formatMoney(check.parsed.lowBalanceThreshold);
    const hours = Number.isFinite(check.parsed.estimatedHoursRemaining)
      ? `, about ${Math.round(check.parsed.estimatedHoursRemaining)}h remaining`
      : "";
    findings.push(`Vast status failing: balance ${balance} is below threshold ${threshold}${hours}.`);
  } else if (Number(check.exitCode) !== 0) {
    findings.push(`Vast status exited ${check.exitCode}: ${preview(check.stderr || check.stdout)}`);
  }
}

function collectVastDriftFindings(check, findings) {
  if (!check) {
    findings.push("Vast drift check did not run.");
    return;
  }

  if (!check.parsed) {
    if (Number(check.exitCode) !== 0) {
      findings.push(`Vast drift failed: ${preview(check.stderr || check.stdout)}`);
    }
    return;
  }

  if (check.parsed.drifted === true) {
    const diffs = Array.isArray(check.parsed.comparisons)
      ? check.parsed.comparisons
          .filter((comparison) => comparison.drifted)
          .slice(0, 5)
          .map(formatDriftComparison)
      : [];
    findings.push(["Vast drift detected.", ...diffs].filter(Boolean).join(" "));
  } else if (Number(check.exitCode) !== 0) {
    findings.push(`Vast drift exited ${check.exitCode}: ${preview(check.stderr || check.stdout)}`);
  }
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
  return Number.isFinite(value) ? `$${Number(value).toFixed(2)}` : "unknown";
}

function preview(value) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "no details";
  return normalized.length > 500 ? `${normalized.slice(0, 500)}...` : normalized;
}

function formatAlert({ checkedAt, host, remoteDir, findings }) {
  return [
    "Mush DevOps health check alert",
    `Checked at: ${checkedAt || new Date().toISOString()}`,
    `Target: ${host}:${remoteDir}`,
    "",
    ...findings.map((finding) => `- ${finding}`),
  ].join("\n");
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

main().catch((error) => {
  console.error(`Mush DevOps health check wrapper failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
