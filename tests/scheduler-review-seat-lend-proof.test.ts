/**
 * REVSEAT1 end to end: a review pinned to its bound local reviewer (this machine does not take codex reviews) waits, and after 30
 * minutes the production auto tick lends it through the existing scheduler-pool offer; B's real take_review / submit_verdict answer
 * it (pool-review-proof-helpers.ts) and the existing pool proof accepts it. Duplicate / concurrent ticks, a peer gone before the
 * offer's transaction, off after the order is out, and tampered receipts are covered here; planner-level cases are in
 * tests/scheduler-review-seat-lend.test.ts.
 */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { mergeReviewProof } from "../src/lib/scheduler-merge.js";
import { aResultDeps, B_WORKER, lendSide } from "./pool-review-proof-helpers.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";
import { addSeat } from "./scheduler-review-seat-fixture.test.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";

/** agents = the agent-pool path (this machine's one codex seat taken); legacy = scheduler.json without agents, this machine off for reviews. */
const AGENTS: RemotePolicy = { agents: { claude: 2, codex: 1 }, mode: "balance", roles: ["review"], poolTimeoutMin: 15 };
const LEGACY: RemotePolicy = { mode: "overflow", roles: ["review"], poolTimeoutMin: 15, localPriority: "off" };
const MIN = 60_000;
/** The session_bind event bindSession writes beside every reviewer row (scheduler-sessions.ts): T1's agent-rv-t1 / s-rv. */
const bindEvent = (db: ReturnType<typeof autoFixture>["db"]) =>
  db.query(`INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (0,'scheduler','p','T1','scheduler','',?)`).run(JSON.stringify({
    op: "session_bind", role: "reviewer", agent: "agent-rv-t1", sessionId: "s-rv", family: "codex", transport: "acp", source: "registry_runtime", intentId: "earlier" }));

afterEach(() => { rmSync(RECOVERY_POLICY_PATH, { force: true }); });
const seatLendOff = () => writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { reviewSeatLend: "off" } } } }));

