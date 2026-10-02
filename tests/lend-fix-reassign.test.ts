/**
 * i28-RA1 end to end on a real ledger, through the scheduler tick, the pool CLI and the lend CLI (same harness as
 * scheduler-write-remote.test.ts): a fix waiting on a busy write-lease holder past remote.fixReassignMin is reassigned to
 * another peer with a free slot of the card's writing family, from the PR's current head on the new peer's own lend/ branch,
 * with no PR number (the lender opens a new PR whose base is main); after delivery the old PR is closed with a comment that
 * points at the new one. Under the threshold, or with no other free peer, it keeps waiting; a second reassignment within
 * the hour goes to PM. Plus the pure pieces: the planner's candidate keeps the review family, ensurePr's base is main.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { getWriteLease } from "../src/lib/ledger-lend-lease.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { listEvents } from "../src/lib/ledger-store.js";
import type { Grant } from "../src/lib/lend-wire-v2.js";
import type { RemoteHead } from "../src/lib/order-deliver.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { parseRemotePolicy, type RemotePolicy } from "../src/lib/scheduler-config.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { orderFamily } from "../src/lib/scheduler-placement-plan.js";
import { remoteHeadFamily } from "../src/lib/scheduler-head-family.js";
import { ensurePr } from "../src/lib/lend-push.js";
import { writeMaterials } from "../src/lib/lend-write-materials.js";
import { orderDir } from "../src/lib/lend-clone.js";
import { relayCandidate } from "../src/lib/lend-fix-reassign.js";
import { FIX_LEASE_WAIT_OP, FIX_RELAY_OP, FIX_RELAY_CLOSED_OP, RELAY_DRIFT } from "../src/lib/lend-fix-reassign-event.js";
import type { Gh } from "../src/lib/lend-fix-reassign-pr.js";
import type { PlacementFacts } from "../src/lib/scheduler-placement.js";
import { autoFixture, H2, P1, toBuild } from "./scheduler-auto-helpers.js";

const H3 = "3".repeat(40);
const FPS: Record<string, string> = { mate: "abcd-ef01-2345-6789", other: "fe12-ef01-2345-6789" };
const BRANCH = "lend/T1-abcd";
const RELAY_BRANCH = "lend/T1-fe12";
const MIN = 60_000;
/** Many ticks through the real CLI: the 5 s default is tight when the whole suite runs in parallel. */
const E2E_MS = 30_000;
const WRITE: RemotePolicy = { mode: "balance", roles: ["review", "write"], poolTimeoutMin: 15, repo: "o/r" };
const borrowOf = (peer: string): BorrowEntry => ({ peer, projects: ["p"], roles: ["review", "write"], maxOpen: 3 });
type Slots = { codex: { total: number; busy: number }; claude: { total: number; busy: number } };
const FREE: Slots = { codex: { total: 2, busy: 0 }, claude: { total: 0, busy: 0 } };
const FULL: Slots = { codex: { total: 2, busy: 2 }, claude: { total: 0, busy: 0 } };

