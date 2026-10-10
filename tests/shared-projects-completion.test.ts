import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openLedger } from "../src/lib/ledger-store.js";
import { answerAsk, getAsk, openAsk, patchAsk, type Ask } from "../src/lib/ledger-asks.js";
import { createV2ProjectsFixtures } from "../src/lib/shared-ledger-contract-v2-projects-fixtures.js";
import { readSharedLedgerBindings, setSharedLedgerBinding, type SharedLedgerBinding } from "../src/lib/shared-ledger-gate-bindings.js";
import { writeJsonAtomicSync } from "../src/lib/state-file.js";
import type { Principal } from "../src/lib/principals.js";
import { sharedProjectAskPorts } from "../src/bridge/local-api/shared-projects-asks.js";
import { answerSharedProject, createSharedProject, openSharedProjectAction } from "../src/bridge/local-api/shared-projects-actions.js";
import { readSharedProjectCompletion, sharedProjectBindingGeneration, sharedProjectCompletionStore } from "../src/bridge/local-api/shared-projects-completion.js";
import { configureSharedProjects, onSharedProjectAnswered } from "../src/bridge/local-api/shared-projects-runtime.js";
import { handleSharedProjectsApi } from "../src/bridge/local-api/shared-projects.js";
import type { ProjectPerson, SharedProjectsPorts } from "../src/bridge/local-api/shared-projects-ports.js";

const owner: Principal = { id: "owner:self", role: "owner", agents: ["*"], manage: true, createdAt: "" };
const operationId = "operation_n4r_0001";
const person: ProjectPerson = { subject: "owner:self", kind: "person", centerId: "center-a", teamId: "team-a", personId: "alice", instanceId: "machine-a" };
const canonical = createV2ProjectsFixtures();
const project = { ...canonical.project, centerId: person.centerId, teamId: person.teamId, projectId: "b", name: "Project B", createdBy: person.personId };
const operation = { ...canonical.operation, centerId: project.centerId, teamId: project.teamId, projectId: project.projectId, operationId,
  personId: person.personId, instanceId: person.instanceId };
const SECRET = "SECRET_BEARER_n4r";

let root: string, db: Database;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "n4r-")); db = openLedger(join(root, "ledger.sqlite")); });
afterEach(() => { configureSharedProjects(undefined); db.close(); rmSync(root, { recursive: true, force: true }); });

