/**
 * dispatch-recovery-R1 on a real temp ledger, through the formal entries only: the scheduler tick (plan + pool step + lend gate),
 * `placementOf` (what `ledger lend-orders` and the borrow panel show) and `auditLedger` (the patrol). The incident: a fix goes
 * back to the write-lease holder "mate", whose Codex slots are free and whose grant is valid; this machine has no Codex agent
 * and task.agent is empty; the order is refused by the outbound gate and its intent cancelled. Before R1 the card then said
 * "等 codex 空位（固定 mate）" forever and nobody was told; now it is a security-material block that survives a restart, retries
 * once (full gate) only when its material changes, and closes on a claim, PM's reclaim or a manual takeover.
 */
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { auditLedger } from "../src/lib/ledger-audit.js";
import { ackFindings, openFindings, reconcileFindings } from "../src/lib/ledger-audit-store.js";
import { getWriteLease } from "../src/lib/ledger-lend-lease.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { placementOf } from "../src/lib/lend-placement-view.js";
import { recordGateRefused } from "../src/lib/order-gate-heads.js";
import { gateBlock } from "../src/lib/scheduler-dispatch-block.js";
import { blockFixture, E2E_MS, FREE, MIN, toFix, type Fx } from "./scheduler-dispatch-block-helpers.js";

const leaked = () => `# 审查报告\nP1：两个 tick 抢同一个意图\n别处粘来的 ${randomBytes(32).toString("hex")}`;
const CLEAN = "# 审查报告\nP1：两个 tick 抢同一个意图（复现见 tests/x.test.ts）";

const view = (p: Fx, db: Database = p.f.db) =>
  placementOf(db, getTask(db, "T1")!, p.policy, [{ peer: "mate", projects: ["p"], roles: ["review", "write"], maxOpen: 3 }], p.f.tickDeps.now());
const audit = (p: Fx) => auditLedger({ project: "p", pms: ["pm"], tasks: [{ task: p.f.task(), events: p.events() }],
  agents: null, reviewers: null, held: null, ownerInbox: null }, p.f.tickDeps.now());
const blocked = (p: Fx) => audit(p).findings.filter((f) => f.rule === "dispatch_blocked");
/** A pass after the undelivered backoff (30 s after a refused offer) has run out, with mate's hello fresh. */
const later = async (p: Fx) => { p.f.advance(MIN); p.hello(); return p.tick(); };

async function refusedFix() {
  const p = await blockFixture();
  await toFix(p, leaked());
  const r = audit(p); // the patrol was already running before the refusal (its rules' first run stays silent)
  reconcileFindings(p.f.db, "p", r.findings, r.evaluated, p.f.tickDeps.now());
  expect(await p.tick()).toMatchObject({ step: "pool_refused", detail: expect.stringContaining("外发闸") });
  expect(p.fixes()).toEqual([]);
  expect(p.f.task().agent).toBeNull();
  return p;
}

describe("acceptance 1: a refused fix is a visible, accurate block (no local agent, peer valid with free slots)", () => {
  test("tick, placement view and patrol all say security material, round and next step — never a capacity wait", async () => {
    const p = await refusedFix();
    try {
      for (let i = 0; i < 4; i++) {
        const r = await later(p);
        expect(r?.step).toBe("waiting");
        expect(r?.detail).toStartWith("安全材料阻塞（第 1 轮 fix");
        expect(r?.detail.includes("空位")).toBe(false);
      }
      expect(view(p)).toMatchObject({ category: "security_material", where: "-", reason: expect.stringContaining("ledger lend-reclaim T1"),
        block: { state: "blocked", round: 1, stage: "fix" } });
      expect(String(view(p).reason).includes("空位")).toBe(false);
      const [row] = blocked(p);
      expect(row).toMatchObject({ taskId: "T1", notify: "pm", detail: expect.stringContaining("长十六进制") });
      expect(audit(p).evaluated).toContain("dispatch_blocked"); // no agents / reviewers source needed
      // Persisted PM item: pushed once, then deduped, still listed as open while PM was away.
      const patrol = () => { const r = audit(p); return reconcileFindings(p.f.db, "p", r.findings, r.evaluated, p.f.tickDeps.now()); };
      const pending = patrol().pending.filter((x) => x.rule === "dispatch_blocked");
      expect(pending).toHaveLength(1);
      ackFindings(p.f.db, pending.map((x) => x.key), p.f.tickDeps.now());
      await later(p);
      expect(patrol().pending.filter((x) => x.rule === "dispatch_blocked")).toEqual([]);
      expect(openFindings(p.f.db, "p").filter((x) => x.rule === "dispatch_blocked")).toHaveLength(1);
    } finally { p.f.close(); }
  }, E2E_MS);
});

