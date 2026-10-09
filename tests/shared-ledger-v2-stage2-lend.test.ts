import { afterEach, expect, mock, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerLendTool } from "../src/bridge/lend-tools.js";
import { sharedLendApi, type LendCentralApiDeps } from "../src/bridge/shared-ledger-v2-lend-api.js";
import {
  configureLendCentral, configureLendCentralRouting, recoverLendCentral, type LendCentralRoutingPort,
} from "../src/bridge/shared-ledger-v2-lend.js";
import { sharedLendTool } from "../src/bridge/shared-ledger-v2-lend-tools.js";
import type { LendCentralJournalEntry } from "../src/bridge/shared-ledger-v2-lend-journal.js";
import type { CallerIdentity } from "../src/lib/caller-identity.js";
import { advance, LEND_JOURNAL_PATH, openLendJournal, recordAsked } from "../src/lib/lend-journal.js";
import type { LendCentralView } from "../src/lib/ledger-lend-central-checks.js";
import type { LendCentralTransport } from "../src/lib/ledger-lend-central.js";
import type { LendOrder } from "../src/lib/ledger-lend.js";
import * as ledgerWrites from "../src/lib/ledger-write.js";
import { STATE_DIR } from "../src/lib/paths.js";
import type { LendEntry, LendRead } from "../src/lib/lend-config.js";
import {
  parseActor, parseLendOrder, parseLendLease, parseTask, parseReceipt, v2ObjectDigest, V2ContractError, type V2Command, type V2Receipt,
} from "../src/lib/shared-ledger-contract-v2.js";
import { V2_DTO_FIXTURES as fixtures } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { isolatedStateSuite } from "./isolated-state.js";

const { test } = isolatedStateSuite(import.meta.path);
const directories: string[] = [], databases: ReturnType<typeof openLendJournal>[] = [];
afterEach(() => {
  mock.restore();
  configureLendCentral(null); configureLendCentralRouting(null);
  const openedJournal = databases.length > 0;
  for (const db of databases.splice(0)) db.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (openedJournal) for (const suffix of ["", "-wal", "-shm"]) rmSync(LEND_JOURNAL_PATH + suffix, { force: true });
});

