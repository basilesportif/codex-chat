import { readFile } from "node:fs/promises";
import type { CapabilityGrant, UserEvent } from "./types.js";
import { nowIso } from "./util.js";

export const DEFAULT_BRAIN_CAPABILITY_STORE_PATH = "/home/tim/.brain/control-plane/capabilities.json";
export const SLACK_BRAIN_PERMISSION_DENIED_MESSAGE = "I can see this, but I don't have permission to run Brain for this Slack identity yet.";
export const ASSISTANT_RUN_CAPABILITY_ID = "assistant.run";
export const FALLBACK_SLACK_RUN_CAPABILITY_ID = "slack.source.read";

type DenyReason =
  | "missing_slack_actor"
  | "store_missing"
  | "store_unreadable"
  | "store_invalid"
  | "identity_not_linked"
  | "person_not_linked"
  | "person_inactive"
  | "required_capability_missing";

export interface BrainCapabilityRequirement {
  capabilityId: string;
  action: string;
}

export interface SlackBrainCapabilityResource {
  teamId: string;
  userId: string;
  channelId?: string;
  threadTs?: string;
}

export interface SlackBrainCapabilityGrantSummary {
  id: string;
  subjectId: string;
  capabilityId: string;
  grantKind: string;
  actions: string[];
  resourceSelectors: Record<string, string>;
  grantedAt?: string;
  expiresAt?: string;
  source?: string;
}

export type SlackBrainCapabilityDecision =
  | {
      allowed: true;
      checkedAt: string;
      storePath: string;
      capabilityId: string;
      action: string;
      identityId: string;
      personId: string;
      subjectIds: string[];
      grantIds: string[];
      grants: SlackBrainCapabilityGrantSummary[];
      reason: "active_grant";
    }
  | {
      allowed: false;
      checkedAt: string;
      storePath: string;
      capabilityId?: string;
      action?: string;
      identityId?: string;
      personId?: string;
      subjectIds?: string[];
      grantIds: string[];
      grants: SlackBrainCapabilityGrantSummary[];
      reason: DenyReason;
      detail?: string;
    };

interface BrainCapabilityStore {
  schemaVersion: 2;
  people: BrainPerson[];
  externalIdentities: BrainExternalIdentity[];
  subjects: BrainSubject[];
  grantBundles: BrainGrantBundle[];
  grants: BrainGrant[];
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
}

interface BrainGrantBundle {
  id: string;
  includes?: {
    groupIds?: string[];
    capabilityIds?: string[];
  };
  status?: string;
}

interface BrainGrant {
  id: string;
  subjectId: string;
  capabilityId: string;
  grantKind?: string;
  bundleId?: string;
  resource?: {
    kind?: string;
    id?: string;
    selectors?: Record<string, unknown>;
  };
  actions?: unknown[];
  status?: string;
  enforcement?: string;
  source?: { kind?: string; id?: string };
  grantedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
}

interface LoadedStoreResult {
  store?: BrainCapabilityStore;
  decisionOnFailure?: SlackBrainCapabilityDecision;
}

export function brainCapabilityStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.BRAIN_CAPABILITY_STORE_PATH?.trim() || DEFAULT_BRAIN_CAPABILITY_STORE_PATH;
}

export async function resolveSlackBrainCapabilityForEvent(
  event: UserEvent,
  options: { storePath?: string; now?: Date } = {},
): Promise<SlackBrainCapabilityDecision> {
  const resource = slackResourceFromEvent(event);
  const storePath = options.storePath ?? brainCapabilityStorePath();
  if (!resource) {
    return deny({ reason: "missing_slack_actor", storePath, detail: "Slack event is missing team_id or user_id metadata", now: options.now });
  }
  return resolveSlackBrainCapability(resource, { storePath, now: options.now });
}

