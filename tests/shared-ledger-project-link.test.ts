import { afterEach, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createV2ProjectsFixtures } from "../src/lib/shared-ledger-contract-v2-projects-fixtures.js";
import type { V2ProjectJoinGrant } from "../src/lib/shared-ledger-contract-v2-projects-types.js";
import { SHARED_LEDGER_LIST_FIXTURE } from "../src/lib/shared-ledger-contract-fixtures.js";
import { joinSharedLedger, redeemSharedLedgerProjectCredential, type SharedLedgerJoinInput } from "../src/lib/shared-ledger-join.js";
import { sharedLedgerInstanceId, sharedLedgerJoinFields, SHARED_LEDGER_JOIN_PURPOSE } from "../src/lib/shared-ledger-join-protocol.js";
import { verifyPurpose } from "../src/lib/instance-key.js";
import { readSharedLedgerBindings } from "../src/lib/shared-ledger-gate-bindings.js";
import * as stateFile from "../src/lib/state-file.js";
import * as projectFile from "../src/lib/projects.js";
import { readSharedLedgerProjects } from "../src/lib/shared-ledger-project-link.js";

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function world() {
  const dir = mkdtempSync(join(tmpdir(), "sl-project-link-")); roots.push(dir);
  const pair = generateKeyPairSync("ed25519"), key = { privateKey: pair.privateKey, publicKey: String(pair.publicKey.export({ format: "jwk" }).x) };
  const projects = ["shared", "shared-2", "existing", "personal", "umbrella"].map(id =>
    ({ id, name: id, dirs: id === "umbrella" ? ["/"] : [], personal: id === "personal" }));
  writeFileSync(join(dir, "projects.json"), JSON.stringify({ projects }));
  writeFileSync(join(dir, "shared-ledger-credentials.json"), '{ "credentials" : [] }\n', { mode: 0o600 });
  let calls = 0;
  const grant: V2ProjectJoinGrant = { ...createV2ProjectsFixtures().grant, centerId: "center-" + "a".repeat(32), teamId: "team", personId: "person", instanceId: "instance", role: "member",
    bearer: "b".repeat(43), expiresAt: Date.now() + 60_000, projects: [{ projectId: "shared", actions: ["read"] }], project: { teamId: "team", projectId: "shared", name: "团队项目" } };
  const input: SharedLedgerJoinInput = { url: "https://center.example/", code: `sljoin1.center-${"a".repeat(32)}.${"a".repeat(32)}.${"A".repeat(43)}`,
    key, subject: "owner:self", instanceId: "instance", stateDir: dir,
    fetch: (async () => ++calls % 2 ? Response.json(grant) : Response.json({ ...SHARED_LEDGER_LIST_FIXTURE, teamId: "team", features: [] })) as unknown as typeof fetch };
  return { dir, input, grant, calls: () => calls };
}
const display = { centerId: "center-" + "a".repeat(32), teamId: "team", projectId: "shared", name: "团队项目", personId: "person" };
const bytes = (dir: string) => ["projects.json", "shared-ledger-bindings.json", "shared-ledger-credentials.json"].map(name =>
  existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : null);

test("explicit selection required before redeem; missing and personal projects never redeem", async () => {
  const w = world(), before = bytes(w.dir);
  for (const extra of [{}, { localProjectId: "absent" }, { localProjectId: "personal" }, { localProjectId: "umbrella" }, { create: true, localProjectId: "existing" }]) {
    await expect(joinSharedLedger({ ...w.input, expectedProject: display, ...extra })).rejects.toThrow();
    expect(w.calls()).toBe(0);
    expect(bytes(w.dir)).toEqual(before);
  }
  await expect(joinSharedLedger({ ...w.input, create: true })).rejects.toThrow("requires");
  expect(bytes(w.dir)).toEqual(before);
});

