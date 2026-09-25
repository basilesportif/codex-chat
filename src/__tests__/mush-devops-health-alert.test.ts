import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

type HealthAlertModule = {
  collectFindings(
    payload: unknown,
    options?: {
      lowBalanceThreshold?: number;
      driftNoticeStatePath?: string;
      readDriftNoticeState?: (filePath: string) => { state: unknown; error: string | null };
      writeDriftNoticeState?: (filePath: string, state: unknown) => void;
      now?: () => number;
    }
  ): string[];
  capDriftNoticeState(state: unknown, limit?: number): { version: number; notices: Record<string, unknown> };
  parsePositiveNumber(value: unknown, fallback: number): number;
  isSkippedCheck(check: unknown): boolean;
  collectCaddyFindings(check: unknown, findings: string[]): void;
  parseBooleanFlag(value: unknown, fallback: boolean): boolean;
  parseCliOptions(argv?: string[], env?: Record<string, string | undefined>): {
    autoRemediate: boolean;
    dryRun: boolean;
    cooldownMinutes: number;
    remediationTimeoutSec: number;
    gatewaySshOverride: string | null;
  };
  runRemediationPhase(options: Record<string, unknown>): Promise<string>;
  isTransientSshTransportFailure(result: unknown): boolean;
  resolveTransientHttpFailures(payload: unknown, options?: Record<string, unknown>): Promise<unknown>;
  formatAlert(options: {
    checkedAt?: string;
    host?: string;
    remoteDir?: string;
    findings: string[];
  }): string;
};

const {
  capDriftNoticeState,
  collectCaddyFindings,
  collectFindings,
  formatAlert,
  isSkippedCheck,
  parseBooleanFlag,
  parseCliOptions,
  parsePositiveNumber,
  isTransientSshTransportFailure,
  resolveTransientHttpFailures,
  runRemediationPhase
} = await import("../../scripts/mush-devops-health-alert.mjs") as HealthAlertModule;

const VAST_DNS_SKIP = {
  status: "skipped",
  skipped: true,
  skipReason: "vast-dns-unreachable",
  message:
    "Vast API unreachable (DNS resolution failed for vast.ai — likely a Vast-side domain/registrar issue, not a local problem)",
  checkedAt: "2026-08-03T15:00:00.000Z"
};

function skippedVastPayload(extra: Record<string, unknown> = {}) {
  return {
    checkedAt: "2026-08-03T15:00:00.000Z",
    results: [
      {
        key: "http",
        label: "HTTP health",
        exitCode: 0,
        status: "healthy",
        parsed: {
          results: [
            { componentId: "ai-stylist-workshop", status: "healthy", httpStatus: 200 },
            { componentId: "remote-inference", status: "healthy", httpStatus: 200 }
          ]
        }
      },
      {
        key: "vastStatus",
        label: "Vast status",
        exitCode: 0,
        status: "skipped",
        parsed: VAST_DNS_SKIP
      },
      {
        key: "vastDrift",
        label: "Vast drift",
        exitCode: 0,
        status: "skipped",
        parsed: VAST_DNS_SKIP
      }
    ],
    ...extra
  };
}

function healthPayload(vastStatus: Record<string, unknown>, httpVastAi?: Record<string, unknown>) {
  return {
    checkedAt: "2026-04-30T17:01:50.395Z",
    results: [
      {
        key: "http",
        label: "HTTP health",
        exitCode: 0,
        parsed: {
          results: [],
          vastAi: httpVastAi
        }
      },
      {
        key: "vastStatus",
        label: "Vast status",
        exitCode: 0,
        parsed: vastStatus
      },
      {
        key: "vastDrift",
        label: "Vast drift",
        exitCode: 0,
        parsed: { drifted: false, comparisons: [] }
      }
    ]
  };
}

function caddyAlias(alias: string, overrides: Record<string, unknown> = {}) {
  return {
    alias,
    sshTarget: `root@${alias}.ssh.invalid`,
    publicIp: "203.0.113.7",
    accessPath: "direct",
    configuredAccessPath: "dev server direct SSH",
    status: "in-sync",
    diff: "",
    warnings: [],
    error: null,
    ...overrides
  };
}

function caddyCheck(results: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}) {
  return {
    key: "caddyDrift",
    label: "Caddy configuration state",
    exitCode: 1,
    stdout: JSON.stringify({ checkedAt: "2026-08-03T15:00:00.000Z", results }),
    stderr: "",
    parsed: {
      checkedAt: "2026-08-03T15:00:00.000Z",
      host: null,
      passing: false,
      status: "indeterminate",
      driftDetected: false,
      indeterminate: true,
      results
    },
    ...overrides
  };
}

describe("mush devops health alert", () => {
  test("uses a positive numeric threshold override", () => {
    expect(parsePositiveNumber("7.5", 5)).toBe(7.5);
    expect(parsePositiveNumber("0", 5)).toBe(5);
    expect(parsePositiveNumber("not-a-number", 5)).toBe(5);
  });

  test("stays quiet when Vast balance is at the configured threshold", () => {
    const findings = collectFindings(
      healthPayload({
        healthy: true,
        lowBalanceThreshold: 10,
        balance: 5,
        estimatedHoursRemaining: 12.4
      }),
      { lowBalanceThreshold: 5 }
    );

    expect(findings).toEqual([]);
  });

  test("alerts when Vast balance is below the configured threshold", () => {
    const findings = collectFindings(
      healthPayload({
        healthy: true,
        lowBalanceThreshold: 10,
        balance: "4.99",
        estimatedHoursRemaining: 12.4
      }),
      { lowBalanceThreshold: 5 }
    );

    expect(findings).toEqual([
      "Vast balance low: balance $4.99 is below threshold $5.00, about 12h remaining."
    ]);
  });

  test("can fall back to the HTTP health Vast.ai balance", () => {
    const payload = healthPayload({ healthy: true }, {
      balance: 3.5,
      estimatedHoursRemaining: 8
    });
    payload.results = payload.results.filter((result) => result.key !== "vastStatus");

    const findings = collectFindings(payload, { lowBalanceThreshold: 5 });

    expect(findings).toContain("Vast status check did not run.");
    expect(findings).toContain("Vast balance low: balance $3.50 is below threshold $5.00, about 8h remaining.");
  });

  test("recognizes skipped checks from any of the documented shapes", () => {
    expect(isSkippedCheck({ status: "skipped" })).toBe(true);
    expect(isSkippedCheck({ exitCode: 0, parsed: { skipped: true } })).toBe(true);
    expect(isSkippedCheck({ exitCode: 0, parsed: { status: "skipped" } })).toBe(true);
    expect(isSkippedCheck({ exitCode: 0, parsed: { healthy: true } })).toBe(false);
    expect(isSkippedCheck(undefined)).toBe(false);
    expect(isSkippedCheck(null)).toBe(false);
  });

  test("stays silent when the Vast checks skip because vast.ai DNS is unresolvable", () => {
    const findings = collectFindings(skippedVastPayload(), { lowBalanceThreshold: 5 });

    expect(findings).toEqual([]);
  });

  test("does not resurrect a stale low balance when the Vast status check was skipped", () => {
    const findings = collectFindings(
      skippedVastPayload({ vastAi: { balance: 1.25, estimatedHoursRemaining: 3 } }),
      { lowBalanceThreshold: 5 }
    );

    expect(findings).toEqual([]);
  });

  test("ignores skipped checks in the generic nonzero-exit fallback", () => {
    const payload = skippedVastPayload();
    payload.results.push({
      key: "vastBalance",
      label: "Vast balance",
      exitCode: 3,
      status: "skipped",
      parsed: VAST_DNS_SKIP
    } as (typeof payload.results)[number]);

    expect(collectFindings(payload, { lowBalanceThreshold: 5 })).toEqual([]);
  });

  test("still alerts when the Vast status check genuinely fails", () => {
    const payload = skippedVastPayload();
    payload.results[1] = {
      key: "vastStatus",
      label: "Vast status",
      exitCode: 1,
      stderr: "Error: Vast API returned 401 Unauthorized"
    } as (typeof payload.results)[number];

    expect(collectFindings(payload, { lowBalanceThreshold: 5 })).toEqual([
      "Vast status failed: Error: Vast API returned 401 Unauthorized"
    ]);
  });

  test("still alerts when Vast reports unhealthy or drifted", () => {
    const payload = skippedVastPayload();
    payload.results[1] = {
      key: "vastStatus",
      label: "Vast status",
      exitCode: 0,
      parsed: { healthy: false, balance: 42 }
    } as (typeof payload.results)[number];
    payload.results[2] = {
      key: "vastDrift",
      label: "Vast drift",
      exitCode: 0,
      parsed: { drifted: true, comparisons: [{ logicalId: "backend-3", drifted: true, diffs: ["gpu: 4090 -> 3090"] }] }
    } as (typeof payload.results)[number];

    expect(collectFindings(payload, { lowBalanceThreshold: 5 })).toEqual([
      "Vast status failing: balance $42.00.",
      "Vast drift detected. backend-3: gpu: 4090 -> 3090"
    ]);
  });

  test("still alerts on a low balance while the drift check is skipped", () => {
    const payload = skippedVastPayload();
    payload.results[1] = {
      key: "vastStatus",
      label: "Vast status",
      exitCode: 0,
      parsed: { healthy: true, balance: 1.5, estimatedHoursRemaining: 4 }
    } as (typeof payload.results)[number];

    expect(collectFindings(payload, { lowBalanceThreshold: 5 })).toEqual([
      "Vast balance low: balance $1.50 is below threshold $5.00, about 4h remaining."
    ]);
  });

  test("still alerts on unhealthy HTTP components while the Vast checks are skipped", () => {
    const payload = skippedVastPayload();
    payload.results[0] = {
      key: "http",
      label: "HTTP health",
      exitCode: 1,
      parsed: {
        results: [
          { componentId: "ai-stylist-workshop", status: "healthy", httpStatus: 200 },
          {
            componentId: "remote-inference",
            componentName: "Remote inference",
            instance: "backend-3",
            status: "unhealthy",
            url: "http://example.invalid/health",
            httpStatus: 502
          }
        ]
      }
    } as (typeof payload.results)[number];

    expect(collectFindings(payload, { lowBalanceThreshold: 5 })).toEqual([
      "HTTP health unhealthy: Remote inference / backend-3 at http://example.invalid/health. HTTP 502."
    ]);
  });
});

