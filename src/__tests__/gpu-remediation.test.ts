import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

const mod = await import("../../scripts/lib/gpu-remediation.mjs");

const {
  OUTCOMES,
  buildTwoHopSshArgs,
  detectGpuRemediationTargets,
  describeTarget,
  formatRemediationReport,
  normalizeRemediationState,
  parseBackendHealth,
  parseGatewaySshTarget,
  parseRemediationScriptOutput,
  readRemediationState,
  recordRemediationAttempt,
  redactSecrets,
  redactedTail,
  resolveBackendEndpoint,
  runGpuRemediation,
  shellQuote,
  shellQuoteNested,
  shouldAttemptRemediation,
  writeRemediationState,
} = mod as any;

// The exact alert text Tim gets when the Vast box's remote-inference service dies.
const REAL_ERROR =
  "Enabled backend(s) unhealthy: gpu-gateway/gpu-1 (182.224.239.168:63571).";
const REAL_URL = "ssh://root@162.55.45.186 http://127.0.0.1:3081/admin/backends";

function httpCheck(results: Array<Record<string, unknown>>) {
  return { key: "http", label: "HTTP health", exitCode: 1, parsed: { results } };
}

function remoteInferenceResult(overrides: Record<string, unknown> = {}) {
  return {
    componentId: "remote-inference",
    componentName: "Remote Inference (GPU Service)",
    status: "unhealthy",
    url: REAL_URL,
    httpStatus: 200,
    responseTimeMs: 2008,
    error: REAL_ERROR,
    ...overrides,
  };
}

describe("gpu remediation detection", () => {
  test("detects the production gpu-1 signature", () => {
    const targets = detectGpuRemediationTargets(httpCheck([remoteInferenceResult()]));

    expect(targets).toEqual([
      {
        componentId: "remote-inference",
        componentName: "Remote Inference (GPU Service)",
        gatewayService: "gpu-gateway",
        backendId: "gpu-1",
        address: "182.224.239.168",
        port: 63571,
        gatewaySshTarget: "root@162.55.45.186",
      },
    ]);
  });

  test("detects every backend in a multi-backend finding without hardcoding gpu-1", () => {
    const targets = detectGpuRemediationTargets(
      httpCheck([
        remoteInferenceResult({
          error:
            "Enabled backend(s) unhealthy: gpu-gateway/gpu-2 (1.2.3.4:63572), gpu-gateway/gpu-3 (5.6.7.8:63573).",
        }),
      ]),
    );

    expect(targets.map((target: any) => target.backendId)).toEqual(["gpu-2", "gpu-3"]);
    expect(targets[1]).toMatchObject({ address: "5.6.7.8", port: 63573 });
  });

  test("ignores non-GPU backends and non-GPU components", () => {
    const targets = detectGpuRemediationTargets(
      httpCheck([
        {
          componentId: "ai-stylist-workshop",
          componentName: "AI Stylist Workshop",
          status: "unhealthy",
          url: "ssh://root@10.0.0.1 http://127.0.0.1:3080/admin/backends",
          error: "Enabled backend(s) unhealthy: web-gateway/web-1 (10.0.0.2:8080).",
        },
      ]),
    );

    expect(targets).toEqual([]);
  });

  test("picks only the GPU backend out of a mixed finding", () => {
    const targets = detectGpuRemediationTargets(
      httpCheck([
        {
          componentId: "inference-gateway",
          componentName: "Inference Gateway",
          status: "unhealthy",
          url: REAL_URL,
          error:
            "Enabled backend(s) unhealthy: web-gateway/web-1 (10.0.0.2:8080), gpu-gateway/gpu-1 (182.224.239.168:63571).",
        },
      ]),
    );

    expect(targets.map((target: any) => target.backendId)).toEqual(["gpu-1"]);
  });

  test("dedupes the same backend reported by several results", () => {
    const targets = detectGpuRemediationTargets(
      httpCheck([remoteInferenceResult(), remoteInferenceResult({ instance: "second-probe" })]),
    );

    expect(targets).toHaveLength(1);
  });

  test("ignores healthy, skipped, malformed, and error-less results", () => {
    expect(
      detectGpuRemediationTargets(
        httpCheck([
          remoteInferenceResult({ status: "healthy" }),
          remoteInferenceResult({ status: "skipped" }),
          remoteInferenceResult({ error: undefined }),
          remoteInferenceResult({ error: null }),
          remoteInferenceResult({ error: 42 }),
          remoteInferenceResult({ error: "connect ECONNREFUSED 127.0.0.1:3081" }),
          remoteInferenceResult({ error: "Enabled backend(s) unhealthy: totally malformed" }),
          null,
          "nonsense",
        ]),
      ),
    ).toEqual([]);

    expect(detectGpuRemediationTargets(undefined)).toEqual([]);
    expect(detectGpuRemediationTargets({ parsed: {} })).toEqual([]);
    expect(detectGpuRemediationTargets({ parsed: { results: "nope" } })).toEqual([]);
  });

  test("resolves the gateway ssh target from the url, honoring the env override", () => {
    expect(parseGatewaySshTarget(REAL_URL)).toBe("root@162.55.45.186");
    expect(parseGatewaySshTarget(REAL_URL, "root@override.invalid")).toBe("root@override.invalid");
    expect(parseGatewaySshTarget("http://127.0.0.1:3081/admin/backends")).toBeNull();
    expect(parseGatewaySshTarget(undefined)).toBeNull();

    const targets = detectGpuRemediationTargets(
      httpCheck([remoteInferenceResult({ url: "http://127.0.0.1:3081/admin/backends" })]),
    );
    expect(targets[0].gatewaySshTarget).toBeNull();
  });

  test("describes a target the way the alert renders it", () => {
    expect(describeTarget(detectGpuRemediationTargets(httpCheck([remoteInferenceResult()]))[0])).toBe(
      "gpu-gateway/gpu-1 (182.224.239.168:63571)",
    );
  });
});