export async function resolveSlackBrainCapability(
  resource: SlackBrainCapabilityResource,
  options: { storePath?: string; now?: Date } = {},
): Promise<SlackBrainCapabilityDecision> {
  const storePath = options.storePath ?? brainCapabilityStorePath();
  const loaded = await loadBrainCapabilityStore(storePath, options.now);
  if (!loaded.store) return loaded.decisionOnFailure!;

  const store = loaded.store;
  const requirement = selectSlackRunRequirement(store);
  const identity = findLinkedSlackIdentity(store, resource);
  if (!identity) {
    return deny({
      reason: "identity_not_linked",
      storePath,
      capabilityId: requirement.capabilityId,
      action: requirement.action,
      detail: "No linked Slack external identity matched the event team_id/user_id",
      now: options.now,
    });
  }

  const person = findPersonForIdentity(store, identity);
  if (!person) {
    return deny({
      reason: "person_not_linked",
      storePath,
      capabilityId: requirement.capabilityId,
      action: requirement.action,
      identityId: identity.id,
      detail: "Slack identity is not linked to a Brain person",
      now: options.now,
    });
  }
  if (person.status !== "active") {
    return deny({
      reason: "person_inactive",
      storePath,
      capabilityId: requirement.capabilityId,
      action: requirement.action,
      identityId: identity.id,
      personId: person.id,
      detail: `Brain person status is ${person.status ?? "unknown"}`,
      now: options.now,
    });
  }

  const subjectIds = personSubjectIds(store, person, identity);
  const grants = activeEffectiveGrants(store, subjectIds, requirement, resource, options.now);
  if (grants.length === 0) {
    return deny({
      reason: "required_capability_missing",
      storePath,
      capabilityId: requirement.capabilityId,
      action: requirement.action,
      identityId: identity.id,
      personId: person.id,
      subjectIds,
      detail: `No active Brain grant allows ${requirement.capabilityId}/${requirement.action}`,
      now: options.now,
    });
  }

  const grantSummaries = grants.map((grant) => summarizeGrant(grant));
  return {
    allowed: true,
    checkedAt: isoNow(options.now),
    storePath,
    capabilityId: requirement.capabilityId,
    action: requirement.action,
    identityId: identity.id,
    personId: person.id,
    subjectIds,
    grantIds: grantSummaries.map((grant) => grant.id),
    grants: grantSummaries,
    reason: "active_grant",
  };
}

export function brainCapabilityGrantsFromDecision(
  decision: SlackBrainCapabilityDecision,
  actorId?: string,
  conversationSessionId?: string,
): CapabilityGrant[] {
  if (!decision.allowed) return [];
  return decision.grants.map((grant) => ({
    id: `brain:${grant.id}`,
    name: `Brain ${decision.capabilityId}`,
    description: `Brain capability grant ${grant.id} allowed ${decision.capabilityId}/${decision.action} for Slack runtime enforcement.`,
    scope: "user",
    operations: [
      decision.capabilityId,
      `${decision.capabilityId}:${decision.action}`,
      decision.action,
    ],
    resourceSelectors: {
      ...grant.resourceSelectors,
      brainPersonId: decision.personId,
      brainIdentityId: decision.identityId,
    },
    source: "brain_capability_store",
    grantor: grant.source,
    actorId,
    conversationSessionId,
    expiresAt: grant.expiresAt,
    auditPolicy: "log",
    createdAt: grant.grantedAt ?? decision.checkedAt,
  }));
}

export function annotateEventWithBrainCapabilityDecision(event: UserEvent, decision: SlackBrainCapabilityDecision): void {
  event.metadata = {
    ...event.metadata,
    brainCapability: {
      checkedAt: decision.checkedAt,
      allowed: decision.allowed,
      reason: decision.reason,
      capabilityId: decision.capabilityId,
      action: decision.action,
      identityId: decision.identityId,
      personId: decision.personId,
      grantIds: decision.grantIds,
    },
  };
  if (!decision.allowed) return;
  const existing = event.capabilityGrants ?? [];
  const additions = brainCapabilityGrantsFromDecision(decision, event.actor?.id, event.conversationSessionId);
  const seen = new Set(existing.map((grant) => grant.id));
  event.capabilityGrants = [
    ...existing,
    ...additions.filter((grant) => !seen.has(grant.id)),
  ];
}