describe("caddy configuration state findings", () => {
  test("names the alias and diff when a host has drifted", () => {
    const findings: string[] = [];
    collectCaddyFindings(
      caddyCheck([
        caddyAlias("production-backend-load-balancer", {
          status: "drift",
          diff: "- reverse_proxy 10.0.0.1:8080\n+ reverse_proxy 10.0.0.2:8080"
        })
      ]),
      findings
    );

    expect(findings).toEqual([
      "Caddy config drift on production-backend-load-balancer (root@production-backend-load-balancer.ssh.invalid). - reverse_proxy 10.0.0.1:8080 + reverse_proxy 10.0.0.2:8080"
    ]);
  });

  test("names the alias, reason, and error when a host is indeterminate", () => {
    const findings: string[] = [];
    collectCaddyFindings(
      caddyCheck([
        caddyAlias("staging-backend-load-balancer", {
          status: "indeterminate",
          reason: "host-unavailable",
          error: "ssh: connect to host 178.105.107.43 port 22: Connection timed out"
        })
      ]),
      findings
    );

    expect(findings).toEqual([
      "Caddy config state indeterminate for staging-backend-load-balancer (root@staging-backend-load-balancer.ssh.invalid): host-unavailable - ssh: connect to host 178.105.107.43 port 22: Connection timed out"
    ]);
  });

  test("falls back to a generic error note when an indeterminate alias has no error text", () => {
    const findings: string[] = [];
    collectCaddyFindings(
      caddyCheck([caddyAlias("edge-lb", { status: "indeterminate", reason: "inspection-error", error: null })]),
      findings
    );

    expect(findings).toEqual([
      "Caddy config state indeterminate for edge-lb (root@edge-lb.ssh.invalid): inspection-error - no error detail"
    ]);
  });

  test("reports unknown statuses rather than dropping them", () => {
    const findings: string[] = [];
    collectCaddyFindings(caddyCheck([caddyAlias("edge-lb", { status: "exploded", error: "boom" })]), findings);

    expect(findings).toEqual(["Caddy config state exploded for edge-lb (root@edge-lb.ssh.invalid): boom"]);
  });

  test("mentions only the failing alias in a mixed payload", () => {
    const findings: string[] = [];
    collectCaddyFindings(
      caddyCheck([
        caddyAlias("production-backend-load-balancer"),
        caddyAlias("staging-backend-load-balancer"),
        caddyAlias("inference-load-balancer", {
          status: "indeterminate",
          reason: "host-unavailable",
          error: "ssh: Could not resolve hostname"
        })
      ]),
      findings
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("inference-load-balancer");
    expect(findings.join("\n")).not.toContain("production-backend-load-balancer");
    expect(findings.join("\n")).not.toContain("staging-backend-load-balancer");
  });

  test("names the failing alias even when it is last in a realistic six-alias payload", () => {
    const results = [
      caddyAlias("production-backend-load-balancer"),
      caddyAlias("production-frontend-load-balancer"),
      caddyAlias("staging-backend-load-balancer"),
      caddyAlias("staging-frontend-load-balancer"),
      caddyAlias("inference-load-balancer"),
      caddyAlias("legacy-edge-load-balancer", {
        status: "indeterminate",
        reason: "inspection-error",
        error: "caddy adapt failed: adapting config using caddyfile: /etc/caddy/Caddyfile:12 - unrecognized directive"
      })
    ];
    const check = caddyCheck(results);

    // The raw stdout is long enough that the old 500-character preview never reached the
    // failing alias, which is exactly the truncation this collector replaces.
    expect(check.stdout.indexOf("legacy-edge-load-balancer")).toBeGreaterThan(500);

    const findings: string[] = [];
    collectCaddyFindings(check, findings);

    expect(findings).toEqual([
      "Caddy config state indeterminate for legacy-edge-load-balancer (root@legacy-edge-load-balancer.ssh.invalid): inspection-error - caddy adapt failed: adapting config using caddyfile: /etc/caddy/Caddyfile:12 - unrecognized directive"
    ]);
  });

  test("falls back to the raw output when the check output could not be parsed", () => {
    const findings: string[] = [];
    collectCaddyFindings(
      {
        key: "caddyDrift",
        label: "Caddy configuration state",
        exitCode: 2,
        stdout: "",
        stderr: "Error: caddy inspector crashed"
      },
      findings
    );

    expect(findings).toEqual(["Caddy configuration state failed: Error: caddy inspector crashed"]);
  });

  test("falls back when the exit code is nonzero but every alias parsed as in-sync", () => {
    const findings: string[] = [];
    collectCaddyFindings(
      caddyCheck([caddyAlias("production-backend-load-balancer"), caddyAlias("staging-backend-load-balancer")], {
        exitCode: 1,
        stderr: "warning: 1 alias could not be summarized"
      }),
      findings
    );

    expect(findings).toEqual([
      "Caddy configuration state failed: warning: 1 alias could not be summarized"
    ]);
  });

  test("stays silent when the check is absent, skipped, or entirely in-sync", () => {
    const missing: string[] = [];
    collectCaddyFindings(undefined, missing);
    expect(missing).toEqual([]);

    const skipped: string[] = [];
    collectCaddyFindings(caddyCheck([caddyAlias("edge-lb", { status: "drift" })], { status: "skipped" }), skipped);
    expect(skipped).toEqual([]);

    const clean: string[] = [];
    collectCaddyFindings(
      caddyCheck([caddyAlias("production-backend-load-balancer"), caddyAlias("staging-backend-load-balancer")], {
        exitCode: 0
      }),
      clean
    );
    expect(clean).toEqual([]);
  });

  test("is wired into collectFindings without double-reporting the raw output", () => {
    const payload = skippedVastPayload();
    payload.results.push(
      caddyCheck([
        caddyAlias("production-backend-load-balancer"),
        caddyAlias("inference-load-balancer", {
          status: "indeterminate",
          reason: "host-unavailable",
          error: "ssh: connect to host 178.105.107.43 port 22: Connection timed out"
        })
      ]) as unknown as (typeof payload.results)[number]
    );

    expect(collectFindings(payload, { lowBalanceThreshold: 5 })).toEqual([
      "Caddy config state indeterminate for inference-load-balancer (root@inference-load-balancer.ssh.invalid): host-unavailable - ssh: connect to host 178.105.107.43 port 22: Connection timed out"
    ]);
  });
});

describe("auto-remediation safety switches", () => {
  test("auto-remediation is OFF by default: arming it is an explicit opt-in", () => {
    const options = parseCliOptions([], {});
    expect(options.autoRemediate).toBe(false);
    expect(options.dryRun).toBe(false);
    expect(options.cooldownMinutes).toBe(45);
    expect(options.remediationTimeoutSec).toBe(180);
    expect(options.gatewaySshOverride).toBeNull();
  });

  test("--no-remediate and MUSH_DEVOPS_AUTO_REMEDIATE turn it off", () => {
    expect(parseCliOptions(["--no-remediate"], {}).autoRemediate).toBe(false);
    for (const value of ["0", "false", "off", "no", "OFF", "", undefined, "weird"]) {
      expect(parseCliOptions([], { MUSH_DEVOPS_AUTO_REMEDIATE: value }).autoRemediate).toBe(false);
    }
    for (const value of ["1", "true", "on", "yes"]) {
      expect(parseCliOptions([], { MUSH_DEVOPS_AUTO_REMEDIATE: value }).autoRemediate).toBe(true);
    }
    // --no-remediate wins even when the env arms it.
    expect(
      parseCliOptions(["--no-remediate"], { MUSH_DEVOPS_AUTO_REMEDIATE: "1" }).autoRemediate
    ).toBe(false);
  });

  test("--dry-run-remediation is recognized", () => {
    expect(parseCliOptions(["--dry-run-remediation"], {}).dryRun).toBe(true);
    expect(parseCliOptions(["--dry-run-remediation", "--no-remediate"], {})).toMatchObject({
      dryRun: true,
      autoRemediate: false
    });
  });

  test("reads the cooldown, timeout, and gateway overrides", () => {
    expect(
      parseCliOptions([], {
        MUSH_DEVOPS_REMEDIATION_COOLDOWN_MIN: "10",
        MUSH_DEVOPS_REMEDIATION_TIMEOUT_SEC: "90",
        MUSH_DEVOPS_GPU_GATEWAY_SSH: " root@10.0.0.9 "
      })
    ).toMatchObject({ cooldownMinutes: 10, remediationTimeoutSec: 90, gatewaySshOverride: "root@10.0.0.9" });

    // Nonsense values fall back to the defaults rather than disabling the cooldown.
    expect(
      parseCliOptions([], { MUSH_DEVOPS_REMEDIATION_COOLDOWN_MIN: "0" }).cooldownMinutes
    ).toBe(45);
  });

  test("parses boolean flags with a fallback", () => {
    expect(parseBooleanFlag("no", true)).toBe(false);
    expect(parseBooleanFlag("YES", false)).toBe(true);
    expect(parseBooleanFlag("  ", false)).toBe(false);
    expect(parseBooleanFlag(undefined, true)).toBe(true);
  });
});

describe("auto-remediation wiring (runRemediationPhase)", () => {
  const GATEWAY_URL = "ssh://root@162.55.45.186 http://127.0.0.1:3081/admin/backends";
  const HOST = "tim@89.167.72.52";
  const REMOTE_DIR = "/home/tim/pkg/mush/mush-devops";

  function backendFinding(...backends: Array<[string, number]>) {
    return `Enabled backend(s) unhealthy: ${backends
      .map(([id, port]) => `gpu-gateway/${id} (182.224.239.168:${port})`)
      .join(", ")}.`;
  }

  function payloadWith(error: string | null) {
    return {
      checkedAt: "2026-09-12T12:00:00.000Z",
      results: [
        {
          key: "http",
          label: "HTTP health",
          exitCode: error ? 1 : 0,
          parsed: {
            results: [
              {
                componentId: "remote-inference",
                componentName: "Remote Inference (GPU Service)",
                status: error ? "unhealthy" : "healthy",
                url: GATEWAY_URL,
                httpStatus: 200,
                ...(error ? { error } : {})
              }
            ]
          }
        }
      ]
    };
  }

  const UNHEALTHY = payloadWith(backendFinding(["gpu-1", 63571]));
  const TWO_UNHEALTHY = payloadWith(backendFinding(["gpu-1", 63571], ["gpu-2", 63572]));
  const ALL_HEALTHY = payloadWith(null);

  function makeOptions(overrides: Record<string, unknown> = {}) {
    return {
      autoRemediate: true,
      dryRun: false,
      cooldownMinutes: 45,
      remediationTimeoutSec: 180,
      gatewaySshOverride: null,
      ...overrides
    };
  }

  function ok(stdout: string) {
    return { exitCode: 0, signal: null, stdout, stderr: "", timedOut: false };
  }

  const DRIFT = JSON.stringify({
    drifted: false,
    comparisons: [
      {
        logicalId: "gpu-1",
        vastInstanceId: 46154118,
        expected: { host: "182.224.239.168", sshPort: 63530, servicePort: 63571 },
        actual: { host: "182.224.239.168", sshPort: 63530, servicePort: 63571, status: "running" },
        diffs: []
      }
    ]
  });

  /** A fake two-hop ssh runner that walks the real remediation script through a good restart. */
  function makeExec({ restartFails = false } = {}) {
    const calls: string[] = [];
    const exec = async (_command: string, args: string[]) => {
      const command = String(args[args.length - 1]);
      if (command.includes("vast-drift")) {
        calls.push("drift");
        return ok(DRIFT);
      }
      if (command.includes("admin/backends")) {
        calls.push("gateway");
        return ok(JSON.stringify([{ id: "gpu-1", enabled: true, health: { status: "healthy" } }]));
      }
      if (command.includes("RI-HEALTH")) {
        calls.push("poll");
        return ok("RI-HEALTH:200");
      }
      if (command.includes("http_code")) {
        calls.push("probe");
        return ok("000");
      }
      if (command.includes("RI-FAIL")) {
        calls.push("restart");
        return restartFails
          ? { exitCode: 1, signal: null, stdout: "RI:start-script:present\nRI-FAIL:api-key:missing", stderr: "", timedOut: false }
          : ok("RI:start-script:present\nRI:api-key:present\nRI:venv:present\nRI:deps:present\nRI:tmux:started\nRI:done");
      }
      if (command.includes("tail -n")) {
        calls.push("logTail");
        return ok("boot failed");
      }
      calls.push(`unknown:${command}`);
      return ok("");
    };
    return { exec, calls };
  }

  function recorder(initial: unknown = { version: 1, backends: {} }) {
    const writes: any[] = [];
    return {
      writes,
      readState: async () => JSON.parse(JSON.stringify(initial)),
      writeState: async (_path: string, state: unknown) => {
        writes.push(JSON.parse(JSON.stringify(state)));
      }
    };
  }

  async function tmpStatePath() {
    const dir = await mkdtemp(path.join(tmpdir(), "remediation-wiring-"));
    return path.join(dir, "mush_devops_remediation.json");
  }

  test("returns nothing when no GPU backend is unhealthy, but still clears a recovered backend", async () => {
    const state = {
      version: 1,
      backends: {
        "gpu-1": { lastAttemptAt: "2026-09-12T10:00:00.000Z", lastOutcome: "failed", attempts: 4, consecutiveFailures: 3 }
      }
    };
    const store = recorder(state);
    const { exec, calls } = makeExec();

    const report = await runRemediationPhase({
      payload: ALL_HEALTHY,
      options: makeOptions(),
      host: HOST,
      remoteDir: REMOTE_DIR,
      statePath: "/tmp/does-not-matter.json",
      exec,
      readState: store.readState,
      writeState: store.writeState
    });

    expect(report).toBe("");
    expect(calls).toEqual([]);
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0].backends["gpu-1"].consecutiveFailures).toBe(0);
    // The lifetime counter is preserved; only the streak is cleared.
    expect(store.writes[0].backends["gpu-1"].attempts).toBe(4);
  });

  test("never clears the failure streak of a backend that is still unhealthy", async () => {
    const store = recorder({
      version: 1,
      backends: {
        "gpu-1": { lastAttemptAt: "2026-09-12T10:00:00.000Z", lastOutcome: "failed", attempts: 4, consecutiveFailures: 3 }
      }
    });
    const { exec, calls } = makeExec();

    const report = await runRemediationPhase({
      payload: UNHEALTHY,
      options: makeOptions(),
      host: HOST,
      remoteDir: REMOTE_DIR,
      exec,
      readState: store.readState,
      writeState: store.writeState
    });

    expect(store.writes).toEqual([]);
    expect(calls).toEqual([]);
    expect(report).toContain("SKIPPED (circuit open)");
  });

  test("disarmed: reports skipped-disabled without touching ssh or the state file", async () => {
    const store = recorder();
    const { exec, calls } = makeExec();

    const report = await runRemediationPhase({
      payload: UNHEALTHY,
      options: makeOptions({ autoRemediate: false }),
      host: HOST,
      remoteDir: REMOTE_DIR,
      exec,
      readState: store.readState,
      writeState: store.writeState
    });

    expect(report).toContain("SKIPPED (disabled)");
    expect(report).toContain("gpu-gateway/gpu-1 (182.224.239.168:63571)");
    expect(calls).toEqual([]);
    expect(store.writes).toEqual([]);
  });

  test("dry run: reports what would happen and writes no state", async () => {
    const store = recorder();
    const { exec, calls } = makeExec();

    const report = await runRemediationPhase({
      payload: UNHEALTHY,
      options: makeOptions({ dryRun: true }),
      host: HOST,
      remoteDir: REMOTE_DIR,
      exec,
      readState: store.readState,
      writeState: store.writeState
    });

    expect(report).toContain("DRY RUN");
    expect(report).toContain("would restart remote-inference");
    expect(report).toContain("Note: Dry run: nothing on the GPU boxes or in the cooldown state file was modified.");
    expect(store.writes).toEqual([]);
    expect(calls).not.toContain("restart");
  });

  test("cooldown: skips without ssh and names the retry time", async () => {
    const store = recorder({
      version: 1,
      backends: {
        "gpu-1": { lastAttemptAt: "2026-09-12T11:50:00.000Z", lastOutcome: "failed", attempts: 1, consecutiveFailures: 1 }
      }
    });
    const { exec, calls } = makeExec();

    const report = await runRemediationPhase({
      payload: UNHEALTHY,
      options: makeOptions(),
      host: HOST,
      remoteDir: REMOTE_DIR,
      exec,
      now: () => Date.parse("2026-09-12T12:00:00.000Z"),
      readState: store.readState,
      writeState: store.writeState
    });

    expect(report).toContain("SKIPPED (cooldown)");
    expect(report).toContain("2026-09-12T12:35:00.000Z");
    expect(calls).toEqual([]);
    expect(store.writes).toEqual([]);
  });

  test("circuit open: demands manual intervention and never ssh-es", async () => {
    const store = recorder({
      version: 1,
      backends: {
        "gpu-1": { lastAttemptAt: "2026-09-11T01:00:00.000Z", lastOutcome: "failed", attempts: 7, consecutiveFailures: 3 }
      }
    });
    const { exec, calls } = makeExec();

    const report = await runRemediationPhase({
      payload: UNHEALTHY,
      options: makeOptions(),
      host: HOST,
      remoteDir: REMOTE_DIR,
      statePath: "/var/lib/whatever/mush_devops_remediation.json",
      exec,
      now: () => Date.parse("2026-09-12T12:00:00.000Z"),
      readState: store.readState,
      writeState: store.writeState
    });

    expect(report).toContain("⚠️ MANUAL INTERVENTION REQUIRED");
    expect(report).toContain("SKIPPED (circuit open)");
    expect(report).toContain("MANUAL INTERVENTION NEEDED");
    expect(report).toContain("suspended for gpu-1 after 3 consecutive failed attempts");
    expect(report).toContain("/var/lib/whatever/mush_devops_remediation.json");
    expect(calls).toEqual([]);
    expect(store.writes).toEqual([]);
  });

  test("two unhealthy backends: alert only, nothing restarted, no state written", async () => {
    const store = recorder();
    const { exec, calls } = makeExec();

    const report = await runRemediationPhase({
      payload: TWO_UNHEALTHY,
      options: makeOptions(),
      host: HOST,
      remoteDir: REMOTE_DIR,
      exec,
      readState: store.readState,
      writeState: store.writeState
    });

    expect(report).toContain("⚠️ MANUAL INTERVENTION REQUIRED");
    expect(report.match(/SKIPPED \(correlated failure\)/g)).toHaveLength(2);
    expect(report).toContain("gpu-gateway/gpu-1");
    expect(report).toContain("gpu-gateway/gpu-2");
    expect(report).toContain("upstream or gateway-level cause");
    expect(calls).toEqual([]);
    expect(store.writes).toEqual([]);
  });

  test("successful remediation: in-progress marker first, then a clean final state", async () => {
    const statePath = await tmpStatePath();
    const { exec, calls } = makeExec();

    const report = await runRemediationPhase({
      payload: UNHEALTHY,
      options: makeOptions(),
      host: HOST,
      remoteDir: REMOTE_DIR,
      statePath,
      exec
    });

    expect(report).toContain("SUCCEEDED");
    expect(report).not.toContain("MANUAL INTERVENTION");
    expect(calls).toContain("restart");

    const persisted = JSON.parse(await readFile(statePath, "utf8"));
    expect(persisted.backends["gpu-1"]).toMatchObject({
      lastOutcome: "succeeded",
      attempts: 1,
      consecutiveFailures: 0
    });
  });

  test("three failed runs open the circuit on the fourth, through the real state file", async () => {
    const statePath = await tmpStatePath();
    const start = Date.parse("2026-09-12T12:00:00.000Z");

    for (let run = 0; run < 3; run += 1) {
      const { exec, calls } = makeExec({ restartFails: true });
      const report = await runRemediationPhase({
        payload: UNHEALTHY,
        options: makeOptions(),
        host: HOST,
        remoteDir: REMOTE_DIR,
        statePath,
        exec,
        now: () => start + run * 60 * 60 * 1000
      });

      expect(calls).toContain("restart");
      expect(report).toContain("FAILED");
      const persisted = JSON.parse(await readFile(statePath, "utf8"));
      expect(persisted.backends["gpu-1"].consecutiveFailures).toBe(run + 1);
      expect(persisted.backends["gpu-1"].attempts).toBe(run + 1);
    }

    const { exec, calls } = makeExec({ restartFails: true });
    const report = await runRemediationPhase({
      payload: UNHEALTHY,
      options: makeOptions(),
      host: HOST,
      remoteDir: REMOTE_DIR,
      statePath,
      exec,
      now: () => start + 3 * 60 * 60 * 1000
    });

    expect(report).toContain("SKIPPED (circuit open)");
    expect(calls).toEqual([]);
    // A fourth attempt was never charged.
    const persisted = JSON.parse(await readFile(statePath, "utf8"));
    expect(persisted.backends["gpu-1"].attempts).toBe(3);
  });

  test("a cleared circuit lets the next unhealthy run try again", async () => {
    const statePath = await tmpStatePath();
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        backends: {
          "gpu-1": { lastAttemptAt: "2026-09-11T01:00:00.000Z", lastOutcome: "failed", attempts: 3, consecutiveFailures: 3 }
        }
      })
    );

    // A healthy run clears the streak...
    await runRemediationPhase({
      payload: ALL_HEALTHY,
      options: makeOptions(),
      host: HOST,
      remoteDir: REMOTE_DIR,
      statePath,
      exec: makeExec().exec
    });
    expect(JSON.parse(await readFile(statePath, "utf8")).backends["gpu-1"].consecutiveFailures).toBe(0);

    // ...so a later failure is remediated again instead of being suppressed forever.
    const { exec, calls } = makeExec();
    const report = await runRemediationPhase({
      payload: UNHEALTHY,
      options: makeOptions(),
      host: HOST,
      remoteDir: REMOTE_DIR,
      statePath,
      exec
    });
    expect(calls).toContain("restart");
    expect(report).toContain("SUCCEEDED");
  });

  test("fails closed when the preliminary cooldown marker cannot be written", async () => {
    const store = recorder();
    const { exec, calls } = makeExec();

    const report = await runRemediationPhase({
      payload: UNHEALTHY,
      options: makeOptions(),
      host: HOST,
      remoteDir: REMOTE_DIR,
      statePath: "/nope/mush_devops_remediation.json",
      exec,
      readState: store.readState,
      writeState: async () => {
        throw new Error("EACCES: permission denied");
      }
    });

    expect(report).toContain("ERROR");
    expect(report).toContain("auto-remediation did not run");
    expect(report).toContain("cooldown marker could not be written");
    expect(report).toContain("EACCES: permission denied");
    expect(calls).toEqual([]);
  });

  test("still reports the restart when the final state write fails", async () => {
    const store = recorder();
    let writes = 0;
    const { exec, calls } = makeExec();

    const report = await runRemediationPhase({
      payload: UNHEALTHY,
      options: makeOptions(),
      host: HOST,
      remoteDir: REMOTE_DIR,
      statePath: "/tmp/state.json",
      exec,
      readState: store.readState,
      writeState: async () => {
        writes += 1;
        if (writes > 1) throw new Error("ENOSPC: no space left on device");
      }
    });

    expect(calls).toContain("restart");
    expect(report).toContain("SUCCEEDED");
    expect(report).toContain("Note: The result above is real");
    expect(report).toContain("could not be updated");
    expect(report).toContain("ENOSPC");
    expect(writes).toBe(2);
  });

  test("an exploding remediation runner becomes an error outcome, and state is still finalized", async () => {
    const store = recorder();

    const report = await runRemediationPhase({
      payload: UNHEALTHY,
      options: makeOptions(),
      host: HOST,
      remoteDir: REMOTE_DIR,
      exec: async () => ok(""),
      remediate: async () => {
        throw new Error("remediation runner exploded");
      },
      readState: store.readState,
      writeState: store.writeState
    });

    expect(report).toContain("ERROR");
    expect(report).toContain("remediation runner exploded");
    expect(store.writes).toHaveLength(2);
    expect(store.writes[0].backends["gpu-1"].lastOutcome).toBe("in-progress");
    expect(store.writes[1].backends["gpu-1"]).toMatchObject({ lastOutcome: "error", attempts: 1, consecutiveFailures: 1 });
  });

  test("redacts secrets that straddle the preview cutoff in ordinary findings", () => {
    const UUID = "0f2b5c1e-11aa-4d33-9f77-8b2a6c4e5d10";
    const payload = skippedVastPayload();
    payload.results[1] = {
      key: "vastStatus",
      label: "Vast status",
      exitCode: 1,
      stderr: `${"log ".repeat(120)}${UUID} trailing noise that is cut off by the preview limit`
    } as (typeof payload.results)[number];

    const findings = collectFindings(payload, { lowBalanceThreshold: 5 });

    expect(findings).toHaveLength(1);
    expect(findings[0]).not.toContain(UUID);
    expect(findings[0]).not.toContain(UUID.slice(0, 20));
    expect(findings[0]).toContain("[redacted]");
  });
});