describe("acceptance 2: a refusal is not a dispatch; it persists and only real work closes it", () => {
  test("same material: no second offer, intent or alarm; notes, memory and hellos do not clear it; a restarted reader sees it", async () => {
    const p = await refusedFix();
    try {
      const intents = p.f.intents().length;
      insertEvent(p.f.db, p.f.at("pm"), { project: "p", target: "T1", kind: "note", text: "看了一下，先放着", data: {} }, true);
      insertEvent(p.f.db, p.f.at("pm"), { project: "p", target: "T1", kind: "memory", text: "mate 今天空闲", data: { op: "remember" } }, true);
      for (let i = 0; i < 5; i++) await later(p);
      expect(p.f.intents()).toHaveLength(intents);
      expect(p.refusals()).toHaveLength(1);
      expect(p.orders().filter((o) => o.step === "fix")).toEqual([]);
      const fresh = new Database(join(p.f.dir, "ledger.sqlite"), { readonly: true }); // a scheduler restart reads only the ledger
      try { expect(view(p, fresh)).toMatchObject({ category: "security_material", block: { state: "blocked" } }); } finally { fresh.close(); }
      expect(getWriteLease(p.f.db, "T1")).toMatchObject({ peer: "mate", state: "held" }); // the live lease is not taken
    } finally { p.f.close(); }
  }, E2E_MS);

  test("a late refusal of an earlier window does not apply, and does not reopen a closed block", async () => {
    const p = await refusedFix();
    try {
      const old = { op: "gate_refused", reason: "旧轮", waiting: "x", intentId: "t68:old", stage: "build", round: 0, head: "1".repeat(40), window: 1, material: "old" };
      insertEvent(p.f.db, p.f.at("scheduler"), { project: "p", target: "T1", kind: "scheduler", text: "迟到", data: old }, true);
      expect(gateBlock(p.f.task(), p.events())).toMatchObject({ state: "blocked", reason: expect.stringContaining("长十六进制") });
      p.rereview(CLEAN);
      expect(await later(p)).toMatchObject({ step: "pool_pooled" });
      expect(await p.lendCall("lend-claim", { v: 1, orderId: p.fixes().at(-1)!.orderId, worker: "w2" })).toMatchObject({ ok: true });
      expect(gateBlock(p.f.task(), p.events())).toBeNull();
      insertEvent(p.f.db, p.f.at("scheduler"), { project: "p", target: "T1", kind: "scheduler", text: "迟到", data: old }, true);
      expect(gateBlock(p.f.task(), p.events())).toBeNull();
      expect(blocked(p)).toEqual([]);
    } finally { p.f.close(); }
  }, E2E_MS);
});

describe("FB1 coexistence: a moved fix start is not a dispatch", () => {
  test("head / rev moved after the refusal (fix_start_moved) keeps the block open (at most one more full-gate offer)", async () => {
    const p = await refusedFix();
    try {
      const moved = "4".repeat(40);
      p.f.db.run("UPDATE tasks SET headSHA = ?, rev = rev + 1 WHERE id = 'T1'", [moved]); // adoptFixStart's effect
      insertEvent(p.f.db, p.f.at("scheduler"), { project: "p", target: "T1", kind: "scheduler", text: "修复起点已移动", data: { op: "fix_start_moved", head: moved } }, true);
      expect(gateBlock(p.f.task(), p.events())).toMatchObject({ state: "retry" });
      expect(blocked(p)).toEqual([expect.objectContaining({ detail: expect.stringContaining("长十六进制") })]);
      expect(view(p).block).toMatchObject({ state: "retry", round: 1 }); // retry = one more full-gate offer, not a success
      expect(p.fixes()).toEqual([]);
    } finally { p.f.close(); }
  }, E2E_MS);
});

