/**
 * i28-W9 end to end on a real ledger, through the scheduler tick, the pool CLI (whose offer re-plans with the daemon's flags)
 * and the lend CLI the bridge maps the lender's calls onto: a build order goes to a peer that may write, the lender claims
 * it and delivers a lend/ branch with a PR, the card moves to review, and the review goes across to Claude (never back to the
 * lender's Codex), up to the merge gate. Tiers on the same path: a `first` peer wins, full `first` falls back to `balance`,
 * `low` only when balance is full, `off` never. A grant / borrow / config without write never gets a write order, and a
 * project without write plans its local build exactly as before.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import type { BorrowEntry, Priority } from "../src/lib/lend-config.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { deliver } from "../src/lib/ledger-write.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import type { Grant } from "../src/lib/lend-wire-v2.js";
import type { RemoteHead } from "../src/lib/order-deliver.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { remoteHeadFamily } from "../src/lib/scheduler-head-family.js";
import { advanceMergeRun, beginMergeRun } from "../src/lib/scheduler-merge.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { autoFixture, H2, P1, toBuild } from "./scheduler-auto-helpers.js";

const BASE_SHA = "b".repeat(40);
const FP = "abcd-ef01-2345-6789";
const BRANCH = "lend/T1-abcd";
const WRITE: RemotePolicy = { mode: "balance", roles: ["review", "write"], poolTimeoutMin: 15, repo: "o/r" };
const REVIEW_ONLY: RemotePolicy = { mode: "balance", roles: ["review"], poolTimeoutMin: 15 };
const borrowOf = (peer: string, priority?: Priority, roles: BorrowEntry["roles"] = ["review", "write"]): BorrowEntry =>
  ({ peer, projects: ["p"], roles, maxOpen: 3, ...(priority ? { priority } : {}) });
type Slots = { codex: { total: number; busy: number }; claude: { total: number; busy: number } };
const CODEX_ONLY: Slots = { codex: { total: 2, busy: 0 }, claude: { total: 0, busy: 0 } };

async function ready(o: { remote?: RemotePolicy; borrow?: BorrowEntry[]; maxWorkers?: number } = {}) {
  const f = autoFixture({ reviewerRuntime: "claude-code" });
  // The fixture's reviewer is an ACP Codex session; here it is a Claude one, which the channel worker drives over tmux.
  const reg = JSON.parse(readFileSync(f.registryPath, "utf8"));
  delete reg.agents["agent-rv-t1"].transport;
  writeFileSync(f.registryPath, JSON.stringify(reg));
  const spec = join(f.dir, "T1.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
  f.db.run("UPDATE tasks SET spec = ? WHERE id = 'T1'", [spec]);
  const reports = join(f.dir, "reports");
  mkdirSync(reports);
  const key = instanceKeySync(mkdtempSync(join(f.dir, "key-")));
  const borrow = o.borrow ?? [borrowOf("mate")];
  const policy = { maxActiveWorkers: o.maxWorkers ?? 2, remote: o.remote ?? WRITE };
  const remote: Record<string, RemoteHead> = { main: { ok: true, head: BASE_SHA } };
  const lend = {
    borrow: async () => borrow, notifyPm: async () => {}, schedulerPolicy: () => policy,
    result: { reportDir: () => reports, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: (x: string[]) => signPurpose(RECEIPT_PURPOSE, x, key),
      peerFp: async () => FP, remoteHead: async (_repo: string, branch: string) => remote[branch] ?? { ok: false as const, error: "没有这个分支" } },
  };
  const cli = (actor: string, ...args: string[]) => f.cliWith({ lend }, actor, ...args) as Promise<Record<string, any>>;
  const deps = { ...f.tickDeps, manager: (...args: string[]) => cli("scheduler", ...args.slice(1)), borrow: async () => borrow };
  const tick = async () => {
    const r = await schedulerAutoTick(f.db, { p: policy }, deps);
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards[0];
  };
  let seq = 0;
  const hello = (peer: string, grant: Partial<Grant> = {}, slots: Slots = CODEX_ONLY) =>
    recordHello(f.db, peer, null, { v: 1, proto: 2, boot: `boot-${peer}`, seq: ++seq, slots, paused: null,
      grant: { until: f.tickDeps.now() + 3_600_000, roles: ["review", "write"], repos: ["o/r"], ordersPerDay: 50, ordersLeftToday: 50, ...grant } }, f.tickDeps.now());
  const lendCall = (op: string, peer: string, body: unknown) => cli("owner", op, "--", peer, JSON.stringify(body));
  const plans = () => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.kind === "scheduler" && e.data.op === "plan");
  await toBuild(f);
  return { f, cli, tick, hello, lendCall, remote, policy, borrow, orders: () => listLendOrders(f.db, "T1"), plans };
}

describe("a build order to a peer, delivered, reviewed across families", () => {
  test("build → peer writes (lend/ branch + PR) → review → Claude reviews, not the lender's Codex → merge", async () => {
    const p = await ready();
    try {
      p.hello("mate");
      expect(await p.tick()).toMatchObject({ step: "pool_pooled", detail: expect.stringContaining("开工挂给 mate 的 codex worker") });
      expect(p.plans().at(-1)?.data).toMatchObject({ action: "dispatch", recipient: "peer:mate" });
      expect(p.plans().at(-1)?.text).toContain("开工单派给 mate 的 codex worker");
      const [order] = p.orders();
      expect(order).toMatchObject({ step: "write", peer: "mate", family: "codex", status: "pooled", branch: BRANCH, head: BASE_SHA });
      expect(p.f.sent.filter((s) => s.text.includes("开工"))).toEqual([]); // the local author got no work order
      // The worker slot the card held since restate is released: a peer writing it takes nothing of this machine's cap.
      expect(p.plans().at(-1)?.data.releasedSlots).toEqual([expect.stringMatching(/^slot:p:/)]);
      expect(slotsOf(p, "T1")).toEqual([]);
      expect(snapshot(p)).toMatchObject({ workerCount: 0, freeWorkerSlot: expect.stringMatching(/^slot:p:/) });

      expect(await p.lendCall("lend-claim", "mate", { v: 1, orderId: order.orderId, worker: "w1" })).toMatchObject({ ok: true });
      expect(await p.tick()).toMatchObject({ step: "pool_claimed", detail: "w1@mate 在写" });
      p.remote[BRANCH] = { ok: true, head: H2 };
      const delivered = await p.lendCall("lend-write", "mate", { v: 1, orderId: order.orderId, gen: 1, branch: BRANCH, pr: 7,
        session: { id: "sess-1", family: "codex" }, deliver: { v: 1, orderId: order.orderId, head: H2, evidence: BRANCH, summary: "实现了 x", selfCheck: "单测全绿" } });
      expect(delivered).toMatchObject({ ok: true });
      expect(p.f.task()).toMatchObject({ stage: "review", headSHA: H2, branch: BRANCH, pr: "https://github.com/o/r/pull/7" });
      expect(await p.tick()).toMatchObject({ step: "pool_done" });

      // mate only lends Codex: the review of a Codex-written head cannot go there, it becomes a local Claude reviewer.
      p.hello("mate");
      await p.tick();
      expect(p.f.ensured.at(-1)).toEqual({ role: "reviewer", family: "claude" });
      expect(p.orders()).toHaveLength(1);
      await p.tick();
      expect(p.f.intents().at(-1)).toMatchObject({ action: "review", recipient: "agent-rv-t1" });

      const findings = join(p.f.dir, "none.json");
      writeFileSync(findings, "[]");
      const verdict = (family: string) => p.cli("agent-rv-t1", "review", "T1", "--reviewer", "agent-rv-t1", "--verdict", "pass", "--p0", "0", "--p1", "0",
        "--p2", "0", "--head", H2, "--session", "s-rv", "--family", family, "--findings", findings, "--path", "reviews/T1-r1/report.md");
      expect(await verdict("claude")).toMatchObject({ ok: true });
      await p.tick();
      expect(p.f.task().stage).toBe("merge");
    } finally { p.f.close(); }
  });

  test("a Codex verdict on the Codex-written head is refused: the bound reviewer is Claude, nothing is recorded", async () => {
    const p = await ready();
    try {
      p.hello("mate");
      await p.tick();
      const [order] = p.orders();
      await p.lendCall("lend-claim", "mate", { v: 1, orderId: order.orderId, worker: "w1" });
      p.remote[BRANCH] = { ok: true, head: H2 };
      await p.lendCall("lend-write", "mate", { v: 1, orderId: order.orderId, gen: 1, branch: BRANCH, pr: 7, session: { id: "sess-1", family: "codex" },
        deliver: { v: 1, orderId: order.orderId, head: H2, evidence: BRANCH, summary: "实现了 x", selfCheck: "单测全绿" } });
      await p.tick(); // pool_done
      await p.tick(); // reviewer session (claude)
      await p.tick(); // review order
      const findings = join(p.f.dir, "none.json");
      writeFileSync(findings, "[]");
      const r = await p.cli("agent-rv-t1", "review", "T1", "--reviewer", "agent-rv-t1", "--verdict", "pass", "--p0", "0", "--p1", "0", "--p2", "0",
        "--head", H2, "--session", "s-rv", "--family", "codex", "--findings", findings, "--path", "reviews/T1-r1/report.md");
      expect(r).toMatchObject({ ok: false, code: "forbidden", error: expect.stringContaining("agent-rv-t1 / s-rv / claude") });
      expect(listEvents(p.f.db, { project: "p", target: "T1" }).filter((e) => e.kind === "review")).toEqual([]);
      await p.tick();
      expect(p.f.task().stage).toBe("review");
    } finally { p.f.close(); }
  });
});

const slotsOf = (p: Awaited<ReturnType<typeof ready>>, task: string) =>
  p.f.db.query("SELECT resource FROM scheduler_resources WHERE taskId = ? AND resource LIKE 'slot:%'").all(task);
const snapshot = (p: Awaited<ReturnType<typeof ready>>) => autoSnapshot(p.f.db, p.f.task(), { registry: [], maxWorkers: p.policy.maxActiveWorkers,
  now: p.f.tickDeps.now(), pool: { remote: p.policy.remote, borrow: p.borrow } });

/** Build → mate's Codex writes H2 → delivered → a local Claude reviewer holds the review order. */
async function toRemoteReview(p: Awaited<ReturnType<typeof ready>>) {
  p.hello("mate");
  await p.tick();
  const [order] = p.orders();
  await p.lendCall("lend-claim", "mate", { v: 1, orderId: order.orderId, worker: "w1" });
  p.remote[BRANCH] = { ok: true, head: H2 };
  await p.lendCall("lend-write", "mate", { v: 1, orderId: order.orderId, gen: 1, branch: BRANCH, pr: 7, session: { id: "sess-1", family: "codex" },
    deliver: { v: 1, orderId: order.orderId, head: H2, evidence: BRANCH, summary: "实现了 x", selfCheck: "单测全绿" } });
  await p.tick(); // pool_done
  await p.tick(); // reviewer session (claude)
  await p.tick(); // review order
}