/** An auto card in review on H1 whose reviewer agent-rv-t1 is bound here (an earlier round's local session). */
async function pinned(opts: { path?: "agents" | "legacy"; offerBorrow?: () => BorrowEntry[] } = {}) {
  const f = autoFixture();
  const agents = (opts.path ?? "agents") === "agents", remote = agents ? AGENTS : LEGACY;
  const spec = join(f.dir, "T1.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
  f.db.run("UPDATE tasks SET spec = ?, pr = 'https://github.com/o/r/pull/7' WHERE id = 'T1'", [spec]);
  const borrow: BorrowEntry[] = [{ peer: "mate", projects: ["p"], roles: ["review"], maxOpen: 1 }];
  const b = lendSide(f.dir);
  const a = aResultDeps(f.dir, b.pinned);
  const lend = { borrow: async () => opts.offerBorrow?.() ?? borrow, notifyPm: async () => {}, result: a.result,
    ...(agents ? { schedulerPolicy: () => ({ remote, maxActiveWorkers: 3 }) } : {}) };
  const cli = (actor: string, ...args: string[]) => f.cliWith({ lend }, actor, ...args) as Promise<Record<string, any>>;
  const deps = { ...f.tickDeps, manager: (...args: string[]) => cli("scheduler", ...args.slice(1)), borrow: async () => borrow };
  const hello = () => agents && recordHello(f.db, "mate", null, { v: 1, proto: 2, boot: "boot-mate", seq: f.tickDeps.now(), paused: null,
    slots: { codex: { total: 2, busy: 0 }, claude: { total: 0, busy: 0 } },
    grant: { until: f.tickDeps.now() + 3_600_000, roles: ["review"], repos: ["o/r"], ordersPerDay: 9, ordersLeftToday: 9 } }, f.tickDeps.now());
  const tick = async () => {
    hello();
    const r = await schedulerAutoTick(f.db, { p: { maxActiveWorkers: agents ? 3 : 2, remote } }, deps);
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards[0];
  };
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
  f.db.run("PRAGMA foreign_keys=OFF"); // the bindings stand for earlier ensures, whose intents this fixture never ran
  f.db.query(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
    VALUES ('T1','reviewer','agent-rv-t1','s-rv','codex','acp','active','earlier',0,0)`).run();
  bindEvent(f.db);
  if (agents) addSeat(f.db, "other", "author", "build"); // another card's codex author holds this machine's only codex seat
  f.db.run("PRAGMA foreign_keys=ON");
  const peer = (ep: string, body: unknown) => cli("owner", `lend-${ep}`, "--", "mate", JSON.stringify(body));
  const notices = f.notices.length;
  const seat = () => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.mechanism === "reviewSeatLend");
  const answer = async (verdict: "pass" | "changes") => {
    const [order] = listLendOrders(f.db, "T1");
    const claim = await peer("claim", { v: 1, orderId: order.orderId, worker: B_WORKER });
    expect(claim.ok).toBe(true);
    return b.answer(claim as never, { verdict, findings: [] }, (body) => peer("write", body));
  };
  return { f, tick, cli, seat, answer, newNotices: () => f.notices.slice(notices) };
}

const reviewIntents = (f: ReturnType<typeof autoFixture>) => f.intents().filter((i) => i.action === "review");

for (const path of ["agents", "legacy"] as const) {
  test(`[验收线 1] ${path} pool path: waits 29 minutes, lends exactly one order at 30, card stays auto with no PM push of its own`, async () => {
    const p = await pinned({ path });
    try {
      expect(await p.tick()).toMatchObject({ step: "waiting" });
      expect(p.seat().filter((e) => e.data.seat === "start")).toHaveLength(1);
      p.f.advance(29 * MIN);
      expect(await p.tick()).toMatchObject({ step: "waiting" });
      expect(listLendOrders(p.f.db, "T1")).toHaveLength(0);
      p.f.advance(MIN);
      expect(await p.tick()).toMatchObject({ step: "pool_pooled" });
      expect(await p.tick()).toMatchObject({ step: "pool_pooled" });
      const orders = listLendOrders(p.f.db, "T1");
      expect(orders).toHaveLength(1);
      expect(reviewIntents(p.f)).toEqual([expect.objectContaining({ recipient: "peer:mate", status: "pending" })]);
      const offer = listEvents(p.f.db, { project: "p", target: "T1" }).find((e) => e.data.op === "pool_offer")!;
      expect(offer.data).toMatchObject({ orderId: orders[0].orderId, seatLend: { evidence: "local_full", reviewer: "agent-rv-t1", reviewerSessionId: "s-rv", head: H1 } });
      expect(getWorkflow(p.f.db, "T1")!.mode).toBe("auto");
      // legacy: localPriority off keeps its existing one-time info notice (scheduler-family-pick-notice.ts); this card adds none
      expect(p.newNotices().filter((t) => !t.includes("本机审查已关闭，保持自动调度"))).toEqual([]);
      expect(p.newNotices().length).toBeLessThanOrEqual(path === "legacy" ? 1 : 0);
    } finally { p.f.close(); }
  });
}

for (const path of ["agents", "legacy"] as const) {
  test(`[验收线 2] ${path} pool path, real ticks: the reviewer retired 10 minutes in still waits the full 30 minutes`, async () => {
    const p = await pinned({ path });
    try {
      expect(await p.tick()).toMatchObject({ step: "waiting" });
      p.f.advance(10 * MIN);
      p.f.db.query("UPDATE scheduler_sessions SET state='retired' WHERE taskId='T1' AND role='reviewer'").run();
      expect(await p.tick()).toMatchObject({ step: "waiting" });
      p.f.advance(19 * MIN);
      expect(await p.tick()).toMatchObject({ step: "waiting" });
      expect(listLendOrders(p.f.db, "T1")).toHaveLength(0);
      p.f.advance(MIN);
      expect(await p.tick()).toMatchObject({ step: "pool_pooled" });
      expect(listLendOrders(p.f.db, "T1")).toHaveLength(1);
      const offer = listEvents(p.f.db, { project: "p", target: "T1" }).find((e) => e.data.op === "pool_offer")!;
      expect(offer.data).toMatchObject({ seatLend: { evidence: "reviewer_gone", reviewer: "agent-rv-t1", reviewerSessionId: "s-rv" } });
    } finally { p.f.close(); }
  });

  test(`[验收线 2] ${path} pool path, real ticks: a reviewer retired before the first tick waits 30 minutes from that tick`, async () => {
    const p = await pinned({ path });
    try {
      p.f.db.query("UPDATE scheduler_sessions SET state='retired' WHERE taskId='T1' AND role='reviewer'").run();
      expect(await p.tick()).toMatchObject({ step: "waiting" });
      expect(p.seat().filter((e) => e.data.seat === "start")).toHaveLength(1);
      p.f.advance(29 * MIN);
      expect(await p.tick()).toMatchObject({ step: "waiting" });
      expect(listLendOrders(p.f.db, "T1")).toHaveLength(0);
      p.f.advance(MIN);
      expect(await p.tick()).toMatchObject({ step: "pool_pooled" });
      expect(listLendOrders(p.f.db, "T1")).toHaveLength(1);
      const offer = listEvents(p.f.db, { project: "p", target: "T1" }).find((e) => e.data.op === "pool_offer")!;
      expect(offer.data).toMatchObject({ seatLend: { evidence: "reviewer_gone", reviewer: "agent-rv-t1", reviewerSessionId: "s-rv" } });
    } finally { p.f.close(); }
  });

  test(`[验收线 2] ${path} pool path, real ticks: retired mid-wait then a new head waits a fresh 30 minutes`, async () => {
    const p = await pinned({ path });
    try {
      await p.tick(); p.f.advance(10 * MIN);
      p.f.db.query("UPDATE scheduler_sessions SET state='retired' WHERE taskId='T1' AND role='reviewer'").run();
      expect(await p.tick()).toMatchObject({ step: "waiting" });
      p.f.db.query("UPDATE tasks SET headSHA=? WHERE id='T1'").run("3".repeat(40));
      expect(await p.tick()).toMatchObject({ step: "waiting" });
      expect(listLendOrders(p.f.db, "T1")).toHaveLength(0);
      p.f.advance(29 * MIN);
      expect(await p.tick()).toMatchObject({ step: "waiting" });
      expect(listLendOrders(p.f.db, "T1")).toHaveLength(0);
      p.f.advance(MIN);
      expect(await p.tick()).toMatchObject({ step: "pool_pooled" });
      expect(listLendOrders(p.f.db, "T1")).toHaveLength(1);
    } finally { p.f.close(); }
  });

  test(`[验收线 2] ${path} pool path, real ticks: head A → B → A restarts A's 30 minutes`, async () => {
    const p = await pinned({ path });
    const head = (sha: string) => p.f.db.query("UPDATE tasks SET headSHA=? WHERE id='T1'").run(sha);
    try {
      await p.tick(); p.f.advance(10 * MIN);
      head("3".repeat(40)); await p.tick(); p.f.advance(20 * MIN);
      head(H1);
      expect(await p.tick()).toMatchObject({ step: "waiting" });
      p.f.advance(29 * MIN);
      expect(await p.tick()).toMatchObject({ step: "waiting" });
      expect(listLendOrders(p.f.db, "T1")).toHaveLength(0);
      p.f.advance(MIN);
      expect(await p.tick()).toMatchObject({ step: "pool_pooled" });
      expect(listLendOrders(p.f.db, "T1")).toHaveLength(1);
    } finally { p.f.close(); }
  });
}