async function ready(remote: RemotePolicy = WRITE) {
  const f = autoFixture({ reviewerRuntime: "claude-code" });
  const reg = JSON.parse(readFileSync(f.registryPath, "utf8"));
  delete reg.agents["agent-rv-t1"].transport;
  writeFileSync(f.registryPath, JSON.stringify(reg));
  const spec = join(f.dir, "T1.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
  f.db.run("UPDATE tasks SET spec = ? WHERE id = 'T1'", [spec]);
  const reports = join(f.dir, "reports");
  mkdirSync(reports);
  const key = instanceKeySync(mkdtempSync(join(f.dir, "key-")));
  const borrow = [borrowOf("mate"), borrowOf("other")];
  const policy = { maxActiveWorkers: 2, remote };
  const heads: Record<string, RemoteHead> = { main: { ok: true, head: "b".repeat(40) } };
  const gh: string[][] = [];
  const ghFail = { left: 0 };
  const relayGh: Gh = async (args) => {
    gh.push(args);
    return ghFail.left-- > 0 ? { code: 1, stdout: "", stderr: "gh: 502", timedOut: false } : { code: 0, stdout: "", stderr: "", timedOut: false };
  };
  const lend = {
    borrow: async () => borrow, notifyPm: async () => {}, schedulerPolicy: () => policy,
    result: { reportDir: () => reports, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: (x: string[]) => signPurpose(RECEIPT_PURPOSE, x, key),
      peerFp: async (peer: string) => FPS[peer] ?? null, remoteHead: async (_repo: string, branch: string) => heads[branch] ?? { ok: false as const, error: "没有这个分支" } },
  };
  const cli = (actor: string, ...args: string[]) => f.cliWith({ lend, relayGh }, actor, ...args) as Promise<Record<string, any>>;
  const deps = { ...f.tickDeps, manager: (...args: string[]) => cli("scheduler", ...args.slice(1)), borrow: async () => borrow };
  const tick = async () => {
    const r = await schedulerAutoTick(f.db, { p: policy }, deps);
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards[0];
  };
  let seq = 0;
  const hello = (peer: string, slots: Slots = FREE, grant: Partial<Grant> = {}) =>
    recordHello(f.db, peer, null, { v: 1, proto: 2, boot: `boot-${peer}`, seq: ++seq, slots, paused: null,
      grant: { until: f.tickDeps.now() + 3 * 3_600_000, roles: ["review", "write"], repos: ["o/r"], ordersPerDay: 50, ordersLeftToday: 50, ...grant } }, f.tickDeps.now());
  const lendCall = (op: string, peer: string, body: unknown) => cli("owner", op, "--", peer, JSON.stringify(body));
  const events = () => listEvents(f.db, { project: "p", target: "T1" });
  await toBuild(f);
  return { f, cli, tick, hello, lendCall, heads, gh, ghFail, policy, borrow, events, orders: () => listLendOrders(f.db, "T1") };
}
type P = Awaited<ReturnType<typeof ready>>;

async function deliverAs(p: P, peer: string, orderId: string, branch: string, head: string, pr: number) {
  expect(await p.lendCall("lend-claim", peer, { v: 1, orderId, worker: "w1" })).toMatchObject({ ok: true });
  p.heads[branch] = { ok: true, head };
  expect(await p.lendCall("lend-write", peer, { v: 1, orderId, gen: 1, branch, pr, session: { id: `sess-${peer}`, family: "codex" },
    deliver: { v: 1, orderId, head, evidence: branch, summary: "改好了", selfCheck: "单测全绿" } })).toMatchObject({ ok: true });
}

/** Changes at `head` from the bound Claude reviewer (mate / other write in Codex) → the card is in fix. */
async function reviewToFix(p: P, head: string) {
  await p.tick(); // pool_done
  await p.tick(); // reviewer session (claude)
  await p.tick(); // review order
  const report = join(p.f.dir, `report-${head.slice(0, 4)}.md`);
  writeFileSync(report, "# 审查报告\nP1：两个 tick 抢同一个意图");
  const findings = join(p.f.dir, `p1-${head.slice(0, 4)}.json`);
  writeFileSync(findings, JSON.stringify([P1]));
  expect(await p.cli("agent-rv-t1", "review", "T1", "--reviewer", "agent-rv-t1", "--verdict", "changes", "--p0", "0", "--p1", "1", "--p2", "0",
    "--head", head, "--session", "s-rv", "--family", "claude", "--findings", findings, "--path", report)).toMatchObject({ ok: true });
  await p.tick(); // → fix
  expect(p.f.task()).toMatchObject({ stage: "fix", headSHA: head });
}

/** Build → mate's Codex writes H2 with PR #7 → reviewed with one P1 → fix, write lease at mate. */
async function toFix(p: P) {
  p.hello("mate");
  await p.tick();
  await deliverAs(p, "mate", p.orders()[0].orderId, BRANCH, H2, 7);
  await reviewToFix(p, H2);
  expect(getWriteLease(p.f.db, "T1")).toMatchObject({ peer: "mate", branch: BRANCH, state: "held" });
}

const relays = (p: P) => p.events().filter((e) => e.kind === "scheduler" && e.data.op === FIX_RELAY_OP);

describe("automatic fix reassignment (i28-RA1)", () => {
  test("holder busy past the threshold, another peer free: reassigned from the PR head; new PR base main; old PR closed with a link", async () => {
    const p = await ready();
    try {
      await toFix(p);
      p.hello("mate", FULL);
      p.hello("other");
      const fixes = () => p.orders().filter((o) => o.step === "fix");
      expect(await p.tick()).toMatchObject({ detail: expect.stringContaining("写租约在 mate") });
      expect(fixes()).toEqual([]);

      p.f.advance(21 * MIN);
      p.hello("mate", FULL);
      p.hello("other");
      expect(await p.tick()).toMatchObject({ step: "pool_pooled", detail: expect.stringContaining("修复挂给 other") });
      const order = fixes().at(-1)!;
      // Start = the PR's current head; the new lender's own branch; no PR number, base main: the lender opens a new PR on main.
      expect(order).toMatchObject({ peer: "other", family: "codex", head: H2, branch: RELAY_BRANCH, base: "main", pr: null, status: "pooled" });
      expect(order.wire.findings).toEqual([P1]);
      expect(getWriteLease(p.f.db, "T1")).toMatchObject({ peer: "other", branch: RELAY_BRANCH, state: "held" });
      const [relay] = relays(p);
      expect(relay.data).toMatchObject({ from: "mate", to: "other", head: H2, fromBranch: BRANCH, toBranch: RELAY_BRANCH, oldPr: 7, repo: "o/r" });
      expect(relay.data.reason).toContain("超过阈值");
      expect(await p.lendCall("lend-claim", "other", { v: 1, orderId: order.orderId, worker: "w1" })).toMatchObject({ ok: true, write: { branch: RELAY_BRANCH, base: "main" } });

      p.heads[RELAY_BRANCH] = { ok: true, head: H3 };
      expect(await p.lendCall("lend-write", "other", { v: 1, orderId: order.orderId, gen: 1, branch: RELAY_BRANCH, pr: 9, session: { id: "s2", family: "codex" },
        deliver: { v: 1, orderId: order.orderId, head: H3, evidence: RELAY_BRANCH, summary: "改好了", selfCheck: "单测全绿" } })).toMatchObject({ ok: true });
      expect(p.f.task()).toMatchObject({ stage: "review", headSHA: H3, branch: RELAY_BRANCH, pr: "https://github.com/o/r/pull/9" });
      expect(p.gh).toEqual([]);
      expect(await p.tick()).toMatchObject({ step: "pool_done" });
      expect(p.gh).toEqual([["pr", "close", "7", "--repo", "o/r", "--comment", expect.stringContaining("接力 PR：#9（base main）")]]);
      expect(p.events().filter((e) => e.data.op === FIX_RELAY_CLOSED_OP).map((e) => e.data)).toEqual([expect.objectContaining({ oldPr: 7, newPr: 9 })]);
      await p.tick();
      expect(p.gh).toHaveLength(1); // closed once
      // Cross-family review holds: the relay head was written by Codex, so its review goes to Claude.
      expect(remoteHeadFamily(p.f.db, p.f.task())).toBe("codex");
      expect(p.f.ensured.at(-1)).toEqual({ role: "reviewer", family: "claude" });
    } finally { p.f.close(); }
  }, E2E_MS);

  test("holder busy but under the threshold: no reassignment", async () => {
    const p = await ready();
    try {
      await toFix(p);
      p.hello("mate", FULL);
      p.hello("other");
      await p.tick(); // the holder-wait clock starts here
      p.f.advance(19 * MIN);
      p.hello("mate", FULL);
      p.hello("other");
      expect(await p.tick()).toMatchObject({ detail: expect.stringContaining("写租约在 mate") });
      expect(p.orders().filter((o) => o.step === "fix")).toEqual([]);
      expect(relays(p)).toEqual([]);
      expect(getWriteLease(p.f.db, "T1")).toMatchObject({ peer: "mate", state: "held" });
    } finally { p.f.close(); }
  }, E2E_MS);

  test("the threshold comes from scheduler.json remote.fixReassignMin", async () => {
    const p = await ready({ ...WRITE, fixReassignMin: 5 });
    try {
      await toFix(p);
      p.hello("mate", FULL);
      await p.tick();
      p.f.advance(6 * MIN);
      p.hello("mate", FULL);
      p.hello("other");
      expect(await p.tick()).toMatchObject({ step: "pool_pooled", detail: expect.stringContaining("修复挂给 other") });
      expect(parseRemotePolicy({ ...WRITE, fixReassignMin: 5 }).fixReassignMin).toBe(5);
      expect(() => parseRemotePolicy({ ...WRITE, fixReassignMin: 0 })).toThrow("fixReassignMin");
    } finally { p.f.close(); }
  }, E2E_MS);

  test("no other peer has a free slot: the fix keeps waiting on the holder", async () => {
    const p = await ready();
    try {
      await toFix(p);
      p.f.advance(30 * MIN);
      p.hello("mate", FULL);
      p.hello("other", FULL);
      expect(await p.tick()).toMatchObject({ detail: expect.stringContaining("写租约在 mate") });
      expect(p.orders().filter((o) => o.step === "fix")).toEqual([]);
      expect(relays(p)).toEqual([]);
    } finally { p.f.close(); }
  }, E2E_MS);

  test("the holder still has a live order on the card: no reassignment", async () => {
    const p = await ready();
    try {
      await toFix(p);
      p.hello("mate");
      expect(await p.tick()).toMatchObject({ step: "pool_pooled", detail: expect.stringContaining("修复挂给 mate") });
      expect(await p.lendCall("lend-claim", "mate", { v: 1, orderId: p.orders().at(-1)!.orderId, worker: "w2" })).toMatchObject({ ok: true });
      p.f.advance(30 * MIN);
      p.hello("mate", FULL);
      p.hello("other");
      await p.tick();
      expect(p.orders().filter((o) => o.step === "fix").map((o) => o.peer)).toEqual(["mate"]);
      expect(relays(p)).toEqual([]);
    } finally { p.f.close(); }
  }, E2E_MS);

  test("a second reassignment within the hour goes to PM instead of bouncing the card back", async () => {
    const p = await ready();
    try {
      await toFix(p);
      p.hello("mate", FULL);
      await p.tick();
      p.f.advance(21 * MIN);
      p.hello("mate", FULL);
      p.hello("other");
      await p.tick();
      const order = p.orders().at(-1)!;
      expect(order).toMatchObject({ peer: "other", branch: RELAY_BRANCH });
      await deliverAs(p, "other", order.orderId, RELAY_BRANCH, H3, 9);
      await reviewToFix(p, H3);
      // Now the holder is other, busy; mate is free again. 21 more minutes: still within the hour of the first relay.
      p.hello("other", FULL);
      p.hello("mate");
      await p.tick();
      p.f.advance(21 * MIN);
      p.hello("other", FULL);
      p.hello("mate");
      expect(await p.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining("一小时内已自动改派过一次（mate → other）") });
      expect(relays(p)).toHaveLength(1);
      expect(getWriteLease(p.f.db, "T1")).toMatchObject({ peer: "other", state: "held" });
      expect(p.orders().filter((o) => o.step === "fix").map((o) => o.peer)).toEqual(["other"]);
    } finally { p.f.close(); }
  }, E2E_MS);
});

