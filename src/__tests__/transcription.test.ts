import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadConfig } from "../config.js";
import { OpenAITranscriber } from "../transcription.js";

const openAiMocks = vi.hoisted(() => ({
  create: vi.fn()
}));

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(function MockOpenAI() {
    return {
      audio: {
        transcriptions: {
          create: openAiMocks.create
        }
      }
    };
  })
}));

const tempDirs: string[] = [];
const originalEnv = { ...process.env };

async function loadTranscriptionConfig(promptPath: string) {
  const root = await mkdtemp(join(tmpdir(), "codex-chat-transcription-"));
  tempDirs.push(root);
  const configDir = join(root, "config");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "codex-chat.toml"), `
version = 1

[service]
workspace = "${root}"

[transcription]
enabled = true
provider = "openai"
model = "gpt-4o-transcribe"
apiKeyEnv = "OPENAI_API_KEY"
language = "en"
promptPath = "${promptPath}"
`);
  process.env.OPENAI_API_KEY = "sk-test";
  const config = await loadConfig(join(configDir, "codex-chat.toml"));
  const audioPath = join(root, "voice.ogg");
  await writeFile(audioPath, "audio");
  return { config, root, audioPath };
}

function destroyRequestFile(input: unknown): void {
  const file = (input as { file?: { destroy?: () => void } }).file;
  file?.destroy?.();
}

beforeEach(() => {
  openAiMocks.create.mockReset();
  openAiMocks.create.mockImplementation(async (input: unknown) => {
    destroyRequestFile(input);
    return { text: "transcribed text" };
  });
});

afterEach(async () => {
  process.env = { ...originalEnv };
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("OpenAITranscriber", () => {
  test("passes configured prompt file contents to OpenAI transcription", async () => {
    const { config, root, audioPath } = await loadTranscriptionConfig("prompts/voice-transcription.md");
    const promptPath = join(root, "prompts", "voice-transcription.md");
    await mkdir(join(root, "prompts"), { recursive: true });
    await writeFile(promptPath, "Prefer Codex, not codecs.\n");

    const transcriber = new OpenAITranscriber(config);
    await expect(transcriber.transcribe({ path: audioPath })).resolves.toMatchObject({
      text: "transcribed text",
      mode: "regular",
      model: "gpt-4o-transcribe"
    });

    expect(openAiMocks.create).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-4o-transcribe",
      language: "en",
      prompt: "Prefer Codex, not codecs.\n"
    }));
    expect(openAiMocks.create.mock.calls[0]?.[0]).not.toEqual(expect.objectContaining({
      response_format: "diarized_json"
    }));
  });

  test("omits prompt when configured prompt file is missing", async () => {
    const { config, audioPath } = await loadTranscriptionConfig("prompts/missing.md");

    const transcriber = new OpenAITranscriber(config);
    await transcriber.transcribe({ path: audioPath });

    const request = openAiMocks.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request).not.toHaveProperty("prompt");
  });

  test("reads prompt file fresh for every transcription", async () => {
    const { config, root, audioPath } = await loadTranscriptionConfig("prompts/voice-transcription.md");
    const promptPath = join(root, "prompts", "voice-transcription.md");
    await mkdir(join(root, "prompts"), { recursive: true });
    const transcriber = new OpenAITranscriber(config);

    await writeFile(promptPath, "First dictionary\n");
    await transcriber.transcribe({ path: audioPath });
    await writeFile(promptPath, "Second dictionary\n");
    await transcriber.transcribe({ path: audioPath });

    expect(openAiMocks.create.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ prompt: "First dictionary\n" }));
    expect(openAiMocks.create.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ prompt: "Second dictionary\n" }));
  });

  test("constructs diarization requests without prompt and normalizes speaker segments", async () => {
    const { config, root, audioPath } = await loadTranscriptionConfig("prompts/voice-transcription.md");
    await mkdir(join(root, "prompts"), { recursive: true });
    await writeFile(join(root, "prompts", "voice-transcription.md"), "Regular prompt should be omitted for diarize.\n");
    openAiMocks.create.mockImplementationOnce(async (input: unknown) => {
      destroyRequestFile(input);
      return {
        task: "transcribe",
        duration: 4.2,
        text: "A: Hello.\nB: Hi.",
        segments: [
          { type: "transcript.text.segment", id: "seg_1", start: 0, end: 1.5, text: "Hello.", speaker: "A" },
          { type: "transcript.text.segment", id: "seg_2", start: 1.5, end: 3, text: "Hi.", speaker: "B" }
        ],
        usage: { type: "duration", seconds: 4 }
      };
    });

    const transcriber = new OpenAITranscriber(config);
    const result = await transcriber.transcribe({ path: audioPath, mode: "diarize" });

    expect(openAiMocks.create).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-4o-transcribe-diarize",
      language: "en",
      response_format: "diarized_json",
      chunking_strategy: "auto"
    }));
    const request = openAiMocks.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request).not.toHaveProperty("prompt");
    expect(result).toMatchObject({
      text: "A: Hello.\nB: Hi.",
      mode: "diarize",
      model: "gpt-4o-transcribe-diarize",
      speakerSegments: [
        { id: "seg_1", start: 0, end: 1.5, text: "Hello.", speaker: "A" },
        { id: "seg_2", start: 1.5, end: 3, text: "Hi.", speaker: "B" }
      ]
    });
    expect(result.rawDiarizedJson).toEqual(expect.objectContaining({ task: "transcribe", duration: 4.2 }));
  });
});