test("explicit create chooses collision suffix, center display name, empty non-personal project", async () => {
  const w = world();
  const result = await joinSharedLedger({ ...w.input, create: true, expectedProject: display });
  expect(result.localProjectId).toBe("shared-3");
  const project = readSharedLedgerProjects(w.dir).projects.find(p => p.id === result.localProjectId)!;
  expect(project).toMatchObject({ name: display.name, dirs: [] });
  expect(project.personal).toBeUndefined();
  expect(readSharedLedgerBindings(w.dir)).toEqual([{ centerId: "center-" + "a".repeat(32), teamId: "team", projectId: "shared", localProjectId: "shared-3" }]);
});

test("offered project/team mismatches and multi-project grant preserve all original bytes", async () => {
  for (const mismatch of ["project", "team", "multiple"]) {
    const w = world(), before = bytes(w.dir);
    if (mismatch === "project") w.grant.projects[0]!.projectId = "other";
    if (mismatch === "team") w.grant.teamId = "other";
    if (mismatch === "multiple") w.grant.projects.push({ projectId: "other", actions: ["read"] });
    await expect(joinSharedLedger({ ...w.input, localProjectId: "existing", expectedProject: display })).rejects.toThrow("offered project");
    expect(bytes(w.dir)).toEqual(before);
    expect(w.calls()).toBe(1);
  }
});

test("save failure after staging and binding publication rolls back projects/bindings; credentials stay byte-identical", async () => {
  const w = world(), before = bytes(w.dir), original = stateFile.writeTextAtomicSync;
  const spy = spyOn(stateFile, "writeTextAtomicSync").mockImplementation((path, text, options) => {
    if (path === join(w.dir, "shared-ledger-credentials.json")) throw new Error("synthetic disk failure");
    return original(path, text, options);
  });
  try { await expect(joinSharedLedger({ ...w.input, create: true, expectedProject: display })).rejects.toThrow("nothing was saved"); }
  finally { spy.mockRestore(); }
  expect(bytes(w.dir)).toEqual(before);
});

test("the canonical project writer failing after credential publication restores both security files and leaves projects unchanged", async () => {
  const w = world(), before = bytes(w.dir), original = projectFile.writeProjects;
  const spy = spyOn(projectFile, "writeProjects").mockImplementation(async (data, path) => {
    if (path === join(w.dir, "projects.json")) throw new Error("synthetic project publication failure");
    return original(data, path);
  });
  try { await expect(joinSharedLedger({ ...w.input, create: true, expectedProject: display })).rejects.toThrow("nothing was saved"); }
  finally { spy.mockRestore(); }
  expect(bytes(w.dir)).toEqual(before);
});

test("center confirmation, unreadable credentials, and binding conflicts never overwrite credentials", async () => {
  for (const mode of ["confirmation", "corrupt", "binding", "no-read"]) {
    const w = world();
    if (mode === "confirmation") w.input.fetch = (async () => Response.json({}, { status: 403 })) as unknown as typeof fetch;
    if (mode === "corrupt") writeFileSync(join(w.dir, "shared-ledger-credentials.json"), "{corrupt");
    if (mode === "binding") writeFileSync(join(w.dir, "shared-ledger-bindings.json"), JSON.stringify([
      { centerId: "center-" + "a".repeat(32), teamId: "team", projectId: "shared", localProjectId: "shared" }]), { mode: 0o600 });
    if (mode === "no-read") w.grant.projects[0]!.actions = ["plan"];
    const before = bytes(w.dir);
    await expect(joinSharedLedger({ ...w.input, localProjectId: "existing", expectedProject: display })).rejects.toThrow();
    expect(bytes(w.dir)).toEqual(before);
  }
});

test("controlled creator exchange requires expected identity and leaves every local file unchanged", async () => {
  const w = world(), before = bytes(w.dir);
  const result = await redeemSharedLedgerProjectCredential({ ...w.input, expectedProject: display });
  expect(JSON.stringify(result.credential.projects)).toBe(JSON.stringify(w.grant.projects));
  expect(result.credential.bearer).toBe(w.grant.bearer);
  expect(bytes(w.dir)).toEqual(before);
});