function fixture(write = true) {
  const directory = mkdtempSync(join(tmpdir(), "s2-lend-")); directories.push(directory);
  const worker = { kind: "peer_agent" as const, instanceId: "peer-a", agentId: "agent-lend-test" };
  const order = parseLendOrder({ ...parseLendOrder(fixtures.lendOrder.valid), worker,
    ...(write ? { step: "write", branch: "lend/task-abcd", base: "main" } : {}) });
  const lease = parseLendLease({ ...parseLendLease(fixtures.lendLease.valid), worker });
  const task = parseTask({ ...parseTask(fixtures.task.valid), stage: write ? "build" : "review", head: order.head });
  const entry: LendCentralJournalEntry = { localProjectId: "local-project", localTaskId: "local-task", binding: {
    order, worker, executorInstanceId: "peer-a", peer: "peer-a", fp: "a".repeat(64), homeInstanceId: "local",
    actor: parseActor({ kind: "service", personId: "person", instanceId: "local", serviceId: "lend", representedPersonId: "owner",
      orderId: order.orderId, projects: ["project"], actions: ["lend.claim", "lend.renew", "lend.result"] }),
  } };
  const grantEntry: LendEntry = { peer: "peer-a", fp: entry.binding.fp, families: { codex: 2 }, roles: ["review", "write"],
    repos: [order.repository], ordersPerDay: 10, grantedAt: new Date(1000).toISOString(), until: new Date(100000).toISOString() };
  const read: LendRead = { status: "ok", file: { version: 2, enabled: true, lend: [grantEntry], borrow: [] } };
  const commands: V2Command[] = [], reads: string[] = [], receipts = new Map<string, V2Receipt>();
  const view: LendCentralView = { order: structuredClone(order), lease, task, now: 2000 };
  let lose = false;
  const transport: LendCentralTransport = {
    receipt: async id => { reads.push("receipt"); return receipts.get(id) ?? null; },
    view: async () => { reads.push("view"); return structuredClone(view); },
    command: async c => {
      commands.push(structuredClone(c));
      if (lose) throw new V2ContractError("unavailable");
      const receipt = parseReceipt({ ...parseReceipt(fixtures.receipt.valid), requestId: c.requestId, command: c.type,
        commandDigest: v2ObjectDigest(c), result: { entityId: order.orderId, rev: 1, specRev: order.specRev,
          version: null, epoch: c.epoch, operationId: c.type === "lend.result" ? c.payload.result.operationId : null } });
      receipts.set(c.requestId, receipt);
      if (c.type === "lend.claim") view.order = { ...view.order, status: "claimed", worker, executorInstanceId: "peer-a" };
      return receipt;
    },
  };
  let route: "local" | "skip" | "central" = "central", mode: "off" | "observe" | "on" = "on", fresh = true;
  const decisions: unknown[] = [], shared = { summary: "home approved summary", artifactIds: ["artifact"] };
  const routing: LendCentralRoutingPort = { route: () => route, bindingFor: id => id === order.orderId && fresh ? entry : null,
    sharedResult: () => shared, observe: d => decisions.push(d) };
  const port = { mode: () => mode, transportFor: () => transport, outboxDir: directory, grant: {
    now: () => 2000, readLend: async () => read, context: async () => ({ contacts: [{ name: "peer-a", fp: entry.binding.fp }], projects: [] }),
  } };
  const configure = () => { configureLendCentral(port); configureLendCentralRouting(routing); };
  configure();
  const db = openLendJournal(LEND_JOURNAL_PATH); databases.push(db);
  recordAsked(db, { orderId: "order", peer: "peer-a", fp: entry.binding.fp, family: "codex", preview: {} });
  advance(db, "order", "asked", "claimed", { leaseGen: 1,
    wire: { order: { orderId: "order", taskId: "local-task", head: order.head, step: order.step }, text: "trusted order" } });
  advance(db, "order", "claimed", "cloned", { dir: directory });
  advance(db, "order", "cloned", "started", { agent: worker.agentId, sessionId: "worker-session" });
  const identity: CallerIdentity = { agent: worker.agentId, sessionId: "worker-session", family: "codex", verified: true };
  const deliver = { v: 1, orderId: "order", head: "c".repeat(40), evidence: "evidence.md", summary: "worker raw summary", selfCheck: "local checks" };
  const wire = { v: 1, orderId: "order", gen: 1, deliver, branch: order.branch, pr: order.pr, session: { id: "worker-session", family: "codex" } };
  const apiDeps: LendCentralApiDeps = { order: () => ({ taskId: "local-task", wire: { orderId: "order", taskId: "local-task" }, text: "trusted order",
    sha256: "a".repeat(64), branch: order.branch, base: order.base } as unknown as LendOrder), sign: () => ({ key: "test-key", sig: "test-sig" }) };
  return { directory, db, identity, entry, view, transport, commands, reads, receipts, shared, routing, port, configure, deliver, wire, apiDeps, decisions,
    lose: (v: boolean) => { lose = v; }, setRoute: (v: typeof route) => { route = v; }, setMode: (v: typeof mode) => { mode = v; },
    noFreshBinding: () => { fresh = false; } };
}
const beat = (ended = false) => ({ v: 1, orders: [{ orderId: "order", gen: 1, phase: "working", lastActivityAt: 2000, excerpt: "",
  ...(ended ? { ended: { reason: "revoked", clean: true } } : {}) }] });