describe("secret redaction", () => {
  // Shaped like the real gateway response, which this script would otherwise pipe to Telegram.
  const GATEWAY_BODY = JSON.stringify([
    {
      id: "gpu-1",
      address: "182.224.239.168",
      port: 63571,
      enabled: true,
      apiKey: "0f2b5c1e-11aa-4d33-9f77-8b2a6c4e5d10",
      metadata: { api_key: "sk-live-abc123", region: "eu" },
      health: { status: "unhealthy", consecutiveFailures: 6, consecutiveSuccesses: 0 },
    },
  ]);

  test("removes api_key and apiKey values from a gateway payload", () => {
    const redacted = redactSecrets(GATEWAY_BODY);

    expect(redacted).not.toContain("sk-live-abc123");
    expect(redacted).not.toContain("0f2b5c1e-11aa-4d33-9f77-8b2a6c4e5d10");
    expect(redacted).toContain("[redacted]");
    // Non-secret diagnostics survive.
    expect(redacted).toContain("182.224.239.168");
    expect(redacted).toContain("63571");
    expect(redacted).toContain("consecutiveFailures");
  });

  test("removes API_KEY env lines and bare uuid/hex tokens", () => {
    const redacted = redactSecrets(
      [
        "API_KEY=super-secret-value",
        "export GATEWAY_TOKEN='another-secret'",
        "BACKGROUND_REMOVAL_MAX_IN_FLIGHT=2",
        "request id 0f2b5c1e-11aa-4d33-9f77-8b2a6c4e5d10 failed",
        "hash 8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92",
      ].join("\n"),
    );

    expect(redacted).not.toContain("super-secret-value");
    expect(redacted).not.toContain("another-secret");
    expect(redacted).not.toContain("0f2b5c1e-11aa-4d33-9f77-8b2a6c4e5d10");
    expect(redacted).not.toContain("8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92");
    expect(redacted).toContain("API_KEY=[redacted]");
    expect(redacted).toContain("BACKGROUND_REMOVAL_MAX_IN_FLIGHT=2");
  });

  test("redacts log tails and tolerates empty input", () => {
    expect(redactSecrets(null)).toBe("");
    expect(redactedTail("a\nb\n\nAPI_KEY=zzz\n", 2)).toEqual(["b", "API_KEY=[redacted]"]);
  });
});