function slackResourceFromEvent(event: UserEvent): SlackBrainCapabilityResource | undefined {
  if (event.source !== "slack") return undefined;
  const teamId = stringValue(event.metadata?.slackTeamId) ?? event.outputTarget?.teamId;
  const userId = stringValue(event.metadata?.slackUserId) ?? event.actor?.surfaceUserId;
  if (!teamId || !userId) return undefined;
  return {
    teamId,
    userId,
    channelId: stringValue(event.metadata?.slackChannelId) ?? event.outputTarget?.channelId,
    threadTs: stringValue(event.metadata?.slackSourceThreadTs)
      ?? stringValue(event.metadata?.slackThreadTs)
      ?? event.outputTarget?.threadId,
  };
}

async function loadBrainCapabilityStore(storePath: string, now?: Date): Promise<LoadedStoreResult> {
  let raw: string;
  try {
    raw = await readFile(storePath, "utf8");
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "ENOENT") {
      return { decisionOnFailure: deny({ reason: "store_missing", storePath, detail: "Brain capability store file does not exist", now }) };
    }
    return { decisionOnFailure: deny({ reason: "store_unreadable", storePath, detail: "Brain capability store could not be read", now }) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { decisionOnFailure: deny({ reason: "store_invalid", storePath, detail: "Brain capability store JSON is invalid", now }) };
  }
  const store = normalizeBrainCapabilityStore(parsed);
  if (!store) {
    return { decisionOnFailure: deny({ reason: "store_invalid", storePath, detail: "Brain capability store schema is invalid", now }) };
  }
  return { store };
}

function normalizeBrainCapabilityStore(value: unknown): BrainCapabilityStore | undefined {
  if (!isRecord(value)) return undefined;
  if (value.schemaVersion !== 2) return undefined;
  if (!Array.isArray(value.people) || !Array.isArray(value.externalIdentities) || !Array.isArray(value.subjects) || !Array.isArray(value.grantBundles) || !Array.isArray(value.grants)) return undefined;
  const people = value.people.filter(isRecord).map((person) => ({
    id: stringValue(person.id) ?? "",
    status: stringValue(person.status),
    primarySubjectId: stringValue(person.primarySubjectId),
    identityIds: stringArray(person.identityIds),
    subjectIds: stringArray(person.subjectIds),
  })).filter((person) => person.id);
  const externalIdentities = value.externalIdentities.filter(isRecord).map((identity) => ({
    id: stringValue(identity.id) ?? "",
    provider: stringValue(identity.provider) ?? "",
    providerUserId: stringValue(identity.providerUserId) ?? "",
    providerTeamId: stringValue(identity.providerTeamId),
    personId: stringValue(identity.personId),
    status: stringValue(identity.status),
    metadata: isRecord(identity.metadata) ? identity.metadata : undefined,
  })).filter((identity) => identity.id && identity.provider && identity.providerUserId);
  const subjects = value.subjects.filter(isRecord).map((subject) => ({
    id: stringValue(subject.id) ?? "",
    personId: stringValue(subject.personId),
    identityId: stringValue(subject.identityId),
  })).filter((subject) => subject.id);
  const grantBundles = value.grantBundles.filter(isRecord).map((bundle) => ({
    id: stringValue(bundle.id) ?? "",
    includes: isRecord(bundle.includes) ? {
      groupIds: stringArray(bundle.includes.groupIds),
      capabilityIds: stringArray(bundle.includes.capabilityIds),
    } : undefined,
    status: stringValue(bundle.status),
  })).filter((bundle) => bundle.id);
  const grants = value.grants.filter(isRecord).map((grant) => ({
    id: stringValue(grant.id) ?? "",
    subjectId: stringValue(grant.subjectId) ?? "",
    capabilityId: stringValue(grant.capabilityId) ?? "",
    grantKind: stringValue(grant.grantKind),
    bundleId: stringValue(grant.bundleId),
    resource: normalizeResource(grant.resource),
    actions: Array.isArray(grant.actions) ? grant.actions : [],
    status: stringValue(grant.status),
    enforcement: stringValue(grant.enforcement),
    source: isRecord(grant.source) ? { kind: stringValue(grant.source.kind), id: stringValue(grant.source.id) } : undefined,
    grantedAt: stringValue(grant.grantedAt),
    expiresAt: stringValue(grant.expiresAt),
    revokedAt: stringValue(grant.revokedAt),
  })).filter((grant) => grant.id && grant.subjectId && grant.capabilityId);
  return {
    schemaVersion: 2,
    people,
    externalIdentities,
    subjects,
    grantBundles,
    grants,
  };
}

