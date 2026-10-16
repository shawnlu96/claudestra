/**
 * i28-STALELEASE1 · the judgment (pure assessContinuity), the handover transaction's re-checks and replays, and the local
 * takeover's family_switch: a continuing original author is not a model switch. The end-to-end path is lend-local-continuity-e2e.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { getWriteLease, type WriteLease } from "../src/lib/ledger-lend-lease.js";
import { getTask } from "../src/lib/ledger-store.js";
import { applyStaleLeaseHandover } from "../src/lib/lend-local-continuity-apply.js";
import { assessContinuity, continuityCheck, setStaleLeasePolicy, STALE_LEASE_OP, type ContinuityInput } from "../src/lib/lend-local-continuity.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import { assessLocalFallback, readLocalFallbackFacts, type LocalFallbackFacts } from "../src/lib/recovery-local-fallback-plan.js";
import { H2 } from "./scheduler-auto-helpers.js";
import { E2E_MS, LEND_BRANCH, ofOp, ready, toStaleFix, type P } from "./lend-local-continuity-helpers.js";
import { blockFixture, toFix } from "./scheduler-dispatch-block-helpers.js";

const lease: WriteLease = { taskId: "T1", project: "p", peer: "mate", fp: "f", branch: "lend/T1-abcd", repo: "o/r", prevAssignee: null, prevAssigneeKind: null,
  state: "held", reason: null, createdAt: 1, updatedAt: 5 };
const base = (): ContinuityInput => ({
  task: { id: "T1", stage: "fix", branch: "feat/t1", headSHA: H2, agent: "agent-task-one", assigneeKind: "agent", extra: {}, round: 1, specRev: 1 },
  auto: true, lease,
  orders: [{ orderId: "o1", step: "write", status: "cancelled" }, { orderId: "o0", step: "review", status: "pooled" }],
  intents: [{ id: "i1", status: "cancelled" }, { id: "i2", status: "done" }],
  events: [{ seq: 9, kind: "deliver", actor: "agent-task-one", data: { headSHA: H2 } }, { seq: 10, kind: "review", actor: "agent-rv-t1", data: {} }],
  author: { agent: "agent-task-one", sessionId: "s-one", family: "claude", transport: "tmux", state: "active" },
});
const why = (i: ContinuityInput) => { const c = assessContinuity(i); return c.ok ? "ok" : c.why; };

describe("assessContinuity (pure)", () => {
  test("every condition holds: evidence names the lease, the session and the delivery; a pin on the lease holder is to be dropped", () => {
    expect(assessContinuity(base())).toEqual({ ok: true, evidence: { peer: "mate", leaseBranch: "lend/T1-abcd", leaseAt: 5, branch: "feat/t1", head: H2,
      round: 1, specRev: 1, agent: "agent-task-one", sessionId: "s-one", family: "claude", transport: "tmux", deliverSeq: 9, unpin: false } });
    const pinned = base();
    pinned.task.extra = { placement: "peer:mate" };
    expect(assessContinuity(pinned)).toMatchObject({ ok: true, evidence: { unpin: true } });
  });

  test.each([
    ["[验收线 3] a pooled write order", (i: ContinuityInput) => { i.orders = [{ orderId: "o2", step: "fix", status: "pooled" }]; }, "o2（pooled）"],
    ["[验收线 3] a claimed write order", (i: ContinuityInput) => { i.orders = [{ orderId: "o2", step: "write", status: "claimed" }]; }, "o2（claimed）"],
    ["[验收线 3] an unknown write order", (i: ContinuityInput) => { i.orders = [{ orderId: "o2", step: "fix", status: "unknown" }]; }, "o2（unknown）"],
    ["[验收线 3] an intent of unknown effect", (i: ContinuityInput) => { i.intents = [{ id: "i3", status: "unknown" }]; }, "i3（unknown）"],
    ["[验收线 3] an intent in flight", (i: ContinuityInput) => { i.intents = [{ id: "i3", status: "submitted" }]; }, "i3（submitted）"],
    ["[验收线 4] last delivery from the peer", (i: ContinuityInput) => { i.events = [...i.events, { seq: 11, kind: "deliver", actor: "peer:mate", data: { headSHA: H2 } }]; }, "来自 peer:mate"],
    ["[验收线 4] last delivery from another agent", (i: ContinuityInput) => { i.events = [{ seq: 11, kind: "deliver", actor: "agent-x", data: { headSHA: H2 } }]; }, "来自 agent-x"],
    ["[验收线 4] last delivery's head is not the card's", (i: ContinuityInput) => { i.task.headSHA = "3".repeat(40); }, "head"],
    ["[验收线 4] the card is on the lend branch (peer delivered normally)", (i: ContinuityInput) => { i.task.branch = lease.branch; }, "就是租约分支"],
    ["no delivery at all", (i: ContinuityInput) => { i.events = []; }, "没有交付"],
    ["no held lease", (i: ContinuityInput) => { i.lease = null; }, "没有 held"],
    ["a merge-stage card", (i: ContinuityInput) => { i.task.stage = "merge"; }, "不是修复"],
    ["a verified card", (i: ContinuityInput) => { i.task.stage = "verified"; }, "不是修复"],
    ["not an auto card of the current spec", (i: ContinuityInput) => { i.auto = false; }, "自动卡"],
    ["no author row", (i: ContinuityInput) => { i.author = null; }, "active 的本机作者"],
    ["a retiring author row", (i: ContinuityInput) => { i.author = { ...i.author!, state: "retiring" }; }, "active 的本机作者"],
    ["a peer author row", (i: ContinuityInput) => { i.author = { ...i.author!, transport: "peer" }; }, "active 的本机作者"],
    ["the card names another executor", (i: ContinuityInput) => { i.task.agent = "agent-y"; }, "不是本机作者会话"],
    ["the card is assigned to a peer agent", (i: ContinuityInput) => { i.task.assigneeKind = "peer_agent"; }, "不是本机作者会话"],
    ["the card is pinned to another peer", (i: ContinuityInput) => { i.task.extra = { placement: "peer:other" }; }, "peer:other"],
  ])("%s → not continuity (today's path)", (_label, change, reason) => {
    const i = base();
    change(i);
    expect(why(i)).toContain(reason);
  });
});

/** The handover's input as the tick would assess it on the stale fix card. */
const input = (p: P) => {
  const t = getTask(p.f.db, "T1")!, c = continuityCheck(p.f.db, t);
  if (!c.ok) throw new Error(c.why);
  return { taskId: "T1", rev: t.rev, sessionId: c.evidence.sessionId, leaseAt: c.evidence.leaseAt };
};
const scheduler = (p: P) => ({ actor: "scheduler", now: p.f.tickDeps.now() });
const unchanged = (p: P, rev: number) => {
  expect(getWriteLease(p.f.db, "T1")).toMatchObject({ state: "held", branch: LEND_BRANCH });
  expect(getTask(p.f.db, "T1")!.rev).toBe(rev);
  expect(ofOp(p, STALE_LEASE_OP)).toEqual([]);
};

