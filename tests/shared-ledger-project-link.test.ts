import { afterEach, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SHARED_LEDGER_LIST_FIXTURE } from "../src/lib/shared-ledger-contract-fixtures.js";
import { joinSharedLedger, redeemSharedLedgerProjectCredential, type SharedLedgerJoinInput } from "../src/lib/shared-ledger-join.js";
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
  const grant = { centerId: "center-" + "a".repeat(32), teamId: "team", personId: "person", instanceId: "instance", role: "member",
    bearer: "b".repeat(43), expiresAt: Date.now() + 60_000, projects: [{ projectId: "shared", actions: ["read"] }] };
  const input: SharedLedgerJoinInput = { url: "https://center.example/", code: `sljoin1.center-${"a".repeat(32)}.${"a".repeat(32)}.${"A".repeat(43)}`,
    key, subject: "owner:self", instanceId: "instance", stateDir: dir,
    fetch: (async () => ++calls % 2 ? Response.json(grant) : Response.json({ ...SHARED_LEDGER_LIST_FIXTURE, teamId: "team", features: [] })) as unknown as typeof fetch };
  return { dir, input, grant, calls: () => calls };
}
const display = { centerId: "center-" + "a".repeat(32), teamId: "team", projectId: "shared", name: "团队项目" };
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