/** toRemoteReview, then one P1 at `report` → the card is in fix. */
async function toRemoteFix(p: Awaited<ReturnType<typeof ready>>, report: string) {
  await toRemoteReview(p);
  const findings = join(p.f.dir, "p1.json");
  writeFileSync(findings, JSON.stringify([P1]));
  expect(await p.cli("agent-rv-t1", "review", "T1", "--reviewer", "agent-rv-t1", "--verdict", "changes", "--p0", "0", "--p1", "1", "--p2", "0",
    "--head", H2, "--session", "s-rv", "--family", "claude", "--findings", findings, "--path", report)).toMatchObject({ ok: true });
  await p.tick(); // → fix
  expect(p.f.task().stage).toBe("fix");
}

describe("the fix of a remote-written card", () => {
  test("goes back to the lease holder with the last report inlined; it never becomes a local work order", async () => {
    const p = await ready({ borrow: [borrowOf("mate"), borrowOf("other", "first")] });
    try {
      const report = join(p.f.dir, "report.md");
      writeFileSync(report, "# 审查报告\nP1：两个 tick 抢同一个意图");
      await toRemoteFix(p, report);
      p.hello("mate");
      p.hello("other"); // a first-tier peer, but it does not hold the lease
      expect(await p.tick()).toMatchObject({ step: "pool_pooled", detail: expect.stringContaining("修复挂给 mate") });
      expect(p.orders().at(-1)).toMatchObject({ step: "fix", peer: "mate", family: "codex", head: H2, branch: BRANCH });
      expect(p.plans().at(-1)?.text).toContain("写租约在 mate，修复单派回它");
    } finally { p.f.close(); }
  });

  test("the lease holder's fix could not go out (no report to inline): the card stops for PM, it does not wait silently", async () => {
    const p = await ready();
    try {
      await toRemoteFix(p, join(p.f.dir, "missing-report.md"));
      p.hello("mate");
      expect(await p.tick()).toMatchObject({ step: "pool_refused", detail: expect.stringContaining("找不到上一轮审查报告原文") });
      expect(await p.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining("placement_lease") });
      expect(p.orders().filter((o) => o.step === "fix")).toEqual([]);
    } finally { p.f.close(); }
  });
});