describe("shell quoting", () => {
  const NASTY = `it's "quoted" $(rm -rf /) \`whoami\` \\ and | & ; newline\nend`;

  test("survives one shell layer", () => {
    const out = execFileSync("bash", ["-c", `printf %s ${shellQuote(NASTY)}`], { encoding: "utf8" });
    expect(out).toBe(NASTY);
  });

  test("survives two shell parses when appended to an ssh argument list", () => {
    // Mimics `ssh host <words...>`: the local shell strips one layer, ssh re-joins the
    // remaining arguments, and the remote shell strips the second layer.
    const dir = mkdtempSync(path.join(tmpdir(), "join-ssh-"));
    const fake = path.join(dir, "joinssh");
    writeFileSync(fake, '#!/usr/bin/env bash\nshift\nexec bash -c "$*"\n');
    chmodSync(fake, 0o755);

    const out = execFileSync("bash", ["-c", `${fake} host printf %s ${shellQuoteNested(NASTY)}`], {
      encoding: "utf8",
    });
    expect(out).toBe(NASTY);

    // A single layer of quoting would NOT survive both parses.
    const single = execFileSync("bash", ["-c", `${fake} host printf %s ${shellQuote(NASTY)} 2>/dev/null || true`], {
      encoding: "utf8",
    });
    expect(single).not.toBe(NASTY);
  });

  test("builds a nested two-hop ssh invocation that reaches the box intact", () => {
    const args = buildTwoHopSshArgs({
      jumpHost: "tim@89.167.72.52",
      target: "root@182.224.239.168",
      sshPort: 63530,
      remoteCommand: `printf %s ${shellQuote(NASTY)}`,
    });

    expect(args[args.length - 2]).toBe("tim@89.167.72.52");
    expect(args[args.length - 1]).toContain("-p '63530' 'root@182.224.239.168'");

    // Run the whole two-hop command through a fake `ssh` that executes its final argument,
    // proving the quoting survives both hops.
    const dir = mkdtempSync(path.join(tmpdir(), "fake-ssh-"));
    const fake = path.join(dir, "ssh");
    writeFileSync(fake, '#!/usr/bin/env bash\ncmd="${@: -1}"\nexec bash -c "$cmd"\n');
    chmodSync(fake, 0o755);

    const out = execFileSync(fake, args, {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    expect(out).toBe(NASTY);
  });

  test("omits the port flag when no ssh port applies (gateway hop)", () => {
    const args = buildTwoHopSshArgs({
      jumpHost: "tim@89.167.72.52",
      target: "root@162.55.45.186",
      sshPort: null,
      remoteCommand: "curl -s http://127.0.0.1:3081/admin/backends",
    });
    expect(args[args.length - 1]).not.toContain("-p ");
    expect(args[args.length - 1]).toContain("'root@162.55.45.186'");
  });
});

describe("vast endpoint resolution", () => {
  const DRIFT = {
    drifted: false,
    comparisons: [
      {
        logicalId: "gpu-1",
        vastInstanceId: 46154118,
        expected: { host: "1.1.1.1", sshPort: 11111, servicePort: 63571 },
        actual: { host: "182.224.239.168", sshPort: 63530, status: "running" },
        diffs: [],
      },
      { logicalId: "gpu-2", vastInstanceId: 46153242, expected: { host: "2.2.2.2", sshPort: 22222 }, actual: null },
      { logicalId: "gpu-3", expected: {}, actual: {} },
    ],
  };

  test("prefers the live vast values", () => {
    expect(resolveBackendEndpoint(DRIFT, "gpu-1")).toMatchObject({
      ok: true,
      host: "182.224.239.168",
      sshPort: 63530,
      source: "vast-api",
    });
  });

  test("falls back to stack.json values when actual is missing", () => {
    expect(resolveBackendEndpoint(DRIFT, "gpu-2")).toMatchObject({
      ok: true,
      host: "2.2.2.2",
      sshPort: 22222,
      source: "stack.json",
    });
  });

  test("never guesses a port", () => {
    expect(resolveBackendEndpoint(DRIFT, "gpu-3").ok).toBe(false);
    expect(resolveBackendEndpoint(DRIFT, "gpu-9").ok).toBe(false);
    expect(resolveBackendEndpoint(null, "gpu-1").ok).toBe(false);
    expect(resolveBackendEndpoint({ comparisons: "nope" }, "gpu-1").ok).toBe(false);
  });
});

describe("gateway backend health parsing", () => {
  const BODY = JSON.stringify([
    { id: "gpu-1", enabled: true, health: { status: "healthy", consecutiveSuccesses: 3, consecutiveFailures: 0 } },
    { id: "gpu-2", enabled: true, health: { status: "unhealthy", consecutiveSuccesses: 0, consecutiveFailures: 9 } },
  ]);

  test("reads a healthy backend", () => {
    expect(parseBackendHealth(BODY, "gpu-1")).toMatchObject({ ok: true, healthy: true, status: "healthy" });
  });

  test("reads an unhealthy backend", () => {
    expect(parseBackendHealth(BODY, "gpu-2")).toMatchObject({
      ok: true,
      healthy: false,
      status: "unhealthy",
      consecutiveFailures: 9,
    });
  });

  test("accepts a wrapped {backends:[...]} shape", () => {
    expect(parseBackendHealth(JSON.stringify({ backends: JSON.parse(BODY) }), "gpu-1").healthy).toBe(true);
  });

  test("reports malformed, non-list, and missing-backend responses", () => {
    expect(parseBackendHealth("<html>502 bad gateway</html>", "gpu-1")).toMatchObject({ ok: false });
    expect(parseBackendHealth("", "gpu-1").ok).toBe(false);
    expect(parseBackendHealth('{"error":"nope"}', "gpu-1").ok).toBe(false);
    expect(parseBackendHealth(BODY, "gpu-7").error).toContain("gpu-7");
  });
});

describe("cooldown state", () => {
  const STATE = {
    version: 1,
    backends: { "gpu-1": { lastAttemptAt: "2026-09-12T12:00:00.000Z", lastOutcome: "failed", attempts: 2 } },
  };
  const BASE = Date.parse("2026-09-12T12:00:00.000Z");
  const COOLDOWN = 45 * 60 * 1000;

  test("blocks a retry inside the cooldown window", () => {
    const gate = shouldAttemptRemediation(STATE, "gpu-1", BASE + 15 * 60 * 1000, COOLDOWN);
    expect(gate.allowed).toBe(false);
    expect(gate.lastOutcome).toBe("failed");
    expect(gate.lastAttemptAt).toBe("2026-09-12T12:00:00.000Z");
    expect(gate.retryAfter).toBe("2026-09-12T12:45:00.000Z");
  });

  test("allows a retry once the window has passed, or for an unknown backend", () => {
    expect(shouldAttemptRemediation(STATE, "gpu-1", BASE + 46 * 60 * 1000, COOLDOWN).allowed).toBe(true);
    expect(shouldAttemptRemediation(STATE, "gpu-2", BASE, COOLDOWN).allowed).toBe(true);
  });

  test("a self-recovered observation never holds the door shut", () => {
    const state = recordRemediationAttempt(STATE, "gpu-2", OUTCOMES.selfRecovered, "2026-09-12T12:00:00.000Z");
    expect(shouldAttemptRemediation(state, "gpu-2", BASE + 60 * 1000, COOLDOWN).allowed).toBe(true);
    // ...while a real restart does.
    expect(shouldAttemptRemediation(state, "gpu-1", BASE + 60 * 1000, COOLDOWN).allowed).toBe(false);
  });

  test("degrades gracefully on corrupt state instead of throwing", () => {
    for (const corrupt of [null, undefined, "garbage", [], 7, { backends: "nope" }, { backends: { "gpu-1": 5 } }]) {
      expect(normalizeRemediationState(corrupt)).toEqual({ version: 1, backends: {} });
      expect(shouldAttemptRemediation(corrupt, "gpu-1", BASE, COOLDOWN).allowed).toBe(true);
    }
    expect(
      shouldAttemptRemediation({ backends: { "gpu-1": { lastAttemptAt: "not-a-date" } } }, "gpu-1", BASE, COOLDOWN)
        .allowed,
    ).toBe(true);
  });

  test("records attempts without mutating the previous state", () => {
    const next = recordRemediationAttempt(STATE, "gpu-1", OUTCOMES.succeeded, "2026-09-12T13:00:00.000Z");
    expect(next.backends["gpu-1"]).toEqual({
      lastAttemptAt: "2026-09-12T13:00:00.000Z",
      lastOutcome: "succeeded",
      attempts: 3,
    });
    expect(STATE.backends["gpu-1"].attempts).toBe(2);
  });

  test("reads a corrupt or missing state file as empty and writes atomically", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "remediation-state-"));
    const missing = path.join(dir, "nested", "state.json");
    expect(await readRemediationState(missing)).toEqual({ version: 1, backends: {} });

    const corrupt = path.join(dir, "corrupt.json");
    await writeFile(corrupt, "{not json");
    expect(await readRemediationState(corrupt)).toEqual({ version: 1, backends: {} });

    await writeRemediationState(missing, STATE);
    expect(JSON.parse(await readFile(missing, "utf8"))).toEqual(STATE);
    expect(await readRemediationState(missing)).toEqual(STATE);
  });
});

