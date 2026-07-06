import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function runCli(args: string[]): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["src/main.ts", ...args], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.on("error", reject);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => resolve({ code, stderr, stdout }));
  });
}

describe("main CLI employee IPC errors", () => {
  test("wraps IPC token read failures in the guided service-not-running error", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-main-cli-"));
    tempDirs.push(root);
    const configDir = join(root, "config");
    await mkdir(configDir, { recursive: true });
    const configPath = join(configDir, "codex-chat.toml");
    await writeFile(configPath, `
version = 1
[service]
workspace = "${root}"
logLevel = "silent"
`);
    await mkdir(join(root, "data", "run", "ipc.token"), { recursive: true });

    const result = await runCli(["--config", configPath, "employees", "start", "email-calendar"]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Could not reach running codex-chat service");
    expect(result.stderr).toMatch(/EISDIR|illegal operation on a directory|is a directory/);
    expect(result.stderr).not.toMatch(/\n\s+at /);
    expect(result.stderr).not.toContain("readIpcToken");
    expect(result.stdout).toBe("");
  });
});
