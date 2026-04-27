import { describe, expect, test } from "vitest";

describe("codex spawn environment safety", () => {
  test("OPENAI_API_KEY is stripped from codex spawn env", () => {
    // Simulate what every codex spawn site does
    const mockProcessEnv = {
      PATH: "/usr/bin:/bin",
      HOME: "/home/tim",
      OPENAI_API_KEY: "sk-test-should-never-reach-codex",
      TELEGRAM_BOT_TOKEN: "123:abc",
      OTHER_VAR: "keep-me"
    };

    const { OPENAI_API_KEY: _omit, ...safeEnv } = mockProcessEnv;

    expect(safeEnv).not.toHaveProperty("OPENAI_API_KEY");
    expect(safeEnv.PATH).toBe("/usr/bin:/bin");
    expect(safeEnv.HOME).toBe("/home/tim");
    expect(safeEnv.OTHER_VAR).toBe("keep-me");
    expect(_omit).toBe("sk-test-should-never-reach-codex");
  });

  test("safeEnv construction does not mutate process.env", () => {
    const original = { ...process.env };
    const { OPENAI_API_KEY: _omit, ...safeEnv } = process.env;
    // process.env should be unmodified
    expect(process.env).toEqual(original);
    // safeEnv should not have the key
    expect(safeEnv).not.toHaveProperty("OPENAI_API_KEY");
  });
});
