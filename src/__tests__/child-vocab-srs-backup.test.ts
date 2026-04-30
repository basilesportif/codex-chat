import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const tempDirs: string[] = [];
const scriptPath = fileURLToPath(new URL("../../scripts/child-vocab-srs-backup.mjs", import.meta.url));

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
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

function runBackup(env: NodeJS.ProcessEnv, args: string[] = []) {
  return run(process.execPath, [scriptPath, ...args], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...env
    }
  });
}

async function setupDirs() {
  const root = await mkdtemp(join(tmpdir(), "child-vocab-srs-backup-"));
  tempDirs.push(root);
  const dataDir = join(root, "data");
  const backupDir = join(root, "backups");
  await mkdir(dataDir);
  return { root, dataDir, backupDir };
}

async function listTar(archive: string) {
  const result = await run("tar", ["-tzf", archive]);
  return result.stdout.split("\n").filter(Boolean);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("child-vocab-srs backup script", () => {
  test("creates a timestamped backup and excludes temporary files", async () => {
    const { dataDir, backupDir } = await setupDirs();
    const appJson = JSON.stringify({ cards: [{ term: "red", due: "2026-04-30" }] }, null, 2);
    await writeFile(join(dataDir, "app.json"), appJson);
    await writeFile(join(dataDir, "scratch.tmp"), "do not back up\n");
    await mkdir(join(dataDir, "tmp"));
    await writeFile(join(dataDir, "tmp", "cache.json"), "{}\n");

    const result = await runBackup({ DATA_DIR: dataDir, BACKUP_DIR: backupDir });
    const output = JSON.parse(result.stdout);
    const expectedSha = createHash("sha256").update(appJson).digest("hex");

    expect(result.stderr).toBe("");
    expect(output.status).toBe("created");
    expect(output.sha256).toBe(expectedSha);
    expect(output.backupFileName).toMatch(/^child-vocab-srs-\d{8}T\d{6}Z-[a-f0-9]{12}\.tar\.gz$/);
    expect(await readFile(join(backupDir, "latest.sha256"), "utf8")).toBe(`${expectedSha}  app.json\n`);

    const metadata = JSON.parse(await readFile(join(backupDir, "latest-backup.json"), "utf8"));
    expect(metadata.backupFile).toBe(output.backupFile);
    expect(metadata.sizeBytes).toBeGreaterThan(0);

    const entries = await listTar(output.backupFile);
    expect(entries.some((entry) => entry.endsWith("app.json"))).toBe(true);
    expect(entries.some((entry) => entry.includes("scratch.tmp"))).toBe(false);
    expect(entries.some((entry) => entry.includes("tmp/cache.json"))).toBe(false);
  });

  test("skips unchanged app.json and creates a new backup after a change", async () => {
    const { dataDir, backupDir } = await setupDirs();
    await writeFile(join(dataDir, "app.json"), JSON.stringify({ cards: [] }));

    await runBackup({ DATA_DIR: dataDir, BACKUP_DIR: backupDir });
    const unchanged = JSON.parse((await runBackup({ DATA_DIR: dataDir, BACKUP_DIR: backupDir })).stdout);
    const firstBackups = (await readdir(backupDir)).filter((name) => name.endsWith(".tar.gz"));

    expect(unchanged.status).toBe("unchanged");
    expect(firstBackups).toHaveLength(1);

    await writeFile(join(dataDir, "app.json"), JSON.stringify({ cards: [{ term: "blue" }] }));
    const changed = JSON.parse((await runBackup({ DATA_DIR: dataDir, BACKUP_DIR: backupDir })).stdout);
    const secondBackups = (await readdir(backupDir)).filter((name) => name.endsWith(".tar.gz"));

    expect(changed.status).toBe("created");
    expect(secondBackups).toHaveLength(2);
  });

  test("loads DATA_DIR and BACKUP_DIR from an env file", async () => {
    const { root, dataDir, backupDir } = await setupDirs();
    const envFile = join(root, "child-vocab-srs.env");
    await writeFile(join(dataDir, "app.json"), JSON.stringify({ cards: [{ term: "green" }] }));
    await writeFile(envFile, `DATA_DIR=${dataDir}\nBACKUP_DIR="${backupDir}"\n`);

    const result = await runBackup({}, ["--env-file", envFile]);
    const output = JSON.parse(result.stdout);

    expect(output.status).toBe("created");
    expect(output.dataDir).toBe(dataDir);
    expect(output.backupDir).toBe(backupDir);
  });

  test("rejects invalid app.json without writing metadata", async () => {
    const { dataDir, backupDir } = await setupDirs();
    await writeFile(join(dataDir, "app.json"), "{ invalid json\n");

    await expect(runBackup({ DATA_DIR: dataDir, BACKUP_DIR: backupDir })).rejects.toThrow(/invalid JSON/);
    await expect(readFile(join(backupDir, "latest-backup.json"), "utf8")).rejects.toThrow();
  });
});
