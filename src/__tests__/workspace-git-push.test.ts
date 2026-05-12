import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const tempDirs: string[] = [];
const scriptPath = fileURLToPath(new URL("../../scripts/workspace-git-push.sh", import.meta.url));

function runWithExit(
  command: string,
  args: string[],
  cwd: string
): Promise<{ code: number; stdout: string; stderr: string }> {
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
      if (code === null) reject(new Error(`${command} ${args.join(" ")} exited without a code\n${stderr || stdout}`));
      else resolve({ code, stdout, stderr });
    });
  });
}

async function run(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  const result = await runWithExit(command, args, cwd);
  if (result.code === 0) return { stdout: result.stdout, stderr: result.stderr };
  throw new Error(`${command} ${args.join(" ")} exited with ${result.code}\n${result.stderr || result.stdout}`);
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

  test("fails without pulling when upstream has new commits", async () => {
    const workspace = await setupWorkspace();
    const root = join(workspace, "..");
    const external = join(root, "external");

    await run("git", ["clone", "-b", "main", join(root, "origin.git"), external], root);
    await run("git", ["config", "user.name", "External User"], external);
    await run("git", ["config", "user.email", "external@example.com"], external);
    await mkdir(join(external, "assistant-agent-data"));
    await writeFile(join(external, "assistant-agent-data", "dictionary.txt"), "remote\n");
    await run("git", ["add", "assistant-agent-data/dictionary.txt"], external);
    await run("git", ["commit", "-m", "external dictionary update"], external);
    await run("git", ["push", "origin", "main"], external);

    await writeFile(join(workspace, "README.md"), "initial\nlocal\n");
    await writeFile(join(workspace, "local-notes.txt"), "local\n");

    const result = await runWithExit(scriptPath, [], workspace);
    const status = await run("git", ["status", "--short"], workspace);
    const log = await run("git", ["log", "--format=%s", "-1"], workspace);
    const remoteFile = await run("git", ["show", "origin/main:assistant-agent-data/dictionary.txt"], workspace);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "workspace-git-push failed: branch main is 0 commit(s) ahead and 1 commit(s) behind origin/main; reconcile manually before pushing\n"
    );
    expect(status.stdout.split("\n").filter(Boolean).sort()).toEqual([" M README.md", "?? local-notes.txt"]);
    expect(log.stdout).toBe("initial\n");
    expect(remoteFile.stdout).toBe("remote\n");
  });
});