test("[验收线 4] the peer's same-head pass with its full receipts moves the card on without a re-review and passes the merge proof", async () => {
  const p = await pinned();
  try {
    await p.tick(); p.f.advance(30 * MIN); await p.tick();
    expect((await p.answer("pass")).r).toMatchObject({ ok: true });
    for (let n = 0; n < 4 && p.f.task().stage === "review"; n++) await p.tick();
    expect(p.f.task().stage).toBe("merge");
    expect(reviewIntents(p.f)).toHaveLength(1);
    expect(mergeReviewProof(p.f.db, p.f.task(), getWorkflow(p.f.db, "T1")!)).toMatchObject({ reviewer: "peer:mate", head: H1, verdict: "pass" });
    expect(getWorkflow(p.f.db, "T1")!.mode).toBe("auto");
    expect(p.newNotices().filter((t) => t.includes("退回人工"))).toEqual([]);
  } finally { p.f.close(); }
});

test("[验收线 5] a lent verdict whose receipt signature or order id was altered is refused by the merge proof", async () => {
  const p = await pinned();
  try {
    await p.tick(); p.f.advance(30 * MIN); await p.tick();
    await p.answer("pass");
    for (let n = 0; n < 4 && p.f.task().stage === "review"; n++) await p.tick();
    const [order] = listLendOrders(p.f.db, "T1");
    const proof = () => mergeReviewProof(p.f.db, p.f.task(), getWorkflow(p.f.db, "T1")!);
    const raw = (p.f.db.query("SELECT receipt FROM lend_orders WHERE orderId = ?").get(order.orderId) as { receipt: string }).receipt;
    const receipt = JSON.parse(raw) as Record<string, unknown>;
    for (const forged of [{ ...receipt, sig: "" }, { ...receipt, orderId: `${order.orderId}x` }]) {
      p.f.db.query("UPDATE lend_orders SET receipt = ? WHERE orderId = ?").run(JSON.stringify(forged), order.orderId);
      expect(proof).toThrow("入账回执");
    }
    p.f.db.query("UPDATE lend_orders SET receipt = ? WHERE orderId = ?").run(raw, order.orderId);
    expect(proof()).toMatchObject({ reviewer: "peer:mate" });
  } finally { p.f.close(); }
});

