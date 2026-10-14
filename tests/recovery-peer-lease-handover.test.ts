/**
 * dispatch-recovery-PEERLEASE1 · peerLeaseRecovery, the local takeover's peer author handover, on a real ledger through the scheduler
 * tick and the ledger CLI: mate's Claude delivered the head, PM reclaimed the write lease (Sekai offline), the card's author binding is
 * still mate's peer worker; this machine's author runtime is Codex. [验收线 4] [验收线 5] [验收线 6] [验收线 7]
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { leaseLend, listLendOrders } from "../src/lib/ledger-lend.js";
import { getWriteLease } from "../src/lib/ledger-lend-lease.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { listEvents } from "../src/lib/ledger-store.js";
import type { RemoteHead } from "../src/lib/order-deliver.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import { PEER_LEASE_KEY, peerLeasePorts, setPeerLeasePorts } from "../src/lib/recovery-peer-lease.js";
import { applyPeerHandover } from "../src/lib/recovery-peer-lease-handover.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { remoteHeadFamily } from "../src/lib/scheduler-head-family.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { autoFixture, H2, P1, toBuild } from "./scheduler-auto-helpers.js";

const H3 = "3".repeat(40);
const FP = "abcd-ef01-2345-6789";
const BRANCH = "lend/T1-abcd";
const E2E_MS = 30_000;
const WRITE: RemotePolicy = { mode: "balance", roles: ["review", "write"], poolTimeoutMin: 15, repo: "o/r" };
const CODEX = { codex: { total: 2, busy: 0 }, claude: { total: 0, busy: 0 } };
const PEER_AUTHOR = { agent: "w1@mate", sessionId: "sess-mate" };
const AT_H2: RemoteHead = { ok: true, head: H2 };

async function ready() {
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
  const borrow: BorrowEntry[] = [{ peer: "mate", projects: ["p"], roles: ["review", "write"], maxOpen: 3 }];
  const policy = { maxActiveWorkers: 2, remote: WRITE };
  const heads: Record<string, RemoteHead> = { main: { ok: true, head: "b".repeat(40) } };
  const mode = { now: "on" as RecoveryMode };
  const runtime = { now: "codex" as "claude" | "codex" };
  setPeerLeasePorts(f.db, { policy: () => ({ mode: mode.now, manualAfterMs: null, source: "config" }), authorRuntime: () => runtime.now,
    remoteHead: async (_repo, branch) => heads[branch] ?? { ok: false as const, error: "没有这个分支" } });
  const lend = {
    borrow: async () => borrow, notifyPm: async () => {}, schedulerPolicy: () => policy,
    result: { reportDir: () => reports, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: (x: string[]) => signPurpose(RECEIPT_PURPOSE, x, key),
      peerFp: async () => FP, remoteHead: async (_repo: string, branch: string) => heads[branch] ?? { ok: false as const, error: "没有这个分支" } },
  };
  const cli = (actor: string, ...args: string[]) => f.cliWith({ lend }, actor, ...args) as Promise<Record<string, any>>;
  const created: string[] = [];
  // The production ensure creates the local author through scheduler-autostart local-author, which writes the workflow's author family
  // to the runtime it actually created; the fixture's ensure binds an existing row, so the test plays that step.
  const ensure: typeof f.tickDeps.ensure = async (task, role, family) => {
    if (role === "author") { created.push(family); f.db.run("UPDATE task_workflows SET authorFamily = ? WHERE taskId = ?", [family, task.id]); }
    return f.tickDeps.ensure(task, role, family);
  };
  const deps = { ...f.tickDeps, ensure, manager: (...args: string[]) => cli("scheduler", ...args.slice(1)), borrow: async () => borrow };
  const tick = async () => {
    const r = await schedulerAutoTick(f.db, { p: policy }, deps);
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards[0];
  };
  let seq = 0;
  const hello = () => recordHello(f.db, "mate", null, { v: 1, proto: 2, boot: "boot-mate", seq: ++seq, slots: CODEX, paused: null,
    grant: { until: f.tickDeps.now() + 3 * 3_600_000, roles: ["review", "write"], repos: ["o/r"], ordersPerDay: 50, ordersLeftToday: 50 } }, f.tickDeps.now());
  const lendCall = (op: string, body: unknown) => cli("owner", op, "--", "mate", JSON.stringify(body));
  const events = () => listEvents(f.db, { project: "p", target: "T1" });
  const author = () => f.db.query("SELECT agent, sessionId, family, transport, state FROM scheduler_sessions WHERE taskId = 'T1' AND role = 'author' ORDER BY rowid")
    .all() as { agent: string; sessionId: string; family: string; transport: string; state: string }[];
  await toBuild(f);
  return { f, cli, tick, hello, lendCall, heads, mode, runtime, events, author, created, policy, orders: () => listLendOrders(f.db, "T1") };
}
type P = Awaited<ReturnType<typeof ready>>;

/** mate writes H2 (PR #7, recorded as a Claude delivery), one P1 → fix; the author binding is mate's peer worker; lease at mate. */
async function toFix(p: P) {
  p.hello();
  await p.tick();
  const orderId = p.orders()[0].orderId;
  expect(await p.lendCall("lend-claim", { v: 1, orderId, worker: "w1" })).toMatchObject({ ok: true });
  p.heads[BRANCH] = { ok: true, head: H2 };
  expect(await p.lendCall("lend-write", { v: 1, orderId, gen: 1, branch: BRANCH, pr: 7, session: { id: "sess-mate", family: "codex" },
    deliver: { v: 1, orderId, head: H2, evidence: BRANCH, summary: "改好了", selfCheck: "单测全绿" } })).toMatchObject({ ok: true });
  await p.tick();
  await p.tick();
  await p.tick();
  const report = join(p.f.dir, "report.md");
  writeFileSync(report, "# 审查报告\nP1：两个 tick 抢同一个意图");
  const findings = join(p.f.dir, "p1.json");
  writeFileSync(findings, JSON.stringify([P1]));
  expect(await p.cli("agent-rv-t1", "review", "T1", "--reviewer", "agent-rv-t1", "--verdict", "changes", "--p0", "0", "--p1", "1", "--p2", "0",
    "--head", H2, "--session", "s-rv", "--family", "claude", "--findings", findings, "--path", report)).toMatchObject({ ok: true });
  await p.tick();
  expect(p.f.task()).toMatchObject({ stage: "fix", headSHA: H2 });
  // PM's six cards: the old delivery was Claude's. The in-memory ledger records mate's done order as a Claude one.
  p.f.db.run("UPDATE lend_orders SET family = 'claude' WHERE taskId = 'T1'");
  expect(remoteHeadFamily(p.f.db, p.f.task())).toBe("claude");
  // The binding PM found on the six cards: the old peer worker still the card's active author.
  p.f.db.run("UPDATE scheduler_sessions SET agent = ?, sessionId = ?, family = 'claude', transport = 'peer' WHERE taskId = 'T1' AND role = 'author'",
    [PEER_AUTHOR.agent, PEER_AUTHOR.sessionId]);
  const reg = JSON.parse(readFileSync(p.f.registryPath, "utf8"));
  reg.agents["agent-task-one"] = { ...reg.agents["agent-task-one"], runtime: "codex", transport: "acp" }; // this machine's author now runs Codex
  writeFileSync(p.f.registryPath, JSON.stringify(reg));
}

