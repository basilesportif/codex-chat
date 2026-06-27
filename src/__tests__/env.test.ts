import { describe, expect, test } from "vitest";
import type { AppConfig } from "../config.js";
import { childSecretEnvNames, sanitizeChildProcessEnv } from "../env.js";

function config(apiKeyEnv = "TRANSCRIPTION_API_KEY", ingestKeysEnv?: string): Pick<AppConfig, "transcription"> & Partial<Pick<AppConfig, "ingest" | "slack">> {
  return {
    transcription: { apiKeyEnv },
    ingest: ingestKeysEnv ? { apiKeysEnv: ingestKeysEnv } : undefined,
    slack: {
      signingSecretEnv: "SLACK_SIGNING_SECRET",
      botTokenEnv: "SLACK_BOT_TOKEN",
      appTokenEnv: "SLACK_APP_TOKEN"
    }
  } as Pick<AppConfig, "transcription"> & Partial<Pick<AppConfig, "ingest" | "slack">>;
}

describe("child process environment sanitizer", () => {
  test("strips OPENAI_API_KEY and configured transcription env without mutating input", () => {
    const input = {
      OPENAI_API_KEY: "present",
      TRANSCRIPTION_API_KEY: "present",
      OTHER_VAR: "keep"
    };

    const sanitized = sanitizeChildProcessEnv(config(), input);

    expect(sanitized).not.toHaveProperty("OPENAI_API_KEY");
    expect(sanitized).not.toHaveProperty("TRANSCRIPTION_API_KEY");
    expect(sanitized.OTHER_VAR).toBe("keep");
    expect(input.OPENAI_API_KEY).toBe("present");
    expect(input.TRANSCRIPTION_API_KEY).toBe("present");
  });

  test("strips configured secrets even when overrides attempt to re-add them", () => {
    const sanitized = sanitizeChildProcessEnv(
      config("CUSTOM_TRANSCRIPTION_KEY"),
      { OPENAI_API_KEY: "parent", CUSTOM_TRANSCRIPTION_KEY: "parent", OTHER_VAR: "parent" },
      { OPENAI_API_KEY: "override", CUSTOM_TRANSCRIPTION_KEY: "override", OTHER_VAR: "override" }
    );

    expect(sanitized).not.toHaveProperty("OPENAI_API_KEY");
    expect(sanitized).not.toHaveProperty("CUSTOM_TRANSCRIPTION_KEY");
    expect(sanitized.OTHER_VAR).toBe("override");
  });

  test("reports the literal and configured secret env names", () => {
    expect(new Set(childSecretEnvNames(config("CUSTOM_TRANSCRIPTION_KEY")))).toEqual(new Set([
      "OPENAI_API_KEY",
      "CUSTOM_TRANSCRIPTION_KEY",
      "SLACK_SIGNING_SECRET",
      "SLACK_BOT_TOKEN",
      "SLACK_APP_TOKEN"
    ]));
    expect(new Set(childSecretEnvNames(config("OPENAI_API_KEY")))).toEqual(new Set([
      "OPENAI_API_KEY",
      "SLACK_SIGNING_SECRET",
      "SLACK_BOT_TOKEN",
      "SLACK_APP_TOKEN"
    ]));
  });

  test("strips configured ingest API key env", () => {
    const sanitized = sanitizeChildProcessEnv(
      config("CUSTOM_TRANSCRIPTION_KEY", "CODEXCHAT_INGEST_API_KEYS"),
      { OPENAI_API_KEY: "parent", CUSTOM_TRANSCRIPTION_KEY: "parent", CODEXCHAT_INGEST_API_KEYS: "secret", OTHER_VAR: "keep" }
    );

    expect(sanitized).not.toHaveProperty("CODEXCHAT_INGEST_API_KEYS");
    expect(sanitized.OTHER_VAR).toBe("keep");
  });

  test("strips configured Slack secrets", () => {
    const sanitized = sanitizeChildProcessEnv(
      config("CUSTOM_TRANSCRIPTION_KEY", "CODEXCHAT_INGEST_API_KEYS"),
      {
        SLACK_SIGNING_SECRET: "signing-secret",
        SLACK_BOT_TOKEN: "xoxb-secret",
        SLACK_APP_TOKEN: "xapp-secret",
        OTHER_VAR: "keep"
      }
    );

    expect(sanitized).not.toHaveProperty("SLACK_SIGNING_SECRET");
    expect(sanitized).not.toHaveProperty("SLACK_BOT_TOKEN");
    expect(sanitized).not.toHaveProperty("SLACK_APP_TOKEN");
    expect(sanitized.OTHER_VAR).toBe("keep");
  });
});
