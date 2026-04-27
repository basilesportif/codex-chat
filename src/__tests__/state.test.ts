import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AppConfig } from "../config.js";

const tempDirs: string[] = [];

function testConfig(rootDir: string): AppConfig {
  return {
    rootDir,
    configPath: join(rootDir, "config", "codex-chat.toml"),
    service: { stateDir: "state" }
  } as AppConfig;
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-chat-state-"));
  tempDirs.push(root);
  return root;
}

afterEach(async () => {
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("state store", () => {
  test("creates the state directory layout", async () => {
    const { StateStore } = await import("../state.js");
    const root = await tempRoot();
    const store = new StateStore(testConfig(root));

    await store.init();

    expect((await stat(join(root, "state"))).isDirectory()).toBe(true);
    expect((await stat(join(root, "state", "jobs"))).isDirectory()).toBe(true);
    expect(JSON.parse(await readFile(join(root, "state", "schema.json"), "utf8"))).toMatchObject({ version: 1 });
  });

  test("writes and reads JSON state", async () => {
    const { StateStore } = await import("../state.js");
    const root = await tempRoot();
    const store = new StateStore(testConfig(root));

    await store.init();
    await store.writeJson("settings.json", { ok: true });

    expect(await store.readJson("settings.json", {})).toEqual({ ok: true });
  });

  test("writes through a temp file before rename", async () => {
    vi.resetModules();
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const writeFile = vi.fn(actualFs.writeFile);
    const rename = vi.fn(actualFs.rename);
    vi.doMock("node:fs/promises", () => ({ ...actualFs, writeFile, rename }));
    const { StateStore } = await import("../state.js");
    const root = await tempRoot();
    const store = new StateStore(testConfig(root));

    await store.init();
    await store.writeJson("settings.json", { atomically: true });

    const stateFiles = await readdir(join(root, "state"));
    const lastWritePath = writeFile.mock.calls.at(-1)?.[0] as string;
    const lastRenameCall = rename.mock.calls.at(-1);
    expect(lastWritePath).toMatch(/settings\.json\.\d+\.\d+\.tmp$/);
    expect(lastRenameCall).toEqual([lastWritePath, join(root, "state", "settings.json")]);
    expect(stateFiles.some((file) => file.endsWith(".tmp"))).toBe(false);
  });
});
