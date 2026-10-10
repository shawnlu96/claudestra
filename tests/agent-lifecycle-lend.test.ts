/** Explicit B facts coexist with ordinary LIFE1; all files and journals are synthetic, and no production cleanup is run. */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger, closeLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { advance, getOrder, openLendJournal, patchOrder, recordAsked } from "../src/lib/lend-journal.js";
import { workerName } from "../src/lib/lend-worker-name.js";
import { archiveHash, workerArchiveIdentity } from "../src/lib/lend-worker-registry-archive.js";
import { cardWorkerIndex } from "../src/lib/agent-lifecycle-store.js";
import { planLifecycle } from "../src/lib/agent-lifecycle.js";
import { planLendLifecycle, type LendLifecycleInput } from "../src/lib/agent-lifecycle-lend.js";
import { DEFAULT_LIFECYCLE } from "../src/lib/agent-lifecycle-config.js";
import { ledgerFacts, lendAgents } from "../src/lib/agent-lifecycle-deps.js";
import { runLifecycle, type LifecycleDeps } from "../src/lib/agent-lifecycle-run.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const clean of cleanups.splice(0).reverse()) clean(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "life1-lend-")), ledgerPath = join(root, "ledger.sqlite");
  const ledger = openLedger(ledgerPath), journalPath = join(root, "journal.sqlite"), journal = openLendJournal(journalPath);
  cleanups.push(() => { journal.close(); closeLedger(ledgerPath); rmSync(root, { recursive: true, force: true }); });
  const agent = workerName("o1");
  recordAsked(journal, { orderId: "o1", peer: "A", fp: "a-instance", family: "codex", preview: { taskId: "remote-card" } });
  advance(journal, "o1", "asked", "claimed", { leaseGen: 3, wire: { order: { orderId: "o1", taskId: "remote-card" }, text: "claimed order" } });
  advance(journal, "o1", "claimed", "cloned", { dir: root, agent });
  advance(journal, "o1", "cloned", "started", { sessionId: "session-1", startedAt: 100 });
  const payload = { orderId: "o1", gen: 3, session: { id: "session-1" }, verdict: "pass" }, payloadSha = archiveHash(JSON.stringify(payload));
  advance(journal, "o1", "started", "result_pending", { payload, payloadSha });
  advance(journal, "o1", "result_pending", "acked", { receipt: { orderId: "o1", taskId: "remote-card", sha256: payloadSha },
    settle: { notify: null, removeDir: false } });
  const id = workerArchiveIdentity(getOrder(journal, "o1")!)!;
  const read = (mode: LendLifecycleInput["mode"] = "on"): LendLifecycleInput => ({
    identity: id, row: getOrder(journal, "o1"), record: { cwd: root, sessionId: id.sessionId, kind: "worker", status: "stopped", runtime: "codex" },
    index: cardWorkerIndex(ledger, { journal, identity: id }), ...ledgerFacts(ledger, { strictProtection: true }),
    facts: { identity: id, journalAuthenticated: true, workerExited: true, preservationComplete: true, protected: false, pendingResult: false }, mode,
  });
  const card = (stage: string, extra: unknown = {}) => {
    createTask(ledger, { actor: "owner" }, { project: "local", id: "remote-card", title: "same named local card", kind: "code" });
    ledger.query("UPDATE tasks SET stage = ?, agent = ?, extra = ? WHERE id = 'remote-card'").run(stage, agent, JSON.stringify(extra));
  };
  return { root, ledger, journal, journalPath, id, read, card };
}

test("the one reader labels B provenance separately; default index and periodic/doctor policy keep B workers protected", () => {
  const f = fixture();
  expect(cardWorkerIndex(f.ledger).has(f.id.agent)).toBe(false);
  const input = f.read(), link = input.index.get(f.id.agent)!;
  expect(link).toMatchObject({ source: "lend_orders", taskId: null, sessionId: f.id.sessionId });
  expect(link.lend).toMatchObject({ orderId: "o1", peer: "A", fp: "a-instance", leaseGen: 3 });
  for (const foreign of [new Set<string>(), lendAgents(f.journalPath)]) {
    const plan = planLifecycle({ ...ledgerFacts(f.ledger), now: 100000, policy: { ...DEFAULT_LIFECYCLE, mode: "on" },
      index: input.index, foreign, master: new Set(), swapPct: 100,
      pending: [{ agent: f.id.agent, sessionId: f.id.sessionId, taskId: null, role: "other", createdAt: 1,
        entries: [{ checkout: f.root, tmp: join(f.root, "tmp") }] }],
      agents: [{ name: f.id.agent, sessionId: f.id.sessionId, kind: "worker", status: "stopped", running: false, idleMs: 100000000, turnActive: false }] });
    expect(plan.actions).toEqual([]);
    expect(plan.memory).toEqual([]);
    expect(plan.cleanups).toEqual([]);
  }
});