describe("remediation script output parsing", () => {
  test("reads the step markers", () => {
    expect(
      parseRemediationScriptOutput(
        ["RI:start-script:present", "RI:api-key:present", "RI:venv:present", "RI:tmux:started", "RI:done"].join("\n"),
      ),
    ).toEqual({
      steps: ["start-script:present", "api-key:present", "venv:present", "tmux:started", "done"],
      failedStep: null,
      completed: true,
    });
  });

  test("reads a failure marker", () => {
    const parsed = parseRemediationScriptOutput("RI:start-script:present\nRI-FAIL:api-key:missing");
    expect(parsed.failedStep).toBe("api-key:missing");
    expect(parsed.completed).toBe(false);
  });

  test("tolerates empty output", () => {
    expect(parseRemediationScriptOutput("")).toEqual({ steps: [], failedStep: null, completed: false });
    expect(parseRemediationScriptOutput(undefined).completed).toBe(false);
  });
});

describe("remediation report formatting", () => {
  const target = {
    gatewayService: "gpu-gateway",
    backendId: "gpu-1",
    address: "182.224.239.168",
    port: 63571,
  };

  test("renders a success", () => {
    const report = formatRemediationReport([
      { target, outcome: OUTCOMES.succeeded, message: "remote-inference restarted; backend is healthy again." },
    ]);
    expect(report).toBe(
      [
        "",
        "Auto-remediation: gpu-gateway/gpu-1 (182.224.239.168:63571)",
        "  Result: SUCCEEDED — remote-inference restarted; backend is healthy again.",
      ].join("\n"),
    );
    expect(report).not.toContain("MANUAL INTERVENTION");
  });

  test("renders a self-recovery without shouting", () => {
    const report = formatRemediationReport([{ target, outcome: OUTCOMES.selfRecovered }]);
    expect(report).toContain("Result: SELF-RECOVERED —");
    expect(report).not.toContain("MANUAL INTERVENTION");
  });

  test("renders a partial as verify-shortly and flags it", () => {
    const report = formatRemediationReport([{ target, outcome: OUTCOMES.partial }]);
    expect(report).toContain("⚠️ MANUAL INTERVENTION REQUIRED");
    expect(report).toContain("Result: PARTIAL — restarted, gateway not yet healthy — verify shortly.");
  });

  test("renders a failure with the failed step and a redacted log tail", () => {
    const report = formatRemediationReport([
      {
        target,
        outcome: OUTCOMES.failed,
        message: "/root/pkg/remote-inference/.env has no non-empty API_KEY",
        failedStep: "api-key:missing",
        plan: ["resolved gpu-1 to root@182.224.239.168:63530 via vast-drift (vast-api)"],
        logTail: ["Traceback (most recent call last):", "API_KEY=leaked-value"],
      },
    ]);

    expect(report).toContain("⚠️ MANUAL INTERVENTION REQUIRED");
    expect(report).toContain("  Result: FAILED —");
    expect(report).toContain("  Failed step: api-key:missing");
    expect(report).toContain("  Last service.log lines:");
    expect(report).toContain("API_KEY=[redacted]");
    expect(report).not.toContain("leaked-value");
  });

  test("renders cooldown, disabled, dry-run, error, and notes", () => {
    const report = formatRemediationReport(
      [
        { target, outcome: OUTCOMES.skippedCooldown, message: "cooled down until 2026-09-12T12:45:00.000Z" },
        { target: { ...target, backendId: "gpu-2" }, outcome: OUTCOMES.skippedDisabled },
        { target: { ...target, backendId: "gpu-3" }, outcome: OUTCOMES.dryRun, plan: ["would restart"] },
        { target: null, outcome: OUTCOMES.error, message: "boom" },
      ],
      ["1 additional unhealthy GPU backend(s) were not remediated in this run."],
    );

    expect(report).toContain("Result: SKIPPED (cooldown) — cooled down until 2026-09-12T12:45:00.000Z");
    expect(report).toContain("Result: SKIPPED (disabled) — auto-remediation is disabled.");
    expect(report).toContain("Result: DRY RUN — no changes were made (dry run).");
    expect(report).toContain("  Step: would restart");
    expect(report).toContain("Auto-remediation: unknown-backend");
    expect(report).toContain("Result: ERROR — boom");
    expect(report).toContain("Note: 1 additional unhealthy GPU backend(s) were not remediated in this run.");
  });

  test("returns an empty section when there is nothing to say", () => {
    expect(formatRemediationReport([])).toBe("");
    expect(formatRemediationReport(undefined)).toBe("");
  });
});