describe("acceptance 3: recovery is the code's job, bounded, and always through the full gate", () => {
  test("material changed but still leaking → one more full-gate offer, refused, new block; then a clean report → offered and claimed", async () => {
    const p = await refusedFix();
    try {
      await later(p);
      p.rereview(leaked());
      expect(view(p)).toMatchObject({ block: { state: "retry" }, where: "peer:mate" });
      expect(await later(p)).toMatchObject({ step: "pool_refused", detail: expect.stringContaining("长十六进制") });
      expect(p.refusals()).toHaveLength(2);
      const [first, second] = p.refusals();
      expect(second!.data.material).not.toBe(first!.data.material);
      for (let i = 0; i < 3; i++) expect(await later(p)).toMatchObject({ step: "waiting", detail: expect.stringContaining("安全材料阻塞") });
      expect(p.refusals()).toHaveLength(2);
      p.rereview(CLEAN);
      expect(await later(p)).toMatchObject({ step: "pool_pooled", detail: expect.stringContaining("修复挂给 mate") });
      expect(p.fixes()).toHaveLength(1);
      expect(p.fixes()[0]!.text).not.toMatch(/[0-9a-f]{64}/); // the untrusted text was never rewritten to pass: the new report is what went out
      expect(blocked(p)).toEqual([]); // passed the gate: waiting for the claim is the pool's ordinary wait
      expect(await p.lendCall("lend-claim", { v: 1, orderId: p.fixes()[0]!.orderId, worker: "w2" })).toMatchObject({ ok: true });
      expect(gateBlock(p.f.task(), p.events())).toBeNull();
    } finally { p.f.close(); }
  }, E2E_MS);

  test("a refusal recorded before the handler version existed gets exactly one re-evaluation, then holds", async () => {
    const p = await blockFixture();
    try {
      await toFix(p, leaked());
      // What GATE2 / GATE3 wrote before R1: no material, no window (order-gate-heads.ts without facts).
      recordGateRefused(p.f.db, p.f.at("scheduler"), p.f.task(), "派单没过外发闸（拒绝优先，留在本机做）：inputs[1] 疑似含密钥（长十六进制）");
      expect(gateBlock(p.f.task(), p.events())).toMatchObject({ state: "retry" });
      expect(view(p)).toMatchObject({ block: { state: "retry" } });
      expect(await p.tick()).toMatchObject({ step: "pool_refused" });
      expect(p.refusals()).toHaveLength(2);
      for (let i = 0; i < 3; i++) await later(p);
      expect(p.refusals()).toHaveLength(2);
      expect(gateBlock(p.f.task(), p.events())).toMatchObject({ state: "blocked" });
    } finally { p.f.close(); }
  }, E2E_MS);
});

