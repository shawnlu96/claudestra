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
import type { Grant } from "../src/lib/lend-wire-v2.js";
import type { RemoteHead } from "../src/lib/order-deliver.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
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
  return { f, cli, tick, hello, lendCall, remote, orders: () => listLendOrders(f.db, "T1"), plans };
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

describe("the fix of a remote-written card", () => {
  test("goes back to the lease holder with the last report inlined; it never becomes a local work order", async () => {
    const p = await ready({ borrow: [borrowOf("mate"), borrowOf("other", "first")] });
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
      const report = join(p.f.dir, "report.md");
      writeFileSync(report, "# 审查报告\nP1：两个 tick 抢同一个意图");
      const findings = join(p.f.dir, "p1.json");
      writeFileSync(findings, JSON.stringify([P1]));
      expect(await p.cli("agent-rv-t1", "review", "T1", "--reviewer", "agent-rv-t1", "--verdict", "changes", "--p0", "0", "--p1", "1", "--p2", "0",
        "--head", H2, "--session", "s-rv", "--family", "claude", "--findings", findings, "--path", report)).toMatchObject({ ok: true });
      await p.tick(); // → fix
      expect(p.f.task().stage).toBe("fix");
      p.hello("mate");
      p.hello("other"); // a first-tier peer, but it does not hold the lease
      expect(await p.tick()).toMatchObject({ step: "pool_pooled", detail: expect.stringContaining("修复挂给 mate") });
      expect(p.orders().at(-1)).toMatchObject({ step: "fix", peer: "mate", family: "codex", head: H2, branch: BRANCH });
      expect(p.plans().at(-1)?.text).toContain("写租约在 mate，修复单派回它");
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
