import { describe, expect, test } from "vitest";
import type { AppConfig } from "../config.js";
import { childSecretEnvNames, sanitizeChildProcessEnv } from "../env.js";

function config(apiKeyEnv = "TRANSCRIPTION_API_KEY"): Pick<AppConfig, "transcription"> {
  return { transcription: { apiKeyEnv } } as Pick<AppConfig, "transcription">;
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
    expect(new Set(childSecretEnvNames(config("CUSTOM_TRANSCRIPTION_KEY")))).toEqual(new Set(["OPENAI_API_KEY", "CUSTOM_TRANSCRIPTION_KEY"]));
    expect(childSecretEnvNames(config("OPENAI_API_KEY"))).toEqual(["OPENAI_API_KEY"]);
  });
});