const reclaim = (p: P) => p.cli("pm", "lend-reclaim", "T1", "--reason", "Sekai 离线");
const handovers = (p: P) => p.events().filter((e) => e.kind === "scheduler" && e.data.op === "peer_author_handover");
const observed = (p: P) => p.events().filter((e) => e.kind === "note" && e.data.op === "recovery_observe" && e.data.mechanism === PEER_LEASE_KEY);
const snap = (p: P) => autoSnapshot(p.f.db, p.f.task(), { registry: [], maxWorkers: 2, now: p.f.tickDeps.now(), pool: { remote: WRITE, borrow: [] } });

describe("peerLeaseRecovery · peer author handover", () => {
  test("[验收线 4] [验收线 5] reclaim + settled orders: the peer binding leaves active first, then a Codex local author fixes the Claude head", async () => {
    const p = await ready();
    try {
      await toFix(p);
      expect(await reclaim(p)).toMatchObject({ ok: true });
      await p.tick();
      expect(handovers(p)).toHaveLength(1);
      expect(handovers(p)[0].data).toMatchObject({ agent: PEER_AUTHOR.agent, sessionId: PEER_AUTHOR.sessionId, family: "claude", peer: "mate", runtime: "codex" });
      expect(p.author()).toEqual([expect.objectContaining({ agent: PEER_AUTHOR.agent, transport: "peer", family: "claude", state: "retired" })]);
      expect(p.created).toEqual([]); // nothing created in the handover's own tick
      for (let i = 0; i < 4 && !p.f.intents().some((x) => x.action === "dispatch" && x.node === "fix"); i++) await p.tick();
      expect(p.created).toEqual(["codex"]);
      expect(p.author().filter((r) => r.state === "active")).toEqual([expect.objectContaining({ agent: "agent-task-one", family: "codex", transport: "acp" })]);
      // The old head's family stays the delivery's; the fix author is the handed-over Codex, and the plan dispatches the fix here.
      const s = snap(p);
      expect(s.remoteAuthorFamily).toBe("claude");
      expect(s.workflow?.authorFamily).toBe("codex");
      expect(p.f.intents().filter((x) => x.action === "dispatch" && x.node === "fix")).toEqual([expect.objectContaining({ recipient: "agent-task-one" })]);
      // Repeated ticks: one handover, one author.
      await p.tick();
      expect(handovers(p)).toHaveLength(1);
      expect(p.created).toEqual(["codex"]);
    } finally { p.f.close(); }
  }, E2E_MS);

  test("[验收线 6] before a local delivery the old head source stays Claude; after it, review goes to Claude, a Codex reviewer is refused", async () => {
    const p = await ready();
    try {
      await toFix(p);
      await reclaim(p);
      for (let i = 0; i < 5 && !p.f.intents().some((x) => x.action === "dispatch" && x.node === "fix"); i++) await p.tick();
      expect(remoteHeadFamily(p.f.db, p.f.task())).toBe("claude");
      expect(await p.cli("agent-task-one", "deliver", "T1", "--from", "fix", "--head", H3))
        .toMatchObject({ ok: true });
      expect(p.f.task()).toMatchObject({ stage: "review", headSHA: H3 });
      expect(remoteHeadFamily(p.f.db, p.f.task())).toBeNull();
      const s = snap(p);
      expect(s.workflow?.authorFamily).toBe("codex");
      // The bound reviewer is Claude, across from the local Codex delivery: the round's review goes to it.
      expect(s.reviewer).toMatchObject({ agent: "agent-rv-t1", family: "claude" });
      expect(planScheduler(s)).toMatchObject({ kind: "intent", action: "review", recipient: "agent-rv-t1" });
      // A Codex reviewer — the new author's family — is still refused: it is swapped, never sent the review.
      expect(planScheduler({ ...s, reviewer: { ...s.reviewer!, family: "codex" } })).toMatchObject({ kind: "intent", action: "review_swap",
        reason: expect.stringContaining("变成 codex") });
    } finally { p.f.close(); }
  }, E2E_MS);

  test("[验收线 4] lease still held (no reclaim, offline only): no handover, the block is noted once", async () => {
    const p = await ready();
    try {
      await toFix(p);
      await p.tick();
      await p.tick();
      expect(handovers(p)).toEqual([]);
      expect(p.author()).toEqual([expect.objectContaining({ agent: PEER_AUTHOR.agent, state: "active" })]);
      expect(observed(p)).toHaveLength(1);
      expect(observed(p)[0].text).toContain("写租约仍在 mate");
      expect(getWriteLease(p.f.db, "T1")).toMatchObject({ peer: "mate", state: "held" });
    } finally { p.f.close(); }
  }, E2E_MS);

  test("[验收线 4] an order of the card still unknown / live: no handover", async () => {
    const p = await ready();
    try {
      await toFix(p);
      await reclaim(p);
      p.f.db.run("UPDATE lend_orders SET status = 'unknown' WHERE taskId = 'T1'");
      await p.tick();
      expect(handovers(p)).toEqual([]);
      expect(p.author()).toEqual([expect.objectContaining({ state: "active", transport: "peer" })]);
    } finally { p.f.close(); }
  }, E2E_MS);

  test("[验收线 4] [验收线 7] the transaction refuses a drifted generation, a stale rev and a non-scheduler; a replay is the same event", async () => {
    const p = await ready();
    try {
      await toFix(p);
      await reclaim(p);
      const lease = getWriteLease(p.f.db, "T1")!;
      const ctx = { actor: "scheduler", now: p.f.tickDeps.now() };
      const base = { taskId: "T1", rev: p.f.task().rev, sessionId: PEER_AUTHOR.sessionId, leaseAt: lease.updatedAt, runtime: "codex", remoteHead: AT_H2 };
      expect(() => applyPeerHandover(p.f.db, ctx, { ...base, leaseAt: lease.updatedAt - 1 })).toThrow("代次");
      expect(() => applyPeerHandover(p.f.db, ctx, { ...base, rev: base.rev - 1 })).toThrow("变了");
      expect(() => applyPeerHandover(p.f.db, ctx, { ...base, sessionId: "other" })).toThrow();
      expect(() => applyPeerHandover(p.f.db, { actor: "pm" }, base)).toThrow("调度服务");
      expect(p.author()).toEqual([expect.objectContaining({ state: "active" })]);
      const first = applyPeerHandover(p.f.db, ctx, base);
      expect(first.duplicate).toBe(false);
      expect(applyPeerHandover(p.f.db, ctx, base)).toEqual({ ...first, duplicate: true });
      expect(() => applyPeerHandover(p.f.db, ctx, { ...base, runtime: "claude" })).toThrow("另一组证据");
      expect(handovers(p)).toHaveLength(1);
    } finally { p.f.close(); }
  }, E2E_MS);

  test("[验收线 3] off: nothing read into the ledger; observe: one note with the evidence, the binding stays", async () => {
    const p = await ready();
    try {
      await toFix(p);
      await reclaim(p);
      p.mode.now = "off";
      await p.tick();
      expect(observed(p)).toEqual([]);
      expect(handovers(p)).toEqual([]);
    } finally { p.f.close(); }
    const q = await ready();
    try {
      await toFix(q);
      await reclaim(q);
      q.mode.now = "observe";
      await q.tick();
      await q.tick();
      expect(handovers(q)).toEqual([]);
      expect(observed(q)).toHaveLength(1);
      expect(observed(q)[0].data).toMatchObject({ kind: "handover", evidence: expect.objectContaining({ sessionId: PEER_AUTHOR.sessionId, peer: "mate" }) });
      // The transaction itself re-reads the switch: not on, no handover even when called.
      const lease = getWriteLease(q.f.db, "T1")!;
      expect(() => applyPeerHandover(q.f.db, { actor: "scheduler" }, { taskId: "T1", rev: q.f.task().rev, sessionId: PEER_AUTHOR.sessionId,
        leaseAt: lease.updatedAt, runtime: "codex", remoteHead: AT_H2 })).toThrow("不是 on");
    } finally { q.f.close(); }
  }, E2E_MS);
});

