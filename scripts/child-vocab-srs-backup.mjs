#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, rmSync, writeSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_ENV_FILE = "/etc/child-vocab-srs.env";
const DEFAULT_BACKUP_DIR = "/root/var/child-vocab-srs/backups";
const APP_JSON = "app.json";

class BackupError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function usage() {
  return `Usage: child-vocab-srs-backup.mjs [--env-file <path>]

Creates a tar.gz backup of DATA_DIR when DATA_DIR/app.json changes.

Configuration:
  DATA_DIR      Required unless supplied by the env file.
  BACKUP_DIR    Optional; defaults to ${DEFAULT_BACKUP_DIR}.

By default the script reads ${DEFAULT_ENV_FILE}. Existing process env vars
take precedence over values loaded from the env file.`;
}

function parseArgs(argv) {
  let envFile = process.env.CHILD_VOCAB_SRS_ENV_FILE || DEFAULT_ENV_FILE;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--env-file") {
      const value = argv[i + 1];
      if (!value) {
        throw new BackupError("--env-file requires a path", 2);
      }
      envFile = value;
      i += 1;
      continue;
    }
    throw new BackupError(`unknown argument: ${arg}`, 2);
  }

  return { envFile };
}

function stripInlineComment(value) {
  let quote = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if ((char === "'" || char === "\"") && value[i - 1] !== "\\") {
      quote = quote === char ? "" : quote || char;
    }
    if (char === "#" && !quote && /\s/.test(value[i - 1] || " ")) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value.trimEnd();
}

function parseEnvValue(rawValue) {
  const value = stripInlineComment(rawValue.trim());
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  if (value.startsWith("\"") && value.endsWith("\"")) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\");
  }
  return value;
}

function parseEnvFile(text) {
  const vars = {};
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) {
      throw new BackupError(`invalid env file line ${i + 1}`);
    }
    vars[match[1]] = parseEnvValue(match[2]);
  }

  return vars;
}

async function loadEnvFile(path) {
  try {
    return parseEnvFile(await readFile(path, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return {};
    throw error;
  }
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function timestampForFilename(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function readLatestSha(path) {
  try {
    const text = await readFile(path, "utf8");
    return text.trim().split(/\s+/)[0] || undefined;
  } catch (error) {
    if (error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeAtomic(path, content, mode = 0o600) {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, content, { mode });
  await rename(tempPath, path);
}

function acquireLock(path) {
  let fd;
  try {
    fd = openSync(path, "wx", 0o600);
    writeSync(fd, `${process.pid}\n`);
    return () => {
      closeSync(fd);
      rmSync(path, { force: true });
    };
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (error && error.code === "EEXIST") {
      throw new BackupError(`backup already running; lock exists at ${path}`, 75);
    }
    throw error;
  }
}

function backupDirExcludePatterns(dataDir, backupDir) {
  const rel = relative(dataDir, backupDir);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return [];
  return [rel, `./${rel}`, `${rel}/**`, `./${rel}/**`];
}

function tarExcludePatterns(dataDir, backupDir) {
  return [
    "tmp",
    "./tmp",
    "tmp/**",
    "./tmp/**",
    ".tmp",
    "./.tmp",
    ".tmp/**",
    "./.tmp/**",
    "*.tmp",
    "*.temp",
    "*.part",
    "*.swp",
    "*.swx",
    "*~",
    "*.lock",
    ".DS_Store",
    ...backupDirExcludePatterns(dataDir, backupDir)
  ];
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new BackupError(`${command} exited with ${code}: ${stderr || stdout}`));
      }
    });
  });
}

async function createTarball({ dataDir, backupDir, tempBackupFile, tarBin }) {
  const args = [
    "--create",
    "--gzip",
    "--file",
    tempBackupFile,
    "--directory",
    dataDir
  ];

  for (const pattern of tarExcludePatterns(dataDir, backupDir)) {
    args.push("--exclude", pattern);
  }
  args.push(".");

  await run(tarBin, args);
}

function buildConfig(env) {
  const dataDir = env.DATA_DIR;
  if (!dataDir) {
    throw new BackupError(`DATA_DIR is required; set it in ${DEFAULT_ENV_FILE} or the process environment`, 2);
  }

  return {
    dataDir: resolve(dataDir),
    backupDir: resolve(env.BACKUP_DIR || DEFAULT_BACKUP_DIR),
    tarBin: env.TAR_BIN || "tar"
  };
}

async function runBackup({ envFile, now = new Date() }) {
  const envFromFile = await loadEnvFile(envFile);
  const env = { ...envFromFile, ...process.env };
  const { dataDir, backupDir, tarBin } = buildConfig(env);
  const appJsonPath = join(dataDir, APP_JSON);
  const backupStartedAt = now.toISOString();

  const rawAppJson = await readFile(appJsonPath, "utf8");
  try {
    JSON.parse(rawAppJson);
  } catch (error) {
    throw new BackupError(`invalid JSON in ${appJsonPath}: ${error.message}`);
  }

  const appJsonSha256 = sha256(rawAppJson);

  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const releaseLock = acquireLock(join(backupDir, ".child-vocab-srs-backup.lock"));

  try {
    const latestShaPath = join(backupDir, "latest.sha256");
    const previousSha256 = await readLatestSha(latestShaPath);
    if (previousSha256 === appJsonSha256) {
      return {
        status: "unchanged",
        checkedAt: new Date().toISOString(),
        dataDir,
        backupDir,
        appJsonPath,
        sha256: appJsonSha256
      };
    }

    const stamp = timestampForFilename(now);
    const backupFileName = `child-vocab-srs-${stamp}-${appJsonSha256.slice(0, 12)}.tar.gz`;
    const backupFile = join(backupDir, backupFileName);
    const tempBackupFile = `${backupFile}.tmp-${process.pid}`;

    await createTarball({ dataDir, backupDir, tempBackupFile, tarBin });
    await rename(tempBackupFile, backupFile);

    const backupStats = await stat(backupFile);
    const metadata = {
      schemaVersion: 1,
      app: "child-vocab-srs",
      status: "created",
      createdAt: backupStartedAt,
      dataDir,
      appJsonPath,
      backupDir,
      backupFile,
      backupFileName,
      sha256: appJsonSha256,
      sizeBytes: backupStats.size
    };

    await writeAtomic(latestShaPath, `${appJsonSha256}  ${APP_JSON}\n`);
    await writeAtomic(join(backupDir, "latest-backup.json"), `${JSON.stringify(metadata, null, 2)}\n`);

    return metadata;
  } finally {
    releaseLock();
  }
}

async function main() {
  try {
    const config = parseArgs(process.argv.slice(2));
    const result = await runBackup(config);
    console.log(JSON.stringify(result));
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error(`[child-vocab-srs-backup] ${message}`);
    process.exitCode = error && Number.isInteger(error.exitCode) ? error.exitCode : 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}

export {
  DEFAULT_BACKUP_DIR,
  DEFAULT_ENV_FILE,
  parseEnvFile,
  runBackup,
  timestampForFilename
};
