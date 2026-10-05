/**
 * LIFE1 registration side: `manager create --card` flags and gate (an executor without a card is refused, user agents are not,
 * names decide nothing; only the session the create started is registered, a failed registration keeps the agent for PM), the ledger
 * write the scheduler uses (`scheduler-worker-retire`, scheduler identity only for stock rows), and the swap parsers behind the
 * memory backstop.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeWorkers, recordRegisterFailure, registerWorker } from "../src/lib/agent-lifecycle-store.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { parseMeminfo, parseSwapUsage } from "../src/lib/sys-memory.js";
import { cardGate, extractCardFlags, registerCreated, type RegisterDeps } from "../src/manager/create-lifecycle.js";
import { parseCreateArgs } from "../src/manager/create-args.js";
import { runLedger } from "../src/manager/ledger.js";
import type { LedgerDeps } from "../src/manager/ledger-context.js";
import type { Registry } from "../src/manager/core.js";

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function ledger() {
  const dir = mkdtempSync(join(tmpdir(), "life1c-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  cleanup.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
  db.query("INSERT INTO meta (project, key, value) VALUES ('p', 'pms', '[\"agent-pm\"]')").run();
  createTask(db, { actor: "owner", now: 10 }, { project: "p", id: "T1", title: "T1", kind: "code" });
  const registryPath = join(dir, "registry.json");
  writeFileSync(registryPath, JSON.stringify({ socket: "", agents: { "agent-pm": { channelId: "1", projectId: "p" } } }));
  const deps = (actor: string): LedgerDeps => ({ db, actor, registryPath, projectIds: ["p"], now: () => 5000,
    loadRegistry: async () => ({ socket: "", agents: { "agent-pm": { channelId: "1", projectId: "p" } } }) as unknown as Registry, saveRegistry: async () => {} });
  return { db, path, deps };
}

describe("create flags and gate", () => {
  test("--card / --card-role parsed, default role other, bad role and orphan --card-role refused", () => {
    expect(extractCardFlags(["x", "--card", "T1", "--card-role=reviewer"])).toEqual({ rest: ["x"], card: { taskId: "T1", role: "reviewer" } });
    expect(extractCardFlags(["--card=T1"]).card).toEqual({ taskId: "T1", role: "other" });
    expect(extractCardFlags(["--card", "T1", "--card-role", "boss"]).error).toContain("--card-role");
    expect(extractCardFlags(["--card-role", "author"]).error).toContain("--card");
    const c = parseCreateArgs(["agent-x-once", "/repo", "--task", "T1 审查", "--card", "T1", "--card-role", "reviewer"]);
    expect("error" in c ? c.error : c.card).toEqual({ taskId: "T1", role: "reviewer" });
  });

  test("executor without --card refused; user agents pass whatever their name; unknown card refused", () => {
    const { path } = ledger();
    expect(cardGate("agent-x", undefined, "executor", path)).toContain("--card");
    expect(cardGate("agent-task-looks-like-worker-once", undefined, undefined, path)).toBeNull();
    expect(cardGate("agent-x", { taskId: "T1", role: "author" }, undefined, path)).toBeNull();
    expect(cardGate("agent-x", { taskId: "NOPE", role: "author" }, undefined, path)).toContain("NOPE");
  });

  test("registration writes the row and one event; re-creating the name replaces it", () => {
    const { db } = ledger();
    registerWorker(db, { agent: "agent-a", sessionId: "s1", taskId: "T1", role: "author", createdBy: "agent-pm", now: 100 });
    registerWorker(db, { agent: "agent-a", sessionId: "s2", taskId: "T1", role: "author", createdBy: "agent-pm", now: 200 });
    expect(activeWorkers(db).map((w) => [w.agent, w.sessionId, w.createdBy])).toEqual([["agent-a", "s2", "agent-pm"]]);
    expect(listEvents(db, { project: "p" }).filter((e) => (e.data as { op?: string }).op === "worker_register")).toHaveLength(2);
  });
});

describe("registerCreated: only the session this create started; a failed registration keeps the agent for PM", () => {
  function fake(db: ReturnType<typeof ledger>["db"], path: string, agents: Record<string, Record<string, unknown>>) {
    const reg = { socket: "", agents } as unknown as Registry;
    const saved: string[] = [];
    const deps: RegisterDeps = { ledgerPath: path, loadRegistry: async () => reg, createdBy: async () => "agent-pm",
      saveRegistry: async (r) => { saved.push(JSON.stringify(r.agents)); }, recordFailure: (f) => recordRegisterFailure(db, f) };
    return { reg, deps, saved };
  }
  const card = { taskId: "T1", role: "reviewer" as const };
  const failures = (db: ReturnType<typeof ledger>["db"]) => listEvents(db, { project: "p" })
    .filter((e) => (e.data as { op?: string }).op === "worker_register_failed").map((e) => e.data as { agent: string; sessionId: string; reason: string });
  const noReg = "CREATE TRIGGER no_reg BEFORE INSERT ON worker_agents BEGIN SELECT RAISE(ABORT, 'synthetic registration failure'); END";

  test("a failed create (name taken by the user's agent) registers nothing and tags nothing", async () => {
    const { db, path } = ledger();
    const { deps, saved, reg } = fake(db, path, { "agent-personal": { sessionId: "personal", channelId: "9" } });
    const failed = { ok: false, error: "agent-personal 已存在" };
    expect(await registerCreated("agent-personal", card, failed, "personal", deps)).toEqual(failed);
    expect(await registerCreated("agent-personal", card, null, "personal", deps)).toMatchObject({ ok: false });
    // ok but the session is the one that was already there: not this create's, refused without touching it
    expect(await registerCreated("agent-personal", card, { ok: true, agent: "agent-personal", sessionId: "personal" }, "personal", deps))
      .toMatchObject({ ok: false });
    expect([activeWorkers(db), saved, (reg.agents["agent-personal"] as { kind?: string }).kind, failures(db)]).toEqual([[], [], undefined, []]);
  });

  test("success: the new session is registered and kind=worker saved; the create's result goes back with the card", async () => {
    const { db, path } = ledger();
    const { deps, saved } = fake(db, path, { "agent-r": { sessionId: "new-s", channelId: "9" } });
    const out = await registerCreated("agent-r", card, { ok: true, agent: "agent-r", sessionId: "new-s" }, null, deps);
    expect(out).toMatchObject({ ok: true, agent: "agent-r", card: { taskId: "T1", role: "reviewer", registered: true } });
    expect(activeWorkers(db).map((w) => [w.agent, w.sessionId, w.role])).toEqual([["agent-r", "new-s", "reviewer"]]);
    expect(saved.at(-1)).toContain("\"kind\":\"worker\"");
  });

  test("ledger registration fails: the agent is kept untagged, create reports it for PM, one failure event recorded", async () => {
    const { db, path } = ledger();
    db.exec(noReg);
    const { deps, saved, reg } = fake(db, path, { "agent-r": { sessionId: "new-s", channelId: "9" } });
    const out = await registerCreated("agent-r", card, { ok: true, agent: "agent-r", sessionId: "new-s" }, null, deps);
    expect(out).toMatchObject({ ok: false, agent: "agent-r", sessionId: "new-s", registered: false, kept: true });
    expect(String(out.error)).toContain("agent agent-r 已建但登记失败，未打 worker 标签，需 PM 处理");
    expect(String(out.error)).toContain("synthetic registration failure");
    expect([reg.agents["agent-r"]?.sessionId, (reg.agents["agent-r"] as { kind?: string }).kind, saved, activeWorkers(db)]).toEqual(["new-s", undefined, [], []]);
    expect(failures(db)).toMatchObject([{ agent: "agent-r", sessionId: "new-s", reason: expect.stringContaining("synthetic") }]);
  });

  test("the registry read fails: kept and reported too (no undo on a read error)", async () => {
    const { db, path } = ledger();
    const { deps, reg } = fake(db, path, { "agent-r": { sessionId: "new-s", channelId: "9", role: "pm" } });
    deps.loadRegistry = async () => { throw new Error("synthetic registry read failure"); };
    const out = await registerCreated("agent-r", card, { ok: true, agent: "agent-r", sessionId: "new-s" }, null, deps);
    expect(out).toMatchObject({ ok: false, kept: true });
    expect(String(out.error)).toContain("synthetic registry read failure");
    expect([reg.agents["agent-r"]?.sessionId, failures(db).map((f) => f.agent)]).toEqual(["new-s", ["agent-r"]]);
  });

  test("a protected agent (PM) is never registered as a worker, never tagged, kept", async () => {
    const { db, path } = ledger();
    const { deps, reg, saved } = fake(db, path, { "agent-r": { sessionId: "new-s", channelId: "9", role: "pm" } });
    const out = await registerCreated("agent-r", card, { ok: true, agent: "agent-r", sessionId: "new-s" }, null, deps);
    expect(out).toMatchObject({ ok: false, kept: true });
    expect([JSON.stringify(reg.agents["agent-r"]), saved, activeWorkers(db)]).toEqual([JSON.stringify({ sessionId: "new-s", channelId: "9", role: "pm" }), [], []]);
  });

  test("rollback-replacement: the name now runs another session → not registered, the replacement is kept and not tagged", async () => {
    const { db, path } = ledger();
    const { deps, reg, saved } = fake(db, path, { "agent-reused": { sessionId: "replacement-user-session", channelId: "9" } });
    const out = await registerCreated("agent-reused", card, { ok: true, agent: "agent-reused", sessionId: "created-session" }, null, deps);
    expect(out).toMatchObject({ ok: false, kept: true });
    expect(String(out.error)).toContain("不是本次建的会话");
    expect([activeWorkers(db), saved, JSON.stringify(reg.agents["agent-reused"])]).toEqual([[], [], JSON.stringify({ sessionId: "replacement-user-session", channelId: "9" })]);
  });

  test("the name is replaced while the ledger row is written: the replacement is not tagged, nothing is removed", async () => {
    const { db, path } = ledger();
    const { deps, reg, saved } = fake(db, path, { "agent-r": { sessionId: "new-s", channelId: "9" } });
    let reads = 0;
    const load = deps.loadRegistry;
    deps.loadRegistry = async () => {
      if (++reads === 2) reg.agents["agent-r"] = { sessionId: "someone-else", channelId: "9" } as never;
      return load();
    };
    const out = await registerCreated("agent-r", card, { ok: true, agent: "agent-r", sessionId: "new-s" }, null, deps);
    expect(out).toMatchObject({ ok: false, kept: true });
    expect(String(out.error)).toContain("worker 标签没打");
    expect([saved, reg.agents["agent-r"]?.sessionId, (reg.agents["agent-r"] as { kind?: string }).kind]).toEqual([[], "someone-else", undefined]);
  });

  test("the failure event itself cannot be written: still kept, both reasons reported", async () => {
    const { db, path } = ledger();
    db.exec(noReg);
    const { deps, reg } = fake(db, path, { "agent-r": { sessionId: "new-s", channelId: "9" } });
    deps.recordFailure = () => { throw new Error("ledger locked"); };
    const out = await registerCreated("agent-r", card, { ok: true, agent: "agent-r", sessionId: "new-s" }, null, deps);
    expect(out).toMatchObject({ ok: false, kept: true });
    expect(String(out.error)).toContain("ledger locked");
    expect(reg.agents["agent-r"]?.sessionId).toBe("new-s");
  });
});

describe("ledger scheduler-worker-retire", () => {
  const wire = (o: Record<string, unknown>) => JSON.stringify({ agent: "agent-a", sessionId: "s1", taskId: "T1", role: "author", rule: "card_finished",
    reason: "卡 T1 已 verified", idleMs: 1, bytesBefore: 9000, bytesAfter: 1000, steps: ["已归档"], ...o });

  test("scheduler records a retire: row closed, event carries bytes freed; repeat is harmless", async () => {
    const { db, deps } = ledger();
    registerWorker(db, { agent: "agent-a", sessionId: "s1", taskId: "T1", role: "author", createdBy: "agent-pm", now: 100 });
    for (let i = 0; i < 2; i++) expect(await runLedger(["scheduler-worker-retire", "--wire", wire({})], deps("scheduler"))).toMatchObject({ ok: true });
    expect(activeWorkers(db)).toEqual([]);
    const ev = listEvents(db, { project: "p" }).filter((e) => (e.data as { op?: string }).op === "worker_retire");
    expect((ev[0]?.data as { bytesFreed?: number }).bytesFreed).toBe(8000);
  });

  test("stock without a card: scheduler only; an executor may not write it; bad wire refused", async () => {
    const { deps } = ledger();
    expect(await runLedger(["scheduler-worker-retire", "--wire", wire({ taskId: null, role: "stock" })], deps("agent-x"))).toMatchObject({ ok: false });
    expect(await runLedger(["scheduler-worker-retire", "--wire", wire({ pending: "nope" })], deps("scheduler"))).toMatchObject({ ok: false });
    expect(await runLedger(["scheduler-worker-retire", "--wire", wire({ pending: [{ checkout: 3 }] })], deps("scheduler"))).toMatchObject({ ok: false });
    expect(await runLedger(["scheduler-worker-retire", "--wire", wire({ taskId: null, role: "stock" })], deps("scheduler"))).toMatchObject({ ok: true });
  });
});

describe("memory parsers", () => {
  test("macOS vm.swapusage and Linux meminfo", () => {
    expect(parseSwapUsage("total = 14336.00M  used = 13000.00M  free = 1336.00M  (encrypted)")).toEqual({ totalMb: 14336, usedMb: 13000 });
    expect(parseSwapUsage("total = 1.00G  used = 512.00M  free = 512.00M")).toEqual({ totalMb: 1024, usedMb: 512 });
    expect(parseSwapUsage("garbage")).toBeNull();
    expect(parseMeminfo("MemAvailable:    2048000 kB\nSwapTotal:       1024000 kB\nSwapFree:         256000 kB\n"))
      .toEqual({ totalMb: 1000, usedMb: 750, availMb: 2000 });
    expect(parseMeminfo("MemTotal: 1 kB")).toBeNull();
  });
});
