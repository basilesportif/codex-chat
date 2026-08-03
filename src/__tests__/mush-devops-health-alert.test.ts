import { describe, expect, test } from "vitest";

type HealthAlertModule = {
  collectFindings(payload: unknown, options?: { lowBalanceThreshold?: number }): string[];
  parsePositiveNumber(value: unknown, fallback: number): number;
  isSkippedCheck(check: unknown): boolean;
};

const { collectFindings, isSkippedCheck, parsePositiveNumber } = await import(
  "../../scripts/mush-devops-health-alert.mjs"
) as HealthAlertModule;

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
