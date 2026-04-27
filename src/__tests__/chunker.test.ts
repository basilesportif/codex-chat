import { describe, expect, test } from "vitest";
import { chunkText } from "../util.js";

describe("message chunking", () => {
  test("passes messages under the limit through unchanged", () => {
    expect(chunkText("short message", 100)).toEqual(["short message"]);
  });

  test("splits long messages at newline boundaries", () => {
    expect(chunkText("alpha\nbravo\ncharlie", 13)).toEqual(["alpha\nbravo", "charlie"]);
  });

  test("keeps fenced code blocks together when they fit in a chunk", () => {
    const chunks = chunkText("Intro\n\n```ts\nconst value = 1;\n```\n\nOutro", 30);
    const codeChunks = chunks.filter((chunk) => chunk.includes("```"));

    expect(chunks).toEqual(["Intro", "```ts\nconst value = 1;\n```", "Outro"]);
    expect(codeChunks).toHaveLength(1);
    expect(codeChunks[0]?.match(/```/g)).toHaveLength(2);
  });
});