const B: SharedLedgerBinding = { centerId: "center-a", teamId: "team-a", projectId: "b", localProjectId: "local-b" };
/** Real asks ledger and a real, isolated binding file: cards, claims, receipts and bindings use the production writers. */
function world() {
  const calls: string[] = [];
  let saved = false, gate = true, who = person;
  writeFileSync(join(root, "projects.json"), JSON.stringify({ projects: ["local-b", "local-c", "local-other"].map(id => ({ id, name: id, dirs: [] })) }));
  const writeBindings = (next: SharedLedgerBinding[]) => writeJsonAtomicSync(join(root, "shared-ledger-bindings.json"), next, { mode: 0o600 });
  const store = sharedProjectAskPorts(db);
  const d: SharedProjectsPorts = {
    ...store, bindingGeneration: sharedProjectBindingGeneration(root),
    openAsk: input => openAsk(db, input),
    now: () => Date.now(), person: async () => who, list: async () => [project],
    create: async () => { calls.push("create"); return { operation, project }; },
    patch: async () => project, invite: async () => ({ askId: "x" }), sendInvite: async () => [],
    authorizeAnswer: async () => true,
    operation: async () => { calls.push("query"); return { operation, project }; },
    enrollCreator: async () => {
      calls.push("enroll"); await Promise.resolve(); saved = true;
      await setSharedLedgerBinding(B, root);
      return "local-b";
    },
    credentialSaved: async () => { calls.push("readback"); return saved; },
    completionIdentity: () => ({ person: who, credentialSaved: () => { calls.push("readback"); return saved; } }),
    gateRead: async () => { calls.push("gate"); if (!gate) throw new Error(SECRET); return true; },
    members: async () => [], remove: async () => {}, setDirs: async () => {}, leave: async () => {},
    bindings: () => readSharedLedgerBindings(root), eligible: async () => [{ id: "local-b", name: "Project B" }],
    deploymentAuthorized: async () => false,
    preflight: async () => { throw new Error("unused"); }, confirmOwner: async () => { throw new Error("unused"); },
  };
  const card = () => openSharedProjectAction(d, { kind: "complete", who: person, operationId, selection: { mode: "create" },
    input: { operationId, name: "Project B", selection: { mode: "create" } } }, "继续完成项目", "合成卡");
  const approve = (a: Ask) => answerAsk(db, a.id, { principal: "owner:self", owner: true, via: "web_card", at: Date.now(),
    choices: ["[button:shared_project_confirm]"], labels: ["继续完成项目"], text: "", final: true });
  const request = async (method: string, path: string, body?: unknown) => {
    const url = new URL(`http://fixture/api/v1/shared-projects${path}`);
    const res = (await handleSharedProjectsApi(new Request(url.toString(), { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), url,
      { auth: async () => owner, ports: d }))!;
    return { status: res.status, text: await res.text() };
  };
  const read = async () => JSON.parse((await request("GET", `/operations/${operationId}/completion`)).text);
  return { d, calls, writeBindings, card, approve, request, read, setGate: (v: boolean) => { gate = v; }, setWho: (v: ProjectPerson) => { who = v; },
    dropCredential: () => { saved = false; } };
}
const changes = () => (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;

test("first HTTP continue records one receipt; repeated reads return it with zero writes and zero mutating port calls", async () => {
  const w = world();
  const a = w.approve(w.card());
  expect(await w.read()).toEqual({ ok: true, operationId, state: "unknown" });
  const first = await w.request("POST", `/operations/${operationId}/continue`, { askId: a.id });
  expect(JSON.parse(first.text)).toMatchObject({ ok: true, available: true, localProjectId: "local-b" });
  const receipt = getAsk(db, a.id)!.extra.sharedProjectCompletion as Record<string, unknown>;
  expect(receipt).toMatchObject({ v: 2, state: "completed", askId: a.id, operationId, centerId: "center-a", teamId: "team-a",
    personId: "alice", instanceId: "machine-a", projectId: "b", localProjectId: "local-b", paramsDigest: operation.paramsDigest });
  expect(Object.keys(receipt).sort()).toEqual(["askId", "bindingGeneration", "centerId", "completedAt", "instanceId", "localProjectId", "operationId",
    "paramsDigest", "paramsHash", "personId", "projectId", "state", "teamId", "v"]);
  w.calls.length = 0;
  const before = changes();
  for (let i = 0; i < 3; i++) {
    expect(await w.read()).toEqual({ ok: true, operationId, state: "completed", askId: a.id, projectId: "b", localProjectId: "local-b",
      paramsDigest: operation.paramsDigest, completedAt: receipt.completedAt });
  }
  expect(changes()).toBe(before);
  expect(w.calls).toEqual(["readback", "readback", "readback"]); // Local credential readback only: no create/query/enroll/gate.
  // A replayed continue cannot re-execute or overwrite the receipt.
  expect((await w.request("POST", `/operations/${operationId}/continue`, { askId: a.id })).status).toBe(409);
  expect(getAsk(db, a.id)!.extra.sharedProjectCompletion).toEqual(receipt);
});

test("original answered callback persists the result it used to discard, and a restarted connection reads it back", async () => {
  const w = world();
  configureSharedProjects(w.d);
  const a = w.approve(w.card());
  const told: string[] = [];
  await onSharedProjectAnswered(a, async t => { told.push(t); });
  expect(told.join()).toContain("项目可用");
  const restarted = new Database(join(root, "ledger.sqlite"), { readonly: true });
  try {
    const view = await readSharedProjectCompletion(operationId,
      { bindings: w.d.bindings, completionIdentity: w.d.completionIdentity, ...sharedProjectCompletionStore(restarted, root) });
    expect(view).toMatchObject({ state: "completed", askId: a.id, localProjectId: "local-b" });
  } finally { restarted.close(); }
});

test("claim alone is pending; gate failure opens a re-verify card without receipt, replay or secret leakage", async () => {
  const w = world();
  const a = w.approve(w.card());
  expect(sharedProjectAskPorts(db).claimAsk(a)).toBe(true);
  expect(await w.read()).toEqual({ ok: true, operationId, state: "pending" });

  const b = w.approve(w.card());
  w.setGate(false);
  const res = await w.request("POST", `/operations/${operationId}/continue`, { askId: b.id });
  expect(res.text).not.toContain(SECRET);
  const body = JSON.parse(res.text);
  expect(body.available).toBe(false);
  expect(getAsk(db, b.id)!.extra.sharedProjectCompletion).toBeUndefined();
  const view = await w.read();
  expect(view).toEqual({ ok: true, operationId, state: "pending", openAskId: body.askId });
  expect(JSON.stringify(view)).not.toContain(SECRET);
  expect(w.calls.filter(c => c === "create")).toEqual([]);

  // The owner-approved re-verify card completes the same operation with the existing binding, no second enrollment.
  w.setGate(true); w.calls.length = 0;
  const next = w.approve(getAsk(db, body.askId)!);
  expect((await answerSharedProject(next, w.d))!.available).toBe(true);
  expect(w.calls).not.toContain("enroll");
  expect(await w.read()).toMatchObject({ state: "completed", askId: next.id });
});

test("a receipt write failure is reported as pending, never as available", async () => {
  for (const fail of ["false", "throw", "taken"] as const) {
    const w = world();
    const a = w.approve(w.card());
    if (fail === "false") w.d.recordCompletion = () => false;
    if (fail === "throw") w.d.recordCompletion = () => { throw new Error(SECRET); };
    if (fail === "taken") patchAsk(db, a.id, { extra: { sharedProjectCompletion: { v: 1, state: "completed", askId: "forged" } } });
    const result = await answerSharedProject(a, w.d);
    expect(result!.available).toBe(false);
    expect(typeof result!.askId).toBe("string");
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect((await w.read()).state).toBe("pending");
    w.calls.length = 0;
    db.exec("DELETE FROM asks");
  }
});

test("two concurrent executions of one approval: one claim, one enrollment, one receipt", async () => {
  const w = world();
  const a = w.approve(w.card());
  const results = await Promise.allSettled([answerSharedProject(structuredClone(a), w.d), answerSharedProject(structuredClone(a), w.d)]);
  expect(results.filter(r => r.status === "fulfilled" && r.value?.available === true)).toHaveLength(1);
  expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  expect(w.calls.filter(c => c === "enroll")).toHaveLength(1);
  expect(await w.read()).toMatchObject({ state: "completed", askId: a.id });
  // The low-level CAS port also refuses a second receipt on the same claim.
  const receipt = getAsk(db, a.id)!.extra.sharedProjectCompletion as never;
  expect(sharedProjectAskPorts(db).recordCompletion(a, { ...(receipt as object), completedAt: 1 } as never)).toBe(false);
});

test("person, instance, binding and same-name drift never read as success", async () => {
  const w = world();
  const a = w.approve(w.card());
  await answerSharedProject(a, w.d);
  expect((await w.read()).state).toBe("completed");

  w.setWho({ ...person, instanceId: "machine-b" });
  expect(await w.read()).toEqual({ ok: true, operationId, state: "stale" });
  w.setWho({ ...person, personId: "bob" });
  expect(await w.read()).toEqual({ ok: true, operationId, state: "unknown" });
  w.setWho(person);

  // Every drift is stale; restoring the original row afterwards is a new binding generation and stays stale.
  for (const next of [[{ ...B, localProjectId: "local-other" }], [{ ...B, projectId: "b2" }], [], [B, { ...B, localProjectId: "local-c" }], [B]]) {
    w.writeBindings(next);
    expect((await w.read()).state).toBe("stale");
  }
  // A forged receipt on a different operation's card, or a tampered binding, is not trusted.
  const w2 = world();
  db.exec("DELETE FROM asks"); rmSync(join(root, "shared-ledger-bindings.json"));
  const fresh = w2.approve(w2.card());
  await answerSharedProject(fresh, w2.d);
  expect((await w2.read()).state).toBe("completed");
  const forged = getAsk(db, fresh.id)!;
  patchAsk(db, fresh.id, { extra: { sharedProjectCompletion: { ...(forged.extra.sharedProjectCompletion as object), askId: "ask_other" } } });
  expect((await w2.read()).state).toBe("pending");
  db.prepare("UPDATE asks SET bind = json_set(bind, '$.params.who.personId', 'mallory') WHERE id = ?").run(fresh.id);
  expect((await w2.read()).state).toBe("unknown");
});

test("completion read is GET-only, rejects query strings and is behind the owner gate", async () => {
  const w = world();
  expect((await w.request("POST", `/operations/${operationId}/completion`, {})).status).toBe(404);
  const url = new URL(`http://fixture/api/v1/shared-projects/operations/${operationId}/completion?askId=x`);
  expect((await handleSharedProjectsApi(new Request(url.toString()), url, { auth: async () => owner, ports: w.d }))!.status).toBe(400);
  const plain = new URL(`http://fixture/api/v1/shared-projects/operations/${operationId}/completion`);
  expect((await handleSharedProjectsApi(new Request(plain.toString()), plain, { auth: async () => ({ ...owner, manage: false }), ports: w.d }))!.status).toBe(403);
  expect(w.calls).toEqual([]);
});

test("direct create without an approval card keeps its synchronous result and records no receipt", async () => {
  const w = world();
  expect((await createSharedProject({ operationId, name: "Project B", selection: { mode: "create" } }, w.d)).available).toBe(true);
  expect(await w.read()).toEqual({ ok: true, operationId, state: "unknown" });
});

test("target credential gone after completion reads stale; the read never re-enrolls, gates or continues", async () => {
  const w = world();
  const a = w.approve(w.card());
  await answerSharedProject(a, w.d);
  expect((await w.read()).state).toBe("completed");
  w.dropCredential(); w.calls.length = 0;
  const before = changes();
  expect(await w.read()).toEqual({ ok: true, operationId, state: "stale" });
  expect(w.calls).toEqual(["readback"]);
  expect(changes()).toBe(before);
  // A throwing readback (identity drift in the adapter) is not success either.
  w.d.completionIdentity = () => ({ person, credentialSaved: () => { throw new Error(SECRET); } });
  const view = await w.read();
  expect(view.state).toBe("stale");
  expect(JSON.stringify(view)).not.toContain(SECRET);
});

test("removing the target binding and re-adding the identical row through the formal writer never revives the old receipt", async () => {
  const w = world();
  const a = w.approve(w.card());
  await answerSharedProject(a, w.d);
  expect((await w.read()).state).toBe("completed");
  w.writeBindings([]);
  expect((await w.read()).state).toBe("stale");
  await setSharedLedgerBinding(B, root);
  expect(readSharedLedgerBindings(root)).toEqual([B]);
  w.calls.length = 0;
  expect(await w.read()).toEqual({ ok: true, operationId, state: "stale" });
  expect(w.calls).toEqual([]);
  // A binding store the adapter does not read (wrong state dir) is unknown, and a receipt cannot be written against it.
  w.d.bindingGeneration = sharedProjectBindingGeneration(join(root, "elsewhere"));
  expect((await w.read()).state).toBe("unknown");
});

test("no consistent binding snapshot at completion stores no receipt and stays pending", async () => {
  const w = world();
  w.d.bindingGeneration = () => null;
  const result = await answerSharedProject(w.approve(w.card()), w.d);
  expect(result!.available).toBe(false);
  expect((await w.read()).state).toBe("pending");
});

test("completion GET takes identity only from the read-only port: never d.person(); absent or unresolvable identity is unknown", async () => {
  const w = world();
  await answerSharedProject(w.approve(w.card()), w.d);
  expect((await w.read()).state).toBe("completed");
  w.d.person = async () => { throw new Error(SECRET); }; // The action identity (which may create/cache identity files) is never consulted.
  expect((await w.read()).state).toBe("completed");
  for (const identity of [undefined, () => null, () => { throw new Error(SECRET); }]) {
    w.d.completionIdentity = identity as SharedProjectsPorts["completionIdentity"];
    const view = await w.read();
    expect(view).toEqual({ ok: true, operationId, state: "unknown" });
  }
});
