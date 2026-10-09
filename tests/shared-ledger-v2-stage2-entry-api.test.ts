import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "../src/lib/principals.js";
import { SharedLedgerExecClient, execOperationId } from "../src/lib/shared-ledger-exec-client.js";
import { SharedLedgerExecGate, type ExecIdentity } from "../src/lib/shared-ledger-exec-gate.js";
import { writeSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import { parseFeature, parseReceipt, v2ObjectDigest, V2_COMMAND_NAMES, type V2Command, type V2Receipt } from "../src/lib/shared-ledger-contract-v2.js";
import { V2_COMMAND_FIXTURES, V2_DTO_FIXTURES, V2_FIXTURE_FENCE } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { handleSharedExecApi } from "../src/bridge/local-api/shared-exec.js";
import { configureSharedExecEntry, sharedExecEntryFailure, type EntryReceiptQuery, type EntrySwitch, type SharedExecEntryPort } from "../src/bridge/shared-ledger-v2-entry.js";

const principal: Principal = { id: "guest:member", role: "external", agents: [], createdAt: "synthetic" };
const dirs: string[] = [];
afterEach(() => { configureSharedExecEntry(null); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const command = () => structuredClone(V2_COMMAND_FIXTURES.find(f => f.type === "task.set")!.valid);
function receipt(c: V2Command): V2Receipt {
  return parseReceipt({ ...V2_DTO_FIXTURES.receipt.valid as object, requestId: c.requestId, command: c.type, commandDigest: v2ObjectDigest(c),
    result: { entityId: "task", rev: 2, specRev: 1, version: null, epoch: c.epoch, operationId: execOperationId(c) } });
}
async function harness() {
  const dir = mkdtempSync(join(tmpdir(), "s2e-api-")); dirs.push(dir);
  await writeSharedLedgerMode("feature", { authorityMode: "execution", sharedPlanning: true }, dir);
  const feature = parseFeature({ ...V2_DTO_FIXTURES.feature.valid as object, authorityMode: "execution" });
  const identity: ExecIdentity = { centerId: "center", teamId: "team", projectId: "project", projectRole: "member",
    registeredPersonId: "member-person", registeredInstanceId: "local",
    actor: { kind: "person", personId: "member-person", instanceId: "local", serviceId: null, representedPersonId: null,
      orderId: null, projects: ["project"], actions: [...V2_COMMAND_NAMES] } };
  const state = { mode: "on" as EntrySwitch, writes: 0, clientReads: 0, snapshots: 0, clientFor: 0, migrating: false, offline: false };
  const actors: unknown[] = [], principals: Principal[] = [], queries: EntryReceiptQuery[] = [];
  const client = new SharedLedgerExecClient(new SharedLedgerExecGate({ modeDirectory: dir, identity: () => identity,
    context: () => ({ feature, fence: V2_FIXTURE_FENCE, orderId: null }) }), {
    receipt: async () => { state.clientReads++; return null; },
    submit: async (c, actor) => {
      state.writes++; actors.push(actor);
      return parseReceipt({ ...receipt(c), personId: actor.personId, instanceId: actor.instanceId });
    },
    ask: async () => structuredClone(V2_DTO_FIXTURES.ask.valid),
  });
  let lookup: unknown = { teamId: "team", projectId: "project", requestId: "request", status: "unknown", receipt: null };
  const port: SharedExecEntryPort = {
    mode: () => state.mode,
    clientFor: (p, project) => {
      state.clientFor++; principals.push(p); expect(project).toBe("local-project");
      return p.id === principal.id ? client : null;
    },
    snapshot: async (p, project, fid) => {
      state.snapshots++; expect(p).toBe(principal); expect(project).toBe("local-project"); expect(fid).toBe("feature");
      if (state.offline) throw Error("secret transport text");
      return { feature: { id: fid }, capabilities: { "task.set": { enabled: true } } };
    },
    receipt: async (p, q) => { expect(p).toBe(principal); queries.push(q); return lookup; },
    scopeFor: (p, project) => {
      expect(p).toBe(principal); expect(project).toBe("local-project");
      return { teamId: "team", projectId: "project" };
    },
    commandRoute: () => state.migrating ? { route: "skip", reason: "migrating" } : "central",
    holdReason: () => state.migrating ? "migrating" : null,
  };
  configureSharedExecEntry(port);
  return { state, actors, principals, queries, port, identity, setLookup: (value: unknown) => { lookup = value; } };
}
async function api(path: string, method = "GET", body?: unknown, p = principal) {
  const url = new URL("http://synthetic.invalid/api/v1/shared-exec/" + path);
  const req = new Request(url.href, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return (await handleSharedExecApi(req, url.pathname.slice("/api/v1".length), p, url))!;
}
test("commands reject actor/role at top level and payload before selecting a client", async () => {
  const h = await harness(), c = command();
  for (const field of ["actor", "role"]) {
    expect((await api("commands?project=local-project", "POST", { ...c, [field]: "owner" })).status).toBe(400);
    expect((await api("commands?project=local-project", "POST", { ...c, payload: { ...c.payload, [field]: "owner" } })).status).toBe(400);
  }
  expect(h.state.clientFor).toBe(0); expect(h.state.writes).toBe(0); expect(h.state.clientReads).toBe(0);
});
test("authenticated Principal selects client identity; transport actor is mapped member, never owner", async () => {
  const h = await harness(), c = command(), r = await api("commands?project=local-project", "POST", c);
  expect(r.status).toBe(200); expect(await r.json()).toEqual({ ...receipt(c), personId: "member-person" });
  expect(h.principals).toEqual([principal]); expect(h.actors).toEqual([h.identity.actor]);
  expect(h.state.writes).toBe(1);
  const denied = await api("commands?project=local-project", "POST", c, { ...principal, id: "guest:other" });
  expect(denied.status).toBe(503); expect(h.state.writes).toBe(1);
});
test("receipts pass all five mapped query fields and committed/unknown bodies verbatim; zero writes", async () => {
  const h = await harness(), c = command();
  const query = "receipts/" + c.requestId + "?project=local-project&operationId=operation&commandDigest=" + v2ObjectDigest(c);
  for (const value of [
    { teamId: "team", projectId: "project", requestId: c.requestId, status: "unknown", receipt: null },
    { teamId: "team", projectId: "project", requestId: c.requestId, status: "committed", receipt: receipt(c) },
  ]) {
    h.setLookup(value);
    expect(await (await api(query)).json()).toEqual(value);
  }
  expect(h.queries).toEqual(Array(2).fill({ teamId: "team", projectId: "project", requestId: c.requestId,
    operationId: "operation", commandDigest: v2ObjectDigest(c) }));
  expect(h.state.writes).toBe(0); expect(h.state.clientReads).toBe(0); expect(h.state.clientFor).toBe(0);
});
test("null port and off return unavailable with zero center reads/writes; observe permits reads only", async () => {
  const h = await harness();
  configureSharedExecEntry(null);
  expect((await api("features/feature?project=local-project")).status).toBe(503);
  expect((await api("commands?project=local-project", "POST", command())).status).toBe(503);
  configureSharedExecEntry(h.port); h.state.mode = "off";
  expect((await api("features/feature?project=local-project")).status).toBe(503);
  expect((await api("commands?project=local-project", "POST", command())).status).toBe(503);
  expect(h.state.snapshots + h.state.clientReads + h.state.writes).toBe(0);
  h.state.mode = "observe";
  const blocked = await api("commands?project=local-project", "POST", command());
  expect(blocked.status).toBe(403); expect(await blocked.json()).toMatchObject({ code: "execution_not_shared" });
  expect((await api("features/feature?project=local-project")).status).toBe(200);
  expect((await api("asks/ask?project=local-project")).status).toBe(200);
  expect(h.state.writes).toBe(0);
});
test("migrating is 409 before off/on; missing route/scope mapping is held without center calls", async () => {
  const h = await harness(); h.state.migrating = true;
  for (const mode of ["off", "observe", "on"] as const) {
    h.state.mode = mode;
    const r = await api("commands?project=local-project", "POST", command());
    expect(r.status).toBe(409); expect(await r.json()).toMatchObject({ code: "migrating" });
  }
  h.state.mode = "on"; h.state.migrating = false;
  configureSharedExecEntry({ ...h.port, commandRoute: undefined, scopeFor: undefined });
  expect(await (await api("commands?project=local-project", "POST", command())).json()).toMatchObject({ code: "v2_unmapped" });
  const query = "receipts/request?project=local-project&commandDigest=" + "a".repeat(64);
  expect(await (await api(query)).json()).toMatchObject({ code: "v2_unmapped" });
  expect(h.state.writes + h.state.clientReads + h.state.clientFor).toBe(0);
});
test("invalid query/body/peer is rejected and errors never expose transport text", async () => {
  const h = await harness();
  expect((await api("features/feature")).status).toBe(400);
  expect((await api("features/bad%2Fid?project=local-project")).status).toBe(400);
  expect((await api("receipts/request?project=local-project&commandDigest=bad")).status).toBe(400);
  expect((await api("commands?project=local-project", "POST", command(), { ...principal, peer: "peer" })).status).toBe(403);
  expect((await api("commands?project=local-project", "POST", command(), { ...principal, disabled: true })).status).toBe(403);
  h.state.offline = true;
  expect(await (await api("features/feature?project=local-project")).json()).toEqual({ ok: false, code: "unavailable" });
  expect(h.state.writes).toBe(0);
});
test("exact new family leaves existing shared-ledger and unrelated routes untouched", async () => {
  for (const path of ["/shared-ledger/features/feature", "/shared-execx/commands", "/shared-exec/features/a/more", "/ledger"]) {
    const url = new URL("http://synthetic.invalid/api/v1" + path);
    expect(await handleSharedExecApi(new Request(url.href), path, principal, url)).toBeNull();
  }
});
test("R1 scope-null distinguishes denied project binding from missing optional wiring", async () => {
  const h = await harness();
  configureSharedExecEntry({ ...h.port, scopeFor: () => null });
  const r = await api("receipts/request?project=local-project&commandDigest=" + "a".repeat(64));
  expect(r.status).toBe(403); expect(await r.json()).toMatchObject({ code: "forbidden" });
  expect(h.state.writes + h.state.clientReads + h.state.clientFor).toBe(0);
});
test("R1 safe logging retains error class and system code without message, paths or tokens", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const fault = Object.assign(new Error("sensitive message /synthetic/path bearer-value"), { code: "ECONNRESET" });
    expect(sharedExecEntryFailure(fault)).toEqual({ status: 503, code: "unavailable" });
    expect(warn.mock.calls).toMatchObject([["shared execution entry failed", { errorType: "Error", code: "ECONNRESET" }]]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(fault.message);
    sharedExecEntryFailure({ code: "bearer-value" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("bearer-value");
  } finally { warn.mockRestore(); }
});
