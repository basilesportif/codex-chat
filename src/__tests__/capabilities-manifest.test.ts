import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { authorize, resolveSubjectManifest } from "../capabilities.js";
import type { ActorContext } from "../types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeStore(store: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-chat-capabilities-"));
  tempDirs.push(root);
  await mkdir(root, { recursive: true });
  const path = join(root, "capabilities.json");
  await writeFile(path, JSON.stringify(store, null, 2));
  return path;
}

function subjectActor(subjectId: string): ActorContext {
  return {
    id: subjectId,
    surfaceKind: "system",
    correlationId: "corr_test",
    metadata: { brainSubjectId: subjectId }
  };
}

function baseStore(grants: unknown[]): Record<string, unknown> {
  return {
    schemaVersion: 2,
    people: [{ id: "person_tim", status: "active", primarySubjectId: "person:person_tim", subjectIds: ["person:person_tim", "person:person_tim_work"] }],
    externalIdentities: [],
    subjects: [
      { id: "person:person_tim", personId: "person_tim", status: "active" },
      { id: "person:person_tim_work", personId: "person_tim", status: "active" }
    ],
    grantBundles: [],
    grants
  };
}

describe("Brain subject manifest resolution", () => {
  test("advertises a subject whose check_capability-style authorization allows every listed capability", async () => {
    const storePath = await writeStore(baseStore([
      {
        id: "grant_sibling_calendar",
        subjectId: "person:person_tim_work",
        capabilityId: "calendar.event.write",
        grantKind: "capability",
        resource: { kind: "calendar", id: "*", selectors: { calendarId: "abc" } },
        actions: ["write"],
        status: "active",
        enforcement: "enforcing"
      }
    ]));
    const manifest = await resolveSubjectManifest(subjectActor("person:person_tim"), { storePath });

    expect(manifest).toEqual({
      subjectId: "person:person_tim",
      capabilities: [{ capabilityId: "calendar.event.write", selectors: { calendarId: "abc" } }]
    });
    for (const capability of manifest?.capabilities ?? []) {
      await expect(authorize(subjectActor(manifest!.subjectId), {
        operation: capability.capabilityId,
        action: "write",
        resource: capability.selectors ?? {},
        reason: "manifest consistency"
      }, { storePath })).resolves.toMatchObject({ allowed: true });
    }
  });

  test("includes active grants with omitted enforcement fields", async () => {
    const storePath = await writeStore(baseStore([
      {
        id: "grant_no_enforcement",
        subjectId: "person:person_tim",
        capabilityId: "crm.contact.read",
        grantKind: "capability",
        resource: { kind: "crm", id: "*", selectors: {} },
        actions: ["read"],
        status: "active"
      }
    ]));

    await expect(resolveSubjectManifest(subjectActor("person:person_tim"), { storePath })).resolves.toMatchObject({
      capabilities: [{ capabilityId: "crm.contact.read", selectors: undefined }]
    });
  });

  test("expands group grants to concrete registry capability ids", async () => {
    const storePath = await writeStore(baseStore([
      {
        id: "grant_runtime_group",
        subjectId: "person:person_tim",
        capabilityId: "runtime",
        grantKind: "group",
        resource: { kind: "global", id: "*", selectors: {} },
        actions: ["*"],
        status: "active",
        enforcement: "enforcing"
      }
    ]));
    const manifest = await resolveSubjectManifest(subjectActor("person:person_tim"), { storePath });

    expect(manifest?.capabilities.map((item) => item.capabilityId)).toEqual(["runtime.admin", "runtime.status.read"]);
  });
});

describe("grant action matching", () => {
  // Well-formed selectors (wildcards over real resource keys) so these tests
  // isolate ACTION matching. A grant that lists concrete actions ["read",
  // "search"] must still be satisfied by an unspecified ("*") requested action.
  const seedReadGrant = {
    id: "grant_seed_crm_read",
    subjectId: "person:person_tim",
    capabilityId: "crm.contact.read",
    grantKind: "capability",
    resource: { kind: "crm", id: "*", selectors: { contactId: "*", businessId: "*" } },
    actions: ["read", "search"],
    status: "active",
    enforcement: "enforcing"
  };

  test("a wildcard requested action authorizes against a concrete-action grant (operation-level)", async () => {
    const storePath = await writeStore(baseStore([seedReadGrant]));
    await expect(authorize(subjectActor("person:person_tim"), {
      operation: "crm.contact.read",
      action: "*",
      resource: {},
      reason: "owner CRM read"
    }, { storePath })).resolves.toMatchObject({ allowed: true });
  });

  test("an omitted/empty requested action is also operation-level", async () => {
    const storePath = await writeStore(baseStore([seedReadGrant]));
    await expect(authorize(subjectActor("person:person_tim"), {
      operation: "crm.contact.read",
      action: "",
      resource: {},
      reason: "owner CRM read no action"
    }, { storePath })).resolves.toMatchObject({ allowed: true });
  });

  test("a concrete requested action is still gated against the grant's action list", async () => {
    const storePath = await writeStore(baseStore([seedReadGrant]));
    // "delete" is not in ["read","search"] and the grant has no "*" — must deny.
    await expect(authorize(subjectActor("person:person_tim"), {
      operation: "crm.contact.read",
      action: "delete",
      resource: {},
      reason: "concrete action still gated"
    }, { storePath })).resolves.toMatchObject({ allowed: false });
  });

  test("wildcard action does NOT bypass selector explicit-coverage", async () => {
    const scopedGrant = {
      ...seedReadGrant,
      id: "grant_scoped_crm_read",
      resource: { kind: "crm", id: "*", selectors: { contactId: "ct_allowed" } }
    };
    const storePath = await writeStore(baseStore([scopedGrant]));
    // Resource names a contactId the grant does not cover -> selector gate denies
    // even though the requested action is "*".
    await expect(authorize(subjectActor("person:person_tim"), {
      operation: "crm.contact.read",
      action: "*",
      resource: { contactId: "ct_other" },
      reason: "selector scoping preserved"
    }, { storePath })).resolves.toMatchObject({ allowed: false });
  });
});