/**
 * REGRESSION: the circuit-breaker auto-reset used to treat "we could not see the backends" as
 * "the backends recovered". `detectGpuRemediationTargets` only names backends when the gateway
 * enumerated them, so a gateway-level outage produced an EMPTY detected list and silently closed
 * every open breaker — handing the box three more automated restarts with zero evidence.
 */
describe("circuit-breaker auto-reset demands positive evidence", () => {
  const HOST = "tim@89.167.72.52";
  const REMOTE_DIR = "/home/tim/pkg/mush/mush-devops";
  const GATEWAY_URL = "ssh://root@162.55.45.186 http://127.0.0.1:3081/admin/backends";

  function gpuResult(overrides: Record<string, unknown>) {
    return {
      componentId: "remote-inference",
      componentName: "Remote Inference (GPU Service)",
      url: GATEWAY_URL,
      ...overrides
    };
  }

  function payload(results: Array<Record<string, unknown>>) {
    return {
      checkedAt: "2026-09-12T12:00:00.000Z",
      results: [{ key: "http", label: "HTTP health", exitCode: 1, parsed: { results } }]
    };
  }

  function options(overrides: Record<string, unknown> = {}) {
    return {
      autoRemediate: true,
      dryRun: false,
      cooldownMinutes: 45,
      remediationTimeoutSec: 180,
      gatewaySshOverride: null,
      ...overrides
    };
  }

  function openBreakers(...backendIds: string[]) {
    const backends: Record<string, unknown> = {};
    for (const backendId of backendIds) {
      backends[backendId] = {
        lastAttemptAt: "2026-09-12T10:00:00.000Z",
        lastOutcome: "failed",
        attempts: 4,
        consecutiveFailures: 3
      };
    }
    return { version: 1, backends };
  }

  function recorder(initial: unknown) {
    const writes: any[] = [];
    return {
      writes,
      readState: async () => JSON.parse(JSON.stringify(initial)),
      writeState: async (_path: string, state: unknown) => {
        writes.push(JSON.parse(JSON.stringify(state)));
      }
    };
  }

  function run(payloadValue: unknown, store: ReturnType<typeof recorder>, calls: string[]) {
    return runRemediationPhase({
      payload: payloadValue,
      options: options(),
      host: HOST,
      remoteDir: REMOTE_DIR,
      statePath: "/tmp/does-not-matter.json",
      exec: async (_command: string, args: string[]) => {
        calls.push(String(args[args.length - 1]));
        return { exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false };
      },
      readState: store.readState,
      writeState: store.writeState
    });
  }

  test("an unreachable gateway never clears an open breaker", async () => {
    const store = recorder(openBreakers("gpu-1"));
    const calls: string[] = [];

    const report = await run(
      payload([gpuResult({ status: "unhealthy", error: "connect ECONNREFUSED 127.0.0.1:3081" })]),
      store,
      calls
    );

    expect(report).toBe("");
    // The breaker stays open: nothing was written, so gpu-1 keeps its streak of 3.
    expect(store.writes).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("other unobservable gateway failures are equally uninformative", async () => {
    for (const error of ["timeout of 5000ms exceeded", "getaddrinfo ENOTFOUND gateway.internal"]) {
      const store = recorder(openBreakers("gpu-1"));
      await run(payload([gpuResult({ status: "unhealthy", error })]), store, []);
      expect(store.writes).toEqual([]);
    }
    // A skipped GPU check is not evidence either.
    const skipped = recorder(openBreakers("gpu-1"));
    await run(payload([gpuResult({ status: "skipped", skipped: true })]), skipped, []);
    expect(skipped.writes).toEqual([]);
  });

  test("a healthy gateway response does clear the breaker", async () => {
    const store = recorder(openBreakers("gpu-1"));

    const report = await run(payload([gpuResult({ status: "healthy", httpStatus: 200 })]), store, []);

    expect(report).toBe("");
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0].backends["gpu-1"].consecutiveFailures).toBe(0);
    expect(store.writes[0].backends["gpu-1"].attempts).toBe(4);
  });

  test("an enumeration clears only the backends it did not name", async () => {
    const store = recorder(openBreakers("gpu-1", "gpu-2"));

    const report = await run(
      payload([
        gpuResult({
          status: "unhealthy",
          error: "Enabled backend(s) unhealthy: gpu-gateway/gpu-1 (182.224.239.168:63571)."
        })
      ]),
      store,
      []
    );

    expect(store.writes).toHaveLength(1);
    // gpu-2 was not named by an enumeration we actually received, so it is positively healthy.
    expect(store.writes[0].backends["gpu-2"].consecutiveFailures).toBe(0);
    // gpu-1 was named: its breaker stays open and the run reports the suspension instead of acting.
    expect(store.writes[0].backends["gpu-1"].consecutiveFailures).toBe(3);
    expect(report).toContain("SKIPPED (circuit open)");
  });

  test("an http check with no gpu component result clears nothing", async () => {
    const store = recorder(openBreakers("gpu-1"));

    const report = await run(
      payload([
        { componentId: "ai-stylist-workshop", componentName: "Workshop", status: "healthy" },
        { componentId: "api", componentName: "API", status: "unhealthy", error: "HTTP 500" }
      ]),
      store,
      []
    );

    expect(report).toBe("");
    expect(store.writes).toEqual([]);
  });
});

