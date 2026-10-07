import { afterEach, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createV2ProjectsFixtures } from "../src/lib/shared-ledger-contract-v2-projects-fixtures.js";
import type { V2ProjectJoinGrant } from "../src/lib/shared-ledger-contract-v2-projects-types.js";
import { SHARED_LEDGER_LIST_FIXTURE } from "../src/lib/shared-ledger-contract-fixtures.js";
import { joinSharedLedger } from "../src/lib/shared-ledger-join.js";
import * as stateFile from "../src/lib/state-file.js";
import { readSharedLedgerBindings, replaceSharedLedgerBindings, setSharedLedgerBinding } from "../src/lib/shared-ledger-gate-bindings.js";
import { resolveSharedLedgerCredential } from "../src/lib/shared-ledger-mode.js";
import { recoverSharedLedgerProjectUnbind, sharedLedgerProjectUnbindCard, unbindSharedLedgerProject } from "../src/lib/shared-ledger-project-link-unbind.js";
const CENTER = "center-" + "a".repeat(32);
const FILES = ["projects.json", "shared-ledger-bindings.json", "shared-ledger-credentials.json", "shared-ledger-project-unbind.json",
  "shared-ledger-bindings-generation.json"];
const roots: string[] = [];
const cleanup = () => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); };
const credential = (localSubject: string, kind: "person" | "service", projectId: string, personId = "person") => ({ centerId: CENTER,
  baseUrl: "https://center.example/", teamId: "team", personId, instanceId: "instance", bearer: "k".repeat(43), localSubject, kind,
  projects: [{ projectId, actions: ["read", "plan"] }] });

/** Real temp ledger: another bound project, another member and a service, then "shared" enrolled through the fixed fake center. */
async function enrolled() {
  const dir = mkdtempSync(join(tmpdir(), "sl-unbind-")); roots.push(dir);
  for (const id of ["existing", "keep", "spare"]) mkdirSync(join(dir, id));
  writeFileSync(join(dir, "projects.json"), JSON.stringify({ projects: ["existing", "keep", "spare", "personal"].map(id =>
    ({ id, name: id, dirs: [join(dir, id)], personal: id === "personal" })) }));
  writeFileSync(join(dir, "shared-ledger-bindings.json"), JSON.stringify([{ centerId: CENTER, teamId: "team", projectId: "keep", localProjectId: "keep" }]), { mode: 0o600 });
  writeFileSync(join(dir, "shared-ledger-credentials.json"), JSON.stringify({ credentials: [credential("owner:self", "person", "keep"),
    credential("member:other", "person", "shared", "other-person"), credential("svc", "service", "shared")] }), { mode: 0o600 });
  await enroll(dir);
  return dir;
}

/** The formal N2 enrollment path through the fixed fake center; never a real center. */
async function enroll(dir: string) {
  const pair = generateKeyPairSync("ed25519"), key = { privateKey: pair.privateKey, publicKey: String(pair.publicKey.export({ format: "jwk" }).x) };
  const grant: V2ProjectJoinGrant = { ...createV2ProjectsFixtures().grant, centerId: CENTER, teamId: "team", personId: "person", instanceId: "instance",
    role: "member", bearer: "b".repeat(43), expiresAt: Date.now() + 60_000, projects: [{ projectId: "shared", actions: ["read"] }],
    project: { teamId: "team", projectId: "shared", name: "团队项目" } };
  let calls = 0;
  const fetch = (async () => ++calls % 2 ? Response.json(grant) : Response.json({ ...SHARED_LEDGER_LIST_FIXTURE, teamId: "team", features: [] })) as unknown as typeof globalThis.fetch;
  await joinSharedLedger({ url: "https://center.example/", code: `sljoin1.${CENTER}.${"a".repeat(32)}.${"A".repeat(43)}`, key, subject: "owner:self",
    instanceId: "instance", stateDir: dir, fetch, localProjectId: "existing",
    expectedProject: { centerId: CENTER, teamId: "team", projectId: "shared", name: "团队项目", personId: "person" } });
}
const bytes = (dir: string) => FILES.map(name => existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : null);
const mode = (dir: string, name: string) => statSync(join(dir, name)).mode & 0o777;
afterEach(cleanup);

