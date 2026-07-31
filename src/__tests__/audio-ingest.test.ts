import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiGateway, type ApiGatewayHooks, type AudioIngestionCompletedEvent } from "../api.js";
import { loadConfig, type AppConfig } from "../config.js";
import { FileStore } from "../file-store.js";
import { createLogger } from "../logger.js";
import { StateStore } from "../state.js";
import type { Transcriber, TranscriptionResult, TranscribeInput } from "../transcription.js";

const tempDirs: string[] = [];
const gateways: ApiGateway[] = [];
const originalEnv = { ...process.env };

class StubTranscriber implements Transcriber {
  readonly transcribe = vi.fn(async (_input: TranscribeInput): Promise<TranscriptionResult> => ({ text: "hello transcript", mode: _input.mode ?? "regular" }));
}

beforeEach(() => {
  process.env = { ...originalEnv };
  process.env.CODEXCHAT_INGEST_API_KEYS = "shortcut:test-secret,backup:backup-secret";
  delete process.env.CODEX_CHAT_SLACK_ENABLED;
  delete process.env.CODEX_CHAT_SLACK_EVENTS_PATH;
  delete process.env.CODEX_CHAT_API_PORT;
  delete process.env.CODEXCHAT_AUDIO_INGEST_MAX_MB;
});

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.stop()));
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeHarness(extraToml = "", hooks: ApiGatewayHooks = {}): Promise<{ config: AppConfig; state: StateStore; files: FileStore; transcriber: StubTranscriber; gateway: ApiGateway; baseUrl: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "codex-chat-audio-ingest-"));
  tempDirs.push(root);
  const configDir = join(root, "config");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "codex-chat.toml"), `
version = 1

[service]
workspace = "${root}"
stateDir = "state"
logLevel = "silent"

[api]
enabled = true
host = "127.0.0.1"
port = 0

[transcription]
enabled = false
${extraToml}
`);
  const config = await loadConfig(join(configDir, "codex-chat.toml"));
  const logger = createLogger("silent");
  const state = new StateStore(config);
  await state.init();
  const files = new FileStore(config, state);
  await files.init();
  const transcriber = new StubTranscriber();
  const gateway = new ApiGateway(config, state, files, transcriber, logger, hooks);
  await gateway.start();
  gateways.push(gateway);
  const port = gateway.address()?.port;
  if (!port) throw new Error("test API did not bind a port");
  return { config, state, files, transcriber, gateway, baseUrl: `http://127.0.0.1:${port}`, root };
}

function formWithMp3(fields: Record<string, string> = {}, bytes: Buffer | string = "mp3-data"): FormData {
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: "audio/mpeg" }), "recording.mp3");
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

function formWithAudio(filename: string, contentType: string, bytes = "audio-data"): FormData {
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: contentType }), filename);
  return form;
}