describe("alert rendering redaction", () => {
  test("an API-key-shaped UUID in an http finding never reaches the alert text", () => {
    const KEY = "3f9a1c72-8b4e-4d21-9a55-6c0e7f2b1d84";
    const findings = collectFindings(
      {
        checkedAt: "2026-09-12T12:00:00.000Z",
        results: [
          {
            key: "http",
            label: "HTTP health",
            exitCode: 1,
            parsed: {
              results: [
                {
                  componentId: "remote-inference",
                  componentName: "Remote Inference (GPU Service)",
                  status: "unhealthy",
                  url: `http://127.0.0.1:3081/admin/backends?api_key=${KEY}`,
                  error: `gateway said {"apiKey":"${KEY}"} for gpu-1`
                }
              ]
            }
          }
        ]
      },
      { lowBalanceThreshold: 5 }
    );

    expect(findings.some((finding) => finding.includes("Remote Inference"))).toBe(true);

    const alert = formatAlert({
      checkedAt: "2026-09-12T12:00:00.000Z",
      host: "tim@89.167.72.52",
      remoteDir: "/home/tim/pkg/mush/mush-devops",
      findings
    });

    expect(alert).not.toContain(KEY);
    expect(alert).toContain("[redacted]");
    // The rest of the alert is intact.
    expect(alert).toContain("Mush DevOps health check alert");
    expect(alert).toContain("Target: tim@89.167.72.52:/home/tim/pkg/mush/mush-devops");
    expect(alert).toContain("Remote Inference (GPU Service)");
  });
});