function normalizeResource(value: unknown): BrainGrant["resource"] | undefined {
  if (!isRecord(value)) return undefined;
  return {
    kind: stringValue(value.kind),
    id: stringValue(value.id),
    selectors: isRecord(value.selectors) ? value.selectors : undefined,
  };
}

function selectSlackRunRequirement(store: BrainCapabilityStore): BrainCapabilityRequirement {
  const capabilityIds = new Set<string>();
  for (const grant of store.grants) {
    if (grant.status === "active") capabilityIds.add(grant.capabilityId);
  }
  for (const bundle of store.grantBundles) {
    if (bundle.status && bundle.status !== "active") continue;
    for (const capabilityId of bundle.includes?.capabilityIds ?? []) capabilityIds.add(capabilityId);
  }
  if (capabilityIds.has(ASSISTANT_RUN_CAPABILITY_ID)) return { capabilityId: ASSISTANT_RUN_CAPABILITY_ID, action: "run" };
  return { capabilityId: FALLBACK_SLACK_RUN_CAPABILITY_ID, action: "read" };
}

function findLinkedSlackIdentity(store: BrainCapabilityStore, resource: SlackBrainCapabilityResource): BrainExternalIdentity | undefined {
  return store.externalIdentities.find((identity) => {
    if (identity.provider !== "slack") return false;
    if (identity.status !== "linked") return false;
    if (identity.providerUserId !== resource.userId) return false;
    const teamId = identity.providerTeamId ?? stringValue(identity.metadata?.teamId);
    return teamId === resource.teamId;
  });
}

function findPersonForIdentity(store: BrainCapabilityStore, identity: BrainExternalIdentity): BrainPerson | undefined {
  const personId = identity.personId ?? store.people.find((person) => person.identityIds?.includes(identity.id))?.id;
  if (!personId) return undefined;
  return store.people.find((person) => person.id === personId);
}

function personSubjectIds(store: BrainCapabilityStore, person: BrainPerson, identity: BrainExternalIdentity): string[] {
  const out = new Set<string>();
  out.add(`person:${person.id}`);
  if (person.primarySubjectId) out.add(person.primarySubjectId);
  for (const id of person.subjectIds ?? []) out.add(id);
  out.add(`identity:${identity.id}`);
  for (const subject of store.subjects) {
    if (subject.personId === person.id || subject.identityId === identity.id) out.add(subject.id);
  }
  return [...out];
}

function activeEffectiveGrants(
  store: BrainCapabilityStore,
  subjectIds: string[],
  requirement: BrainCapabilityRequirement,
  resource: SlackBrainCapabilityResource,
  now?: Date,
): BrainGrant[] {
  const subjectSet = new Set(subjectIds);
  return store.grants.filter((grant) =>
    subjectSet.has(grant.subjectId)
    && grantIsActive(grant, now)
    && grantAllowsCapability(store, grant, requirement.capabilityId)
    && grantAllowsAction(grant, requirement.action)
    && grantResourceMatches(grant, resource)
  );
}