test("[验收线 3] concurrent ticks after the threshold still leave one intent and one order", async () => {
  const p = await pinned();
  try {
    await p.tick(); p.f.advance(30 * MIN);
    await Promise.all([p.tick(), p.tick(), p.tick()]);
    await p.tick();
    expect(listLendOrders(p.f.db, "T1")).toHaveLength(1);
    expect(reviewIntents(p.f).filter((i) => i.status !== "cancelled")).toHaveLength(1);
  } finally { p.f.close(); }
});

test("[验收线 3] the peer gone by the offer's own transaction: no order, the intent is cancelled, the card stays auto and waits", async () => {
  let offerPeers: BorrowEntry[] = [];
  const p = await pinned({ offerBorrow: () => offerPeers });
  try {
    await p.tick(); p.f.advance(30 * MIN);
    const r = await p.tick();
    expect(r.step).not.toBe("pool_pooled");
    expect(listLendOrders(p.f.db, "T1")).toHaveLength(0);
    expect(reviewIntents(p.f)).toEqual([expect.objectContaining({ recipient: "peer:mate", status: "cancelled" })]);
    expect(getWorkflow(p.f.db, "T1")!.mode).toBe("auto");
    offerPeers = [{ peer: "mate", projects: ["p"], roles: ["review"], maxOpen: 1 }];
    expect(p.newNotices()).toEqual([]);
  } finally { p.f.close(); }
});

test("[验收线 6] off after the order is out: no new lend, the real order still syncs to its verdict as before", async () => {
  const p = await pinned();
  try {
    await p.tick(); p.f.advance(30 * MIN); await p.tick();
    seatLendOff();
    expect((await p.answer("pass")).r).toMatchObject({ ok: true });
    for (let n = 0; n < 4 && p.f.task().stage === "review"; n++) await p.tick();
    expect(p.f.task().stage).toBe("merge");
    expect(listLendOrders(p.f.db, "T1")).toHaveLength(1);
  } finally { p.f.close(); }
});

test("[验收线 6] off before the threshold: the card keeps the legacy local wait forever and nothing is recorded", async () => {
  const p = await pinned();
  try {
    seatLendOff();
    const first = await p.tick();
    p.f.advance(120 * MIN);
    expect(await p.tick()).toEqual(first);
    expect(p.seat()).toEqual([]);
    expect(listLendOrders(p.f.db, "T1")).toHaveLength(0);
    expect(reviewIntents(p.f)).toHaveLength(0);
  } finally { p.f.close(); }
});
