import { access, readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { capabilityRegistry } from "./capability-registry.js";
import type { ActorContext, BrainSubjectManifest, CapabilityDecision, CapabilityGrant, CapabilityRequirement, CapabilityResource, JsonRecord, OutputTarget, UserEvent } from "./types.js";
import { nowIso } from "./util.js";

export const DEFAULT_BRAIN_CAPABILITY_STORE_PATH = "/home/tim/.brain/control-plane/capabilities.json";

export const CAPABILITY_DENIED_MESSAGE = "I can see this, but Brain has not granted codex-chat permission to do that for this identity and target.";

/**
 * Reason used for allowed decisions on traffic outside Brain's enforcement
 * scope (Telegram and internal/system paths keep their existing authorizers:
 * the numeric Telegram allowlist and local-socket trust). Slack-surface
 * traffic and Brain-authenticated IPC are enforced fail-closed.
 */
export const OUTSIDE_BRAIN_SCOPE_REASON = "outside_brain_enforcement_scope";

export function outOfScopeAllowedDecision(input: { actorId?: string; operation: string; caller?: string }): CapabilityDecision {
  return {
    id: `capdec_${randomUUID()}`,
    allowed: true,
    actorId: input.actorId,
    operation: input.operation,
    action: actionFromOperation(input.operation),
    resourceSummary: {},
    resourceHash: "",
    grantIds: [],
    reason: OUTSIDE_BRAIN_SCOPE_REASON,
    checkedAt: nowIso(),
    caller: input.caller,
  };
}

export interface BrainCapabilityStore {
  schemaVersion?: number;
  people?: BrainPerson[];
  externalIdentities?: BrainExternalIdentity[];
  subjects?: BrainSubject[];
  grantBundles?: BrainGrantBundle[];
  grants?: BrainGrant[];
}

interface BrainPerson {
  id: string;
  status?: string;
  primarySubjectId?: string;
  identityIds?: string[];
  subjectIds?: string[];
}

interface BrainExternalIdentity {
  id: string;
  provider: string;
  providerUserId: string;
  providerTeamId?: string;
  personId?: string;
  status?: string;
  metadata?: Record<string, unknown>;
}

interface BrainSubject {
  id: string;
  personId?: string;
  identityId?: string;
  status?: string;
  kind?: string;
  metadata?: Record<string, unknown>;
}

interface BrainGrantBundle {
  id: string;
  includes?: { groupIds?: string[]; capabilityIds?: string[] };
  status?: string;
}

interface BrainGrant {
  id: string;
  subjectId: string;
  capabilityId: string;
  grantKind?: string;
  bundleId?: string;
  resource?: { kind?: string; id?: string; selectors?: Record<string, unknown> };
  actions?: unknown[];
  status?: string;
  enforcement?: string;
  source?: { kind?: string; id?: string } | string;
  grantedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
}

export interface AuthorizeOptions {
  storePath?: string;
  store?: BrainCapabilityStore;
  storeLoadError?: unknown;
  now?: Date;
  caller?: string;
}

export function brainCapabilityStorePath(config?: AppConfig, env: NodeJS.ProcessEnv = process.env): string {
  const configured = config?.brain.storePath?.trim();
  if (configured && configured !== DEFAULT_BRAIN_CAPABILITY_STORE_PATH) return configured;
  return env.BRAIN_CAPABILITY_STORE_PATH?.trim() || configured || DEFAULT_BRAIN_CAPABILITY_STORE_PATH;
}

export async function assertBrainCapabilitySourceAvailable(config: AppConfig): Promise<void> {
  if (!config.brain.enforcementEnabled) return;
  const storePath = brainCapabilityStorePath(config);
  await access(storePath).catch((error) => {
    throw new Error(`Brain capability enforcement is enabled but store is unavailable at ${storePath}: ${error instanceof Error ? error.message : String(error)}`);
  });
  await loadBrainCapabilityStore(storePath);
}

export async function authorize(
  actor: ActorContext | undefined,
  requirement: CapabilityRequirement,
  options: AuthorizeOptions = {},
): Promise<CapabilityDecision> {
  const checkedAt = isoNow(options.now);
  const operation = requirement.operation;
  const action = requirement.action ?? actionFromOperation(operation);
  const caller = requirement.caller ?? options.caller;
  const storePath = options.storePath ?? brainCapabilityStorePath();
  const base = {
    id: `capdec_${randomUUID()}`,
    actorId: actor?.id,
    operation,
    action,
    resourceSummary: summarizeResource(requirement.resource),
    resourceHash: hashJson(redactResource(requirement.resource)),
    grantIds: [] as string[],
    checkedAt,
    caller,
  };

  if (!actor) {
    return { ...base, allowed: false, reason: "missing_actor" };
  }

  let store: BrainCapabilityStore | undefined = options.store;
  if (!store && options.storeLoadError) {
    const error = options.storeLoadError;
    return { ...base, allowed: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!store) {
    try {
      store = await loadBrainCapabilityStore(storePath);
    } catch (error) {
      return { ...base, allowed: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  const actorResolution = resolveActorSubjects(store, actor);
  if (!actorResolution.allowed) {
    return { ...base, allowed: false, reason: actorResolution.reason };
  }

  const matched: BrainGrant[] = [];
  const reasons: string[] = [];
  for (const grant of store.grants ?? []) {
    const result = grantMatches(store, grant, actorResolution.subjectIds, operation, action, requirement.resource, options.now);
    if (result.allowed) matched.push(grant);
    else if (result.reason) reasons.push(`${grant.id}:${result.reason}`);
  }

  if (matched.length === 0) {
    return { ...base, allowed: false, reason: reasons.length === 0 ? `No active Brain grant allows ${operation}/${action}` : `No matching Brain grant: ${reasons.slice(0, 5).join(", ")}` };
  }

  return {
    ...base,
    allowed: true,
    grantIds: matched.map((grant) => grant.id),
    reason: "active_brain_grant",
    brainSubjectIds: actorResolution.subjectIds,
  };
}

export async function resolveSubjectManifest(
  actor: ActorContext | undefined,
  options: { storePath?: string; store?: BrainCapabilityStore; now?: Date } = {},
): Promise<BrainSubjectManifest | undefined> {
  if (!actor) return undefined;
  let store: BrainCapabilityStore | undefined = options.store;
  try {
    store ??= await loadBrainCapabilityStore(options.storePath ?? brainCapabilityStorePath());
  } catch {
    return undefined;
  }
  const resolution = resolveActorSubjects(store, actor);
  if (!resolution.allowed) return undefined;
  const subjectId = resolution.subjectIds[0];
  if (!subjectId) return undefined;
  const subjectResolution = resolveActorSubjects(store, brainSubjectActor(subjectId));
  if (!subjectResolution.allowed) return undefined;
  const capabilities = manifestCapabilitiesForSubjects(store, subjectResolution.subjectIds, options.now);
  return { subjectId, capabilities };
}

export function formatBrainSubjectManifestBlock(manifest: BrainSubjectManifest, maxCapabilitiesLineChars = 1_000): string {
  const capabilitySummaries = manifest.capabilities.map(formatManifestCapability);
  let capabilityLine = capabilitySummaries.join(", ");
  if (!capabilityLine) capabilityLine = "none";
  if (capabilityLine.length > maxCapabilitiesLineChars) {
    capabilityLine = `${capabilityLine.slice(0, Math.max(0, maxCapabilitiesLineChars - 16)).trimEnd()} ... (truncated)`;
  }
  return [
    `brain_subject: ${manifest.subjectId}`,
    `brain_capabilities: ${capabilityLine}`,
    `When running calendar/CRM/project scripts on behalf of this user, pass --on-behalf-of ${manifest.subjectId}; actions outside brain_capabilities must be refused.`,
  ].join("\n");
}

export async function authorizeOrThrow(actor: ActorContext | undefined, requirement: CapabilityRequirement, options: AuthorizeOptions = {}): Promise<CapabilityDecision> {
  const decision = await authorize(actor, requirement, options);
  if (!decision.allowed) throw new Error(`Capability denied for ${requirement.operation}: ${decision.reason ?? "denied"}`);
  return decision;
}

export async function authorizeOutput(input: {
  actor?: ActorContext;
  target?: OutputTarget;
  outputType: "text" | "image" | "document" | "reaction" | "progress" | "artifact";
  reason: string;
  operation?: string;
  storePath?: string;
  caller?: string;
}): Promise<CapabilityDecision> {
  const target = input.target;
  const resource = outputResource(target, input.outputType);
  if (!target) {
    return authorize(input.actor, { operation: input.operation ?? `output.${input.outputType}.send`, resource, reason: input.reason, caller: input.caller }, { storePath: input.storePath });
  }
  if (!target.allowedOutputTypes.includes(input.outputType)) {
    const checkedAt = nowIso();
    return {
      id: `capdec_${randomUUID()}`,
      allowed: false,
      actorId: input.actor?.id,
      operation: input.operation ?? `output.${input.outputType}.send`,
      action: "send",
      resourceSummary: summarizeResource(resource),
      resourceHash: hashJson(redactResource(resource)),
      grantIds: [],
      reason: `Output target ${target.id} does not allow ${input.outputType}`,
      checkedAt,
      caller: input.caller,
    };
  }
  if (target.routingPolicy === "silent" && input.outputType !== "artifact") {
    const checkedAt = nowIso();
    return {
      id: `capdec_${randomUUID()}`,
      allowed: false,
      actorId: input.actor?.id,
      operation: input.operation ?? `output.${input.outputType}.send`,
      action: "send",
      resourceSummary: summarizeResource(resource),
      resourceHash: hashJson(redactResource(resource)),
      grantIds: [],
      reason: `Output target ${target.id} is silent`,
      checkedAt,
      caller: input.caller,
    };
  }
  const operation = input.operation ?? (input.outputType === "reaction" ? "output.reaction.add" : `output.${input.outputType}.send`);
  return authorize(input.actor, { operation, action: input.outputType === "reaction" ? "add" : "send", resource, reason: input.reason, caller: input.caller }, { storePath: input.storePath });
}

export function requirementForInboundEvent(event: UserEvent, operation: string, reason: string, caller?: string): CapabilityRequirement {
  return { operation, action: actionFromOperation(operation), resource: eventCapabilityResource(event), reason, caller };
}

export function eventCapabilityResource(event: UserEvent): CapabilityResource {
  const target = event.outputTarget;
  return {
    source: event.source,
    surfaceKind: target?.surfaceKind ?? event.actor?.surfaceKind,
    teamId: stringValue(event.metadata?.slackTeamId) ?? target?.teamId ?? event.actor?.teamId,
    channelId: stringValue(event.metadata?.slackChannelId) ?? target?.channelId,
    threadTs: stringValue(event.metadata?.slackThreadTs) ?? (target?.surfaceKind === "slack" ? target.threadId : undefined),
    messageTs: stringValue(event.metadata?.slackMessageTs) ?? (target?.surfaceKind === "slack" ? target.messageId : undefined),
    chatId: event.chatId !== undefined ? String(event.chatId) : target?.chatId,
    messageId: event.messageId !== undefined ? String(event.messageId) : target?.messageId,
    conversationSessionId: event.conversationSessionId,
    actorId: event.actor?.id,
  };
}

export function outputResource(target: OutputTarget | undefined, outputType: string): CapabilityResource {
  return {
    targetId: target?.id,
    surfaceKind: target?.surfaceKind,
    teamId: target?.teamId,
    channelId: target?.channelId,
    threadTs: target?.threadId,
    chatId: target?.chatId,
    messageId: target?.messageId,
    targetPolicy: target?.routingPolicy,
    outputType,
  };
}

export function capabilityGrantFromDecision(decision: CapabilityDecision, actorId?: string, conversationSessionId?: string): CapabilityGrant | undefined {
  if (!decision.allowed) return undefined;
  if (decision.reason === OUTSIDE_BRAIN_SCOPE_REASON) return undefined;
  return {
    id: `brain-decision:${decision.id}`,
    name: `Brain ${decision.operation}`,
    description: `Brain decision ${decision.id} allowed ${decision.operation}`,
    scope: "temporary",
    operations: [decision.operation],
    resourceSelectors: decision.resourceSummary,
    source: "brain_capability_store",
    actorId,
    conversationSessionId,
    auditPolicy: "log",
    createdAt: decision.checkedAt,
  };
}

function actionFromOperation(operation: string): string {
  const tail = operation.split(".").pop() ?? operation;
  return tail || operation;
}

function formatManifestCapability(entry: { capabilityId: string; selectors?: JsonRecord }): string {
  const selectors = entry.selectors ? Object.entries(entry.selectors).filter(([, value]) => value !== undefined) : [];
  if (selectors.length === 0) return entry.capabilityId;
  const parts = selectors.slice(0, 4).map(([key, value]) => `${key}=${manifestSelectorValue(value)}`);
  if (selectors.length > parts.length) parts.push("...");
  return `${entry.capabilityId}{${parts.join(",")}}`;
}

function manifestSelectorValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).replace(/[{}\s,]/g, "_").slice(0, 80);
  }
  return JSON.stringify(value)?.replace(/[{}\s,]/g, "_").slice(0, 80) ?? "unknown";
}

function brainSubjectActor(subjectId: string): ActorContext {
  return {
    id: subjectId,
    surfaceKind: "system",
    correlationId: "manifest",
    metadata: { brainSubjectId: subjectId }
  };
}

function manifestCapabilitiesForSubjects(store: BrainCapabilityStore, subjectIds: string[], now: Date | undefined): BrainSubjectManifest["capabilities"] {
  const seen = new Set<string>();
  const capabilities: BrainSubjectManifest["capabilities"] = [];
  for (const grant of store.grants ?? []) {
    if (!subjectIds.includes(grant.subjectId)) continue;
    if (!grantIsActiveEnforcing(grant, now)) continue;
    for (const capabilityId of concreteCapabilityIdsForGrant(store, grant)) {
      const selectors = grant.resource?.selectors && Object.keys(grant.resource.selectors).length > 0 ? grant.resource.selectors : undefined;
      const key = `${capabilityId}\0${JSON.stringify(selectors ?? {})}`;
      if (seen.has(key)) continue;
      seen.add(key);
      capabilities.push({ capabilityId, selectors });
    }
  }
  return capabilities;
}

function concreteCapabilityIdsForGrant(store: BrainCapabilityStore, grant: BrainGrant): string[] {
  const ids = new Set<string>();
  const registryIds = capabilityRegistry.map((entry) => entry.id);
  if (grant.grantKind === "group") {
    addGroupCapabilityIds(ids, registryIds, grant.capabilityId);
  } else if (grant.grantKind === "bundle") {
    const bundleId = grant.bundleId ?? grant.capabilityId;
    const bundle = (store.grantBundles ?? []).find((candidate) => candidate.id === bundleId && candidate.status === "active");
    for (const capabilityId of bundle?.includes?.capabilityIds ?? []) ids.add(capabilityId);
    for (const groupId of bundle?.includes?.groupIds ?? []) addGroupCapabilityIds(ids, registryIds, groupId);
  } else {
    ids.add(grant.capabilityId);
  }
  return [...ids].sort();
}

function addGroupCapabilityIds(target: Set<string>, registryIds: string[], groupId: string): void {
  for (const capabilityId of registryIds) {
    if (capabilityId === groupId || capabilityId.startsWith(`${groupId}.`)) target.add(capabilityId);
  }
}

export async function loadBrainCapabilityStore(storePath: string): Promise<BrainCapabilityStore> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(storePath, "utf8"));
  } catch (error) {
    throw new Error(`brain_store_unavailable:${storePath}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("brain_store_invalid");
  const store = parsed as BrainCapabilityStore;
  if (!Array.isArray(store.grants) || !Array.isArray(store.subjects) || !Array.isArray(store.externalIdentities)) throw new Error("brain_store_invalid_schema");
  return store;
}

function resolveActorSubjects(store: BrainCapabilityStore, actor: ActorContext): { allowed: true; subjectIds: string[] } | { allowed: false; reason: string } {
  const candidateSubjectIds = new Set<string>();
  const metadataSubject = stringValue(actor.metadata?.brainSubjectId) ?? stringValue(actor.metadata?.brain_subject_id);
  if (metadataSubject) candidateSubjectIds.add(metadataSubject);
  if ((store.subjects ?? []).some((subject) => subject.id === actor.id)) candidateSubjectIds.add(actor.id);

  const identity = findExternalIdentity(store, actor);
  if (identity) {
    if (identity.status && !["active", "linked"].includes(identity.status)) return { allowed: false, reason: `identity_inactive:${identity.status}` };
    const person = findPersonForIdentity(store, identity);
    if (person?.status && person.status !== "active") return { allowed: false, reason: `person_inactive:${person.status}` };
    if (identity.personId) {
      for (const subject of store.subjects ?? []) if (subject.personId === identity.personId) candidateSubjectIds.add(subject.id);
    }
    for (const subject of store.subjects ?? []) if (subject.identityId === identity.id) candidateSubjectIds.add(subject.id);
    if (person?.primarySubjectId) candidateSubjectIds.add(person.primarySubjectId);
    for (const subjectId of person?.subjectIds ?? []) candidateSubjectIds.add(subjectId);
  }
  expandPersonSubjectsForCandidateSubjects(store, candidateSubjectIds);

  const activeSubjectIds = [...candidateSubjectIds].filter((id) => {
    const subject = (store.subjects ?? []).find((candidate) => candidate.id === id);
    return subject && (!subject.status || subject.status === "active");
  });
  if (activeSubjectIds.length === 0) return { allowed: false, reason: "actor_not_linked_to_brain_subject" };
  return { allowed: true, subjectIds: activeSubjectIds };
}

function expandPersonSubjectsForCandidateSubjects(store: BrainCapabilityStore, candidateSubjectIds: Set<string>): void {
  for (const subjectId of [...candidateSubjectIds]) {
    const subject = (store.subjects ?? []).find((candidate) => candidate.id === subjectId);
    if (!subject?.personId) continue;
    for (const sibling of store.subjects ?? []) if (sibling.personId === subject.personId) candidateSubjectIds.add(sibling.id);
    const person = (store.people ?? []).find((candidate) => candidate.id === subject.personId);
    if (person?.primarySubjectId) candidateSubjectIds.add(person.primarySubjectId);
    for (const siblingId of person?.subjectIds ?? []) candidateSubjectIds.add(siblingId);
  }
}

function findExternalIdentity(store: BrainCapabilityStore, actor: ActorContext): BrainExternalIdentity | undefined {
  const identities = store.externalIdentities ?? [];
  if (actor.surfaceKind === "slack") {
    const userId = actor.surfaceUserId ?? stringValue(actor.metadata?.slackUserId);
    const teamId = actor.teamId ?? stringValue(actor.metadata?.slackTeamId);
    return identities.find((identity) => identity.provider === "slack" && identity.providerUserId === userId && (!identity.providerTeamId || identity.providerTeamId === teamId));
  }
  if (actor.surfaceKind === "telegram") {
    const userId = actor.surfaceUserId ?? stringValue(actor.metadata?.telegramUserId);
    return identities.find((identity) => identity.provider === "telegram" && identity.providerUserId === String(userId));
  }
  const provider = actor.surfaceKind;
  return identities.find((identity) => identity.provider === provider && identity.providerUserId === actor.surfaceUserId);
}

function findPersonForIdentity(store: BrainCapabilityStore, identity: BrainExternalIdentity): BrainPerson | undefined {
  if (!identity.personId) return undefined;
  return (store.people ?? []).find((person) => person.id === identity.personId);
}

function grantMatches(
  store: BrainCapabilityStore,
  grant: BrainGrant,
  subjectIds: string[],
  operation: string,
  action: string,
  resource: CapabilityResource,
  now: Date | undefined,
): { allowed: boolean; reason?: string } {
  if (!subjectIds.includes(grant.subjectId)) return { allowed: false };
  const activeReason = grantInactiveReason(grant, now);
  if (activeReason) return { allowed: false, reason: activeReason };
  if (!grantAllowsCapability(store, grant, operation)) return { allowed: false, reason: "operation" };
  if (!grantAllowsAction(grant, action)) return { allowed: false, reason: "action" };
  if (!selectorsMatch(grant.resource?.selectors ?? {}, resource)) return { allowed: false, reason: "resource" };
  return { allowed: true };
}

function grantIsActiveEnforcing(grant: BrainGrant, now: Date | undefined): boolean {
  return grantInactiveReason(grant, now) === undefined;
}

function grantInactiveReason(grant: BrainGrant, now: Date | undefined): string | undefined {
  if (grant.status !== "active") return "inactive";
  if (grant.revokedAt) return "revoked";
  if (grant.enforcement && grant.enforcement !== "enforcing") return `non_enforcing:${grant.enforcement}`;
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= (now?.getTime() ?? Date.now())) return "expired";
  return undefined;
}

function grantAllowsCapability(store: BrainCapabilityStore, grant: BrainGrant, operation: string): boolean {
  // Enforcement intentionally does not honor operation wildcards. Brain may grant
  // grouped capabilities through bundles/groups, but runtime-created '*' grants
  // are never accepted as a side-effect authorization.
  if (grant.capabilityId === operation) return true;
  if (grant.grantKind === "group" && operation.startsWith(`${grant.capabilityId}.`)) return true;
  if (grant.grantKind === "bundle") {
    const bundleId = grant.bundleId ?? grant.capabilityId;
    const bundle = (store.grantBundles ?? []).find((candidate) => candidate.id === bundleId && candidate.status === "active");
    if (!bundle) return false;
    if ((bundle.includes?.capabilityIds ?? []).includes(operation)) return true;
    return (bundle.includes?.groupIds ?? []).some((groupId) => operation === groupId || operation.startsWith(`${groupId}.`));
  }
  return false;
}

function grantAllowsAction(grant: BrainGrant, action: string): boolean {
  // A request that does not name a concrete action (action "*" or empty) is an
  // operation-level check: the capabilityId/operation match has already gated
  // it and resource selectors still apply, so any grant for that operation
  // satisfies the action requirement. Requests that DO name a concrete action
  // (e.g. codex-chat's internal "send"/"deliver") remain gated against the
  // grant's action list. NOTE: this only relaxes the requested-action side; the
  // deliberate selectorsMatch explicit-coverage rule is untouched.
  if (!action || action === "*") return true;
  const actions = (grant.actions ?? []).map((item) => String(item));
  return actions.includes(action) || actions.includes("*");
}

function selectorsMatch(selectors: Record<string, unknown>, resource: CapabilityResource): boolean {
  const resourceRecord = resource as Record<string, unknown>;
  for (const [key, selector] of Object.entries(selectors)) {
    const actual = resourceRecord[key];
    if (!selectorMatches(selector, actual)) return false;
  }
  // Require explicit coverage for each concrete resource selector supplied by
  // the caller. Broad Brain grants must say '*' for that selector key.
  for (const [key, actual] of Object.entries(resourceRecord)) {
    if (actual === undefined || actual === null || actual === "") continue;
    if (!(key in selectors)) return false;
  }
  return true;
}

function selectorMatches(selector: unknown, actual: unknown): boolean {
  if (selector === "*") return true;
  if (Array.isArray(selector)) return selector.some((item) => selectorMatches(item, actual));
  if (actual === undefined || actual === null) return false;
  return String(selector) === String(actual);
}

function summarizeResource(resource: CapabilityResource): JsonRecord {
  return redactResource(resource);
}

function redactResource(resource: CapabilityResource): JsonRecord {
  const redacted: JsonRecord = {};
  for (const [key, value] of Object.entries(resource)) {
    if (value === undefined || value === null || value === "") continue;
    if (/token|secret|key|credential/i.test(key)) redacted[key] = "[redacted]";
    else redacted[key] = value;
  }
  return redacted;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function isoNow(now?: Date): string {
  return now ? now.toISOString() : nowIso();
}
