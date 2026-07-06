export type CapabilityRiskTier = "low" | "medium" | "high";

export type CapabilityFamily =
  | "assistant"
  | "audio_ingest"
  | "directive"
  | "employees"
  | "ipc"
  | "loop"
  | "monitor"
  | "output"
  | "runtime"
  | "service"
  | "slack"
  | "subagents"
  | "system"
  | "telegram";

export interface CapabilityRegistryEntry {
  id: string;
  family: CapabilityFamily;
  description: string;
  selectorKeys: readonly string[];
  riskTier: CapabilityRiskTier;
  deprecated?: boolean;
}

export const registryVersion = 1;

const EVENT_SELECTOR_KEYS = [
  "source",
  "surfaceKind",
  "teamId",
  "channelId",
  "threadTs",
  "messageTs",
  "chatId",
  "messageId",
  "conversationSessionId",
  "actorId",
] as const;

const OUTPUT_SELECTOR_KEYS = [
  "surfaceKind",
  "teamId",
  "channelId",
  "threadTs",
  "chatId",
  "messageId",
  "targetId",
  "targetPolicy",
  "outputType",
] as const;

const IPC_SELECTOR_KEYS = ["command"] as const;
const SUBAGENT_RESULT_SELECTOR_KEYS = ["jobId", "ownerType", "ownerId", "resultTarget"] as const;