function grantIsActive(grant: BrainGrant, now?: Date): boolean {
  if (grant.status !== "active") return false;
  if (grant.revokedAt) return false;
  if (!grant.expiresAt) return true;
  const expiresAt = Date.parse(grant.expiresAt);
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt > (now?.getTime() ?? Date.now());
}

function grantAllowsCapability(store: BrainCapabilityStore, grant: BrainGrant, capabilityId: string): boolean {
  if (capabilityPatternMatches(grant.capabilityId, capabilityId)) return true;
  if (grant.grantKind === "group" && groupMatchesCapability(grant.capabilityId, capabilityId)) return true;
  if (grant.grantKind === "bundle") {
    const bundleId = grant.bundleId ?? grant.capabilityId;
    const bundle = store.grantBundles.find((item) => item.id === bundleId && (!item.status || item.status === "active"));
    if (!bundle) return false;
    if ((bundle.includes?.capabilityIds ?? []).some((item) => capabilityPatternMatches(item, capabilityId))) return true;
    return (bundle.includes?.groupIds ?? []).some((groupId) => groupMatchesCapability(groupId, capabilityId));
  }
  return false;
}

function capabilityPatternMatches(pattern: string, capabilityId: string): boolean {
  if (pattern === "*" || pattern === capabilityId) return true;
  if (pattern.endsWith(".*")) return capabilityId.startsWith(pattern.slice(0, -1));
  return false;
}

function groupMatchesCapability(groupId: string, capabilityId: string): boolean {
  return capabilityId === groupId || capabilityId.startsWith(`${groupId}.`);
}

function grantAllowsAction(grant: BrainGrant, action: string): boolean {
  const actions = (grant.actions ?? []).map((item) => typeof item === "string" ? item : "").filter(Boolean);
  return actions.includes("*") || actions.includes(action);
}

function grantResourceMatches(grant: BrainGrant, resource: SlackBrainCapabilityResource): boolean {
  const selectors = grant.resource?.selectors;
  if (!selectors) return true;
  return selectorMatches(selectors.teamId, resource.teamId)
    && selectorMatches(selectors.channelId, resource.channelId)
    && selectorMatches(selectors.threadTs, resource.threadTs);
}

function selectorMatches(selector: unknown, actual: string | undefined): boolean {
  if (selector === undefined || selector === null || selector === "") return true;
  const expected = String(selector);
  if (expected === "*") return true;
  return actual !== undefined && expected === actual;
}

function summarizeGrant(grant: BrainGrant): SlackBrainCapabilityGrantSummary {
  return {
    id: grant.id,
    subjectId: grant.subjectId,
    capabilityId: grant.capabilityId,
    grantKind: grant.grantKind ?? "capability",
    actions: (grant.actions ?? []).map((item) => typeof item === "string" ? item : "").filter(Boolean),
    resourceSelectors: stringifyRecord(grant.resource?.selectors),
    grantedAt: grant.grantedAt,
    expiresAt: grant.expiresAt,
    source: [grant.source?.kind, grant.source?.id].filter(Boolean).join(":") || undefined,
  };
}

function deny(input: {
  reason: DenyReason;
  storePath: string;
  capabilityId?: string;
  action?: string;
  identityId?: string;
  personId?: string;
  subjectIds?: string[];
  detail?: string;
  now?: Date;
}): SlackBrainCapabilityDecision {
  return {
    allowed: false,
    checkedAt: isoNow(input.now),
    storePath: input.storePath,
    capabilityId: input.capabilityId,
    action: input.action,
    identityId: input.identityId,
    personId: input.personId,
    subjectIds: input.subjectIds,
    grantIds: [],
    grants: [],
    reason: input.reason,
    detail: input.detail,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function stringifyRecord(value: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value ?? {})) {
    if (item === undefined || item === null) continue;
    out[key] = String(item);
  }
  return out;
}

function isoNow(now?: Date): string {
  return now?.toISOString() ?? nowIso();
}
