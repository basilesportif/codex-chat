import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  test("substitutes configured owner tokens in bootstrap and subagent prompts", async () => {
    const root = await makeRoot();
    const behaviorDir = join(root, "behavior");
    await mkdir(join(behaviorDir, "subagents"), { recursive: true });
    await writeFile(
      join(behaviorDir, "AGENTS.md"),
      "Owner={{OWNER_NAME}} chat={{OWNER_TELEGRAM_CHAT_ID}} remotes={{OWNER_TRUSTED_REMOTES}}\n",
    );
    await writeFile(
      join(behaviorDir, "subagents", "tester.md"),
      "Work for {{OWNER_NAME}} in chat {{OWNER_TELEGRAM_CHAT_ID}}.\n",
    );
    await writeFile(
      join(root, "codex-chat.toml"),
      [
        "version = 1",
        "[behavior]",
        `dir = "${behaviorDir}"`,
        "[owner]",
        'name = "Alex Example"',
        "telegramChatId = 987654321",
        'trustedRemotes = ["example/*", "trusted/repo"]',
      ].join("\n"),
    );

    const config = await loadConfig(join(root, "codex-chat.toml"));
    const pack = new BehaviorPack(config);

    const prompt = await pack.loadBootstrapPrompt();
    expect(prompt).toContain(
      "Owner=Alex Example chat=987654321 remotes=example/*, trusted/repo",
    );
    expect(prompt).not.toContain("{{OWNER_");

    const profile = await pack.readSubagentProfile("tester");
    expect(profile).toBe("Work for Alex Example in chat 987654321.\n");
  });

  test("generic behavior pack loads an owner-neutral prompt", async () => {
    const root = await makeRoot();
    const behaviorDir = join(root, "generic");
    await cp(join(process.cwd(), "behavior-templates/generic"), behaviorDir, {
      recursive: true,
    });
    await writeFile(
      join(root, "codex-chat.toml"),
      [
        "version = 1",
        "[behavior]",
        `dir = "${behaviorDir}"`,
        "[owner]",
        'name = "Alex Example"',
        "telegramChatId = 987654321",
        'trustedRemotes = ["example/*"]',
        "[paths]",
        'logicRepo = "/srv/assistant-agent-logic"',
        'assistantWorkspace = "/srv/assistant-workspace"',
      ].join("\n"),
    );

    const config = await loadConfig(join(root, "codex-chat.toml"));
    const prompt = await new BehaviorPack(config).loadBootstrapPrompt();

    expect(prompt).toContain("Alex Example");
    expect(prompt).toContain("987654321");
    expect(prompt).toContain("example/*");
    expect(prompt).not.toContain("{{OWNER_");
    expect(prompt).not.toContain("Tim");
    expect(prompt).not.toContain("253768951");
    expect(prompt).not.toContain("/home/tim");
  });
});