describe("applyStaleLeaseHandover: re-checked in its transaction, replayable", () => {
  test("[验收线 5] scheduler only; a moved rev, a switch no longer on, a changed order / intent / session each refuse and write nothing", async () => {
    const p = await ready("on");
    try {
      await toStaleFix(p);
      const ok = input(p), rev = ok.rev;
      expect(() => applyStaleLeaseHandover(p.f.db, { actor: "pm" }, ok)).toThrow("调度服务");
      expect(() => applyStaleLeaseHandover(p.f.db, scheduler(p), { ...ok, rev: rev - 1 })).toThrow("评估之后变了");
      expect(() => applyStaleLeaseHandover(p.f.db, scheduler(p), { ...ok, sessionId: "s-other" })).toThrow("作者会话或写租约代次已变");
      expect(() => applyStaleLeaseHandover(p.f.db, scheduler(p), { ...ok, leaseAt: ok.leaseAt + 1 })).toThrow("作者会话或写租约代次已变");
      p.sw.mode = "observe";
      expect(() => applyStaleLeaseHandover(p.f.db, scheduler(p), ok)).toThrow("已不是 on");
      p.sw.mode = "on";
      p.f.db.run("UPDATE lend_orders SET status = 'claimed' WHERE taskId = 'T1' AND step = 'write'");
      expect(() => applyStaleLeaseHandover(p.f.db, scheduler(p), ok)).toThrow("未结");
      p.f.db.run("UPDATE lend_orders SET status = 'cancelled' WHERE taskId = 'T1' AND step = 'write'");
      p.f.db.run("UPDATE scheduler_intents SET status = 'unknown' WHERE id = (SELECT id FROM scheduler_intents WHERE taskId = 'T1' ORDER BY eventSeq DESC LIMIT 1)");
      expect(() => applyStaleLeaseHandover(p.f.db, scheduler(p), ok)).toThrow("效果不明");
      unchanged(p, rev);
    } finally { p.f.close(); }
  }, E2E_MS);

  test("[验收线 5] committed once: the replay returns the recorded event; other evidence for it is refused", async () => {
    const p = await ready("on");
    try {
      await toStaleFix(p);
      const ok = input(p);
      const first = applyStaleLeaseHandover(p.f.db, scheduler(p), ok);
      expect(first).toMatchObject({ duplicate: false, peer: "mate", agent: "agent-task-one" });
      expect(getTask(p.f.db, "T1")!.rev).toBe(ok.rev + 1);
      expect(applyStaleLeaseHandover(p.f.db, scheduler(p), ok)).toEqual({ ...first, duplicate: true });
      expect(() => applyStaleLeaseHandover(p.f.db, scheduler(p), { ...ok, sessionId: "s-other" })).toThrow("另一组证据");
      expect(ofOp(p, STALE_LEASE_OP)).toHaveLength(1);
      expect(getWriteLease(p.f.db, "T1")).toMatchObject({ state: "ended", reason: "本机原作者接手：agent-task-one" });
      expect(getTask(p.f.db, "T1")).toMatchObject({ agent: "agent-task-one", assigneeKind: "agent" });
    } finally { p.f.close(); }
  }, E2E_MS);
});

