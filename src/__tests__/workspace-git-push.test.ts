import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const tempDirs: string[] = [];
const scriptPath = fileURLToPath(new URL("../../scripts/workspace-git-push.sh", import.meta.url));

function run(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}\n${stderr || stdout}`));
    });
  });
}

async function setupWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-chat-workspace-push-"));
  tempDirs.push(root);
  const origin = join(root, "origin.git");
  const workspace = join(root, "workspace");
  await mkdir(workspace);

  await run("git", ["init", "--bare", origin], root);
  await run("git", ["init", "-b", "main"], workspace);
  await run("git", ["config", "user.name", "Test User"], workspace);
  await run("git", ["config", "user.email", "test@example.com"], workspace);
  await writeFile(join(workspace, "README.md"), "initial\n");
  await run("git", ["add", "README.md"], workspace);
  await run("git", ["commit", "-m", "initial"], workspace);
  await run("git", ["remote", "add", "origin", origin], workspace);
  await run("git", ["push", "-u", "origin", "main"], workspace);

  return workspace;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("workspace git push script", () => {
  test("stays silent when there are no changes", async () => {
    const workspace = await setupWorkspace();

    const result = await run(scriptPath, [], workspace);

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  test("prints one concise status after committing and pushing changes", async () => {
    const workspace = await setupWorkspace();
    await writeFile(join(workspace, "README.md"), "initial\nupdated\n");
    await writeFile(join(workspace, "notes.txt"), "one\ntwo\n");

    const result = await run(scriptPath, [], workspace);
    const status = await run("git", ["status", "--short"], workspace);
    const head = await run("git", ["rev-parse", "HEAD"], workspace);
    const remoteHead = await run("git", ["rev-parse", "origin/main"], workspace);

    expect(result.stdout).toMatch(/^workspace-git-push ran: committed and pushed 2 files? changed, 3 insertions\(\+\)\n$/);
    expect(result.stderr).toBe("");
    expect(status.stdout).toBe("");
    expect(head.stdout).toBe(remoteHead.stdout);
  });
});
