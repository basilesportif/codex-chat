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