/** The old write order put back to claimed at generation 1, as if mate's worker were still on it when PM reclaimed. */
const claimedAgain = (p: P) => {
  p.f.db.run("UPDATE lend_orders SET status = 'claimed', leaseUntil = ? WHERE taskId = 'T1'", [p.f.tickDeps.now() + 3_600_000]);
  p.f.db.run("UPDATE task_workflows SET authorFamily = 'claude' WHERE taskId = 'T1'"); // no done order left: the workflow names mate's Claude
};
const proofArgs = (p: P) => ({ taskId: "T1", rev: p.f.task().rev, sessionId: PEER_AUTHOR.sessionId, leaseAt: getWriteLease(p.f.db, "T1")!.updatedAt, runtime: "codex", remoteHead: AT_H2 });

describe("peerLeaseRecovery · peer stop proof", () => {
  test("[验收线 4] PM cancel alone: a claimed order cancelled by the reclaim is no stop proof — no handover, binding stays active", async () => {
    const p = await ready();
    try {
      await toFix(p);
      claimedAgain(p);
      expect(await reclaim(p)).toMatchObject({ ok: true });
      expect(p.orders()[0]).toMatchObject({ status: "cancelled", leaseGen: 1 });
      expect(() => applyPeerHandover(p.f.db, { actor: "scheduler", now: p.f.tickDeps.now() }, proofArgs(p))).toThrow("只是本机撤单");
      await p.tick();
      await p.tick();
      expect(handovers(p)).toEqual([]);
      expect(p.author()).toEqual([expect.objectContaining({ agent: PEER_AUTHOR.agent, transport: "peer", state: "active" })]);
      expect(p.created).toEqual([]);
      expect(observed(p)).toHaveLength(1);
      expect(observed(p)[0].text).toContain("缺出借方报停或干净撤单回执");
      // Nothing is forced: the old gate keeps refusing the peer row, the card waits in manual with the block on record.
      expect(p.f.db.query("SELECT mode FROM task_workflows WHERE taskId = 'T1'").get()).toEqual({ mode: "manual" });
    } finally { p.f.close(); }
  }, E2E_MS);

  test("[验收线 4] the lender's own `release stopped` of that generation before the reclaim: the handover goes through", async () => {
    const p = await ready();
    try {
      await toFix(p);
      claimedAgain(p);
      leaseLend(p.f.db, { actor: "owner", now: p.f.tickDeps.now() }, "mate", { v: 1, orderId: p.orders()[0].orderId, gen: 1, action: "release", reason: "stopped", detail: null });
      expect(p.orders()[0].status).toBe("unknown");
      await reclaim(p);
      await p.tick();
      expect(handovers(p)).toHaveLength(1);
      expect(handovers(p)[0].data.stops).toEqual([expect.objectContaining({ orderId: p.orders()[0].orderId, gen: 1, worker: "w1", proof: "stopped_report" })]);
      expect(p.author()).toEqual([expect.objectContaining({ agent: PEER_AUTHOR.agent, state: "retired" })]);
    } finally { p.f.close(); }
  }, E2E_MS);

  test("[验收线 4] a stopped report of another generation, or a peer author that is no proven order's worker: refused", async () => {
    const p = await ready();
    try {
      await toFix(p);
      claimedAgain(p);
      leaseLend(p.f.db, { actor: "owner", now: p.f.tickDeps.now() }, "mate", { v: 1, orderId: p.orders()[0].orderId, gen: 1, action: "release", reason: "stopped", detail: null });
      p.f.db.run("UPDATE lend_orders SET leaseGen = 2 WHERE taskId = 'T1'"); // the report was for generation 1
      await reclaim(p);
      expect(() => applyPeerHandover(p.f.db, { actor: "scheduler", now: p.f.tickDeps.now() }, proofArgs(p))).toThrow("缺出借方报停");
    } finally { p.f.close(); }
    const q = await ready();
    try {
      await toFix(q);
      await reclaim(q);
      q.f.db.run("UPDATE scheduler_sessions SET agent = 'w9@mate' WHERE taskId = 'T1' AND role = 'author'");
      expect(() => applyPeerHandover(q.f.db, { actor: "scheduler", now: q.f.tickDeps.now() }, proofArgs(q))).toThrow("会话代次不符");
      await q.tick();
      expect(handovers(q)).toEqual([]);
    } finally { q.f.close(); }
  }, E2E_MS);
});

