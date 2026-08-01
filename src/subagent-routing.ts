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
    /\b(?:use|using|with|via|run|dispatch)(?:\s+the)?\s+(?:sol|luna|terra|codex|openai)\b/i.test(text) ||
    /\b(?:sol|luna|terra)\s+(?:model|subagent)\b/i.test(text) ||
    /\bmodel(?:\s+is|\s*=|:)?[\s`"']+(?:sol|luna|terra)\b/i.test(text);
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
      return { action, changed: changedByFableDefault, workload };
    }

    if (unrequestedFable || !explicitlyRequestsModel(originText)) {
      const defaults = workload === "coding"
        ? { model: "claude-opus-5", effort: "high" as const }
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

  if (workload === "unknown" || isClaudeOrProviderOverride(action) || explicitlyRequestsModel(originText)) {
    return { action, changed: changedByFableDefault, workload };
  }

  const defaults = workload === "coding"
    ? { model: "gpt-5.6-sol", effort: "high" as const, serviceTier: "fast" as const }
    : { model: "gpt-5.6-luna", effort: "xhigh" as const, serviceTier: "fast" as const };
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
