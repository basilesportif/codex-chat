import { describe, expect, test } from "vitest";

type HealthAlertModule = {
  collectFindings(payload: unknown, options?: { lowBalanceThreshold?: number }): string[];
  parsePositiveNumber(value: unknown, fallback: number): number;
};

const { collectFindings, parsePositiveNumber } = await import(
  "../../scripts/mush-devops-health-alert.mjs"
) as HealthAlertModule;

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
});