describe("pure pieces", () => {
  const facts = (slots: Record<string, Record<"claude" | "codex", number>>): PlacementFacts => ({
    remote: WRITE, repo: "o/r", local: { running: 0, room: true }, pin: null, tried: [], lastPeer: null, writeLeasePeer: "mate", locksFree: true,
    peers: Object.entries(slots).map(([peer, s]) => ({ peer, roles: ["review", "write"], open: 0,
      v2: { why: null, slots: s, roles: ["review", "write"], repos: ["o/r"] } })),
  });

  test("the candidate writes in the card's family only, so the review family (its opposite) stays different", () => {
    const f = facts({ mate: { claude: 0, codex: 0 }, other: { claude: 1, codex: 0 } });
    expect(relayCandidate(f, "mate", "codex")).toBeNull(); // other only has Claude: a Claude fix of a Codex head is not a relay
    expect(relayCandidate(f, "mate", "claude")?.peer).toBe("other");
    expect(relayCandidate({ ...f, tried: ["other"] }, "mate", "claude")).toBeNull();
    expect(relayCandidate(facts({ mate: { claude: 0, codex: 2 } }), "mate", "codex")).toBeNull(); // the holder itself is never a candidate
  });

  test("the order family at the relay peer is the head writer's family", async () => {
    const p = await ready();
    try {
      await toFix(p);
      p.hello("other");
      const snap = autoSnapshot(p.f.db, p.f.task(), { registry: [], maxWorkers: 2, now: p.f.tickDeps.now(), pool: { remote: WRITE, borrow: p.borrow } });
      expect(snap.workflow?.authorFamily).toBe("codex");
      expect(orderFamily(snap, "other", "fix")).toBe("codex");
    } finally { p.f.close(); }
  }, E2E_MS);

  test("the lender opens the relay PR against the order's base (main) and the relay branch", async () => {
    const calls: string[][] = [];
    const run = async (argv: string[]) => {
      calls.push(argv);
      return argv.includes("list") ? { code: 0, stdout: "", stderr: "", timedOut: false }
        : { code: 0, stdout: "https://github.com/o/r/pull/9\n", stderr: "", timedOut: false };
    };
    const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "relay-pr-"));
    mkdirSync(orderDir("lend:T1:s1:r1:a1", root, "push"), { recursive: true }); // the push step made it before the PR
    const r = await ensurePr({ orderId: "lend:T1:s1:r1:a1", repo: "o/r", branch: RELAY_BRANCH, base: "main", pr: null, title: "t", body: "b" },
      { root, env: { PATH: process.env.PATH, HOME: process.env.HOME }, run });
    expect(r).toEqual({ ok: true, pr: 9 });
    const create = calls.find((c) => c.includes("create"))!;
    expect(create.slice(create.indexOf("--base"), create.indexOf("--base") + 4)).toEqual(["--base", "main", "--head", RELAY_BRANCH]);
  });

  test("lend-offer --base only picks the start commit: the build order's PR base is main (no more PRs on feat/*-base)", async () => {
    const f = autoFixture({});
    try {
      await toBuild(f);
      expect(f.task().stage).toBe("build");
      const w = await writeMaterials(f.db, f.task(), { peer: "other", repo: "o/r", base: "feat/i28-T1-base" },
        { peerFp: async () => FPS.other, remoteHead: async (_r, b) => b === "feat/i28-T1-base" ? { ok: true, head: H3 } : { ok: false, error: "no" } });
      expect(w).toMatchObject({ base: "main", baseSha: H3 });
    } finally { f.close(); }
  }, E2E_MS);
});