const keep = { centerId: CENTER, teamId: "team", projectId: "keep", localProjectId: "keep" };
const permits = (dir: string, subject: string, kind: "person" | "service", projectId: string) =>
  (["read", "plan", "import", "project"] as const).some(a => resolveSharedLedgerCredential(subject, kind, CENTER, "team", projectId, a, dir));

test("old gap: before this exit API, no local primitive or center-side removal reads as a local exit", async () => {
  const dir = await enrolled(), before = bytes(dir);
  const shared = readSharedLedgerBindings(dir).find(b => b.projectId === "shared")!;
  await setSharedLedgerBinding(shared, dir);
  await expect(replaceSharedLedgerBindings({ expected: [shared], next: { ...shared, localProjectId: "personal" } }, dir)).rejects.toThrow();
  expect(bytes(dir)).toEqual(before);
  // The center forgetting the member changes nothing locally: the mapping and the person permission are still there.
  expect(readSharedLedgerBindings(dir)).toContainEqual(shared);
  expect(permits(dir, "owner:self", "person", "shared")).toBe(true);
});

test("real enrollment then approved exit removes only this mapping and this person's local permission", async () => {
  const dir = await enrolled(), [projects] = bytes(dir);
  const card = sharedLedgerProjectUnbindCard("existing", dir);
  expect(card).toMatchObject({ centerId: CENTER, teamId: "team", projectId: "shared", localProjectId: "existing", personId: "person", instanceId: "instance" });
  const result = await unbindSharedLedgerProject(card, dir);
  expect(result).toEqual({ binding: { centerId: CENTER, teamId: "team", projectId: "shared", localProjectId: "existing" }, revokedPermissions: 1 });
  expect(readSharedLedgerBindings(dir)).toEqual([keep]);
  expect(permits(dir, "owner:self", "person", "shared")).toBe(false);
  expect(permits(dir, "owner:self", "person", "keep")).toBe(true);
  expect(permits(dir, "member:other", "person", "shared")).toBe(true);
  expect(permits(dir, "svc", "service", "shared")).toBe(true);
  expect(bytes(dir)[0]).toBe(projects); // local project, its directories and agents stay
  expect([mode(dir, "shared-ledger-bindings.json"), mode(dir, "shared-ledger-credentials.json")]).toEqual([0o600, 0o600]);
  expect(readdirSync(dir).filter(f => f.startsWith(".shared-project") || f.endsWith(".tmp") || f.includes("unbind"))).toEqual([]);
  expect(() => sharedLedgerProjectUnbindCard("existing", dir)).toThrow("nothing was changed");
});

test("forged, stale, drifted or wrong-identity approvals refuse with zero bytes changed", async () => {
  const cases: Array<(card: ReturnType<typeof sharedLedgerProjectUnbindCard>) => object> = [
    c => ({ ...c, personId: "other-person" }), c => ({ ...c, instanceId: "other-instance" }), c => ({ ...c, localProjectId: "keep" }),
    c => ({ ...c, projectId: "keep" }), c => ({ ...c, teamId: "other" }), c => ({ ...c, centerId: "center-" + "c".repeat(32) }),
    c => ({ ...c, version: "v1:" + "0".repeat(64) }), c => ({ ...c, version: "latest" }), c => ({ ...c, extra: true }),
    c => { const { instanceId: _, ...rest } = c; return rest; }, c => ({ ...c, personId: "../x" }),
  ];
  for (const change of cases) {
    const dir = await enrolled(), before = bytes(dir);
    await expect(unbindSharedLedgerProject(change(sharedLedgerProjectUnbindCard("existing", dir)) as never, dir)).rejects.toThrow();
    expect(bytes(dir)).toEqual(before);
  }
});

