/**
 * LIFE1 registration side: `manager create --card` flags and gate (an executor without a card is refused, user agents are not,
 * names decide nothing; only the session the create started is registered, a failed registration undoes the create), the ledger
 * write the scheduler uses (`scheduler-worker-retire`, scheduler identity only for stock rows), and the swap parsers behind the
 * memory backstop.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeWorkers, registerWorker } from "../src/lib/agent-lifecycle-store.js";
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

describe("registerCreated: only the session this create started, a failed registration undoes the create", () => {
  function fake(path: string, agents: Record<string, Record<string, unknown>>) {
    const reg = { socket: "", agents } as unknown as Registry;
    const removed: string[] = [], saved: string[] = [];
    const deps: RegisterDeps = { ledgerPath: path, loadRegistry: async () => reg, createdBy: async () => "agent-pm",
      saveRegistry: async (r) => { saved.push(JSON.stringify(r.agents)); },
      remove: async (a) => { removed.push(a); delete reg.agents[a]; return { ok: true }; } };
    return { reg, deps, removed, saved };
  }
  const card = { taskId: "T1", role: "reviewer" as const };

  test("a failed create (name taken by the user's agent) registers nothing and tags nothing", async () => {
    const { db, path } = ledger();
    const { deps, removed, saved, reg } = fake(path, { "agent-personal": { sessionId: "personal", channelId: "9" } });
    const failed = { ok: false, error: "agent-personal 已存在" };
    expect(await registerCreated("agent-personal", card, failed, "personal", deps)).toEqual(failed);
    expect(await registerCreated("agent-personal", card, null, "personal", deps)).toMatchObject({ ok: false });
    // ok but the session is the one that was already there: not this create's, refused without touching it
    expect(await registerCreated("agent-personal", card, { ok: true, agent: "agent-personal", sessionId: "personal" }, "personal", deps))
      .toMatchObject({ ok: false });
    expect([activeWorkers(db), removed, saved, (reg.agents["agent-personal"] as { kind?: string }).kind]).toEqual([[], [], [], undefined]);
  });

  test("success: the new session is registered and kind=worker saved; the create's result goes back with the card", async () => {
    const { db, path } = ledger();
    const { deps, saved } = fake(path, { "agent-r": { sessionId: "new-s", channelId: "9" } });
    const out = await registerCreated("agent-r", card, { ok: true, agent: "agent-r", sessionId: "new-s" }, null, deps);
    expect(out).toMatchObject({ ok: true, agent: "agent-r", card: { taskId: "T1", role: "reviewer", registered: true } });
    expect(activeWorkers(db).map((w) => [w.agent, w.sessionId, w.role])).toEqual([["agent-r", "new-s", "reviewer"]]);
    expect(saved.at(-1)).toContain("\"kind\":\"worker\"");
  });

  test("ledger registration fails: the created agent is removed and the caller gets ok:false (no orphan nobody collects)", async () => {
    const { db, path } = ledger();
    db.exec("CREATE TRIGGER no_reg BEFORE INSERT ON worker_agents BEGIN SELECT RAISE(ABORT, 'synthetic registration failure'); END");
    const { deps, removed } = fake(path, { "agent-r": { sessionId: "new-s", channelId: "9" } });
    const out = await registerCreated("agent-r", card, { ok: true, agent: "agent-r", sessionId: "new-s" }, null, deps);
    expect(out).toMatchObject({ ok: false, rolledBack: true });
    expect(String(out.error)).toContain("synthetic registration failure");
    expect([removed, activeWorkers(db)]).toEqual([["agent-r"], []]);
  });

  test("a protected agent (PM) is never registered as a worker; a failed undo is reported with the manual step", async () => {
    const { db, path } = ledger();
    const { deps } = fake(path, { "agent-r": { sessionId: "new-s", channelId: "9", role: "pm" } });
    deps.remove = async () => ({ ok: false, error: "tmux gone" });
    const out = await registerCreated("agent-r", card, { ok: true, agent: "agent-r", sessionId: "new-s" }, null, deps);
    expect(out).toMatchObject({ ok: false, rolledBack: false });
    expect(String(out.error)).toContain("manager remove agent-r");
    expect(activeWorkers(db)).toEqual([]);
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
