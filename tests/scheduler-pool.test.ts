/**
 * i28-R9 shared pool: the planner's pool branches (local slot free / no slot, can pool / no slot, cannot pool / family /
 * one attempt per round), then the whole path on a real ledger through the ledger CLI: pool → peer claims → peer's verdict
 * → card moves on; timeout withdrawal, withdrawal racing a claim, released and unknown orders, and the in-transaction
 * re-plan refusing an offer the current facts no longer justify.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import type { LedgerTask } from "../src/lib/ledger-stages.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { checkSchedulerPool } from "../src/lib/doctor-scheduler.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { planScheduler, type PlannerSnapshot } from "../src/lib/scheduler-plan.js";
import { poolTarget, type PoolFacts } from "../src/lib/scheduler-pool-plan.js";
import { autoFixture, H1, H2, P1, toBuild } from "./scheduler-auto-helpers.js";

const REMOTE: RemotePolicy = { mode: "overflow", roles: ["review"], poolTimeoutMin: 15 };
const MIN = 60_000;

describe("i28-R9 pool planner (pure)", () => {
  const head = "a".repeat(40);
  const facts = (over: Partial<PoolFacts> = {}): PoolFacts =>
    ({ remote: REMOTE, localReviewers: 2, peers: [{ peer: "mate", open: 0, maxOpen: 1 }], repo: "o/r", lastPeer: null, ...over });
  const snap = (pool: PoolFacts | null, over: Partial<PlannerSnapshot> = {}): PlannerSnapshot => ({
    task: { id: "T1", project: "p", kind: "code", stage: "review", round: 1, headSHA: head, specRev: 1 } as LedgerTask,
    workflow: { taskId: "T1", project: "p", template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "x", specRev: 1,
      rev: 1, createdAt: 1, updatedAt: 1 },
    events: [], intents: [], blockedBy: [], queueFrozen: false, fileGlobs: [], heldResources: [], workerCount: 0, maxWorkers: 2,
    freeWorkerSlot: null, author: null, reviewer: null, reviewDispatches: [], uiGate: { state: "none" }, screenshotsDigest: null, pool, ...over,
  });

  test("local reviewer capacity free → no pool; full → pool to the first peer with room; prefer pools even with room", () => {
    expect(poolTarget(snap(facts({ localReviewers: 1 })), 0)).toBeNull();
    expect(poolTarget(snap(facts()), 0)).toEqual({ peer: "mate", family: "codex", rereview: false });
    expect(poolTarget(snap(facts({ localReviewers: 0, peers: [{ peer: "a", open: 1, maxOpen: 1 }, { peer: "b", open: 0, maxOpen: 2 }] }), { maxWorkers: 0 }), 0))
      .toMatchObject({ peer: "b" });
    expect(poolTarget(snap(facts({ localReviewers: 0, remote: { ...REMOTE, mode: "prefer" } })), 0)).toMatchObject({ peer: "mate" });
  });

  test("no slot but cannot pool: remote off, no review role, no borrow entry, peer full, no PR repo, security, bound reviewer", () => {
    const blocked: PlannerSnapshot[] = [
      snap(null), snap(facts({ remote: { ...REMOTE, mode: "off" } })), snap(facts({ remote: { ...REMOTE, roles: [] } })), snap(facts({ peers: [] })),
      snap(facts({ peers: [{ peer: "mate", open: 1, maxOpen: 1 }] })), snap(facts({ repo: null })),
      snap(facts(), { reviewer: { agent: "rv", sessionId: "s", taskId: "T1", family: "codex", source: "local" } }),
    ];
    const security = snap(facts());
    security.workflow = { ...security.workflow!, template: "security" };
    for (const s of [...blocked, security]) expect(poolTarget(s, 0)).toBeNull();
    const decision = planScheduler({ ...snap(facts({ peers: [] })), events: [{ seq: 1, kind: "task", data: { op: "new" } } as never] });
    expect(decision).toMatchObject({ kind: "intent", action: "ensure_session", sessionRole: "reviewer" });
  });

  test("a Codex-authored card needs a Claude reviewer, which is not lendable in v1: never pooled", () => {
    const s = snap(facts());
    s.workflow = { ...s.workflow!, authorFamily: "codex" };
    expect(poolTarget(s, 0)).toBeNull();
  });

  test("one pool attempt per round and head; a re-review goes back to the answering peer first, local room or not", () => {
    const tried = { id: "i1", taskId: "T1", project: "p", node: "adversarial_review", action: "review", recipient: "peer:mate", causalSeq: 5, eventSeq: 6,
      taskRev: 1, specRev: 1, head, templateVersion: 2, status: "cancelled", attempts: 1, receipt: null, reason: "x", createdAt: 1, updatedAt: 1 } as const;
    expect(poolTarget(snap(facts(), { intents: [tried] }), 5)).toBeNull();
    expect(poolTarget(snap(facts(), { intents: [tried] }), 7)).toMatchObject({ peer: "mate" }); // earlier stage entry = earlier round
    const again = facts({ localReviewers: 0, lastPeer: "mate", peers: [{ peer: "b", open: 0, maxOpen: 1 }, { peer: "mate", open: 0, maxOpen: 1 }] });
    expect(poolTarget(snap(again), 0)).toEqual({ peer: "mate", family: "codex", rereview: true });
    expect(poolTarget(snap({ ...again, peers: [{ peer: "b", open: 0, maxOpen: 1 }] }), 0)).toBeNull();
  });
});

/** An auto card delivered for review, with lend.json borrow, spec text, PR link and the lend CLI deps injected. */
async function pooled(opts: { maxWorkers?: number; remote?: RemotePolicy; borrow?: BorrowEntry[] } = {}) {
  const f = autoFixture();
  const spec = join(f.dir, "T1.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
  f.db.run("UPDATE tasks SET spec = ?, pr = 'https://github.com/o/r/pull/7' WHERE id = 'T1'", [spec]);
  const state = { borrow: opts.borrow ?? [{ peer: "mate", projects: ["p"], roles: ["review"], maxOpen: 1 }] as BorrowEntry[], lendNotices: [] as string[] };
  const reports = join(f.dir, "reports");
  mkdirSync(reports);
  const key = instanceKeySync(mkdtempSync(join(f.dir, "key-")));
  const lend = {
    borrow: async () => state.borrow, notifyPm: async (_p: string, t: string) => { state.lendNotices.push(t); },
    result: { reportDir: () => reports, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: (x: string[]) => signPurpose(RECEIPT_PURPOSE, x, key) },
  };
  const cli = (actor: string, ...args: string[]) => f.cliWith({ lend }, actor, ...args) as Promise<Record<string, any>>;
  const deps = { ...f.tickDeps, manager: (...args: string[]) => cli("scheduler", ...args.slice(1)), borrow: async () => state.borrow };
  const policy = { maxActiveWorkers: opts.maxWorkers ?? 0, remote: opts.remote ?? REMOTE };
  const tick = async () => {
    const r = await schedulerAutoTick(f.db, { p: policy }, deps);
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards[0];
  };
  const peer = (ep: string, body: unknown) => cli("owner", `lend-${ep}`, "--", "mate", JSON.stringify(body));
  const claim = (orderId: string) => peer("claim", { v: 1, orderId, worker: "w1" });
  const verdict = (orderId: string, h: string, findings: object[] = []) => peer("write", {
    v: 1, orderId, gen: 1, report: "## 结论", session: { id: "sess-1", family: "codex" },
    verdict: { v: 1, orderId, head: h, verdict: findings.length ? "changes" : "pass", p0: 0, p1: findings.length, p2: 0, findings, reportPath: "r.md" },
  });
  const orders = () => listLendOrders(f.db, "T1");
  await toBuild(f);
  await f.tick(); // write order
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
  return { f, state, cli, tick, claim, verdict, orders, policy };
}

describe("i28-R9 pool path on a real ledger", () => {
  test("no local slot → pooled to mate's Codex worker; claim = submitted, the peer's verdict = done, the card moves to merge", async () => {
    const p = await pooled();
    try {
      expect(await p.tick()).toMatchObject({ step: "pool_pooled", detail: expect.stringContaining("挂给 mate 的 codex worker") });
      const [o] = p.orders();
      expect(o).toMatchObject({ status: "pooled", peer: "mate", family: "codex", head: H1, repo: "o/r", pr: 7, createdBy: "scheduler" });
      expect(p.f.intents().at(-1)).toMatchObject({ action: "review", status: "pending", recipient: "peer:mate" });
      expect(await p.tick()).toMatchObject({ step: "pool_pooled" });
      expect(p.orders()).toHaveLength(1);
      expect((await p.claim(o.orderId)).ok).toBe(true);
      expect(await p.tick()).toMatchObject({ step: "pool_claimed" });
      expect(p.f.intents().at(-1)).toMatchObject({ status: "submitted" });
      expect(await p.verdict(o.orderId, H1)).toMatchObject({ ok: true });
      expect(await p.tick()).toMatchObject({ step: "pool_done" });
      expect(await p.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
      expect(await p.tick()).toMatchObject({ step: "merge_queue" });
      expect(p.f.ensured.map((e) => e.role)).toEqual(["author"]); // no local reviewer session was ever made
      expect(p.f.sent.map((s) => s.agent)).toEqual(["agent-task-one", "agent-task-one"]);
      const checks = checkSchedulerPool(new LedgerReader(join(p.f.dir, "ledger.sqlite")));
      expect(checks[0]).toMatchObject({ status: "ok", detail: expect.stringContaining("已交结论 1") });
    } finally { p.f.close(); }
  });

  test("a claim and a verdict landing between two passes still settle in order and pass the review proof", async () => {
    const p = await pooled();
    try {
      await p.tick();
      const [o] = p.orders();
      await p.claim(o.orderId);
      await p.verdict(o.orderId, H1);
      expect(await p.tick()).toMatchObject({ step: "pool_done" });
      expect(await p.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
    } finally { p.f.close(); }
  });

  test("P1 from the pool → fix → the re-review goes back to the same peer; unclaimed for 15 min → withdrawn once, PM told, local cross-family review", async () => {
    const p = await pooled();
    try {
      await p.tick();
      const [o] = p.orders();
      await p.claim(o.orderId);
      await p.verdict(o.orderId, H1, [{ ...P1, description: "d" }]);
      await p.tick();
      expect(await p.tick()).toMatchObject({ step: "stage", detail: "review→fix" });
      p.policy.maxActiveWorkers = 1;
      expect(await p.tick()).toMatchObject({ step: "sent" }); // fix order to the author
      await p.f.cli("agent-task-one", "deliver", "T1", "--from", "fix", "--head", H2);
      p.policy.maxActiveWorkers = 5; // local room: a re-review still goes back to the answering peer first
      expect(await p.tick()).toMatchObject({ step: "pool_pooled", detail: expect.stringContaining("mate") });
      expect(p.orders().map((x) => x.status)).toEqual(["done", "pooled"]);
      p.f.advance(16 * MIN);
      expect(await p.tick()).toMatchObject({ step: "pool_timeout" });
      expect(p.orders()[1]).toMatchObject({ status: "cancelled", reason: expect.stringContaining("挂池超时") });
      expect(p.f.notices.filter((n) => n.includes("没人领"))).toHaveLength(1);
      expect(await p.tick()).toMatchObject({ step: "session", detail: "reviewer = agent-rv-t1" });
      expect(await p.tick()).toMatchObject({ step: "sent", detail: "acp" });
      expect(p.orders()).toHaveLength(2);
      expect((await p.f.review("pass", H2, [])).ok).toBe(true);
      expect(await p.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
      expect(p.f.notices.filter((n) => n.includes("没人领"))).toHaveLength(1);
    } finally { p.f.close(); }
  });

  test("withdrawal vs claim: a claim that wins keeps the order (no cancel, no PM notice); after a withdrawal the claim is refused", async () => {
    const p = await pooled();
    try {
      await p.tick();
      const [o] = p.orders();
      p.f.advance(16 * MIN);
      expect((await p.claim(o.orderId)).ok).toBe(true);
      expect(await p.tick()).toMatchObject({ step: "pool_claimed" });
      expect(p.orders()[0].status).toBe("claimed");
      expect(p.f.notices).toEqual([]);
    } finally { p.f.close(); }
    const q = await pooled();
    try {
      await q.tick();
      const [o] = q.orders();
      q.f.advance(16 * MIN);
      expect(await q.tick()).toMatchObject({ step: "pool_timeout" });
      expect(await q.claim(o.orderId)).toMatchObject({ ok: false, current: { lend: "cancelled" } });
      expect(q.orders()[0].status).toBe("cancelled");
    } finally { q.f.close(); }
  });

  test("claimed but the lease runs out → unknown: the intent stops for PM and the card is held, never re-pooled", async () => {
    const p = await pooled();
    try {
      await p.tick();
      const [o] = p.orders();
      await p.claim(o.orderId);
      await p.tick();
      p.f.advance(11 * MIN);
      expect((await p.cli("owner", "lend-sweep")).expired).toBe(1);
      expect(await p.tick()).toMatchObject({ step: "pool_unknown" });
      expect(p.f.intents().at(-1)).toMatchObject({ status: "unknown" });
      expect(await p.tick()).toMatchObject({ step: "held" });
      expect(p.orders()).toHaveLength(1);
    } finally { p.f.close(); }
  });

  test("a released order sends the round back local; no second pool order", async () => {
    const p = await pooled();
    try {
      await p.tick();
      const [o] = p.orders();
      await p.claim(o.orderId);
      await p.cli("owner", "lend-lease", "--", "mate", JSON.stringify({ v: 1, orderId: o.orderId, gen: 1, action: "release", reason: "not_started", detail: null }));
      expect(await p.tick()).toMatchObject({ step: "pool_returned" });
      expect(await p.tick()).toMatchObject({ step: "session", detail: "reviewer = agent-rv-t1" });
      expect(p.orders()).toHaveLength(1);
    } finally { p.f.close(); }
  });

  test("local room, remote off, no borrow entry or a peer at maxOpen → the review stays local", async () => {
    for (const opts of [{ maxWorkers: 1 }, { remote: { ...REMOTE, mode: "off" as const } }, { borrow: [] },
      { borrow: [{ peer: "mate", projects: ["other"], roles: ["review" as const], maxOpen: 1 }] }]) {
      const p = await pooled(opts);
      try {
        expect(await p.tick()).toMatchObject({ step: "session", detail: "reviewer = agent-rv-t1" });
        expect(p.orders()).toEqual([]);
      } finally { p.f.close(); }
    }
  });

  test("the offer re-plans inside its transaction: a pool intent the current facts no longer justify is cancelled, nothing is offered", async () => {
    const p = await pooled();
    try {
      const snapshot = autoSnapshot(p.f.db, p.f.task(), { registry: [], maxWorkers: 0, now: Date.now(), pool: { remote: REMOTE, borrow: p.state.borrow } });
      const plan = planScheduler(snapshot);
      if (plan.kind !== "intent") throw new Error("expected a pool intent");
      const seq = (p.f.db.query("SELECT MAX(seq) AS s FROM events").get() as { s: number }).s;
      const t = p.f.task();
      expect((await p.cli("scheduler", "scheduler-plan", "T1", "--id", plan.id, "--rev", String(t.rev), "--workflow-rev", "1", "--seq", String(seq),
        "--node", plan.node, "--action", "review", "--recipient", plan.recipient!, "--reason", plan.reason, "--resources", plan.resources.join(","))).ok).toBe(true);
      const r = await p.cli("scheduler", "scheduler-pool", plan.id, "--max-workers", "3", "--mode", "overflow", "--roles", "review", "--timeout-min", "15");
      expect(r).toMatchObject({ ok: true, outcome: "refused", intent: { status: "cancelled" } });
      expect(p.orders()).toEqual([]);
      expect(await p.cli("agent-pm", "scheduler-pool", plan.id, "--max-workers", "0", "--mode", "overflow", "--roles", "review", "--timeout-min", "15"))
        .toMatchObject({ ok: false });
      const text = listEvents(p.f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "pool_offer");
      expect(text).toEqual([]);
    } finally { p.f.close(); }
  });
});