describe("relay review fixes (i28-RA1 round 1)", () => {
  const leaseWaits = (p: P) => p.events().filter((e) => e.kind === "scheduler" && e.data.op === FIX_LEASE_WAIT_OP);
  const both = (p: P, mate: Slots, other: Slots = FREE) => { p.hello("mate", mate); p.hello("other", other); };

  test("a wait on a file lock does not count: the clock starts only when the holder itself cannot take the fix", async () => {
    const p = await ready();
    try {
      await toFix(p);
      const globs = (p.f.db.query("SELECT json_extract(extra, '$.fileGlobs') AS g FROM tasks WHERE id = 'T1'").get() as { g: string }).g;
      p.f.db.run(`UPDATE tasks SET extra = json_set(extra, '$.fileGlobs', json('["bad path"]')) WHERE id = 'T1'`); // a lock nobody can take
      both(p, FREE);
      expect(await p.tick()).toMatchObject({ detail: expect.stringContaining("文件锁") });
      p.f.advance(21 * MIN);
      both(p, FREE);
      expect(await p.tick()).toMatchObject({ detail: expect.stringContaining("文件锁") });
      expect(leaseWaits(p)).toEqual([]);
      // Lock released and the holder only now becomes busy: 21 minutes of lock wait are not a holder wait.
      p.f.db.run("UPDATE tasks SET extra = json_set(extra, '$.fileGlobs', json(?)) WHERE id = 'T1'", [globs]);
      both(p, FULL);
      expect(await p.tick()).toMatchObject({ step: "waiting", detail: expect.stringContaining("写租约在 mate") });
      expect(relays(p)).toEqual([]);
      expect(leaseWaits(p).map((e) => e.data.state)).toEqual(["start"]);
      p.f.advance(19 * MIN);
      both(p, FULL);
      expect(await p.tick()).toMatchObject({ step: "waiting" });
      p.f.advance(2 * MIN);
      both(p, FULL);
      expect(await p.tick()).toMatchObject({ step: "pool_pooled", detail: expect.stringContaining("修复挂给 other") });
    } finally { p.f.close(); }
  }, E2E_MS);

  /** The holder's fix intent is refused at the offer (its fingerprint vanished): the holder is tried, the lease stays with it. */
  async function holderTried(p: P, other: Slots) {
    await toFix(p);
    const fp = FPS.mate;
    delete FPS.mate;
    try {
      both(p, FREE, other);
      expect(await p.tick()).toMatchObject({ step: "pool_refused", detail: expect.stringContaining("写单材料没备好") });
    } finally { FPS.mate = fp; }
    expect(getWriteLease(p.f.db, "T1")).toMatchObject({ peer: "mate", state: "held" });
  }

  test("the holder was tried this round and the lease is still its: past the threshold the relay happens, no PM escalation", async () => {
    const p = await ready();
    try {
      await holderTried(p, FULL);
      both(p, FULL);
      expect(await p.tick()).toMatchObject({ step: "waiting", detail: expect.stringContaining("写租约在 mate") });
      p.f.advance(21 * MIN);
      both(p, FULL);
      expect(await p.tick()).toMatchObject({ step: "pool_pooled", detail: expect.stringContaining("修复挂给 other") });
      expect(relays(p).map((e) => e.data)).toEqual([expect.objectContaining({ from: "mate", to: "other", head: H2 })]);
    } finally { p.f.close(); }
  }, E2E_MS);

  test("tried holder and no other free peer: PM escalation as before", async () => {
    const p = await ready();
    try {
      await holderTried(p, FULL);
      both(p, FULL, FULL);
      expect(await p.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining("这一轮没成") });
    } finally { p.f.close(); }
  }, E2E_MS);

  test("the old PR branch moved past the ledger head: no relay from the stale commit, the card goes to PM", async () => {
    const p = await ready();
    try {
      await toFix(p);
      both(p, FULL);
      await p.tick();
      p.heads[BRANCH] = { ok: true, head: H3 }; // pushed after delivery, ledger still at H2
      p.f.advance(21 * MIN);
      both(p, FULL);
      expect(await p.tick()).toMatchObject({ step: "pool_refused", detail: expect.stringContaining(RELAY_DRIFT) });
      expect(relays(p)).toEqual([]);
      expect(p.orders().filter((o) => o.step === "fix")).toEqual([]);
      expect(getWriteLease(p.f.db, "T1")).toMatchObject({ peer: "mate", state: "held" });
      both(p, FULL);
      expect(await p.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining(RELAY_DRIFT) });
    } finally { p.f.close(); }
  }, E2E_MS);

  test("closing the old PR failed once: later passes retry it until it is closed with the link", async () => {
    const p = await ready();
    try {
      await toFix(p);
      both(p, FULL);
      await p.tick();
      p.f.advance(21 * MIN);
      both(p, FULL);
      await p.tick();
      const order = p.orders().at(-1)!;
      expect(order).toMatchObject({ peer: "other", branch: RELAY_BRANCH });
      await deliverAs(p, "other", order.orderId, RELAY_BRANCH, H3, 9);
      p.ghFail.left = 2; // gh pr close and the state check both fail
      await p.tick();
      expect(p.gh.map((a) => a.slice(0, 2))).toEqual([["pr", "close"], ["pr", "view"]]);
      const closed = () => p.events().filter((e) => e.data.op === FIX_RELAY_CLOSED_OP);
      expect(closed()).toEqual([]);
      await p.tick();
      expect(p.gh).toHaveLength(2); // backoff: not every pass
      p.f.advance(61_000);
      await p.tick();
      expect(p.gh.at(-1)).toEqual(["pr", "close", "7", "--repo", "o/r", "--comment", expect.stringContaining("接力 PR：#9（base main）")]);
      expect(closed().map((e) => e.data)).toEqual([expect.objectContaining({ oldPr: 7, newPr: 9 })]);
      p.f.advance(61_000);
      await p.tick();
      expect(p.gh).toHaveLength(3);
    } finally { p.f.close(); }
  }, E2E_MS);
});