describe("tiers on the real path (the pool step re-plans with the same tiers)", () => {
  test("a first peer gets the build even when a balance peer is idler, and the offer keeps it there", async () => {
    const p = await ready({ borrow: [borrowOf("a"), borrowOf("b", "first")] });
    try {
      p.hello("a");
      p.hello("b");
      expect(await p.tick()).toMatchObject({ step: "pool_pooled" });
      expect(p.orders()).toMatchObject([{ peer: "b", step: "write", status: "pooled" }]);
      expect(p.plans().at(-1)?.text).toContain("档位 first");
    } finally { p.f.close(); }
  });

  test("first full → balance; balance full (local too) → low; off never, the card waits on local capacity", async () => {
    const full: Slots = { codex: { total: 0, busy: 0 }, claude: { total: 0, busy: 0 } };
    const a = await ready({ borrow: [borrowOf("f", "first"), borrowOf("b"), borrowOf("l", "low")] });
    try {
      a.hello("f", {}, full);
      a.hello("b");
      a.hello("l");
      await a.tick();
      expect(a.orders()).toMatchObject([{ peer: "b" }]);
    } finally { a.f.close(); }

    const b = await ready({ borrow: [borrowOf("b"), borrowOf("l", "low")], maxWorkers: 0 });
    try {
      b.hello("b", {}, full);
      b.hello("l");
      // The card's own restate slot is room for its writing (dispatchWork's gate); without one this machine is full.
      b.f.db.run("DELETE FROM scheduler_resources WHERE taskId = 'T1' AND resource LIKE 'slot:%'");
      await b.tick();
      expect(b.orders()).toMatchObject([{ peer: "l" }]);
    } finally { b.f.close(); }

    const c = await ready({ borrow: [borrowOf("o", "off")], maxWorkers: 0 });
    try {
      c.hello("o");
      await c.tick();
      expect(c.orders()).toEqual([]);
      expect(c.f.intents().at(-1)).toMatchObject({ action: "dispatch", recipient: "agent-task-one" });
    } finally { c.f.close(); }
  });

  test("this machine off: with no peer that can take it the build waits, it is not run here", async () => {
    const p = await ready({ remote: { ...WRITE, localPriority: "off" }, borrow: [borrowOf("o", "off")] });
    try {
      p.hello("o");
      expect(await p.tick()).toMatchObject({ step: "waiting", detail: expect.stringContaining("localPriority = off") });
      expect(p.orders()).toEqual([]);
      expect(p.f.intents().filter((i) => i.action === "dispatch" && i.node !== "restate")).toEqual([]);
    } finally { p.f.close(); }
  });
});

