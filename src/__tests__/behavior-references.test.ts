import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * The behavior pack references scripts and skill docs that live in the
 * assistant-agent-logic repo. Those references are hand-maintained and have
 * gone stale before (agents then run nonexistent commands and improvise).
 * This test asserts every referenced file actually exists.
 */
const LOGIC_REPO = "/home/tim/pkg/tim/assistant-agent-logic";
const BEHAVIOR_DIR = join(process.cwd(), "behavior");

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function markdownFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await markdownFiles(path));
    else if (entry.name.endsWith(".md")) out.push(path);
  }
  return out;
}

describe("behavior pack cross-repo references", () => {
  test("every referenced assistant-agent-logic script and skill doc exists", async (context) => {
    if (!(await exists(LOGIC_REPO))) {
      context.skip(); // sibling checkout absent (e.g. bare CI); nothing to validate
      return;
    }
    const missing: string[] = [];
    for (const file of await markdownFiles(BEHAVIOR_DIR)) {
      const text = await readFile(file, "utf8");
      for (const match of text.matchAll(/scripts\/([a-zA-Z0-9._-]+\.(?:js|mjs|sh))/g)) {
        const name = match[1];
        const inLogicRepo = await exists(join(LOGIC_REPO, "scripts", name));
        const inThisRepo = await exists(join(process.cwd(), "scripts", name));
        if (!inLogicRepo && !inThisRepo) missing.push(`${file}: scripts/${name}`);
      }
      for (const match of text.matchAll(/config\/skills\/([a-zA-Z0-9._-]+\.md)/g)) {
        const name = match[1];
        if (!(await exists(join(LOGIC_REPO, "config", "skills", name)))) {
          missing.push(`${file}: config/skills/${name}`);
        }
      }
    }
    expect(missing, `stale references to assistant-agent-logic:\n${missing.join("\n")}`).toEqual([]);
  });
});
