/**
 * LIFE1 registration side: `manager create --card` flags and gate (an executor without a card is refused, user agents are not,
 * names decide nothing), the ledger write the scheduler uses (`scheduler-worker-retire`, scheduler identity only for stock rows),
 * and the swap parsers behind the memory backstop.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeWorkers, registerWorker } from "../src/lib/agent-lifecycle-store.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { parseMeminfo, parseSwapUsage } from "../src/lib/sys-memory.js";
import { cardGate, extractCardFlags } from "../src/manager/create-lifecycle.js";
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

describe("ledger scheduler-worker-retire", () => {
  const wire = (o: Record<string, unknown>) => JSON.stringify({ agent: "agent-a", taskId: "T1", role: "author", rule: "card_finished", mode: "retire",
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
    expect(await runLedger(["scheduler-worker-retire", "--wire", wire({ mode: "nuke" })], deps("scheduler"))).toMatchObject({ ok: false });
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