test("mapping or credential changes after the card was approved reject the old approval", async () => {
  for (const drift of ["binding", "credential"]) {
    const dir = await enrolled(), card = sharedLedgerProjectUnbindCard("existing", dir);
    if (drift === "binding") writeFileSync(join(dir, "shared-ledger-bindings.json"), JSON.stringify([...readSharedLedgerBindings(dir),
      { centerId: CENTER, teamId: "team", projectId: "third", localProjectId: "third" }]), { mode: 0o600 });
    else writeFileSync(join(dir, "shared-ledger-credentials.json"), readFileSync(join(dir, "shared-ledger-credentials.json"), "utf8") + "\n", { mode: 0o600 });
    const before = bytes(dir);
    await expect(unbindSharedLedgerProject(card, dir)).rejects.toThrow("绑定已变化");
    expect(bytes(dir)).toEqual(before);
  }
});

test("unknown, unreadable or ambiguous local state never produces a card or an exit", async () => {
  const modes = ["unbound", "corrupt-credentials", "credentials-0644", "corrupt-bindings", "no-person", "two-people", "non-utf8"];
  for (const m of modes) {
    const dir = await enrolled(), card = sharedLedgerProjectUnbindCard("existing", dir);
    const credPath = join(dir, "shared-ledger-credentials.json"), creds = JSON.parse(readFileSync(credPath, "utf8"));
    if (m === "corrupt-credentials") writeFileSync(credPath, "{corrupt");
    if (m === "credentials-0644") chmodSync(credPath, 0o644);
    if (m === "corrupt-bindings") writeFileSync(join(dir, "shared-ledger-bindings.json"), "[{");
    if (m === "non-utf8") writeFileSync(join(dir, "shared-ledger-bindings.json"), Buffer.from([0xff, 0xfe]));
    if (m === "no-person" || m === "two-people") {
      const own = creds.credentials.find((c: { localSubject: string; projects: { projectId: string }[] }) => c.localSubject === "owner:self" && c.projects[0]!.projectId === "shared");
      if (m === "no-person") own.localSubject = "owner:gone";
      else creds.credentials.push({ ...own, personId: "second-person" });
      writeFileSync(credPath, JSON.stringify(creds), { mode: 0o600 });
    }
    const before = bytes(dir);
    const target = m === "unbound" ? "keep-missing" : "existing";
    expect(() => sharedLedgerProjectUnbindCard(target, dir)).toThrow();
    await expect(unbindSharedLedgerProject({ ...card, localProjectId: target }, dir)).rejects.toThrow();
    expect(bytes(dir)).toEqual(before);
    expect(existsSync(join(dir, "shared-ledger-project-unbind.json"))).toBe(false);
  }
});

test("legacy implicit-local binding exits through the same writer; set/replace semantics are unchanged afterwards", async () => {
  const dir = await enrolled();
  const rows = readSharedLedgerBindings(dir).map(b => b.projectId === "shared" ? { centerId: b.centerId, teamId: b.teamId, projectId: b.projectId } : b);
  writeFileSync(join(dir, "shared-ledger-bindings.json"), JSON.stringify(rows), { mode: 0o600 });
  const card = sharedLedgerProjectUnbindCard("shared", dir);
  expect(card.localProjectId).toBe("shared");
  await unbindSharedLedgerProject(card, dir);
  expect(readSharedLedgerBindings(dir)).toEqual([keep]);
  await setSharedLedgerBinding({ centerId: CENTER, teamId: "team", projectId: "shared", localProjectId: "existing" }, dir);
  expect(readSharedLedgerBindings(dir)).toHaveLength(2);
});

const journal = (dir: string) => join(dir, "shared-ledger-project-unbind.json");