/**
 * Vast rebuilds a GPU box and hands the same instance a new direct-SSH host port. That is routine
 * churn, not an incident, and used to page every 15 minutes forever. It is now debounced to one
 * notice per rebuild event, while genuinely wrong drift stays loud.
 */
describe("benign Vast SSH-port renumbering is debounced", () => {
  async function tmpNoticeStatePath() {
    const dir = await mkdtemp(path.join(tmpdir(), "vast-drift-notices-"));
    return path.join(dir, "mush_devops_vast_drift_notices.json");
  }

  async function readNotices(statePath: string) {
    return JSON.parse(await readFile(statePath, "utf8"));
  }

  // gpu-1 as it really is today: 182.224.239.168, sshPort 63530, servicePort 63571, instance 46154118.
  function benign(overrides: Record<string, unknown> = {}, actualSshPort = 63999) {
    return {
      logicalId: "gpu-1",
      vastInstanceId: 46154118,
      drifted: true,
      driftClass: "ssh-port-renumber",
      diffs: [`sshPort: 63530 -> ${actualSshPort}`],
      expected: { host: "182.224.239.168", sshPort: 63530, servicePort: 63571, sshMode: "direct" },
      actual: {
        host: "182.224.239.168",
        sshPort: actualSshPort,
        servicePort: 63571,
        sshMode: "direct",
        status: "running"
      },
      ...overrides
    };
  }

  // gpu-2 with a moved service port: not a clean renumber, so it must page.
  function unexpected(overrides: Record<string, unknown> = {}) {
    return {
      logicalId: "gpu-2",
      vastInstanceId: 46153242,
      drifted: true,
      driftClass: "unexpected",
      diffs: ["servicePort: 61754 -> 61999", "host: 182.224.239.168 -> 91.0.0.7"],
      expected: { host: "182.224.239.168", sshPort: 61785, servicePort: 61754, sshMode: "direct" },
      actual: { host: "91.0.0.7", sshPort: 61785, servicePort: 61999, sshMode: "direct", status: "running" },
      ...overrides
    };
  }

  function clean() {
    return {
      logicalId: "gpu-1",
      vastInstanceId: 46154118,
      drifted: false,
      driftClass: "none",
      diffs: [],
      expected: { host: "182.224.239.168", sshPort: 63530, servicePort: 63571, sshMode: "direct" },
      actual: { host: "182.224.239.168", sshPort: 63530, servicePort: 63571, sshMode: "direct" }
    };
  }

  function driftPayload(parsed: Record<string, unknown>, exitCode = 0) {
    return {
      checkedAt: "2026-09-14T12:00:00.000Z",
      results: [
        { key: "http", label: "HTTP health", exitCode: 0, parsed: { results: [] } },
        { key: "vastStatus", label: "Vast status", exitCode: 0, parsed: { healthy: true, balance: 42 } },
        {
          key: "vastDrift",
          label: "Vast drift",
          exitCode,
          stdout: JSON.stringify(parsed),
          stderr: "",
          parsed
        }
      ]
    };
  }

  function noticeOnly(comparisons: Array<Record<string, unknown>>) {
    return driftPayload({
      drifted: comparisons.some((comparison) => comparison.drifted === true),
      actionableDrift: false,
      benignDrift: comparisons.some((comparison) => comparison.driftClass === "ssh-port-renumber"),
      driftSeverity: comparisons.some((comparison) => comparison.driftClass === "ssh-port-renumber")
        ? "notice"
        : "none",
      comparisons
    });
  }

  function run(payload: unknown, driftNoticeStatePath: string) {
    return collectFindings(payload, { lowBalanceThreshold: 5, driftNoticeStatePath });
  }

  test("first observation of a rebuild raises exactly one low-urgency notice and records it", async () => {
    const statePath = await tmpNoticeStatePath();

    const findings = run(noticeOnly([benign()]), statePath);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("Vast drift notice (low urgency, no action needed right now)");
    expect(findings[0]).toContain("gpu-1 (Vast instance 46154118)");
    expect(findings[0]).toContain("SSH port 63530 -> 63999");
    expect(findings[0]).toContain('run "node scripts/vast/vast-drift.js --update"');
    expect(findings[0]).toContain("deploy-systemd.sh");
    // Never dressed up as an incident.
    expect(findings[0]).not.toContain("Vast drift detected.");

    const persisted = await readNotices(statePath);
    expect(persisted).toMatchObject({
      version: 1,
      notices: { "46154118": { sshPort: 63999, logicalId: "gpu-1" } }
    });
  });

  test("the same rebuilt port stays quiet on every later check", async () => {
    const statePath = await tmpNoticeStatePath();

    expect(run(noticeOnly([benign()]), statePath)).toHaveLength(1);
    expect(run(noticeOnly([benign()]), statePath)).toEqual([]);
    expect(run(noticeOnly([benign()]), statePath)).toEqual([]);

    expect((await readNotices(statePath)).notices["46154118"].sshPort).toBe(63999);
  });

  test("a second rebuild onto a new port is a new event and notifies again", async () => {
    const statePath = await tmpNoticeStatePath();

    expect(run(noticeOnly([benign()]), statePath)).toHaveLength(1);
    expect(run(noticeOnly([benign()]), statePath)).toEqual([]);

    const second = run(noticeOnly([benign({ diffs: ["sshPort: 63530 -> 64100"] }, 64100)]), statePath);
    expect(second).toHaveLength(1);
    expect(second[0]).toContain("SSH port 63530 -> 64100");

    expect((await readNotices(statePath)).notices["46154118"].sshPort).toBe(64100);
  });

  test("a reconciled instance is pruned, so the same port alerts again if it comes back", async () => {
    const statePath = await tmpNoticeStatePath();

    expect(run(noticeOnly([benign()]), statePath)).toHaveLength(1);

    // Someone ran vast-drift.js --update: the box stops reporting drift, and the ledger is emptied.
    expect(run(noticeOnly([clean()]), statePath)).toEqual([]);
    expect((await readNotices(statePath)).notices).toEqual({});

    // Same port comes back later (a fresh rebuild that happened to land on it): loud again.
    expect(run(noticeOnly([benign()]), statePath)).toHaveLength(1);
  });

  test("an instance that vanishes from the comparison list is pruned too", async () => {
    const statePath = await tmpNoticeStatePath();

    expect(run(noticeOnly([benign()]), statePath)).toHaveLength(1);
    expect(run(noticeOnly([]), statePath)).toEqual([]);
    expect((await readNotices(statePath)).notices).toEqual({});
  });

  test("actionable drift always pages, even when a benign notice for it was already recorded", async () => {
    const statePath = await tmpNoticeStatePath();
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        notices: {
          "46154118": {
            sshPort: 63999,
            logicalId: "gpu-1",
            reportedAt: "2026-09-14T11:00:00.000Z",
            lastSeenAt: "2026-09-14T11:45:00.000Z"
          }
        }
      })
    );

    const payload = driftPayload({
      drifted: true,
      actionableDrift: true,
      benignDrift: false,
      driftSeverity: "alert",
      comparisons: [benign({ logicalId: "gpu-1", driftClass: "unexpected", diffs: ["sshMode: direct -> proxy"] })]
    });

    // Every run pages: no debounce is ever applied to actionable drift.
    for (let tick = 0; tick < 3; tick += 1) {
      expect(run(payload, statePath)).toEqual(["Vast drift detected. gpu-1: sshMode: direct -> proxy"]);
    }
  });

  test("a benign renumber never pads or obscures actionable drift in the same payload", async () => {
    const statePath = await tmpNoticeStatePath();

    const findings = run(
      driftPayload({
        drifted: true,
        actionableDrift: true,
        benignDrift: true,
        driftSeverity: "alert",
        comparisons: [benign(), unexpected()]
      }),
      statePath
    );

    expect(findings).toEqual([
      "Vast drift detected. gpu-2: servicePort: 61754 -> 61999; host: 182.224.239.168 -> 91.0.0.7"
    ]);
    expect(findings[0]).not.toContain("gpu-1");
    expect(findings[0]).not.toContain("low urgency");
  });

  test("a drifted comparison with no driftClass is treated as actionable, not swallowed", async () => {
    const statePath = await tmpNoticeStatePath();

    const findings = run(
      driftPayload({
        drifted: true,
        actionableDrift: false,
        benignDrift: false,
        driftSeverity: "none",
        comparisons: [{ logicalId: "gpu-2", drifted: true, diffs: ["host: a -> b"] }]
      }),
      statePath
    );

    expect(findings).toEqual(["Vast drift detected. gpu-2: host: a -> b"]);
  });

  test("backward compatible: a payload without actionableDrift still alerts on any drift", async () => {
    const statePath = await tmpNoticeStatePath();

    const findings = run(
      driftPayload({
        drifted: true,
        comparisons: [
          {
            logicalId: "gpu-1",
            vastInstanceId: 46154118,
            drifted: true,
            diffs: ["sshPort: 63530 -> 63999"]
          }
        ]
      }),
      statePath
    );

    // Exactly the pre-contract behavior, repeated on every run: version skew must never suppress drift.
    expect(findings).toEqual(["Vast drift detected. gpu-1: sshPort: 63530 -> 63999"]);
    expect(run(noticeOnly([]), statePath)).toEqual([]);
  });

  test("a corrupt state file degrades to alerting once and then repairs itself", async () => {
    const statePath = await tmpNoticeStatePath();
    await writeFile(statePath, "{ this is not json");

    const findings = run(noticeOnly([benign()]), statePath);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("Vast drift notice");
    expect(findings[0]).toContain("could not be read");

    // The ledger was rewritten, so the very next check is quiet again.
    expect(run(noticeOnly([benign()]), statePath)).toEqual([]);
  });

  test("an unreadable and unwritable state file still alerts and never throws", async () => {
    // A directory where the ledger should be: every read AND every write fails.
    const statePath = await mkdtemp(path.join(tmpdir(), "vast-drift-notice-dir-"));

    let findings: string[] = [];
    expect(() => {
      findings = run(noticeOnly([benign()]), statePath);
    }).not.toThrow();

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("Vast drift notice");
    expect(findings[0]).toContain("could not be read");
    expect(findings[0]).toContain("could not be written");

    // Nothing was recorded, so it keeps alerting rather than silently swallowing the drift.
    expect(run(noticeOnly([benign()]), statePath)).toHaveLength(1);
  });

  test("a state-writer that throws still lets the notice through", async () => {
    const findings = collectFindings(noticeOnly([benign()]), {
      lowBalanceThreshold: 5,
      driftNoticeStatePath: "/tmp/never-touched.json",
      readDriftNoticeState: () => ({ state: { version: 1, notices: {} }, error: null }),
      writeDriftNoticeState: () => {
        throw new Error("disk on fire");
      }
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("could not be written");
    expect(findings[0]).toContain("disk on fire");
  });

  test("a nonzero exit with no drift at all is still reported", async () => {
    const statePath = await tmpNoticeStatePath();

    const findings = run(
      driftPayload(
        { drifted: false, actionableDrift: false, benignDrift: false, driftSeverity: "none", comparisons: [] },
        2
      ),
      statePath
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("Vast drift exited 2");
  });

  test("the ledger is bounded: only the most recently seen entries survive", () => {
    const notices: Record<string, unknown> = {};
    for (let index = 0; index < 100; index += 1) {
      notices[`instance-${index}`] = {
        sshPort: 60000 + index,
        logicalId: `gpu-${index}`,
        reportedAt: "2026-09-14T10:00:00.000Z",
        lastSeenAt: new Date(Date.parse("2026-09-14T10:00:00.000Z") + index * 1000).toISOString()
      };
    }

    const capped = capDriftNoticeState({ version: 1, notices });
    const keys = Object.keys(capped.notices);

    expect(keys).toHaveLength(32);
    expect(keys).toContain("instance-99");
    expect(keys).not.toContain("instance-0");
  });
});

describe("transient SSH transport failures on HTTP targets", () => {
  const MAXSTARTUPS =
    "kex_exchange_identification: read: Connection reset by peer\r\nConnection reset by 167.235.230.130 port 22";
  const CLOSED = "kex_exchange_identification: Connection closed by remote host\r\nConnection closed by 167.235.230.130 port 22";

  function lb(overrides: Record<string, unknown> = {}) {
    return {
      componentId: "staging-backend-load-balancer",
      componentName: "Staging Backend Load Balancer",
      instance: null,
      url: "ssh://root@167.235.230.130 http://127.0.0.1:3082/admin/backends",
      status: "unreachable",
      responseTimeMs: 120,
      httpStatus: null,
      error: CLOSED,
      attempts: [],
      ...overrides
    };
  }

  function payloadWith(results: unknown[]) {
    return {
      checkedAt: "2026-09-25T10:00:00.000Z",
      results: [
        { key: "http", label: "HTTP health", exitCode: 1, status: "fail", parsed: { results } },
        { key: "vastStatus", label: "Vast status", exitCode: 0, parsed: { healthy: true, balance: 50 } },
        { key: "vastDrift", label: "Vast drift", exitCode: 0, parsed: { drifted: false, comparisons: [] } }
      ]
    };
  }

  function harness(freshSequence: unknown[][], { previousKeys = [] as string[], requireConsecutive = true } = {}) {
    const calls: string[] = [];
    const sleeps: number[] = [];
    const logs: string[] = [];
    let written: string[] | null = null;
    let call = 0;
    const options = {
      runner: async (componentId: string) => {
        calls.push(componentId);
        const next = freshSequence[Math.min(call, freshSequence.length - 1)];
        call += 1;
        return next;
      },
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
      log: (line: string) => logs.push(line),
      requireConsecutive,
      readInconclusiveState: () => previousKeys,
      writeInconclusiveState: (_p: string, keys: string[]) => {
        written = keys;
      }
    };
    return { options, calls, sleeps, logs, written: () => written };
  }

  test("classifier: SSH transport drops before any HTTP response are transient", () => {
    for (const error of [
      CLOSED,
      MAXSTARTUPS,
      "kex_exchange_identification: Exceeded MaxStartups",
      "Connection closed by 167.235.230.130 port 22",
      "Connection timed out during banner exchange\r\nConnection to 167.235.230.130 port 22 timed out",
      "ssh_exchange_identification: read: Connection reset by peer"
    ]) {
      expect(isTransientSshTransportFailure(lb({ error })), error).toBe(true);
    }
    expect(isTransientSshTransportFailure(lb({ exitCode: 255 }))).toBe(true);
    expect(isTransientSshTransportFailure(lb({ error: "", stderr: CLOSED }))).toBe(true);
  });

  test("classifier: real failures are never transient", () => {
    for (const error of [
      "root@167.235.230.130: Permission denied (publickey).",
      "ssh: connect to host 167.235.230.130 port 22: No route to host",
      "ssh: Could not resolve hostname staging-lb: Name or service not known",
      "ssh: connect to host 167.235.230.130 port 22: Connection timed out",
      "ssh: connect to host 167.235.230.130 port 22: Connection refused",
      "curl: (7) Failed to connect to 127.0.0.1 port 3082 after 0 ms: Connection refused",
      "curl: (56) Recv failure: Connection reset by peer",
      "Expected HTTP 200, received 502.",
      "Command failed: ssh -o BatchMode=yes root@167.235.230.130 curl"
    ]) {
      expect(isTransientSshTransportFailure(lb({ error })), error).toBe(false);
    }
    // An HTTP status means the service answered.
    expect(isTransientSshTransportFailure(lb({ status: "unhealthy", httpStatus: 503 }))).toBe(false);
    // A non-255 exit code is the remote command's, so ssh connected.
    expect(isTransientSshTransportFailure(lb({ exitCode: 7 }))).toBe(false);
    expect(isTransientSshTransportFailure(lb({ status: "healthy", error: CLOSED }))).toBe(false);
    expect(isTransientSshTransportFailure(null)).toBe(false);
  });

  test("retry that comes back healthy drops the finding entirely", async () => {
    const h = harness([[lb({ status: "healthy", httpStatus: 200, error: null })]]);
    const resolved = await resolveTransientHttpFailures(payloadWith([lb()]), h.options);
    expect(collectFindings(resolved)).toEqual([]);
    expect(h.calls).toEqual(["staging-backend-load-balancer"]);
    expect(h.sleeps).toEqual([2000]);
    expect(h.logs.join("\n")).toContain("recovered on retry 2/3");
  });

  test("all attempts transient: inconclusive warning, never 'unreachable' (2nd consecutive run)", async () => {
    const h = harness([[lb({ error: MAXSTARTUPS })]], {
      previousKeys: ["staging-backend-load-balancer::"]
    });
    const findings = collectFindings(await resolveTransientHttpFailures(payloadWith([lb()]), h.options));
    expect(h.calls).toHaveLength(2);
    expect(h.sleeps).toEqual([2000, 5000]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(
      /^Warning: Staging Backend Load Balancer check inconclusive — SSH transient failure after 3 attempts \(.*Connection reset by 167\.235\.230\.130 port 22.*\); service itself not verified\.$/
    );
    expect(findings.join("\n")).not.toContain("HTTP health unreachable");
  });

  test("all attempts transient on the first run: silent on stdout, remembered for next run", async () => {
    const h = harness([[lb()]]);
    const findings = collectFindings(await resolveTransientHttpFailures(payloadWith([lb()]), h.options));
    expect(findings).toEqual([]);
    expect(h.written()).toEqual(["staging-backend-load-balancer::"]);
    expect(h.logs.join("\n")).toContain("silent until it repeats next run");
  });

  test("gating disabled: all-transient warns immediately", async () => {
    const h = harness([[lb()]], { requireConsecutive: false });
    const findings = collectFindings(await resolveTransientHttpFailures(payloadWith([lb()]), h.options));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("check inconclusive");
  });

  test("jitter stays within +/-25% of the 2s / 5s backoff", async () => {
    for (const r of [0, 1]) {
      const h = harness([[lb()]]);
      h.options.random = () => r;
      await resolveTransientHttpFailures(payloadWith([lb()]), h.options);
      expect(h.sleeps).toEqual(r === 0 ? [1500, 3750] : [2500, 6250]);
    }
  });

  test("a real failure is reported unchanged and never retried", async () => {
    const real = lb({ error: "ssh: connect to host 167.235.230.130 port 22: Connection refused" });
    const h = harness([[lb({ status: "healthy", httpStatus: 200, error: null })]]);
    const resolved = await resolveTransientHttpFailures(payloadWith([real]), h.options);
    expect(h.calls).toEqual([]);
    expect(h.sleeps).toEqual([]);
    expect(collectFindings(resolved)).toEqual(collectFindings(payloadWith([real])));
    expect(collectFindings(resolved)[0]).toMatch(/^HTTP health unreachable: Staging Backend Load Balancer/);
  });

  test("retry that returns a real failure reports that failure as usual", async () => {
    const real = lb({ status: "unhealthy", httpStatus: 502, error: "Expected HTTP 200, received 502." });
    const h = harness([[real]]);
    const findings = collectFindings(await resolveTransientHttpFailures(payloadWith([lb()]), h.options));
    expect(h.calls).toHaveLength(1);
    expect(findings).toEqual([
      "HTTP health unhealthy: Staging Backend Load Balancer at ssh://root@167.235.230.130 http://127.0.0.1:3082/admin/backends. HTTP 502. 120ms. Expected HTTP 200, received 502."
    ]);
  });

  test("a runner that throws counts as another transient attempt", async () => {
    const h = harness([[lb()]], { previousKeys: ["staging-backend-load-balancer::"] });
    h.options.runner = async () => {
      throw new Error("ssh to jump host failed");
    };
    const findings = collectFindings(await resolveTransientHttpFailures(payloadWith([lb()]), h.options));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("check inconclusive");
    expect(h.logs.join("\n")).toContain("could not run");
  });

  test("healthy payload: no runner calls, no state write, input not mutated", async () => {
    const payload = payloadWith([lb({ status: "healthy", httpStatus: 200, error: null })]);
    const snapshot = JSON.stringify(payload);
    const h = harness([[]]);
    const resolved = await resolveTransientHttpFailures(payload, h.options);
    expect(h.calls).toEqual([]);
    expect(h.written()).toBeNull();
    expect(collectFindings(resolved)).toEqual([]);
    expect(JSON.stringify(payload)).toBe(snapshot);
  });
});