export const capabilityRegistry = [
  {
    id: "telegram.event.receive",
    family: "telegram",
    description: "Accept a Telegram inbound event into the runtime.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "medium",
  },
  {
    id: "slack.event.receive",
    family: "slack",
    description: "Accept a Slack inbound event into the runtime.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "medium",
  },
  {
    id: "loop.event.receive",
    family: "loop",
    description: "Accept a trusted loop callback into the main runtime.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "medium",
  },
  {
    id: "monitor.event.receive",
    family: "monitor",
    description: "Accept a trusted monitor callback into the main runtime.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "medium",
  },
  {
    id: "subagent.event.receive",
    family: "subagents",
    description: "Accept a subagent callback event into the main runtime.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "medium",
  },
  {
    id: "audio_ingest.event.receive",
    family: "audio_ingest",
    description: "Accept an audio ingestion event into the main runtime.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "medium",
  },
  {
    id: "system.event.receive",
    family: "system",
    description: "Accept an internal system event into the main runtime.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "medium",
  },
  {
    id: "assistant.run",
    family: "assistant",
    description: "Run the main assistant model for an authorized event.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "medium",
  },
  {
    id: "assistant.context.read",
    family: "assistant",
    description: "Read source conversation context for prompt hydration.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "medium",
  },
  {
    id: "slack.history.read",
    family: "slack",
    description: "Fetch Slack channel or thread history for context hydration.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "medium",
  },
  {
    id: "service.command.logs",
    family: "service",
    description: "Read recent service log output through a service command.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "medium",
  },
  {
    id: "service.command.help",
    family: "service",
    description: "Read service command help text.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "low",
  },
  {
    id: "service.deploy",
    family: "service",
    description: "Run the service deploy/update command.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "high",
  },
  {
    id: "runtime.status.read",
    family: "runtime",
    description: "Read runtime, loop, employee, or subagent status.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "low",
  },
  {
    id: "runtime.admin",
    family: "runtime",
    description: "Send an administrative owner notification.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "high",
  },
  {
    id: "subagents.dispatch",
    family: "subagents",
    description: "Dispatch a subagent job from a user, automation, or directive.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "high",
  },
  {
    id: "subagents.control.cancel",
    family: "subagents",
    description: "Cancel a subagent job.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "high",
  },
  {
    id: "subagents.control.steer",
    family: "subagents",
    description: "Steer a running subagent job.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "high",
  },
  {
    id: "subagents.backend.set",
    family: "subagents",
    description: "Set or clear the runtime subagent backend override.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "high",
  },
  {
    id: "subagents.result.deliver",
    family: "subagents",
    description: "Deliver a completed subagent result to the main loop or user.",
    selectorKeys: SUBAGENT_RESULT_SELECTOR_KEYS,
    riskTier: "medium",
  },
  {
    id: "output.text.send",
    family: "output",
    description: "Send text to an output target.",
    selectorKeys: OUTPUT_SELECTOR_KEYS,
    riskTier: "medium",
  },
  {
    id: "output.image.send",
    family: "output",
    description: "Send an image to an output target.",
    selectorKeys: OUTPUT_SELECTOR_KEYS,
    riskTier: "medium",
  },
  {
    id: "output.document.send",
    family: "output",
    description: "Send a document to an output target.",
    selectorKeys: OUTPUT_SELECTOR_KEYS,
    riskTier: "medium",
  },
  {
    id: "output.reaction.add",
    family: "output",
    description: "Add a reaction through a directive side effect.",
    selectorKeys: OUTPUT_SELECTOR_KEYS,
    riskTier: "low",
  },
  {
    id: "directive.send_text.execute",
    family: "directive",
    description: "Execute a send_text directive action.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "medium",
  },
  {
    id: "directive.send_image.execute",
    family: "directive",
    description: "Execute a send_image directive action.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "medium",
  },
  {
    id: "directive.send_document.execute",
    family: "directive",
    description: "Execute a send_document directive action.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "medium",
  },
  {
    id: "directive.dispatch_subagent.execute",
    family: "directive",
    description: "Execute a dispatch_subagent directive action.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "high",
  },
  {
    id: "directive.cancel_job.execute",
    family: "directive",
    description: "Execute a cancel_job directive action.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "high",
  },
  {
    id: "directive.steer_subagent.execute",
    family: "directive",
    description: "Execute a steer_subagent directive action.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "high",
  },
  {
    id: "directive.notify_owner.execute",
    family: "directive",
    description: "Execute a notify_owner directive action.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "high",
  },
  {
    id: "directive.react.execute",
    family: "directive",
    description: "Execute a react directive action.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "low",
  },
  {
    id: "directive.enqueue_main.execute",
    family: "directive",
    description: "Execute an enqueue_main directive action.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "high",
  },
  {
    id: "audio_ingest.run",
    family: "audio_ingest",
    description: "Submit an audio ingestion transcript to the main runtime.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "medium",
  },
  {
    id: "system.callback.enqueue",
    family: "system",
    description: "Enqueue a synthetic callback into the main runtime.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "high",
  },
  {
    id: "system.config.write",
    family: "system",
    description: "Write validated service configuration or environment entries.",
    selectorKeys: IPC_SELECTOR_KEYS,
    riskTier: "high",
  },
  {
    id: "system.registry.read",
    family: "system",
    description: "Read the declarative capability registry metadata.",
    selectorKeys: IPC_SELECTOR_KEYS,
    riskTier: "low",
  },
  {
    id: "employees.manage.list",
    family: "employees",
    description: "List configured employee runtimes.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "low",
  },
  {
    id: "employees.manage.status",
    family: "employees",
    description: "Read employee runtime status.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "low",
  },
  {
    id: "employees.manage.start",
    family: "employees",
    description: "Start or resume an employee runtime.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "high",
  },
  {
    id: "employees.manage.stop",
    family: "employees",
    description: "Stop an employee runtime.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "high",
  },
  {
    id: "employees.manage.steer",
    family: "employees",
    description: "Send a steering turn to an employee runtime.",
    selectorKeys: EVENT_SELECTOR_KEYS,
    riskTier: "high",
  },
  {
    id: "ipc.loop.run",
    family: "ipc",
    description: "Run a loop through local IPC.",
    selectorKeys: IPC_SELECTOR_KEYS,
    riskTier: "high",
  },
  {
    id: "ipc.subagent.steer",
    family: "ipc",
    description: "Steer a subagent job through local IPC.",
    selectorKeys: IPC_SELECTOR_KEYS,
    riskTier: "high",
  },
  {
    id: "ipc.employee.manage",
    family: "ipc",
    description: "Start, stop, or steer an employee runtime through local IPC.",
    selectorKeys: IPC_SELECTOR_KEYS,
    riskTier: "high",
  },
  {
    id: "ipc.unknown",
    family: "ipc",
    description: "Fallback audit operation for unrecognized Brain-authenticated IPC messages; do not grant.",
    selectorKeys: IPC_SELECTOR_KEYS,
    riskTier: "high",
  },
] as const satisfies readonly CapabilityRegistryEntry[];

export type CapabilityId = (typeof capabilityRegistry)[number]["id"];

export const capabilityRegistryById = new Map<string, CapabilityRegistryEntry>(
  capabilityRegistry.map((entry) => [entry.id, entry]),
);