describe("no write, no write order", () => {
  test("lender's grant without write: the build stays local", async () => {
    const p = await ready();
    try {
      p.hello("mate", { roles: ["review"] });
      await p.tick();
      expect(p.orders()).toEqual([]);
      expect(p.f.intents().at(-1)).toMatchObject({ action: "dispatch", recipient: "agent-task-one" });
    } finally { p.f.close(); }
  });

  test("borrow entry without write: the build stays local", async () => {
    const p = await ready({ borrow: [borrowOf("mate", "first", ["review"])] });
    try {
      p.hello("mate");
      await p.tick();
      expect(p.orders()).toEqual([]);
      expect(p.f.intents().at(-1)).toMatchObject({ action: "dispatch", recipient: "agent-task-one" });
    } finally { p.f.close(); }
  });

  test("a project without write: same local build plan as a project that never pools", async () => {
    const p = await ready({ remote: REVIEW_ONLY, borrow: [borrowOf("mate", "first")] });
    const q = await ready({ remote: { ...REVIEW_ONLY, mode: "off" }, borrow: [] });
    try {
      p.hello("mate");
      await p.tick();
      await q.tick();
      const strip = (x: { data: Record<string, unknown>; text: string }) => ({ text: x.text, action: x.data.action, recipient: x.data.recipient, resources: x.data.resources });
      expect(strip(p.plans().at(-1)!)).toEqual(strip(q.plans().at(-1)!));
      expect(p.orders()).toEqual([]);
    } finally { p.f.close(); q.f.close(); }
  });
});