describe("local takeover: a continuing original author is not a family switch", () => {
  const OK = { ok: true } as const;
  test("[验收线 2] the Claude-authored refused fix: family_switch without continuity, author_continuity with it (on only)", async () => {
    const p = await blockFixture();
    try {
      await toFix(p, "# 审查报告\nP1：两个 tick 抢同一个意图\n别处粘来的 secret " + "ab".repeat(32));
      expect(await p.tick()).toMatchObject({ step: "pool_refused" });
      p.policy.remote.agents = { claude: 1, codex: 1 };
      p.f.db.run("UPDATE lend_orders SET status = 'cancelled' WHERE taskId = 'T1'"); // as FB2P's own family test: no done Codex build at mate
      p.f.db.run("UPDATE task_workflows SET authorFamily = 'claude' WHERE taskId = 'T1'");
      const facts = (over: Partial<LocalFallbackFacts> = {}): LocalFallbackFacts => ({ ...readLocalFallbackFacts(p.f.db, getTask(p.f.db, "T1")!,
        { registry: [], maxWorkers: 2, now: p.f.tickDeps.now(), pool: { remote: p.policy.remote, borrow: [{ peer: "mate", projects: ["p"], roles: ["review", "write"], maxOpen: 3 }] } },
        { slot: OK, quota: OK }), ...over });
      const mode = { now: "observe" as RecoveryMode };
      setStaleLeasePolicy(p.f.db, () => ({ mode: mode.now, manualAfterMs: null, source: "config" }));
      expect(facts().continuity).toBeNull(); // observe / off: not even read, the takeover answers as before
      expect(assessLocalFallback(facts())).toMatchObject({ kind: "blocked", code: "family_switch" });
      mode.now = "on"; // read now, but mate's own lend branch is the card's: no continuity, still a family switch
      expect(facts().continuity).toMatchObject({ ok: false, why: expect.stringContaining("就是租约分支") });
      expect(assessLocalFallback(facts())).toMatchObject({ kind: "blocked", code: "family_switch" });
      expect(assessLocalFallback(facts({ continuity: { ok: false, why: "最近一次交付来自 peer:mate" } }))).toMatchObject({ kind: "blocked", code: "family_switch" });
      const c = assessContinuity(base());
      expect(assessLocalFallback(facts({ continuity: c }))).toMatchObject({ kind: "blocked", code: "author_continuity",
        reasons: [expect.stringContaining("agent-task-one")] });
    } finally { p.f.close(); }
  }, E2E_MS);
});
