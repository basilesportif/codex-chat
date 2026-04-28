import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumeDeployMarker,
  deployMarkerPath,
  formatDeployFailureMessage,
  formatDeploySuccessMessage,
  isDeployCommand,
  waitForTurnDrain
} from "../deploy.js";
import type { AppConfig } from "../config.js";

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  fatal: () => undefined
} as unknown as Parameters<typeof waitForTurnDrain>[2];

function fakeConfig(rootDir: string): AppConfig {
  return {
    rootDir,
    configPath: join(rootDir, "config/codex-chat.toml"),
    service: { stateDir: "data/state" }
  } as unknown as AppConfig;
}

describe("isDeployCommand", () => {
  it("matches common deploy phrasings", () => {
    for (const text of [
      "update",
      " update ",
      "Update",
      "update yourself",
      "update self",
      "deploy",
      "Deploy",
      "redeploy",
      "pull and restart",
      "self-update",
      "self update"
    ]) {
      expect(isDeployCommand(text)).toBe(true);
    }
  });

  it("ignores non-deploy text", () => {
    for (const text of [
      "update the calendar",
      "deploy the app for me",
      "logs",
      "hello",
      "",
      undefined as unknown as string
    ]) {
      expect(isDeployCommand(text)).toBe(false);
    }
  });
});

describe("waitForTurnDrain", () => {
  it("returns immediately when no turn is running", async () => {
    const result = await waitForTurnDrain(() => false, 5_000, noopLogger);
    expect(result.drained).toBe(true);
    expect(result.waitedMs).toBe(0);
  });

  it("returns after the turn finishes", async () => {
    let running = true;
    setTimeout(() => {
      running = false;
    }, 400);
    const result = await waitForTurnDrain(() => running, 5_000, noopLogger);
    expect(result.drained).toBe(true);
    expect(result.waitedMs).toBeGreaterThan(0);
    expect(result.waitedMs).toBeLessThan(2_000);
  });

  it("times out if the turn never finishes", async () => {
    const result = await waitForTurnDrain(() => true, 600, noopLogger);
    expect(result.drained).toBe(false);
    expect(result.waitedMs).toBeGreaterThanOrEqual(600);
  });
});

describe("consumeDeployMarker", () => {
  it("returns undefined when there is no marker", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-test-"));
    try {
      const config = fakeConfig(dir);
      const result = await consumeDeployMarker(config, noopLogger);
      expect(result).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads and removes a marker", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-test-"));
    try {
      const config = fakeConfig(dir);
      const path = deployMarkerPath(config);
      await mkdir(join(dir, "data/state"), { recursive: true });
      await writeFile(path, JSON.stringify({
        status: "success",
        chatId: 1234,
        commitBefore: "abc1234",
        commitAfter: "def5678",
        message: "ok"
      }));
      const marker = await consumeDeployMarker(config, noopLogger);
      expect(marker?.status).toBe("success");
      expect(marker?.chatId).toBe(1234);
      expect(marker?.commitAfter).toBe("def5678");
      // marker should be deleted after consumption
      await expect(readFile(path, "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("formatDeploySuccessMessage", () => {
  it("includes the new commit and previous when changed", () => {
    const out = formatDeploySuccessMessage(
      { status: "success", chatId: 1, commitBefore: "abc1234", commitAfter: "def5678" },
      "def5678"
    );
    expect(out).toContain("Redeployed successfully");
    expect(out).toContain("commit: def5678");
    expect(out).toContain("previous: abc1234");
  });

  it("omits previous when commit is unchanged", () => {
    const out = formatDeploySuccessMessage(
      { status: "success", chatId: 1, commitBefore: "abc1234", commitAfter: "abc1234" },
      "abc1234"
    );
    expect(out).not.toContain("previous:");
  });
});

describe("formatDeployFailureMessage", () => {
  it("surfaces the build error", () => {
    const out = formatDeployFailureMessage({
      status: "failed",
      chatId: 1,
      commitBefore: "abc1234",
      commitAfter: "def5678",
      message: "tsc error TS1234: oops"
    });
    expect(out).toContain("Deploy failed");
    expect(out).toContain("commit: def5678");
    expect(out).toContain("tsc error TS1234");
  });
});