describe("off is off on every path, and writing room is the writer's (r1)", () => {
  /** Built here (the fixture's own tick, no pool) and delivered at H2 with its PR: the card is in review, not placed yet. */
  async function builtHere(p: Awaited<ReturnType<typeof ready>>) {
    await p.f.tick();
    p.f.db.run("UPDATE tasks SET pr = 'https://github.com/o/r/pull/7' WHERE id = 'T1'");
    expect(await p.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H2)).toMatchObject({ ok: true });
  }

  test("an off peer without hello (proto 1) is not picked by the old overflow rule either; local off too: the review waits", async () => {
    const p = await ready({ remote: { ...REVIEW_ONLY, localPriority: "off" }, borrow: [borrowOf("mate", "off", ["review"])], maxWorkers: 0 });
    try {
      await builtHere(p);
      expect(await p.tick()).toMatchObject({ step: "waiting", detail: expect.stringContaining("localPriority = off") });
      expect(p.orders()).toEqual([]);
    } finally { p.f.close(); }
  });

  test("a balance peer without hello still takes the overflow when this machine is off (off counts as full)", async () => {
    const p = await ready({ remote: { ...REVIEW_ONLY, localPriority: "off" }, borrow: [borrowOf("mate", undefined, ["review"])] });
    try {
      await builtHere(p);
      expect(await p.tick()).toMatchObject({ step: "pool_pooled" });
      expect(p.orders()).toMatchObject([{ peer: "mate", step: "review" }]);
    } finally { p.f.close(); }
  });

  test("this machine turned off after its reviewer session was bound: the review waits, nothing is sent here", async () => {
    const p = await ready({ borrow: [] });
    try {
      // Written here by Claude: the reviewer is the fixture's own Codex (ACP) session again.
      const reg = JSON.parse(readFileSync(p.f.registryPath, "utf8"));
      reg.agents["agent-rv-t1"] = { ...reg.agents["agent-rv-t1"], runtime: "codex", transport: "acp" };
      writeFileSync(p.f.registryPath, JSON.stringify(reg));
      await builtHere(p);
      expect(await p.tick()).toMatchObject({ step: "session" });
      p.policy.remote = { ...WRITE, localPriority: "off" };
      const sent = p.f.sent.length;
      expect(await p.tick()).toMatchObject({ step: "waiting", detail: expect.stringContaining("localPriority = off") });
      expect(p.f.sent.length).toBe(sent);
      p.policy.remote = WRITE;
      expect(await p.tick()).toMatchObject({ step: "sent" });
    } finally { p.f.close(); }
  });

  test("writing room is the card's own worker slot, not the reviewer count: local first keeps the build here", async () => {
    const p = await ready({ remote: { ...WRITE, localPriority: "first" }, borrow: [borrowOf("mate", "low")] });
    try {
      p.hello("mate");
      const s = snapshot(p);
      expect(slotsOf(p, "T1")).toHaveLength(1);
      s.pool!.localReviewers = 2; // every reviewer place taken by other cards
      expect(planScheduler(s)).toMatchObject({ kind: "intent", recipient: "agent-task-one" });
      s.heldResources = s.heldResources.filter((h) => h.taskId !== "T1");
      s.workerCount = 2; // no slot of its own and none free: the low peer writes it
      expect(planScheduler(s)).toMatchObject({ kind: "intent", recipient: "peer:mate" });
    } finally { p.f.close(); }
  });
});