describe("acceptance 4: coexists with peer outages, capacity, PM takeover and observe", () => {
  test("peer offline then back: peer_unavailable, then the ordinary path dispatches (no block involved)", async () => {
    const p = await blockFixture();
    try {
      await toFix(p, CLEAN);
      p.f.advance(5 * MIN); // mate's hello goes stale
      expect(await p.tick()).toMatchObject({ step: "waiting", detail: expect.stringContaining("不是容量：mate hello 超过") });
      expect(view(p)).toMatchObject({ category: "peer_unavailable", block: null });
      p.hello();
      expect(await p.tick()).toMatchObject({ step: "pool_pooled" });
    } finally { p.f.close(); }
  }, E2E_MS);

  test("capacity 0 at the holder is a capacity wait; a gate block is its own reason and survives the peer going away and back", async () => {
    const p = await blockFixture();
    try {
      await toFix(p, CLEAN);
      p.hello({ codex: { total: 0, busy: 0 }, claude: { total: 0, busy: 0 } });
      expect(await p.tick()).toMatchObject({ step: "waiting" });
      expect(view(p)).toMatchObject({ category: "capacity", block: null });
    } finally { p.f.close(); }
    const q = await refusedFix();
    try {
      q.f.advance(5 * MIN);
      expect(await q.tick()).toMatchObject({ detail: expect.stringContaining("安全材料阻塞") });
      q.hello(FREE);
      expect(await q.tick()).toMatchObject({ detail: expect.stringContaining("安全材料阻塞") });
      expect(view(q).category).toBe("security_material");
      expect(q.refusals()).toHaveLength(1);
    } finally { q.f.close(); }
  }, E2E_MS);

  test("PM's reclaim closes the block (lease ends, card back home); a manual takeover closes it too", async () => {
    const p = await refusedFix();
    try {
      expect(await p.cli("pm", "lend-reclaim", "T1", "--reason", "本机接手")).toMatchObject({ ok: true });
      expect(gateBlock(p.f.task(), p.events())).toBeNull();
      expect(view(p).category).not.toBe("security_material");
      expect(blocked(p)).toEqual([]);
    } finally { p.f.close(); }
    const q = await refusedFix();
    try {
      const w = q.f.db.query("SELECT rev FROM task_workflows WHERE taskId = 'T1'").get() as { rev: number };
      expect(await q.cli("pm", "workflow-set", "T1", "--rev", String(q.f.task().rev), "--workflow-rev", String(w.rev), "--template", "code", "--version", "2",
        "--mode", "manual", "--author-family", "claude", "--fallback", "只报错不修", "--reason", "PM 接管")).toMatchObject({ ok: true });
      expect(gateBlock(q.f.task(), q.events())).toBeNull();
    } finally { q.f.close(); }
  }, E2E_MS);

  test("off (manual): a changed material is reported but nothing is retried automatically", async () => {
    const p = await refusedFix();
    try {
      p.f.db.run("UPDATE task_workflows SET mode = 'manual' WHERE taskId = 'T1'");
      p.rereview(CLEAN);
      for (let i = 0; i < 3; i++) expect((await later(p))?.step ?? "skipped").not.toMatch(/^pool_/); // a manual card is not driven
      expect(p.fixes()).toEqual([]);
      expect(p.refusals()).toHaveLength(1);
      expect(blocked(p)).toEqual([expect.objectContaining({ suggestion: expect.stringContaining("observe / manual 卡由 PM 决定") })]);
    } finally { p.f.close(); }
  }, E2E_MS);

  test("observe reports the block and the pending retry but writes no order", async () => {
    const p = await refusedFix();
    try {
      p.f.db.run("UPDATE task_workflows SET mode = 'observe' WHERE taskId = 'T1'");
      p.rereview(CLEAN);
      const before = p.f.intents().length;
      for (let i = 0; i < 3; i++) await later(p);
      expect(p.f.intents()).toHaveLength(before);
      expect(p.fixes()).toEqual([]);
      expect(blocked(p)).toEqual([expect.objectContaining({ suggestion: expect.stringContaining("observe / manual 卡由 PM 决定") })]);
      expect(listEvents(p.f.db, { target: "T1" }).filter((e) => e.data.op === "pool_offer" && e.data.step === "fix")).toEqual([]);
    } finally { p.f.close(); }
  }, E2E_MS);
});

describe("patrol rule on partial facts: no false report, no false clear", () => {
  const task = { id: "T9", stage: "fix" as const, round: 2, specRev: 1, headSHA: "a".repeat(40) };
  const ev = (seq: number, kind: string, data: Record<string, unknown>) => ({ seq, ts: seq, kind, actor: "scheduler", data }) as never;
  const entered = ev(5, "stage", { to: "fix" });
  const refused = ev(7, "scheduler", { op: "gate_refused", reason: "派单没过外发闸（拒绝优先，留在本机做）：inputs[1] 疑似含密钥（敏感字段名）" });

  test("a normal card in fix, or a refusal before the current window, reports nothing", () => {
    expect(gateBlock(task, [ev(1, "task", { op: "new" }), entered])).toBeNull();
    expect(gateBlock(task, [ev(1, "task", { op: "new" }), ev(3, "scheduler", { op: "gate_refused", reason: "旧" }), entered])).toBeNull();
    expect(gateBlock({ ...task, stage: "review" }, [entered, refused])).toBeNull();
  });

  test("a claim without an offer in this window, an empty task-set, a system fallback or a hello do not clear a legacy refusal", () => {
    const noise = [ev(8, "note", { lend: { op: "claim", orderId: "lend:old" } }), ev(9, "task", { op: "set", patch: { agent: null } }),
      ev(10, "scheduler", { op: "fallback_manual", reason: "x" }), ev(11, "note", { lend: { op: "hello" } })];
    expect(gateBlock(task, [entered, refused, ...noise])).toMatchObject({ state: "retry", reason: expect.stringContaining("敏感字段名") });
    expect(gateBlock(task, [entered, refused, ev(12, "note", { lend: { op: "offer", orderId: "lend:new" } }),
      ev(13, "note", { lend: { op: "claim", orderId: "lend:new" } })])).toBeNull();
  });
});