const localRuntime = (p: P, runtime: "codex" | "claude-code") => {
  const reg = JSON.parse(readFileSync(p.f.registryPath, "utf8"));
  reg.agents["agent-task-one"] = { ...reg.agents["agent-task-one"], runtime, transport: runtime === "codex" ? "acp" : "tmux" };
  writeFileSync(p.f.registryPath, JSON.stringify(reg));
};

describe("peerLeaseRecovery · frozen runtime through the plan", () => {
  test("[验收线 5] frozen Claude: the plan asks for Claude, the Claude author passes the session gate and gets the fix", async () => {
    const p = await ready();
    try {
      await toFix(p);
      p.runtime.now = "claude";
      localRuntime(p, "claude-code");
      await reclaim(p);
      for (let i = 0; i < 6 && !p.f.intents().some((x) => x.action === "dispatch" && x.node === "fix"); i++) await p.tick();
      expect(handovers(p)[0].data.runtime).toBe("claude");
      expect(p.created).toEqual(["claude"]);
      expect(snap(p).workflow?.authorFamily).toBe("claude");
      expect(p.f.intents().filter((x) => x.action === "dispatch" && x.node === "fix")).toEqual([expect.objectContaining({ recipient: "agent-task-one" })]);
    } finally { p.f.close(); }
  }, E2E_MS);

  test("[验收线 5] a local binding in another family than the frozen one is not passed off as it: no override, one drift note", async () => {
    const p = await ready();
    try {
      await toFix(p);
      await reclaim(p);
      for (let i = 0; i < 4 && !p.created.length; i++) await p.tick();
      expect(handovers(p)[0].data.runtime).toBe("codex");
      // Simulate a bypassed creation: the new local author's binding says Claude.
      p.f.db.run("UPDATE scheduler_sessions SET family = 'claude' WHERE taskId = 'T1' AND role = 'author' AND state = 'active' AND transport != 'peer'");
      expect(snap(p).workflow?.authorFamily).toBe("claude"); // the old head's source, not the stray binding passed off as the handover's
      await p.tick();
      await p.tick();
      const drift = observed(p).filter((e) => (e.data.data as { kind?: string } | undefined)?.kind === "runtime_drift" || e.text.includes("交接冻结"));
      expect(drift).toHaveLength(1);
      expect(drift[0].text).toContain("交接冻结 codex");
    } finally { p.f.close(); }
  }, E2E_MS);
});

