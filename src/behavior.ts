import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { AppConfig, PathsConfig, resolveConfigPath } from "./config.js";
import { pathExists } from "./util.js";

export class BehaviorPack {
  readonly dir: string;
  readonly entrypointPath: string;
  private readonly paths: PathsConfig;
  constructor(config: AppConfig) {
    this.dir = resolveConfigPath(config, config.behavior.dir);
    this.entrypointPath = join(this.dir, config.behavior.entrypoint);
    this.paths = config.paths;
  }

  /**
   * Behavior-pack markdown refers to the assistant-agent-logic checkout and
   * the assistant workspace via {{LOGIC_REPO}} / {{WORKSPACE}} template
   * tokens; substitute the configured absolute paths whenever file content
   * is assembled into a prompt.
   */
  private substituteTemplateTokens(text: string): string {
    return text
      .replaceAll("{{LOGIC_REPO}}", this.paths.logicRepo)
      .replaceAll("{{WORKSPACE}}", this.paths.assistantWorkspace);
  }

  async loadBootstrapPrompt(): Promise<string> {
    const entry = this.substituteTemplateTokens(await readFile(this.entrypointPath, "utf8"));
    const subagents = await this.listFiles("subagents", ".md");
    const skills = await this.listFiles("skills", "SKILL.md");
    const prompt = [
      "You are the main codex-chat agent for this service.",
      `Read and follow the behavior pack rooted at: ${this.dir}`,
      `Primary behavior file: ${this.entrypointPath}`,
      "",
      "Behavior pack contents:",
      "```markdown",
      entry.trim(),
      "```",
      "",
      subagents.length > 0 ? `Available subagent profiles:\n${subagents.map((file) => `- ${file}`).join("\n")}` : "Available subagent profiles: none",
      skills.length > 0 ? `Available skill files:\n${skills.map((file) => `- ${file}`).join("\n")}` : "Available skill files: none",
      "",
      "When you need the service to perform an external action, emit only a valid codex-chat directive block matching the documented JSON schemas."
    ].join("\n");
    return prompt;
  }

  async hash(): Promise<string> {
    return this.computeHash();
  }


  private async computeHash(): Promise<string> {
    const files = await this.collectFiles(this.dir);
    const hasher = createHash("sha256");
    for (const file of files.sort()) {
      hasher.update(relative(this.dir, file));
      hasher.update("\0");
      hasher.update(await readFile(file));
      hasher.update("\0");
    }
    return hasher.digest("hex");
  }

  async readSubagentProfile(profile: string): Promise<string> {
    const safe = profile.replace(/[^a-zA-Z0-9_.-]/g, "");
    const path = join(this.dir, "subagents", `${safe}.md`);
    if (!(await pathExists(path))) throw new Error(`Unknown subagent profile: ${profile}`);
    return this.substituteTemplateTokens(await readFile(path, "utf8"));
  }

  private async listFiles(folder: string, suffix: string): Promise<string[]> {
    const root = join(this.dir, folder);
    if (!(await pathExists(root))) return [];
    const files = await this.collectFiles(root);
    return files
      .filter((file) => file.endsWith(suffix))
      .map((file) => relative(this.dir, file));
  }

  private async collectFiles(root: string): Promise<string[]> {
    if (!(await pathExists(root))) return [];
    const info = await stat(root);
    if (info.isFile()) return [root];
    const entries = await readdir(root, { withFileTypes: true });
    const out: string[] = [];
    for (const entry of entries) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) out.push(...(await this.collectFiles(path)));
      if (entry.isFile()) out.push(path);
    }
    return out;
  }
}