test("canonical grant rejects center/person/instance/display drift before confirmation or local writes", async () => {
  const changes: Array<(grant: V2ProjectJoinGrant) => void> = [
    grant => { grant.centerId = "center-" + "c".repeat(32); },
    grant => { grant.personId = "other-person"; },
    grant => { grant.instanceId = "other-instance"; },
    grant => { grant.project.name = "另一个名称"; },
    grant => { grant.project.teamId = "other-team"; },
    grant => { grant.project.projectId = "other-project"; },
  ];
  for (const change of changes) {
    const w = world(), before = bytes(w.dir);
    change(w.grant);
    await expect(joinSharedLedger({ ...w.input, create: true, expectedProject: display })).rejects.toThrow("offered project");
    expect(w.calls()).toBe(1);
    expect(bytes(w.dir)).toEqual(before);
  }
});

test("missing invitation person and invitation-bound instance mismatch never redeem", async () => {
  for (const expected of [{ ...display, personId: undefined }, { ...display, instanceId: "different-instance" }]) {
    const w = world(), before = bytes(w.dir);
    await expect(joinSharedLedger({ ...w.input, create: true, expectedProject: expected as typeof display })).rejects.toThrow("nothing was saved");
    expect(w.calls()).toBe(0);
    expect(bytes(w.dir)).toEqual(before);
  }
});

test("new enrollment checks the invitation-bound instance against the locally signed request", async () => {
  const w = world(), original = w.input.fetch!, instanceId = sharedLedgerInstanceId(w.input.key.publicKey);
  w.grant.instanceId = instanceId;
  w.input.fetch = (async (...args: Parameters<typeof fetch>) => {
    const init = args[1];
    if (init?.method === "POST") {
      const request = JSON.parse(String(init.body));
      expect(request.instanceId).toBe(instanceId);
      expect(request.publicKey).toBe(w.input.key.publicKey);
      expect(verifyPurpose(request.publicKey, SHARED_LEDGER_JOIN_PURPOSE,
        sharedLedgerJoinFields(display.centerId, w.input.code, request.publicKey, instanceId), request.signature)).toBe(true);
    }
    return original(...args);
  }) as typeof fetch;
  const result = await joinSharedLedger({ ...w.input, instanceId: undefined, localProjectId: "existing", expectedProject: { ...display, instanceId } });
  expect(result.personId).toBe(display.personId);
});

test("legacy center without display is fixed unavailable for new enrollment; legacy enrollment still works", async () => {
  const w = world(), before = bytes(w.dir);
  delete (w.grant as Partial<V2ProjectJoinGrant>).project;
  await expect(joinSharedLedger({ ...w.input, create: true, expectedProject: display })).rejects.toThrow("project enrollment unavailable; nothing was saved");
  expect(w.calls()).toBe(1);
  expect(bytes(w.dir)).toEqual(before);
  const old = world();
  delete (old.grant as Partial<V2ProjectJoinGrant>).project;
  expect((await joinSharedLedger(old.input)).localProjectId).toBe("shared");
  expect(old.calls()).toBe(2);
});

test("expected scope is frozen before redeem and secret response fields never enter errors", async () => {
  const w = world(), original = w.input.fetch!, expected = { ...display }, before = bytes(w.dir);
  w.input.fetch = (async (...args: Parameters<typeof fetch>) => {
    expected.personId = "other-person";
    expected.name = "changed after approval";
    return original(...args);
  }) as typeof fetch;
  const result = await joinSharedLedger({ ...w.input, create: true, expectedProject: expected });
  expect(result.personId).toBe(display.personId);
  expect(readSharedLedgerProjects(w.dir).projects.find(p => p.id === result.localProjectId)?.name).toBe(display.name);
  const bad = world(), badBefore = bytes(bad.dir);
  bad.input.fetch = (async () => Response.json({ ...bad.grant, project: { ...bad.grant.project, name: bad.grant.bearer } })) as unknown as typeof fetch;
  try {
    await joinSharedLedger({ ...bad.input, create: true, expectedProject: display });
    throw new Error("expected rejection");
  } catch (error) {
    expect((error as Error).message).toBe("center grant does not match offered project; nothing was saved");
    expect((error as Error).message).not.toContain(bad.grant.bearer);
    expect((error as Error).message).not.toContain(bad.input.code);
  }
  expect(bytes(bad.dir)).toEqual(badBefore);
  expect(bytes(w.dir)).not.toEqual(before);
});