test("real worker deliver sends one lend.result; retry reconciles; changing orderId is forbidden", async () => {
  const f = fixture(), before = f.db.query("SELECT * FROM lend_orders").all(), localDeliver = spyOn(ledgerWrites, "deliver");
  expect(await answerLendTool("deliver", f.identity, f.deliver)).toMatchObject({ ok: true, status: "confirmed" });
  expect(await answerLendTool("deliver", f.identity, f.deliver)).toMatchObject({ ok: true, status: "confirmed" });
  expect(await answerLendTool("deliver", f.identity, { ...f.deliver, orderId: "other" })).toMatchObject({ ok: false, code: "forbidden" });
  expect(f.commands.map(c => c.type)).toEqual(["lend.result"]);
  const c = f.commands[0]!;
  if (c.type !== "lend.result") throw Error("wrong command");
  expect(c.payload.result).toMatchObject({ head: f.deliver.head, expectedHead: f.entry.binding.order.head, summary: f.shared.summary,
    artifactIds: f.shared.artifactIds, worker: f.entry.binding.worker });
  expect(JSON.stringify(c)).not.toContain("worker raw summary");
  expect(f.db.query("SELECT * FROM lend_orders").all()).toEqual(before);
  expect(localDeliver).toHaveBeenCalledTimes(0);
});
test("forged central metadata is ignored; shared result and binding come from the home", async () => {
  const f = fixture();
  const forged = { ...f.deliver, binding: { order: { orderId: "other", epoch: 99 } }, sharedResult: { summary: "forged", artifactIds: ["forged"] },
    result: { summary: "forged" }, artifactIds: ["forged"] };
  expect(await answerLendTool("deliver", f.identity, forged)).toMatchObject({ status: "confirmed" });
  expect(JSON.stringify(f.commands)).not.toContain("forged");
  expect(JSON.stringify(f.commands)).toContain("home approved summary");
});
test("unavailable command enters outbox; restart only reconciles; explicit recover keeps requestId", async () => {
  const f = fixture(); f.lose(true);
  expect(await answerLendTool("deliver", f.identity, f.deliver)).toMatchObject({ ok: false, code: "unavailable", status: "outbox" });
  const first = structuredClone(f.commands[0]);
  f.lose(false); configureLendCentral(null); configureLendCentralRouting(null); f.configure();
  expect(await answerLendTool("deliver", f.identity, f.deliver)).toMatchObject({ ok: false, code: "unavailable", status: "ready" });
  expect((await recoverLendCentral("order", "result")).status).toBe("ready");
  expect(f.commands).toHaveLength(1);
  expect((await recoverLendCentral("order", "result", true)).status).toBe("confirmed");
  expect(f.commands[1]).toEqual(first);
});
test("recovery retains original fence even when fresh binding disappears or advances", async () => {
  const f = fixture(); f.lose(true); await answerLendTool("deliver", f.identity, f.deliver);
  f.lose(false); f.entry.binding.order.epoch++; f.entry.binding.order.leaseGen++;
  expect((await recoverLendCentral("order", "result")).status).toBe("ready");
  f.noFreshBinding();
  expect((await recoverLendCentral("order", "result", true)).status).toBe("confirmed");
  expect(f.commands[1]).toEqual(f.commands[0]);
});
test("stale current lease blocks explicit resubmission without repinning", async () => {
  const f = fixture(); f.lose(true); await answerLendTool("deliver", f.identity, f.deliver);
  f.lose(false); f.view.order.epoch++;
  await expect(recoverLendCentral("order", "result", true)).rejects.toThrow("stale_epoch");
  expect(f.commands).toHaveLength(1);
});
test("switch revocation during an online read prevents the pending result command", async () => {
  const f = fixture(), readView = f.transport.view;
  f.transport.view = async id => { const view = await readView(id); f.setMode("observe"); return view; };
  expect(await answerLendTool("deliver", f.identity, f.deliver)).toMatchObject({ status: "outbox" });
  expect(f.commands).toEqual([]);
});
test("beat only renews its own order; ended observations report unknown_operation", async () => {
  const f = fixture();
  const ok = await sharedLendApi("beat", JSON.stringify(beat()), "peer-a", f.apiDeps);
  expect(ok?.status).toBe(200);
  expect(await (await sharedLendApi("beat", JSON.stringify(beat(true)), "peer-a", f.apiDeps))?.json()).toMatchObject({ code: "unknown_operation" });
  expect(await (await sharedLendApi("beat", JSON.stringify({ v: 1, orders: [...beat().orders, { ...beat().orders[0], orderId: "other" }] }),
    "peer-a", f.apiDeps))?.json()).toMatchObject({ code: "forbidden" });
  expect(f.commands.map(c => c.type)).toEqual(["lend.renew"]);
});
test("API result bypasses local deliver, preserves legacy signed receipt, checks peer", async () => {
  const f = fixture(), localDeliver = spyOn(ledgerWrites, "deliver");
  const signedFields: string[][] = [];
  f.apiDeps.sign = fields => { signedFields.push(fields); return { key: "test-key", sig: "test-sig" }; };
  const response = await sharedLendApi("result", JSON.stringify(f.wire), "peer-a", f.apiDeps);
  expect(response?.status).toBe(200);
  const { receipt } = await response!.json() as { receipt: { orderId: string; taskId: string; sha256: string; eventSeq: number } };
  expect(receipt).toMatchObject({ orderId: "order", taskId: f.apiDeps.order("order")!.wire.taskId, key: "test-key" });
  expect(signedFields).toEqual([[receipt.orderId, receipt.sha256, String(receipt.eventSeq), receipt.taskId]]);
  expect(f.commands[0]?.type === "lend.result" && f.commands[0].payload.result.taskId).toBe("task");
  expect(localDeliver).toHaveBeenCalledTimes(0);
  expect(await (await sharedLendApi("result", JSON.stringify(f.wire), "other-peer", f.apiDeps))?.json()).toMatchObject({ code: "forbidden" });
  expect(f.commands).toHaveLength(1);
});
test("another peer cannot observe or pin a fresh or persisted binding", async () => {
  const f = fixture(), route = spyOn(f.routing, "route");
  const call = () => sharedLendApi("result", JSON.stringify(f.wire), "other-peer", f.apiDeps);
  expect(await (await call())?.json()).toMatchObject({ code: "forbidden" });
  expect(existsSync(join(f.directory, "bindings"))).toBe(false);
  expect(route).toHaveBeenCalledTimes(0);
  expect(f.decisions).toEqual([]); expect(f.reads).toEqual([]); expect(f.commands).toEqual([]);
  await sharedLendApi("result", JSON.stringify(f.wire), "peer-a", f.apiDeps);
  f.noFreshBinding(); f.decisions.length = 0; f.reads.length = 0; route.mockClear();
  expect(await (await call())?.json()).toMatchObject({ code: "forbidden" });
  expect(route).toHaveBeenCalledTimes(0);
  expect(f.decisions).toEqual([]); expect(f.reads).toEqual([]); expect(f.commands).toHaveLength(1);
});
test("binding taskId differing from the local order is forbidden before any center request", async () => {
  const f = fixture(), warn = spyOn(console, "warn").mockImplementation(() => {});
  const local = f.apiDeps.order("order")!;
  f.apiDeps.order = () => ({ ...local, taskId: "another-task" } as LendOrder);
  const raw = { v: 1, orderId: "order", worker: f.identity.agent, secret: "raw-marker" };
  for (const [endpoint, body] of [["result", f.wire], ["claim", raw], ["beat", beat()]] as const)
    expect(await (await sharedLendApi(endpoint, JSON.stringify(body), "peer-a", f.apiDeps))?.json()).toMatchObject({ code: "forbidden" });
  expect(f.reads).toEqual([]); expect(f.commands).toEqual([]);
  expect(warn.mock.calls.flat().join("\n")).not.toContain("raw-marker");
  expect(warn.mock.calls.flat().join("\n")).not.toContain("another-task");
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});
test("confirmed claim with a recycled lease returns stale_order and never reclaims", async () => {
  const f = fixture(); f.entry.binding.order.status = "pooled"; f.entry.binding.order.worker = null; f.entry.binding.order.executorInstanceId = null;
  f.view.order = structuredClone(f.entry.binding.order);
  const command = f.transport.command;
  f.transport.command = async c => { const receipt = await command(c); f.view.lease = null; return receipt; };
  const call = () => sharedLendApi("claim", JSON.stringify({ v: 1, orderId: "order", worker: f.identity.agent }), "peer-a", f.apiDeps);
  expect(await (await call())?.json()).toMatchObject({ ok: false, code: "stale_order" });
  expect(await (await call())?.json()).toMatchObject({ ok: false, code: "stale_order" });
  expect(f.commands.map(c => c.type)).toEqual(["lend.claim"]);
});
test("confirmed renewal with a recycled lease returns an explicit stale_order", async () => {
  const f = fixture(), command = f.transport.command;
  f.transport.command = async c => { const receipt = await command(c); f.view.lease = null; return receipt; };
  expect(await (await sharedLendApi("beat", JSON.stringify(beat()), "peer-a", f.apiDeps))?.json())
    .toMatchObject({ ok: false, code: "stale_order" });
  expect(f.commands.map(c => c.type)).toEqual(["lend.renew"]);
});
test("claim and legacy lease renew use center; release never invokes local effects", async () => {
  const f = fixture(); f.entry.binding.order.status = "pooled"; f.entry.binding.order.worker = null; f.entry.binding.order.executorInstanceId = null;
  f.view.order = structuredClone(f.entry.binding.order);
  expect((await sharedLendApi("claim", JSON.stringify({ v: 1, orderId: "order", worker: f.identity.agent }), "peer-a", f.apiDeps))?.status).toBe(200);
  const renewal = { v: 1, orderId: "order", gen: 1, action: "renew", reason: null, detail: null };
  expect((await sharedLendApi("lease", JSON.stringify(renewal), "peer-a", f.apiDeps))?.status).toBe(200);
  expect(await (await sharedLendApi("lease", JSON.stringify({ ...renewal, action: "release", reason: "stopped" }), "peer-a", f.apiDeps))?.json())
    .toMatchObject({ code: "unknown_operation" });
  expect(f.commands.map(c => c.type)).toEqual(["lend.claim", "lend.renew"]);
});
test("unverified, wrong session, wrong family and another worker cannot deliver", async () => {
  const f = fixture();
  for (const over of [{ verified: false }, { sessionId: "other" }, { family: "claude-code" }]) {
    expect(await answerLendTool("deliver", { ...f.identity, ...over }, f.deliver)).toMatchObject({ ok: false });
  }
  expect(await answerLendTool("deliver", { ...f.identity, agent: "agent-lend-other" }, f.deliver)).toMatchObject({ ok: false });
  expect(f.commands).toHaveLength(0);
});
test("review reads local report and sends only the approved shared content", async () => {
  const f = fixture(false); writeFileSync(join(f.directory, "report.md"), "private local report");
  const verdict = { v: 1, orderId: "order", head: f.entry.binding.order.head, verdict: "pass", p0: 0, p1: 0, p2: 0, findings: [], reportPath: "report.md" };
  expect(await answerLendTool("submit_verdict", f.identity, verdict)).toMatchObject({ status: "confirmed" });
  expect(JSON.stringify(f.commands)).not.toContain("private local report");
});
test("coexistence: non-execution is identical in off, observe and on; center receives zero reads/writes", async () => {
  const f = fixture(); f.setRoute("local");
  const snapshots: unknown[] = [], localDeliver = spyOn(ledgerWrites, "deliver");
  const registry = join(STATE_DIR, "registry.json"), worktree = join(f.directory, "worktree.txt");
  writeFileSync(registry, JSON.stringify({ agents: {} })); writeFileSync(worktree, "original worktree");
  for (const mode of ["off", "observe", "on"] as const) {
    f.setMode(mode);
    const before = f.db.query("SELECT * FROM lend_orders").all();
    expect(await sharedLendTool("deliver", f.identity, f.deliver, f.db)).toBeNull();
    const response = await answerLendTool("deliver", f.identity, f.deliver);
    snapshots.push({ response, registry: readFileSync(registry, "utf8"), worktree: readFileSync(worktree, "utf8") });
    expect(response).toMatchObject({ code: "write_closed" });
    expect(f.db.query("SELECT * FROM lend_orders").all()).toEqual(before);
  }
  expect(snapshots[0]).toEqual(snapshots[1]); expect(snapshots[0]).toEqual(snapshots[2]);
  expect(localDeliver).toHaveBeenCalledTimes(0); expect(f.reads).toEqual([]); expect(f.commands).toEqual([]);
  expect(f.decisions).toHaveLength(6);
});
test("coexistence: execution off/observe holds with unchanged journal and zero center calls", async () => {
  const f = fixture(); f.setRoute("skip");
  const states: unknown[] = [];
  for (const mode of ["off", "observe"] as const) {
    f.setMode(mode);
    expect(await answerLendTool("deliver", f.identity, f.deliver)).toMatchObject({ code: "unavailable" });
    states.push(f.db.query("SELECT * FROM lend_orders").all());
  }
  expect(states[0]).toEqual(states[1]); expect(f.reads).toEqual([]); expect(f.commands).toEqual([]);
  expect(f.decisions).toHaveLength(2);
});
test("coexistence: null center and missing transport on execution never fall through", async () => {
  const f = fixture();
  configureLendCentral(null);
  expect(await answerLendTool("deliver", f.identity, f.deliver)).toMatchObject({ code: "unavailable" });
  configureLendCentral({ ...f.port, transportFor: () => null });
  expect(await answerLendTool("deliver", f.identity, f.deliver)).toMatchObject({ code: "unavailable" });
  expect(f.reads).toEqual([]); expect(f.commands).toEqual([]);
});
test("coexistence: migrating planning/execution tasks hold; null routing is exact legacy passthrough", async () => {
  const f = fixture();
  for (const authorityMode of ["planning", "execution"] as const) {
    const mode = { authorityMode, migrating: { batchId: "batch", kind: "execute" } };
    f.routing.route = () => mode.migrating ? "skip" : "central";
    f.routing.skipReason = () => "migrating";
    expect(await answerLendTool("deliver", f.identity, f.deliver)).toMatchObject({ code: "migrating" });
    expect((await sharedLendApi("result", JSON.stringify(f.wire), "peer-a", f.apiDeps))?.status).toBe(409);
  }
  configureLendCentralRouting(null);
  expect(await answerLendTool("deliver", f.identity, f.deliver)).toMatchObject({ code: "write_closed" });
  expect(await sharedLendApi("result", JSON.stringify(f.wire), "peer-a", f.apiDeps)).toBeNull();
  expect(f.reads).toEqual([]); expect(f.commands).toEqual([]);
});