async function postAudio(baseUrl: string, form: FormData, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}/api/ingest/audio`, { method: "POST", headers, body: form });
}

describe("audio ingestion API", () => {
  test("rejects missing API key with unauthorized JSON", async () => {
    const { baseUrl, transcriber } = await makeHarness();

    const response = await postAudio(baseUrl, formWithMp3());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(transcriber.transcribe).not.toHaveBeenCalled();
  });

  test("rejects invalid API key", async () => {
    const { baseUrl, transcriber } = await makeHarness();

    const response = await postAudio(baseUrl, formWithMp3(), { Authorization: "Bearer wrong-secret" });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(transcriber.transcribe).not.toHaveBeenCalled();
  });

  test("rejects missing file", async () => {
    const { baseUrl, transcriber } = await makeHarness();
    const form = new FormData();
    form.set("source", "shortcut");

    const response = await postAudio(baseUrl, form, { Authorization: "Bearer test-secret" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "missing_file" });
    expect(transcriber.transcribe).not.toHaveBeenCalled();
  });

  test("rejects unsupported file type", async () => {
    const { baseUrl, transcriber } = await makeHarness();
    const form = new FormData();
    form.set("file", new Blob(["not mp3"], { type: "text/plain" }), "notes.txt");

    const response = await postAudio(baseUrl, form, { Authorization: "Bearer test-secret" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "unsupported_file_type" });
    expect(transcriber.transcribe).not.toHaveBeenCalled();
  });

  test("accepts MP3, preserves metadata and prompt, stores record, notifies handling layer, and hands stored file to transcriber", async () => {
    const completions: AudioIngestionCompletedEvent[] = [];
    const { baseUrl, state, transcriber } = await makeHarness("", {
      onAudioIngestionCompleted: async (event) => {
        completions.push(event);
      }
    });
    const response = await postAudio(baseUrl, formWithMp3({
      source: "soundcore",
      device: "soundcore-work",
      title: "Soundcore Recording",
      recorded_at: "2026-06-09T12:00:00Z",
      client_request_id: "req-1",
      notes: "meeting notes",
      prompt: "Summarize action items for Tim."
    }), { Authorization: "Bearer test-secret" });

    expect(response.status).toBe(201);
    const body = await response.json() as {
      ingestion_id: string;
      status: string;
      metadata: Record<string, string>;
      file: { filename: string; content_type: string; size_bytes: number; sha256: string };
      transcription: { status: string; mode?: string; text: string };
    };
    expect(body.ingestion_id).toMatch(/^ing_/);
    expect(body.status).toBe("completed");
    expect(body.transcription).toMatchObject({ status: "completed", mode: "regular", text: "hello transcript" });
    expect(body.metadata).toMatchObject({
      source: "soundcore",
      device: "soundcore-work",
      title: "Soundcore Recording",
      recorded_at: "2026-06-09T12:00:00Z",
      client_request_id: "req-1",
      notes: "meeting notes",
      prompt: "Summarize action items for Tim."
    });
    expect(body.file).toMatchObject({ filename: "recording.mp3", content_type: "audio/mpeg", size_bytes: 8 });
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      keyIdentity: "shortcut",
      result: {
        ingestion_id: body.ingestion_id,
        status: "completed",
        metadata: { prompt: "Summarize action items for Tim." },
        transcription: { status: "completed", mode: "regular", text: "hello transcript" }
      }
    });

    expect(transcriber.transcribe).toHaveBeenCalledTimes(1);
    const transcriberInput = transcriber.transcribe.mock.calls[0]?.[0];
    expect(transcriberInput?.path).toContain(body.ingestion_id);
    await expect(readFile(transcriberInput!.path, "utf8")).resolves.toBe("mp3-data");

    const record = await state.readAudioIngestion(body.ingestion_id);
    expect(record?.metadata).toMatchObject({ source: "soundcore", device: "soundcore-work", client_request_id: "req-1", prompt: "Summarize action items for Tim." });
    expect(record?.status).toBe("completed");
    expect(record?.file?.localPath).toBe(transcriberInput?.path);
  });

  test.each([
    ["recording.wav", "audio/wav"],
    ["recording.mp3", "audio/mpeg"],
    ["recording.m4a", "audio/mp4"],
    ["recording.webm", "audio/webm"],
    ["recording.ogg", "audio/ogg"],
  ])("accepts supported audio upload %s (%s)", async (filename, contentType) => {
    const { baseUrl, transcriber } = await makeHarness();
    const response = await postAudio(baseUrl, formWithAudio(filename, contentType), { Authorization: "Bearer test-secret" });

    expect(response.status).toBe(201);
    const body = await response.json() as { file: { filename: string; content_type: string }; transcription: { text: string } };
    expect(body.file).toMatchObject({ filename, content_type: contentType });
    expect(body.transcription.text).toBe("hello transcript");
    expect(transcriber.transcribe).toHaveBeenCalledOnce();
    expect(transcriber.transcribe.mock.calls[0]?.[0].path).toMatch(new RegExp(`original\\.${filename.split(".").at(-1)}$`));
  });

  test("passes requested diarization mode and returns speaker segments", async () => {
    const { baseUrl, state, transcriber } = await makeHarness();
    transcriber.transcribe.mockResolvedValueOnce({
      text: "A: Hello.\nB: Hi.",
      mode: "diarize",
      model: "gpt-4o-transcribe-diarize",
      speakerSegments: [
        { id: "seg_1", start: 0, end: 1.2, text: "Hello.", speaker: "A" },
        { id: "seg_2", start: 1.2, end: 2.4, text: "Hi.", speaker: "B" }
      ],
      rawDiarizedJson: { task: "transcribe", duration: 2.4 }
    });

    const response = await postAudio(baseUrl, formWithMp3({
      transcription_mode: "diarize",
      client_request_id: "diarize-request"
    }), { Authorization: "Bearer test-secret" });

    expect(response.status).toBe(201);
    const body = await response.json() as {
      ingestion_id: string;
      metadata: { transcription_mode?: string };
      transcription: { status: string; mode?: string; model?: string; text: string; speaker_segments?: unknown[]; raw_diarized_json?: unknown };
    };
    expect(transcriber.transcribe).toHaveBeenCalledWith(expect.objectContaining({ mode: "diarize" }));
    expect(body.metadata.transcription_mode).toBe("diarize");
    expect(body.transcription).toMatchObject({
      status: "completed",
      mode: "diarize",
      model: "gpt-4o-transcribe-diarize",
      text: "A: Hello.\nB: Hi.",
      speaker_segments: [
        { id: "seg_1", start: 0, end: 1.2, text: "Hello.", speaker: "A" },
        { id: "seg_2", start: 1.2, end: 2.4, text: "Hi.", speaker: "B" }
      ],
      raw_diarized_json: { task: "transcribe", duration: 2.4 }
    });
    const record = await state.readAudioIngestion(body.ingestion_id);
    expect(record?.transcription).toMatchObject({
      mode: "diarize",
      speakerSegments: [
        { id: "seg_1", start: 0, end: 1.2, text: "Hello.", speaker: "A" },
        { id: "seg_2", start: 1.2, end: 2.4, text: "Hi.", speaker: "B" }
      ]
    });
  });

  test("accepts X-CodexChat-Ingest-Key header", async () => {
    const { baseUrl } = await makeHarness();

    const response = await postAudio(baseUrl, formWithMp3(), { "X-CodexChat-Ingest-Key": "backup-secret" });

    expect(response.status).toBe(201);
    const body = await response.json() as { status: string };
    expect(body.status).toBe("completed");
  });

  test("enforces configured max upload size", async () => {
    process.env.CODEXCHAT_AUDIO_INGEST_MAX_MB = "0.000001";
    const { baseUrl, transcriber } = await makeHarness();

    const response = await postAudio(baseUrl, formWithMp3({}, Buffer.from("larger-than-one-byte")), { Authorization: "Bearer test-secret" });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "file_too_large" });
    expect(transcriber.transcribe).not.toHaveBeenCalled();
  });

  test("reuses existing ingestion for duplicate client_request_id from the same key", async () => {
    const completions: AudioIngestionCompletedEvent[] = [];
    const { baseUrl, transcriber } = await makeHarness("", {
      onAudioIngestionCompleted: async (event) => {
        completions.push(event);
      }
    });

    const first = await postAudio(baseUrl, formWithMp3({ client_request_id: "same-request" }), { Authorization: "Bearer test-secret" });
    const firstBody = await first.json() as { ingestion_id: string; status: string };
    const second = await postAudio(baseUrl, formWithMp3({ client_request_id: "same-request" }), { Authorization: "Bearer test-secret" });
    const secondBody = await second.json() as { ingestion_id: string; status: string; duplicate?: boolean };

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(secondBody).toMatchObject({ ingestion_id: firstBody.ingestion_id, status: "completed", duplicate: true });
    expect(transcriber.transcribe).toHaveBeenCalledTimes(1);
    expect(completions).toHaveLength(1);
  });
});