const relayCli = (p: P) => p.cli("scheduler", "scheduler-fix-relay", "T1", "--op", "peer-handover", "--rev", String(p.f.task().rev),
  "--session", PEER_AUTHOR.sessionId, "--lease-at", String(getWriteLease(p.f.db, "T1")!.updatedAt), "--runtime", "codex");

const headBlocks = (p: P) => p.events().filter((e) => e.kind === "scheduler" && e.data.op === "peer_author_handover_head_block");
const stoppedThenReclaimed = async (p: P) => {
  await toFix(p);
  claimedAgain(p);
  leaseLend(p.f.db, { actor: "owner", now: p.f.tickDeps.now() }, "mate", { v: 1, orderId: p.orders()[0].orderId, gen: 1, action: "release", reason: "stopped", detail: null });
  expect(p.orders()[0].status).toBe("unknown");
};

describe("peerLeaseRecovery · preserved head before the handover", () => {
  test("[验收线 4] stopped with unpreserved pushed head: mate pushed H3 past the ledger's H2, then reported stopped — no handover", async () => {
    const p = await ready();
    try {
      await stoppedThenReclaimed(p);
      p.heads[BRANCH] = { ok: true, head: H3 }; // mate's worker pushed H3, never delivered it
      await reclaim(p);
      expect(p.f.task().headSHA).toBe(H2);
      const ctx = { actor: "scheduler", now: p.f.tickDeps.now() };
      expect(() => applyPeerHandover(p.f.db, ctx, { ...proofArgs(p), remoteHead: { ok: true, head: H3 } })).toThrow("未保全");
      expect(() => applyPeerHandover(p.f.db, ctx, { ...proofArgs(p), remoteHead: null })).toThrow("核不了");
      const rev = p.f.task().rev;
      // The command's own refusal records the block (and moves the rev) before it refuses.
      expect(await relayCli(p)).toMatchObject({ ok: false, error: expect.stringContaining("未交付成果") });
      await p.tick();
      // The block is recorded once and moves the rev: the plan made on the snapshot that dropped the old row is refused.
      expect(headBlocks(p)).toEqual([expect.objectContaining({ data: expect.objectContaining({ head: H2, remoteHead: H3, branch: BRANCH }) })]);
      expect(p.f.task().rev).toBeGreaterThan(rev);
      await p.tick();
      await p.tick();
      expect(headBlocks(p)).toHaveLength(1);
      expect(handovers(p)).toEqual([]);
      expect(p.author()).toEqual([expect.objectContaining({ agent: PEER_AUTHOR.agent, transport: "peer", state: "active" })]);
      expect(p.created).toEqual([]);
      expect(observed(p).filter((e) => e.text.includes(H3.slice(0, 12)))).toHaveLength(1);
      expect(p.f.db.query("SELECT mode FROM task_workflows WHERE taskId = 'T1'").get()).toEqual({ mode: "manual" });
    } finally { p.f.close(); }
  }, E2E_MS);

  test("[验收线 4] remote head unreadable: no handover, no local author; observe notes the block and changes nothing", async () => {
    const p = await ready();
    try {
      await stoppedThenReclaimed(p);
      await reclaim(p);
      delete p.heads[BRANCH];
      expect(await relayCli(p)).toMatchObject({ ok: false, error: expect.stringContaining("核不了") });
      await p.tick();
      await p.tick();
      p.heads[BRANCH] = { ok: true, head: H2 }; // read back later: the recorded block stands, PM decides
      await p.tick();
      expect(handovers(p)).toEqual([]);
      expect(headBlocks(p)).toHaveLength(1);
      expect(p.created).toEqual([]);
      expect(p.author()).toEqual([expect.objectContaining({ agent: PEER_AUTHOR.agent, state: "active" })]);
    } finally { p.f.close(); }
    const q = await ready();
    try {
      await stoppedThenReclaimed(q);
      q.heads[BRANCH] = { ok: true, head: H3 };
      await reclaim(q);
      q.mode.now = "observe";
      await q.tick();
      await q.tick();
      expect(headBlocks(q)).toEqual([]);
      expect(handovers(q)).toEqual([]);
      expect(observed(q)).toEqual([expect.objectContaining({ text: expect.stringContaining("未交付成果") })]);
    } finally { q.f.close(); }
  }, E2E_MS);

  test("[验收线 4] stopped and the branch stands at the ledger's head: the handover records the head it read", async () => {
    const p = await ready();
    try {
      await stoppedThenReclaimed(p);
      await reclaim(p);
      await p.tick();
      expect(headBlocks(p)).toEqual([]);
      expect(handovers(p)).toHaveLength(1);
      expect(handovers(p)[0].data).toMatchObject({ remoteHead: H2, head: H2, branch: BRANCH });
    } finally { p.f.close(); }
  }, E2E_MS);
});

