import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BehaviorPack } from "../behavior.js";
import { defaultPathsConfig, loadConfig } from "../config.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-chat-behavior-"));
  tempDirs.push(root);
  return root;
}

describe("BehaviorPack path template substitution", () => {
  test("bootstrap prompt and subagent profiles substitute configured {{LOGIC_REPO}}/{{WORKSPACE}}", async () => {
    const root = await makeRoot();
    const behaviorDir = join(root, "behavior");
    await mkdir(join(behaviorDir, "subagents"), { recursive: true });
    await writeFile(join(behaviorDir, "AGENTS.md"), [
      "Scripts live at {{LOGIC_REPO}}/scripts/.",
      "State lives at {{WORKSPACE}}/data/.",
      "Overlay: {{WORKSPACE}}/instructions/skills and {{LOGIC_REPO}}/config/skills."
    ].join("\n"));
    await writeFile(join(behaviorDir, "subagents", "tester.md"), "Read {{LOGIC_REPO}}/config/skills/x.md under {{WORKSPACE}}.\n");
    await writeFile(join(root, "codex-chat.toml"), [
      "version = 1",
      "[behavior]",
      `dir = "${behaviorDir}"`,
      "[paths]",
      'logicRepo = "/custom/logic-repo"',
      'assistantWorkspace = "/custom/workspace"'
    ].join("\n"));

    const config = await loadConfig(join(root, "codex-chat.toml"));
    const pack = new BehaviorPack(config);

    const prompt = await pack.loadBootstrapPrompt();
    expect(prompt).toContain("/custom/logic-repo/scripts/");
    expect(prompt).toContain("/custom/workspace/data/");
    expect(prompt).not.toContain("{{LOGIC_REPO}}");
    expect(prompt).not.toContain("{{WORKSPACE}}");

    const profile = await pack.readSubagentProfile("tester");
    expect(profile).toBe("Read /custom/logic-repo/config/skills/x.md under /custom/workspace.\n");
  });

  test("real behavior pack renders default absolute paths with no leftover tokens", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "codex-chat.toml"), [
      "version = 1",
      "[behavior]",
      `dir = "${join(process.cwd(), "behavior")}"`
    ].join("\n"));

    const config = await loadConfig(join(root, "codex-chat.toml"));
    const pack = new BehaviorPack(config);
    const prompt = await pack.loadBootstrapPrompt();
    const defaults = defaultPathsConfig();
    expect(prompt).toContain(defaults.logicRepo);
    expect(prompt).toContain(defaults.assistantWorkspace);
    expect(prompt).not.toContain("{{LOGIC_REPO}}");
    expect(prompt).not.toContain("{{WORKSPACE}}");
  });
});