test("explicit authenticated B terminal facts form exactly one archive-only/no-disk action; observe/off remain closed", () => {
  const f = fixture();
  const result = planLendLifecycle(f.read());
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  expect(result.plan.actions).toHaveLength(1);
  expect(result.plan.actions[0]).toMatchObject({ rule: "lend_terminal", mode: "archive-only-no-disk", taskId: null,
    lend: { identity: f.id, peer: "A", fp: "a-instance" } });
  expect(result.plan.memory).toEqual([]);
  expect(result.plan.cleanups).toEqual([]);
  for (const mode of ["observe", "off", undefined] as const) {
    const input = f.read(); input.mode = mode;
    expect(planLendLifecycle(input)).toMatchObject({ ok: false, code: "blocked-capability" });
  }
});

test.each(["stopped", "started", "unknown", "result_pending"])("local done card cannot turn B %s into terminal", (state) => {
  const f = fixture(); f.card("done");
  f.journal.query("UPDATE lend_orders SET state = ? WHERE orderId = 'o1'").run(state);
  expect(planLendLifecycle(f.read()).ok).toBe(false);
});

test.each(["build", "frozen", "bad-extra", "scalar-extra", "malformed-frozen"])("local %s association remains protected alongside a terminal remote order", (caseName) => {
  const f = fixture();
  const extra = caseName === "frozen" ? { frozen: true } : caseName === "scalar-extra" ? "unknown"
    : caseName === "malformed-frozen" ? { frozen: "unknown" } : {};
  f.card(caseName === "build" ? "build" : "done", extra);
  if (caseName === "bad-extra") f.ledger.query("UPDATE tasks SET extra = '{broken' WHERE id = 'remote-card'").run();
  expect(planLendLifecycle(f.read()).ok).toBe(false);
});

test("missing claims, wrong peer/instance/receipt and missing reader facts never become retirement authority", () => {
  const f = fixture();
  for (const patch of [{ wire: null }, { fp: null }, { peer: "" }, { leaseGen: 4 }, { sessionId: "replacement" },
    { receipt: { ...f.read().row!.receipt, taskId: "local-other-card" } }]) {
    const input = f.read(); input.row = { ...input.row!, ...patch };
    expect(planLendLifecycle(input).ok).toBe(false);
  }
  const input = f.read(); input.index = cardWorkerIndex(f.ledger);
  expect(planLendLifecycle(input).ok).toBe(false);
  for (const key of ["journalAuthenticated", "workerExited", "preservationComplete", "protected", "pendingResult"] as const) {
    const unknown = f.read(); unknown.facts[key] = null;
    expect(planLendLifecycle(unknown).ok).toBe(false);
  }
});

test("late generation, late results and another B order re-read through cardWorkerIndex protect the record", () => {
  const f = fixture();
  patchOrder(f.journal, "o1", ["acked"], { leaseGen: 4 });
  expect(planLendLifecycle(f.read()).ok).toBe(false);
  patchOrder(f.journal, "o1", ["acked"], { leaseGen: 3, work: { head: "later", summary: "pending", selfCheck: "pending" } });
  expect(planLendLifecycle(f.read()).ok).toBe(false);
  patchOrder(f.journal, "o1", ["acked"], { work: null });
  recordAsked(f.journal, { orderId: "o2", peer: "A", fp: "a-instance", family: "codex", preview: {} });
  advance(f.journal, "o2", "asked", "claimed", { agent: f.id.agent });
  expect(planLendLifecycle(f.read()).ok).toBe(false);
});

test("a B action without the canonical retirement capability cannot fall through to LIFE1 disk/process effects", async () => {
  const f = fixture(), result = planLendLifecycle(f.read());
  if (!result.ok) throw new Error(result.reason);
  const effects: string[] = [];
  const deps: LifecycleDeps = {
    manager: async (...args) => { effects.push(args.join(" ")); return { ok: true }; },
    worktreeRoot: f.root, agents: async () => [{ name: f.id.agent, sessionId: f.id.sessionId, status: "stopped", pending: false, window: false }],
    git: async () => { effects.push("git"); return { code: 0, out: "" }; }, exists: () => true,
    tmp: { root: f.root, rm: async () => { effects.push("tmp"); } }, du: async () => { effects.push("du"); return 1; },
    swapPct: async () => 0, record: async () => { effects.push("record"); }, now: () => 100,
  };
  const outcome = await runLifecycle(result.plan, { ...DEFAULT_LIFECYCLE, mode: "on" }, deps);
  expect(outcome.done).toEqual([]);
  expect(outcome.failed[0]?.error).toContain("blocked-capability");
  expect(effects).toEqual([]);
});