/** failAt: the credential publication fails before (or after) its rename; dead: every later write fails too, like a killed process. */
async function interrupted(failAt: "credentials-before" | "credentials-after", dead: boolean) {
  const dir = await enrolled(), card = sharedLedgerProjectUnbindCard("existing", dir), before = bytes(dir), original = stateFile.writeTextAtomicSync;
  let tripped = false;
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const spy = spyOn(stateFile, "writeTextAtomicSync").mockImplementation((path, text, options) => {
    if (tripped && dead) throw new Error("process gone");
    if (path === join(dir, "shared-ledger-credentials.json") && !tripped) {
      tripped = true;
      if (failAt === "credentials-before") throw new Error("synthetic disk failure");
      original(path, text, options);
      if (failAt === "credentials-after") throw new Error("synthetic disk failure after rename");
      return;
    }
    return original(path, text, options);
  });
  let failure: unknown, logged: string[] = [];
  try { await unbindSharedLedgerProject(card, dir); } catch (error) { failure = error; } finally {
    logged = errors.mock.calls.map(c => String(c[0]));
    spy.mockRestore(); errors.mockRestore();
  }
  for (const line of logged) console.log(`[kept fault log] ${line}`);
  return { dir, card, before, failure: failure as Error, logged };
}

test("a failure on either side of the two-file publication restores both files byte-for-byte and clears the journal", async () => {
  for (const failAt of ["credentials-before", "credentials-after"] as const) {
    const run = await interrupted(failAt, false);
    expect(run.failure.message).toContain("synthetic disk failure");
    expect(bytes(run.dir)).toEqual(run.before);
    expect(mode(run.dir, "shared-ledger-credentials.json")).toBe(0o600);
    expect(await unbindSharedLedgerProject(run.card, run.dir)).toMatchObject({ revokedPermissions: 1 });
  }
});

test("an interrupted exit leaves a 0600 journal; restart reconciliation restores the original bytes and the same approval completes", async () => {
  for (const failAt of ["credentials-before", "credentials-after"] as const) {
    const run = await interrupted(failAt, true);
    expect(run.logged).toContain("shared ledger unbind left a journal for restart reconciliation");
    expect(existsSync(journal(run.dir))).toBe(true);
    expect(mode(run.dir, "shared-ledger-project-unbind.json")).toBe(0o600);
    expect(bytes(run.dir).slice(0, 3)).not.toEqual(run.before.slice(0, 3)); // genuinely half-written on disk
    expect(await recoverSharedLedgerProjectUnbind(run.dir)).toBe("restored");
    expect(bytes(run.dir)).toEqual(run.before);
    expect(await recoverSharedLedgerProjectUnbind(run.dir)).toBe("clean");
    await unbindSharedLedgerProject(run.card, run.dir);
    expect(readSharedLedgerBindings(run.dir).map(b => b.projectId)).toEqual(["keep"]);
  }
});

test("the next exit attempt reconciles a pending journal itself before checking the approval", async () => {
  const run = await interrupted("credentials-after", true);
  await unbindSharedLedgerProject(run.card, run.dir);
  expect(existsSync(journal(run.dir))).toBe(false);
  expect(readSharedLedgerBindings(run.dir).map(b => b.projectId)).toEqual(["keep"]);
});

test("reconciliation refuses, and exit stays blocked, when other writers moved the files after the interruption", async () => {
  for (const tamper of ["bindings", "journal"]) {
    const run = await interrupted("credentials-after", true);
    if (tamper === "bindings") writeFileSync(join(run.dir, "shared-ledger-bindings.json"), JSON.stringify([...readSharedLedgerBindings(run.dir),
      { centerId: CENTER, teamId: "team", projectId: "third", localProjectId: "third" }]), { mode: 0o600 });
    else writeFileSync(journal(run.dir), "{broken", { mode: 0o600 });
    const held = bytes(run.dir);
    await expect(recoverSharedLedgerProjectUnbind(run.dir)).rejects.toThrow("owner review required");
    await expect(unbindSharedLedgerProject(run.card, run.dir)).rejects.toThrow("owner review required");
    expect(bytes(run.dir)).toEqual(held);
  }
});