const ensureIntents = (p: P) => p.f.intents().filter((x) => x.action === "ensure_session").map((x) => x.id);
/** The tick's probe reads `first`, every later read (the command's own re-read) `then`. */
const headThen = (p: P, first: RemoteHead, then: RemoteHead) => {
  let reads = 0;
  Object.defineProperty(p.heads, BRANCH, { configurable: true, enumerable: true, get: () => (reads++ ? then : first) });
};

describe("peerLeaseRecovery · a failed handover re-check stops this tick's plan", () => {
  for (const [name, then] of [["drifted to H3", { ok: true, head: H3 }], ["unreadable", { ok: false, error: "网络断了" }]] as [string, RemoteHead][]) {
    test(`[验收线 4] tick reads H2, the command's re-read is ${name}: block recorded, rev moved, no author ensure, old binding active`, async () => {
      const p = await ready();
      try {
        await stoppedThenReclaimed(p);
        await reclaim(p);
        headThen(p, AT_H2, then);
        const rev = p.f.task().rev, ensures = ensureIntents(p);
        await p.tick();
        expect(handovers(p)).toEqual([]);
        expect(headBlocks(p)).toEqual([expect.objectContaining({ data: expect.objectContaining({ head: H2, remoteHead: then.ok ? H3 : null }) })]);
        expect(p.f.task().rev).toBeGreaterThan(rev);
        expect(p.created).toEqual([]);
        expect(p.author()).toEqual([expect.objectContaining({ agent: PEER_AUTHOR.agent, transport: "peer", state: "active" })]);
        expect(ensureIntents(p)).toEqual(ensures);
        await p.tick();
        await p.tick();
        expect(headBlocks(p)).toHaveLength(1); // the reason replays: handoverCheck refuses on the recorded block
        expect(handovers(p)).toEqual([]);
        expect(p.created).toEqual([]);
      } finally { p.f.close(); }
    }, E2E_MS);
  }

  test("[验收线 4] the handover never reached (runtime unread): the fence stops the plan, nothing created, rev untouched", async () => {
    const p = await ready();
    try {
      await toFix(p);
      await reclaim(p);
      const ports = peerLeasePorts(p.f.db);
      setPeerLeasePorts(p.f.db, { ...ports, authorRuntime: () => { throw new Error("读不到运行时"); } });
      const rev = p.f.task().rev, ensures = ensureIntents(p);
      await expect(p.tick()).rejects.toThrow("未交接"); // the card's step lands in the pass's failed list
      expect(p.f.task().rev).toBe(rev);
      expect(handovers(p)).toEqual([]);
      expect(p.created).toEqual([]);
      expect(ensureIntents(p)).toEqual(ensures);
      expect(p.author()).toEqual([expect.objectContaining({ agent: PEER_AUTHOR.agent, transport: "peer", state: "active" })]);
      setPeerLeasePorts(p.f.db, ports); // runtime readable again: the next tick hands over, then creates
      for (let i = 0; i < 4 && !p.created.length; i++) await p.tick();
      expect(handovers(p)).toHaveLength(1);
      expect(p.created).toEqual(["codex"]);
    } finally { p.f.close(); }
  }, E2E_MS);
});
