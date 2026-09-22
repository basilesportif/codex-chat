import type { DirectiveAction } from "./directives.js";
import type { MainAgentProvider } from "./types.js";

export type DispatchSubagentAction = Extract<DirectiveAction, { type: "dispatch_subagent" }>;
export type SubagentWorkload = "coding" | "routine_non_coding" | "unknown";

const CODING_WORK = [
  /\b(?:coding|codebase|source code|source files?)\b/i,
  /\b(?:debug|debugging|bug|regression|stack trace|test failure|failing tests?)\b/i,
  /\b(?:code review|review (?:the )?(?:diff|patch|pull request)|pull request|software architecture|system architecture|application architecture)\b/i,
  /\b(?:deploy|deployment|production rollout|software release|caddy|systemd)\b/i,
  /\b(?:typescript|javascript|python|rust|golang|go code)\b/i,
  /\b(?:implement|edit|modify|change|fix|refactor)\b.{0,40}\b(?:code|source|module|component|api|server|service|repo(?:sitory)?)\b/i
];

const ROUTINE_NON_CODING_WORK = [
  /\b(?:crm|contacts?|business(?:es)?|correspondence|follow[- ]?ups?)\b/i,
  /\b(?:calendar|gmail|email|composio)\b/i,
  /\b(?:project (?:state|data|record|note|task)|projects? scripts?|project access)\b/i,
  /\b(?:todos?|reminders?|betting|odds|finance|banking|transactions?|whoop|health)\b/i,
  /\b(?:external[- ]data|account lookup|messaging read|slack (?:history|thread|channel))\b/i,
  /\b(?:research|web search|docs? lookup|look up|lookup)\b/i,
  /--on-behalf-of\b/i,
  /\/config\/skills\/(?:crm|composio|todo|reminders|betting|finance|whoop|messaging)\.md\b/i
];

/**
 * Classify the work described by a dispatch, independently of the selected
 * subagent profile. Profiles describe the execution role; they must not turn
 * routine CRM/project operations into coding work merely because the role can
 * mutate data.
 */
export function classifySubagentWorkload(action: DispatchSubagentAction): SubagentWorkload {
  const text = `${action.summary}\n${action.prompt}`;
  if (CODING_WORK.some((pattern) => pattern.test(text))) return "coding";
  if (action.profile.trim().toLowerCase() === "operator") return "routine_non_coding";
  if (ROUTINE_NON_CODING_WORK.some((pattern) => pattern.test(text))) return "routine_non_coding";
  return "unknown";
}