describe("the author is the newest delivery, not the newest head (r3)", () => {
  const H3 = "3".repeat(40);
  test("update-branch to a new head after the Claude pass: still Codex-written, the same Claude reviewer reviews it again", async () => {
    const p = await ready();
    try {
      await toRemoteReview(p);
      const findings = join(p.f.dir, "none.json");
      writeFileSync(findings, "[]");
      expect(await p.cli("agent-rv-t1", "review", "T1", "--reviewer", "agent-rv-t1", "--verdict", "pass", "--p0", "0", "--p1", "0", "--p2", "0",
        "--head", H2, "--session", "s-rv", "--family", "claude", "--findings", findings, "--path", "reviews/T1-r1/report.md")).toMatchObject({ ok: true });
      await p.tick(); // → merge
      await p.tick(); // merge intent
      const intent = p.f.intents().at(-1)!;
      expect(intent.action).toBe("merge");
      const ctx = { actor: "scheduler", now: p.f.tickDeps.now() + 1 };
      if (intent.status === "pending") settleIntent(p.f.db, ctx, { id: intent.id, from: "pending", to: "submitted", receipt: "merge claimed" });
      const run = beginMergeRun(p.f.db, ctx, intent.id, ["check"]).run;
      const updating = advanceMergeRun(p.f.db, ctx, { intentId: intent.id, from: "ready", to: "updating", rev: run.rev });
      advanceMergeRun(p.f.db, ctx, { intentId: intent.id, from: "updating", to: "await_review", rev: updating.rev, newHead: H3,
        receipt: "update-branch succeeded; carry unavailable, review again" });
      expect(p.f.task()).toMatchObject({ stage: "review", headSHA: H3 });
      expect(remoteHeadFamily(p.f.db, p.f.task())).toBe("codex");
      const snap = autoSnapshot(p.f.db, p.f.task(), { registry: [], maxWorkers: 2, now: ctx.now, pool: { remote: p.policy.remote, borrow: p.borrow } });
      expect(snap.workflow?.authorFamily).toBe("codex");
      expect(planScheduler(snap).kind).not.toBe("escalate");
    } finally { p.f.close(); }
  });

  test("a later local delivery is the author again: the remote family no longer applies", async () => {
    const p = await ready();
    try {
      await toRemoteFix(p, "reviews/T1-r1/report.md");
      expect(remoteHeadFamily(p.f.db, p.f.task())).toBe("codex");
      // The fix written here (as a fix without lease would be): a delivery with a head that no lend order recorded.
      deliver(p.f.db, { actor: "agent-task-one", now: p.f.tickDeps.now() + 1 }, { taskId: "T1", headSHA: H3 });
      expect(p.f.task()).toMatchObject({ stage: "fix", headSHA: H3 });
      expect(remoteHeadFamily(p.f.db, p.f.task())).toBeNull();
    } finally { p.f.close(); }
  });
});