test("concurrent exits with one approval: exactly one wins, the other sees the changed mapping", async () => {
  const dir = await enrolled(), card = sharedLedgerProjectUnbindCard("existing", dir);
  const results = await Promise.allSettled([unbindSharedLedgerProject(card, dir), unbindSharedLedgerProject(card, dir)]);
  expect(results.map(r => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  expect(String((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason)).toContain("绑定已变化");
  expect(readSharedLedgerBindings(dir).map(b => b.projectId)).toEqual(["keep"]);
  expect(() => sharedLedgerProjectUnbindCard("existing", dir)).toThrow("nothing was changed");
  expect(readFileSync(join(dir, "shared-ledger-credentials.json"), "utf8")).toContain("member:other");
});

test("ABA: an old approval is stale after replace moves the mapping away and back, even though both files' bytes match again", async () => {
  const dir = await enrolled(), card = sharedLedgerProjectUnbindCard("existing", dir), original = bytes(dir).slice(0, 3);
  const shared = readSharedLedgerBindings(dir).find(b => b.projectId === "shared")!;
  await replaceSharedLedgerBindings({ expected: [shared], next: { ...shared, localProjectId: "spare" } }, dir);
  await replaceSharedLedgerBindings({ expected: [{ ...shared, localProjectId: "spare" }], next: shared }, dir);
  expect(bytes(dir).slice(0, 3)).toEqual(original); // content is genuinely back to A
  const fresh = sharedLedgerProjectUnbindCard("existing", dir);
  expect(fresh.version).not.toBe(card.version);
  const before = bytes(dir);
  await expect(unbindSharedLedgerProject(card, dir)).rejects.toThrow("绑定已变化");
  expect(bytes(dir)).toEqual(before);
  expect(permits(dir, "owner:self", "person", "shared")).toBe(true);
  // The owner re-approves the current card; that one completes.
  expect(await unbindSharedLedgerProject(fresh, dir)).toMatchObject({ revokedPermissions: 1 });
});

test("ABA: a used approval cannot exit again after the same identity re-enrolls the same mapping", async () => {
  const dir = await enrolled(), card = sharedLedgerProjectUnbindCard("existing", dir);
  await unbindSharedLedgerProject(card, dir);
  await enroll(dir);
  expect(readSharedLedgerBindings(dir).map(b => b.projectId)).toEqual(["keep", "shared"]);
  expect(sharedLedgerProjectUnbindCard("existing", dir).version).not.toBe(card.version);
  const before = bytes(dir);
  await expect(unbindSharedLedgerProject(card, dir)).rejects.toThrow("绑定已变化");
  expect(bytes(dir)).toEqual(before);
  expect(permits(dir, "owner:self", "person", "shared")).toBe(true);
});

test("a no-op set or a refused replace keeps the generation; any idempotent re-enrollment advances it", async () => {
  const dir = await enrolled(), card = sharedLedgerProjectUnbindCard("existing", dir);
  const shared = readSharedLedgerBindings(dir).find(b => b.projectId === "shared")!;
  await setSharedLedgerBinding(shared, dir);
  await expect(replaceSharedLedgerBindings({ expected: [shared], next: { ...shared, localProjectId: "personal" } }, dir)).rejects.toThrow();
  expect(sharedLedgerProjectUnbindCard("existing", dir).version).toBe(card.version);
  await enroll(dir);
  await expect(unbindSharedLedgerProject(card, dir)).rejects.toThrow("绑定已变化");
});

test("an unreadable generation or a pending journal never produces a card", async () => {
  for (const m of ["corrupt", "0644", "journal"]) {
    const dir = await enrolled(), card = sharedLedgerProjectUnbindCard("existing", dir), path = join(dir, "shared-ledger-bindings-generation.json");
    if (m === "corrupt") writeFileSync(path, "{", { mode: 0o600 });
    if (m === "0644") chmodSync(path, 0o644);
    if (m === "journal") writeFileSync(journal(dir), "{broken", { mode: 0o600 });
    const before = bytes(dir);
    expect(() => sharedLedgerProjectUnbindCard("existing", dir)).toThrow("nothing was changed");
    await expect(unbindSharedLedgerProject(card, dir)).rejects.toThrow();
    expect(bytes(dir)).toEqual(before);
  }
});