function explicitlyRequestsModel(text: string): boolean {
  return /\bgpt-[a-z0-9._-]+\b/i.test(text) ||
    /\b(?:use|using|with|via|run|dispatch)(?:\s+the)?\s+(?:sol|luna|terra|astra|codex|openai)\b/i.test(text) ||
    /\b(?:sol|luna|terra|astra)\s+(?:model|subagent)\b/i.test(text) ||
    /\bmodel(?:\s+is|\s*=|:)?[\s`"']+(?:sol|luna|terra|astra)\b/i.test(text);
}

function explicitlyRequestsEffort(text: string): boolean {
  return /\b(?:effort|reasoning)(?:\s+level)?(?:\s+is|\s*=|:)?[\s`"']*(?:none|minimal|low|medium|high|xhigh)\b/i.test(text) ||
    /\b(?:none|minimal|low|medium|high|xhigh)[- ](?:effort|reasoning)\b/i.test(text);
}

function explicitlyRequestsTier(text: string): boolean {
  return /\b(?:service\s*)?tier(?:\s+is|\s*=|:)?[\s`"']*(?:fast|standard)\b/i.test(text) ||
    /\b(?:fast|standard)[- ](?:service[- ]?)?tier\b/i.test(text) ||
    /\b(?:fast|standard|slow|deep)[- ]mode\b/i.test(text);
}

function isClaudeOrProviderOverride(action: DispatchSubagentAction): boolean {
  const model = action.model.trim().toLowerCase();
  return action.backend === "claude_agent_sdk" ||
    model.startsWith("claude") ||
    ["opus", "fable", "sonnet", "haiku"].includes(model) ||
    Boolean(action.codexProfile || action.modelProvider || action.serviceTierMode);
}

/** True when the dispatch targets Fable (alias `fable` or `claude-fable-*`). */
function isFableModel(model: string | undefined): boolean {
  const normalized = (model ?? "").trim().toLowerCase();
  return normalized === "fable" || normalized.startsWith("claude-fable");
}

/** True when the user's own message asked for Fable by name. */
function explicitlyRequestsFable(text: string): boolean {
  return /\bfable\b/i.test(text);
}

/** Current flagship Opus for Claude-mode coding/intensive subagents. */
export const CLAUDE_CODING_MODEL = "claude-opus-5-5";

const INTENSIVE_WORK = /\b(?:very intensive|intensive|high[- ]stakes|risky|large[- ]scope)\b/i;

/**
 * True when the dispatch describes very intensive / risky / high-stakes /
 * large-scope work, which keeps high effort on Opus 5.5 (the rubric's
 * "intensive" tier) instead of the medium coding default.
 */
function isIntensiveWork(action: DispatchSubagentAction): boolean {
  return INTENSIVE_WORK.test(`${action.summary}\n${action.prompt}`);
}

/**
 * Version token of an Opus model older than Opus 5.5 (`"5"` for
 * `claude-opus-5`, `"4-8"` for `claude-opus-4-8`), or undefined when the
 * model is not a superseded Opus. `claude-opus-5-5`, later Opus releases, and
 * the `opus` alias (which tracks the newest Opus) are not superseded.
 */
function supersededOpusVersion(model: string | undefined): string | undefined {
  const normalized = (model ?? "").trim().toLowerCase().replace(/\[1m\]$/, "");
  const match = /^claude-opus-(5|4(?:-\d+)?)(?:-\d{8})?$/.exec(normalized);
  return match?.[1];
}

/** True when the user's own message named that specific older Opus. */
function explicitlyRequestsOpusVersion(version: string, text: string): boolean {
  // "claude-opus-5" / "Opus 5" must not match inside "claude-opus-5-5" / "Opus 5.5".
  const versionPattern = version.split("-").join("[.-]");
  return new RegExp(`\\b(?:claude-)?opus[\\s-]?${versionPattern}(?![.-]?\\d)`, "i").test(text);
}

function isOpus55(model: string | undefined): boolean {
  return (model ?? "").trim().toLowerCase().startsWith(CLAUDE_CODING_MODEL);
}

const EFFORT_RANK: Record<string, number> = { none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5 };

/**
 * Claude-mode Opus enforcement applied to directives that otherwise pass
 * through untouched (Claude overrides): a superseded Opus the user did not
 * name is upgraded to Opus 5.5, and an Opus 5.5 coding dispatch whose effort
 * exceeds the rubric (medium for coding, high for intensive work) without the
 * user asking for an effort is lowered to the rubric level.
 */
function enforceClaudeOpusDefaults(
  action: DispatchSubagentAction,
  originText: string,
  workload: SubagentWorkload
): DispatchSubagentAction {
  let next = action;
  const olderVersion = supersededOpusVersion(next.model);
  if (olderVersion && !explicitlyRequestsOpusVersion(olderVersion, originText)) {
    next = { ...next, model: CLAUDE_CODING_MODEL };
  }
  const intensive = isIntensiveWork(next);
  if (isOpus55(next.model) && (workload === "coding" || intensive) && !explicitlyRequestsEffort(originText)) {
    const target = intensive ? "high" : "medium";
    if ((EFFORT_RANK[next.effort] ?? 0) > EFFORT_RANK[target]) {
      next = { ...next, effort: target };
    }
  }
  return next;
}

export interface NormalizedSubagentRouting {
  action: DispatchSubagentAction;
  changed: boolean;
  workload: SubagentWorkload;
}

/**
 * Apply the service's default model rubric as a safety net around the main
 * agent's directive. Explicit model requests and Claude/provider overrides
 * are authoritative. Explicit effort/tier requests are preserved while the
 * default model is corrected for the workload.
 */
export function normalizeSubagentRouting(
  action: DispatchSubagentAction,
  originText: string,
  mainProvider: MainAgentProvider = "codex"
): NormalizedSubagentRouting {
  // Fable defaults to medium reasoning effort unless the user explicitly asked
  // for an effort level. Without this, the main agent's rubric tends to pick
  // xhigh for Fable dispatches.
  let changedByFableDefault = false;
  if (isFableModel(action.model) && !explicitlyRequestsEffort(originText) && action.effort !== "medium") {
    action = { ...action, effort: "medium" };
    changedByFableDefault = true;
  }

  const workload = classifySubagentWorkload(action);
  if (mainProvider === "claude_agent_sdk") {
    // Fable is quota-precious: it runs only when the USER explicitly asked for
    // it. A Fable dispatch the main loop invented on its own (precedent drift)
    // is rewritten to the workload default like any other non-explicit choice.
    const unrequestedFable = isFableModel(action.model) && !explicitlyRequestsFable(originText);
    if (!unrequestedFable && isClaudeOrProviderOverride(action)) {
      const enforced = enforceClaudeOpusDefaults(action, originText, workload);
      return { action: enforced, changed: changedByFableDefault || enforced !== action, workload };
    }

    if (unrequestedFable || !explicitlyRequestsModel(originText)) {
      // Coding runs on Opus 5.5 at medium; very intensive work keeps Opus 5.5
      // at high; everything else runs on Sonnet 5 at high.
      const defaults = isIntensiveWork(action)
        ? { model: CLAUDE_CODING_MODEL, effort: "high" as const }
        : workload === "coding"
          ? { model: CLAUDE_CODING_MODEL, effort: "medium" as const }
          : { model: "claude-sonnet-5", effort: "high" as const };
      const normalized: DispatchSubagentAction = {
        ...action,
        model: defaults.model,
        effort: explicitlyRequestsEffort(originText) ? action.effort : defaults.effort,
        serviceTier: explicitlyRequestsTier(originText) ? action.serviceTier : "standard",
        backend: "claude_agent_sdk"
      };
      delete normalized.codexProfile;
      delete normalized.modelProvider;
      delete normalized.serviceTierMode;
      return { action: normalized, changed: true, workload };
    }
  }

  if (isClaudeOrProviderOverride(action) || explicitlyRequestsModel(originText)) {
    return { action, changed: changedByFableDefault, workload };
  }

  // Coding/debugging/review/implementation runs on Astra at high effort; every
  // other workload (including "unknown", which must not silently inherit a
  // heavier default) runs on Sol at medium. Fast service tier is never a
  // default — it applies only when the user's own text asked for it.
  const defaults = workload === "coding"
    ? { model: "gpt-6-astra", effort: "high" as const, serviceTier: "standard" as const }
    : { model: "gpt-5.6-sol", effort: "medium" as const, serviceTier: "standard" as const };
  const normalized: DispatchSubagentAction = {
    ...action,
    model: defaults.model,
    effort: explicitlyRequestsEffort(originText) ? action.effort : defaults.effort,
    serviceTier: explicitlyRequestsTier(originText) ? action.serviceTier : defaults.serviceTier
  };
  const changed = normalized.model !== action.model ||
    normalized.effort !== action.effort ||
    normalized.serviceTier !== action.serviceTier;
  return { action: normalized, changed, workload };
}
