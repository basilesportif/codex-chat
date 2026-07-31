import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadConfig, type AppConfig } from "../config.js";
import {
  AppServerTranscriber,
  assertLocalAudioAppServerCapability,
  normalizeAppServerTranscript,
  parseCodexVersion,
} from "../app-server-transcription.js";

const tempDirs: string[] = [];
const originalEnv = { ...process.env };

interface FakeBehavior {
  version?: string;
  transcript?: string;
  toolItemType?: string;
  silent?: boolean;
}

function fakeAppServer(behavior: FakeBehavior = {}) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    killed: boolean;
    pid?: number;
    kill(signal?: NodeJS.Signals): boolean;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = vi.fn((signal?: NodeJS.Signals) => {
    child.killed = true;
    child.signalCode = signal ?? "SIGTERM";
    child.exitCode = signal ? null : 0;
    queueMicrotask(() => child.emit("exit", child.exitCode, child.signalCode));
    return true;
  });
  const requests: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
  let inputBuffer = "";
  child.stdin.on("data", (chunk) => {
    inputBuffer += chunk.toString();
    while (inputBuffer.includes("\n")) {
      const split = inputBuffer.indexOf("\n");
      const line = inputBuffer.slice(0, split);
      inputBuffer = inputBuffer.slice(split + 1);
      if (!line) continue;
      const request = JSON.parse(line) as { id: number; method: string; params: Record<string, unknown> };
      requests.push(request);
      if (behavior.silent) continue;
      if (request.method === "initialize") {
        child.stdout.write(`${JSON.stringify({ id: request.id, result: { userAgent: `codex-chat-transcription/${behavior.version ?? "0.145.0"} (test)` } })}\n`);
      } else if (request.method === "thread/start") {
        child.stdout.write(`${JSON.stringify({ id: request.id, result: { thread: { id: "thread-test", ephemeral: true } } })}\n`);
      } else if (request.method === "turn/start") {
        child.stdout.write(`${JSON.stringify({ id: request.id, result: { turn: { id: "turn-test" } } })}\n`);
        setTimeout(() => {
          if (behavior.toolItemType) {
            child.stdout.write(`${JSON.stringify({ method: "item/started", params: { turnId: "turn-test", item: { type: behavior.toolItemType } } })}\n`);
            return;
          }
          const text = JSON.stringify({ transcript: behavior.transcript ?? "known speech transcript" });
          child.stdout.write(`${JSON.stringify({ method: "item/agentMessage/delta", params: { turnId: "turn-test", delta: text } })}\n`);
          child.stdout.write(`${JSON.stringify({ method: "item/completed", params: { turnId: "turn-test", item: { type: "agentMessage", text } } })}\n`);
          child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { turn: { id: "turn-test", status: "completed" } } })}\n`);
        }, 0);
      }
    }
  });
  child.stdin.once("finish", () => {
    if (child.killed || child.exitCode !== null) return;
    child.exitCode = 0;
    queueMicrotask(() => child.emit("exit", 0, null));
  });
  return { child, requests };
}

async function makeConfig(timeoutSec = 1): Promise<AppConfig> {
  const root = await mkdtemp(join(tmpdir(), "codex-chat-local-audio-"));
  tempDirs.push(root);
  const configDir = join(root, "config");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "codex-chat.toml"), `
version = 1
[service]
workspace = "${root}"
[codex]
binary = "codex"
model = "gpt-local-audio-test"
[transcription]
enabled = true
provider = "codex_app_server"
apiKeyEnv = "OPENAI_API_KEY"
appServerTimeoutSec = ${timeoutSec}
`);
  delete process.env.OPENAI_API_KEY;
  delete process.env.CODEX_CHAT_CODEX_MODEL;
  delete process.env.CODEX_CHAT_TRANSCRIPTION_PROVIDER;
  delete process.env.CODEX_CHAT_TRANSCRIPTION_APP_SERVER_TIMEOUT_SEC;
  return loadConfig(join(configDir, "codex-chat.toml"));
}

afterEach(async () => {
  process.env = { ...originalEnv };
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("localAudio capability checks", () => {
  test("requires Codex app-server 0.145.0 or newer", () => {
    expect(parseCodexVersion("codex-cli 0.145.0")).toBe("0.145.0");
    expect(() => assertLocalAudioAppServerCapability("client/0.144.0 (test)")).toThrow(/0\.145\.0 or newer/);
    expect(() => assertLocalAudioAppServerCapability("client/0.145.0 (test)")).not.toThrow();
    expect(() => assertLocalAudioAppServerCapability("client/1.0.0 (test)")).not.toThrow();
    expect(() => assertLocalAudioAppServerCapability("unknown")).toThrow(/Unable to determine/);
  });

  test("rejects empty and placeholder output", () => {
    expect(() => normalizeAppServerTranscript("")).toThrow(/empty output/);
    expect(() => normalizeAppServerTranscript('{"transcript":"[Audio]"}')).toThrow(/placeholder/);
    expect(() => normalizeAppServerTranscript('{"transcript":"[Audio transcription unavailable.]"}')).toThrow(/placeholder/);
    expect(() => normalizeAppServerTranscript('{"transcript":"[Audio unavailable]"}')).toThrow(/placeholder/);
    expect(() => normalizeAppServerTranscript('{"transcript":"Codex cannot attach audio at x"}')).toThrow(/placeholder/);
    expect(normalizeAppServerTranscript('{"transcript":"Hello from the recording."}')).toBe("Hello from the recording.");
  });
});

describe("AppServerTranscriber", () => {
  test.each([
    ["voice.wav", "audio/wav"],
    ["voice.mp3", "audio/mpeg"],
    ["voice.m4a", "audio/mp4"],
    ["voice.webm", "audio/webm"],
    ["voice.ogg", "audio/ogg"],
  ])("maps supported format %s to localAudio without an API key", async (filename) => {
    const config = await makeConfig();
    const audioPath = join(config.service.workspace, filename);
    await writeFile(audioPath, "audio");
    const fake = fakeAppServer();
    const spawnAppServer = vi.fn((_command, _args, options) => {
      expect(options.env).not.toHaveProperty("OPENAI_API_KEY");
      return fake.child;
    });
    const transcriber = new AppServerTranscriber(config, { spawnAppServer: spawnAppServer as never });

    await expect(transcriber.transcribe({ path: audioPath })).resolves.toMatchObject({
      text: "known speech transcript",
      mode: "regular",
      model: "gpt-local-audio-test",
    });
    const turn = fake.requests.find((request) => request.method === "turn/start");
    expect(turn?.params.input).toEqual(expect.arrayContaining([{ type: "localAudio", path: audioPath }]));
    const thread = fake.requests.find((request) => request.method === "thread/start");
    expect(thread?.params).toMatchObject({ ephemeral: true, sandbox: "read-only", approvalPolicy: "never" });
    const args = spawnAppServer.mock.calls[0]?.[1] as string[];
    expect(args).toEqual(expect.arrayContaining(["--disable", "shell_tool", "-c", "mcp_servers={}"]));
  });

  test("keeps diarization on OpenAI and reports a missing API key only for diarize mode", async () => {
    const config = await makeConfig();
    const audioPath = join(config.service.workspace, "voice.ogg");
    await writeFile(audioPath, "audio");
    const fake = fakeAppServer();
    const transcriber = new AppServerTranscriber(config, { spawnAppServer: (() => fake.child) as never });

    await expect(transcriber.transcribe({ path: audioPath, mode: "regular" })).resolves.toMatchObject({ text: "known speech transcript" });
    await expect(transcriber.transcribe({ path: audioPath, mode: "diarize" })).rejects.toThrow(/OPENAI_API_KEY is required/);
  });

  test("fails closed if the app-server attempts a tool", async () => {
    const config = await makeConfig();
    const audioPath = join(config.service.workspace, "voice.wav");
    await writeFile(audioPath, "audio");
    const fake = fakeAppServer({ toolItemType: "commandExecution" });
    const transcriber = new AppServerTranscriber(config, { spawnAppServer: (() => fake.child) as never });

    await expect(transcriber.transcribe({ path: audioPath })).rejects.toThrow(/attempted disabled tool item/);
  });

  test("rejects unsupported extensions and unreadable paths before spawning", async () => {
    const config = await makeConfig();
    const spawnAppServer = vi.fn();
    const transcriber = new AppServerTranscriber(config, { spawnAppServer: spawnAppServer as never });
    const unsupported = join(config.service.workspace, "voice.flac");
    await writeFile(unsupported, "audio");

    await expect(transcriber.transcribe({ path: unsupported })).rejects.toThrow(/Unsupported localAudio format/);
    await expect(transcriber.transcribe({ path: join(config.service.workspace, "missing.ogg") })).rejects.toThrow(/missing or unreadable/);
    expect(spawnAppServer).not.toHaveBeenCalled();
  });

  test("enforces the configured end-to-end timeout", async () => {
    const config = await makeConfig(0.01);
    const audioPath = join(config.service.workspace, "voice.ogg");
    await writeFile(audioPath, "audio");
    const fake = fakeAppServer({ silent: true });
    const transcriber = new AppServerTranscriber(config, { spawnAppServer: (() => fake.child) as never });

    await expect(transcriber.transcribe({ path: audioPath })).rejects.toThrow(/timed out after 0\.01s/);
    expect(fake.child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