describe("remediation orchestration (injected exec)", () => {
  const TARGET = {
    componentId: "remote-inference",
    componentName: "Remote Inference (GPU Service)",
    gatewayService: "gpu-gateway",
    backendId: "gpu-1",
    address: "182.224.239.168",
    port: 63571,
    gatewaySshTarget: "root@162.55.45.186",
  };

  const DRIFT_JSON = JSON.stringify({
    drifted: false,
    comparisons: [
      {
        logicalId: "gpu-1",
        vastInstanceId: 46154118,
        expected: { host: "182.224.239.168", sshPort: 63530 },
        actual: { host: "182.224.239.168", sshPort: 63530, status: "running" },
        diffs: [],
      },
    ],
  });

  function gatewayBody(status: string) {
    return JSON.stringify([
      {
        id: "gpu-1",
        address: "182.224.239.168",
        port: 63571,
        enabled: true,
        apiKey: "0f2b5c1e-11aa-4d33-9f77-8b2a6c4e5d10",
        metadata: { api_key: "sk-live-abc123" },
        health: { status, consecutiveSuccesses: status === "healthy" ? 3 : 0, consecutiveFailures: 4 },
      },
    ]);
  }

  function ok(stdout: string) {
    return { exitCode: 0, signal: null, stdout, stderr: "", timedOut: false };
  }

  function makeExec(handlers: {
    probe?: () => unknown;
    restart?: () => unknown;
    poll?: () => unknown;
    gateway?: () => unknown;
    drift?: () => unknown;
    logTail?: () => unknown;
  }) {
    const calls: string[] = [];
    const exec = async (_command: string, args: string[], _timeoutMs: number) => {
      const command = args[args.length - 1];
      if (command.includes("vast-drift")) {
        calls.push("drift");
        return handlers.drift ? handlers.drift() : ok(DRIFT_JSON);
      }
      if (command.includes("admin/backends")) {
        calls.push("gateway");
        return handlers.gateway ? handlers.gateway() : ok(gatewayBody("unhealthy"));
      }
      if (command.includes("RI-HEALTH")) {
        calls.push("poll");
        return handlers.poll ? handlers.poll() : ok("RI-HEALTH:200");
      }
      if (command.includes("http_code")) {
        calls.push("probe");
        return handlers.probe ? handlers.probe() : ok("000");
      }
      if (command.includes("RI-FAIL")) {
        calls.push("restart");
        return handlers.restart
          ? handlers.restart()
          : ok("RI:start-script:present\nRI:api-key:present\nRI:venv:present\nRI:deps:present\nRI:tmux:killed-stuck-session\nRI:tmux:started\nRI:done");
      }
      if (command.includes("tail -n")) {
        calls.push("logTail");
        return handlers.logTail ? handlers.logTail() : ok("boot failed\nAPI_KEY=leaked");
      }
      calls.push(`unknown:${command}`);
      return ok("");
    };
    return { exec, calls };
  }

  const base = {
    targets: [TARGET],
    jumpHost: "tim@89.167.72.52",
    remoteDir: "/home/tim/pkg/mush/mush-devops",
    sleep: async () => {},
  };

  test("does nothing when the box already answers /health", async () => {
    const { exec, calls } = makeExec({ probe: () => ok("200") });
    const results = await runGpuRemediation({ ...base, exec });

    expect(results[0].outcome).toBe(OUTCOMES.selfRecovered);
    expect(calls).toEqual(["drift", "probe"]);
  });

  test("restarts and reports success once the gateway flips healthy", async () => {
    let gatewayCall = 0;
    const { exec, calls } = makeExec({
      gateway: () => ok(gatewayBody(gatewayCall++ === 0 ? "unhealthy" : "healthy")),
    });
    const results = await runGpuRemediation({ ...base, exec });

    expect(results[0].outcome).toBe(OUTCOMES.succeeded);
    expect(calls).toContain("restart");
    expect(formatRemediationReport(results)).not.toContain("sk-live-abc123");
    expect(formatRemediationReport(results)).not.toContain("0f2b5c1e-11aa-4d33-9f77-8b2a6c4e5d10");
  });

  test("reports partial when the gateway never flips healthy", async () => {
    const { exec } = makeExec({ gateway: () => ok(gatewayBody("unhealthy")) });
    const results = await runGpuRemediation({ ...base, exec, gatewayPollAttempts: 2, gatewayPollIntervalMs: 1 });

    expect(results[0].outcome).toBe(OUTCOMES.partial);
    expect(formatRemediationReport(results)).toContain("verify shortly");
  });

  test("fails loudly (and never invents a key) when API_KEY is missing", async () => {
    const { exec } = makeExec({
      restart: () => ({ exitCode: 1, signal: null, stdout: "RI:start-script:present\nRI-FAIL:api-key:missing", stderr: "", timedOut: false }),
    });
    const results = await runGpuRemediation({ ...base, exec });

    expect(results[0].outcome).toBe(OUTCOMES.failed);
    expect(results[0].failedStep).toBe("api-key:missing");
    const report = formatRemediationReport(results);
    expect(report).toContain("set-api-key.sh");
    expect(report).toContain("⚠️ MANUAL INTERVENTION REQUIRED");
    expect(report).toContain("API_KEY=[redacted]");
    expect(report).not.toContain("leaked");
  });

  test("fails when the restart leaves the service unhealthy locally", async () => {
    const { exec } = makeExec({ poll: () => ({ exitCode: 1, signal: null, stdout: "RI-HEALTH:000", stderr: "", timedOut: false }) });
    const results = await runGpuRemediation({ ...base, exec });

    expect(results[0].outcome).toBe(OUTCOMES.failed);
    expect(results[0].failedStep).toBe("health:local");
  });

  test("fails without guessing when vast-drift cannot resolve the backend", async () => {
    const { exec, calls } = makeExec({ drift: () => ok(JSON.stringify({ comparisons: [] })) });
    const results = await runGpuRemediation({ ...base, exec });

    expect(results[0].outcome).toBe(OUTCOMES.failed);
    expect(results[0].message).toContain("no instance matching gpu-1");
    expect(calls).toEqual(["drift"]);
  });

  test("fails cleanly when vast-drift output is not JSON", async () => {
    const { exec } = makeExec({ drift: () => ok("ssh: connect to host failed") });
    const results = await runGpuRemediation({ ...base, exec });
    expect(results[0].outcome).toBe(OUTCOMES.failed);
  });

  test("dry run reads but never mutates", async () => {
    const { exec, calls } = makeExec({});
    const results = await runGpuRemediation({ ...base, exec, dryRun: true });

    expect(results[0].outcome).toBe(OUTCOMES.dryRun);
    expect(calls).toEqual(["drift", "probe", "gateway"]);
    expect(calls).not.toContain("restart");
    expect(formatRemediationReport(results)).toContain("would restart remote-inference");
  });

  test("turns an exec explosion into an error outcome instead of throwing", async () => {
    const exec = async (_command: string, args: string[]) => {
      if (args[args.length - 1].includes("vast-drift")) return ok(DRIFT_JSON);
      throw new Error("ssh exploded");
    };
    const results = await runGpuRemediation({ ...base, exec });

    expect(results[0].outcome).toBe(OUTCOMES.error);
    expect(results[0].message).toContain("ssh exploded");
  });

  test("returns nothing when there are no targets and skips the vast-drift call", async () => {
    const { exec, calls } = makeExec({});
    expect(await runGpuRemediation({ ...base, exec, targets: [] })).toEqual([]);
    expect(calls).toEqual([]);
  });
});
