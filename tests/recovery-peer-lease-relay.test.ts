/**
 * dispatch-recovery-PEERLEASE1 · peerLeaseRecovery, the agents pool relay, end to end on a real ledger through the scheduler tick, the
 * pool CLI and the lend CLI (lend-fix-reassign.test.ts's harness): the card is written by mate under the classic policy, then the
 * project runs the unified agents pool for its fix. [验收线 1] [验收线 2] [验收线 3] [验收线 7]
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
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { FIX_LEASE_WAIT_OP, FIX_RELAY_OP } from "../src/lib/lend-fix-reassign-event.js";
import type { Gh } from "../src/lib/lend-fix-reassign-pr.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import { PEER_LEASE_KEY, poolRelayAway, setPeerLeasePorts } from "../src/lib/recovery-peer-lease.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { peerFacts } from "../src/lib/scheduler-agent-pool-peer.js";
import type { SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import type { LocalSwapFact } from "../src/lib/recovery-fix-local-swap.js";
import { autoFixture, H2, P1, toBuild } from "./scheduler-auto-helpers.js";

const H3 = "3".repeat(40);
const FPS: Record<string, string> = { mate: "abcd-ef01-2345-6789", other: "fe12-ef01-2345-6789" };
const BRANCH = "lend/T1-abcd";
const RELAY_BRANCH = "lend/T1-fe12";
const MIN = 60_000;
const E2E_MS = 30_000;
const WRITE: RemotePolicy = { mode: "balance", roles: ["review", "write"], poolTimeoutMin: 15, repo: "o/r" };
/** The unified pool with no local seats: the fix can only go to a peer, as with Sekai offline. */
const POOL: RemotePolicy = { ...WRITE, agents: { claude: 0, codex: 0 } };
const borrowOf = (peer: string): BorrowEntry => ({ peer, projects: ["p"], roles: ["review", "write"], maxOpen: 3 });
type Slots = { codex: { total: number; busy: number }; claude: { total: number; busy: number } };
const FREE: Slots = { codex: { total: 2, busy: 0 }, claude: { total: 0, busy: 0 } };
const FULL: Slots = { codex: { total: 2, busy: 2 }, claude: { total: 0, busy: 0 } };

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
  const borrow = [borrowOf("mate"), borrowOf("other")];
  const policy = { maxActiveWorkers: 2, remote: WRITE };
  const heads: Record<string, RemoteHead> = { main: { ok: true, head: "b".repeat(40) } };
  const relayGh: Gh = async () => ({ code: 0, stdout: "", stderr: "", timedOut: false });
  const mode = { now: "on" as RecoveryMode, reads: 0 };
  setPeerLeasePorts(f.db, { policy: (_p, k) => { expect(k).toBe(PEER_LEASE_KEY); mode.reads++; return { mode: mode.now, manualAfterMs: null, source: "config" }; } });
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
  return { f, cli, tick, hello, lendCall, heads, policy, mode, events, orders: () => listLendOrders(f.db, "T1") };
}
type P = Awaited<ReturnType<typeof ready>>;

async function deliverAs(p: P, peer: string, orderId: string, branch: string, head: string, pr: number) {
  expect(await p.lendCall("lend-claim", peer, { v: 1, orderId, worker: "w1" })).toMatchObject({ ok: true });
  p.heads[branch] = { ok: true, head };
  expect(await p.lendCall("lend-write", peer, { v: 1, orderId, gen: 1, branch, pr, session: { id: `sess-${peer}`, family: "codex" },
    deliver: { v: 1, orderId, head, evidence: branch, summary: "改好了", selfCheck: "单测全绿" } })).toMatchObject({ ok: true });
}

async function reviewToFix(p: P, head: string) {
  await p.tick();
  await p.tick();
  await p.tick();
  const report = join(p.f.dir, `report-${head.slice(0, 4)}.md`);
  writeFileSync(report, "# 审查报告\nP1：两个 tick 抢同一个意图");
  const findings = join(p.f.dir, `p1-${head.slice(0, 4)}.json`);
  writeFileSync(findings, JSON.stringify([P1]));
  expect(await p.cli("agent-rv-t1", "review", "T1", "--reviewer", "agent-rv-t1", "--verdict", "changes", "--p0", "0", "--p1", "1", "--p2", "0",
    "--head", head, "--session", "s-rv", "--family", "claude", "--findings", findings, "--path", report)).toMatchObject({ ok: true });
  await p.tick();
  expect(p.f.task()).toMatchObject({ stage: "fix", headSHA: head });
}

/** mate's Codex wrote H2 (PR #7), one P1 → fix with the write lease at mate; from here the project runs the agents pool. */
async function toPoolFix(p: P) {
  p.hello("mate");
  await p.tick();
  await deliverAs(p, "mate", p.orders()[0].orderId, BRANCH, H2, 7);
  await reviewToFix(p, H2);
  expect(getWriteLease(p.f.db, "T1")).toMatchObject({ peer: "mate", branch: BRANCH, state: "held" });
  p.policy.remote = POOL;
}

const relays = (p: P) => p.events().filter((e) => e.kind === "scheduler" && e.data.op === FIX_RELAY_OP);
const fixes = (p: P) => p.orders().filter((o) => o.step === "fix");
const observed = (p: P) => p.events().filter((e) => e.kind === "note" && e.data.op === "recovery_observe" && e.data.mechanism === PEER_LEASE_KEY);
const waits = (p: P) => p.events().filter((e) => e.kind === "scheduler" && e.data.op === FIX_LEASE_WAIT_OP);
const both = (p: P, mate: Slots, other: Slots = FREE, grant: Partial<Grant> = {}) => { p.hello("mate", mate); p.hello("other", other, grant); };

describe("peerLeaseRecovery · agents pool relay", () => {
  test("[验收线 1] holder unable for 20 minutes, other peer has a same-family slot: on relays once from the PR head; under the threshold only waits", async () => {
    const p = await ready();
    try {
      await toPoolFix(p);
      both(p, FULL);
      expect(await p.tick()).toMatchObject({ detail: expect.stringContaining("等 codex 空位") });
      expect(waits(p).map((e) => e.data.state)).toEqual(["start"]);
      p.f.advance(19 * MIN);
      both(p, FULL);
      await p.tick();
      expect(fixes(p)).toEqual([]);
      expect(relays(p)).toEqual([]);
      p.f.advance(2 * MIN);
      both(p, FULL);
      expect(await p.tick()).toMatchObject({ step: "pool_pooled", detail: expect.stringContaining("修复挂给 other") });
      expect(fixes(p)).toEqual([expect.objectContaining({ peer: "other", family: "codex", head: H2, branch: RELAY_BRANCH, base: "main", pr: null })]);
      // The old lease ended before the new one was granted: one held lease, at other.
      expect(getWriteLease(p.f.db, "T1")).toMatchObject({ peer: "other", branch: RELAY_BRANCH, state: "held" });
      expect(relays(p).map((e) => e.data)).toEqual([expect.objectContaining({ from: "mate", to: "other", head: H2, oldPr: 7 })]);
      await p.tick();
      await p.tick();
      expect(relays(p)).toHaveLength(1);
      expect(fixes(p)).toHaveLength(1);
    } finally { p.f.close(); }
  }, E2E_MS);

  for (const [name, other, grant] of [
    ["no free slot of the family", FULL, {}],
    ["no repo grant", FREE, { repos: ["x/y"] }],
    ["grant lapsed", FREE, { until: 1 }],
  ] as [string, Slots, Partial<Grant>][]) {
    test(`[验收线 2] candidate refused (${name}): no relay, no new lease`, async () => {
      const p = await ready();
      try {
        await toPoolFix(p);
        both(p, FULL, other, grant);
        await p.tick();
        p.f.advance(25 * MIN);
        both(p, FULL, other, grant);
        await p.tick();
        expect(relays(p)).toEqual([]);
        expect(fixes(p)).toEqual([]);
        expect(getWriteLease(p.f.db, "T1")).toMatchObject({ peer: "mate", state: "held" });
      } finally { p.f.close(); }
    }, E2E_MS);
  }

  test("[验收线 2] the other peer never said hello: not a candidate", async () => {
    const p = await ready();
    try {
      await toPoolFix(p);
      p.hello("mate", FULL);
      await p.tick();
      p.f.advance(25 * MIN);
      p.hello("mate", FULL);
      p.f.db.run("DELETE FROM lend_peers WHERE peer = 'other'");
      await p.tick();
      expect(relays(p)).toEqual([]);
      expect(getWriteLease(p.f.db, "T1")).toMatchObject({ peer: "mate", state: "held" });
    } finally { p.f.close(); }
  }, E2E_MS);

  test("[验收线 2] a file lock blocks the relay like any writer: the lock wait never starts the clock", async () => {
    const p = await ready();
    try {
      await toPoolFix(p);
      p.f.db.run(`UPDATE tasks SET extra = json_set(extra, '$.fileGlobs', json('["bad path"]')) WHERE id = 'T1'`);
      both(p, FREE);
      await p.tick();
      p.f.advance(25 * MIN);
      both(p, FREE);
      expect(await p.tick()).toMatchObject({ detail: expect.stringContaining("文件锁") });
      expect(waits(p)).toEqual([]); // the holder itself could take it: a lock wait is no holder wait
      // The holder busy as well: its wait counts, but past the threshold the candidate is refused on the same lock.
      both(p, FULL);
      await p.tick();
      p.f.advance(25 * MIN);
      both(p, FULL);
      await p.tick();
      expect(waits(p).map((e) => e.data.state)).toEqual(["start"]);
      expect(relays(p)).toEqual([]);
      expect(getWriteLease(p.f.db, "T1")).toMatchObject({ peer: "mate", state: "held" });
    } finally { p.f.close(); }
  }, E2E_MS);

  test("[验收线 2] the holder's order on the card is still live: no relay", async () => {
    const p = await ready();
    try {
      await toPoolFix(p);
      p.hello("mate");
      expect(await p.tick()).toMatchObject({ step: "pool_pooled", detail: expect.stringContaining("修复挂给 mate") });
      expect(await p.lendCall("lend-claim", "mate", { v: 1, orderId: fixes(p).at(-1)!.orderId, worker: "w2" })).toMatchObject({ ok: true });
      p.f.advance(30 * MIN);
      both(p, FULL);
      await p.tick();
      expect(fixes(p).map((o) => o.peer)).toEqual(["mate"]);
      expect(relays(p)).toEqual([]);
    } finally { p.f.close(); }
  }, E2E_MS);

  test("[验收线 3] off: the pool path is the old one (no clock, no note, no relay)", async () => {
    const p = await ready();
    try {
      await toPoolFix(p);
      p.mode.now = "off";
      both(p, FULL);
      const first = await p.tick();
      p.f.advance(30 * MIN);
      both(p, FULL);
      const later = await p.tick();
      expect(first.detail).toBe(later.detail);
      expect(later.detail).not.toContain("peerLeaseRecovery");
      expect(waits(p)).toEqual([]);
      expect(observed(p)).toEqual([]);
      expect(relays(p)).toEqual([]);
    } finally { p.f.close(); }
  }, E2E_MS);

  test("[验收线 3] observe: one deduplicated note, no relay, no lease change; back to off stops the next effect; a restart keeps the clock", async () => {
    const p = await ready();
    try {
      await toPoolFix(p);
      p.mode.now = "observe";
      both(p, FULL);
      await p.tick();
      p.f.advance(21 * MIN);
      for (let i = 0; i < 3; i++) { both(p, FULL); await p.tick(); }
      expect(observed(p)).toHaveLength(1);
      expect(observed(p)[0].text).toContain("本会改派给 other");
      expect(relays(p)).toEqual([]);
      expect(fixes(p)).toEqual([]);
      expect(getWriteLease(p.f.db, "T1")).toMatchObject({ peer: "mate", state: "held" });
      // The clock is the ledger's: one start, never reset by more ticks (a restarted service reads the same events).
      expect(waits(p).map((e) => e.data.state)).toEqual(["start"]);
      p.mode.now = "on";
      both(p, FULL);
      expect(await p.tick()).toMatchObject({ step: "pool_pooled" });
      expect(relays(p)).toHaveLength(1);
    } finally { p.f.close(); }
  }, E2E_MS);

  test("[验收线 3] switched to off between plan and offer: the offer re-plans and refuses, nothing relayed", async () => {
    const p = await ready();
    try {
      await toPoolFix(p);
      both(p, FULL);
      await p.tick();
      p.f.advance(21 * MIN);
      both(p, FULL);
      // The planner reads on; the policy flips to off on its next read (the offer's re-plan).
      let calls = 0;
      setPeerLeasePorts(p.f.db, { policy: () => ({ mode: calls++ === 0 ? "on" : "off", manualAfterMs: null, source: "config" }) });
      await p.tick();
      expect(relays(p)).toEqual([]);
      expect(fixes(p)).toEqual([]);
      expect(getWriteLease(p.f.db, "T1")).toMatchObject({ peer: "mate", state: "held" });
    } finally { p.f.close(); }
  }, E2E_MS);

  test("[验收线 7] a second relay within the hour keeps the existing escalation to PM", async () => {
    const p = await ready();
    try {
      await toPoolFix(p);
      both(p, FULL);
      await p.tick();
      p.f.advance(21 * MIN);
      both(p, FULL);
      await p.tick();
      const order = fixes(p).at(-1)!;
      expect(order).toMatchObject({ peer: "other", branch: RELAY_BRANCH });
      p.policy.remote = WRITE; // the relayed order is delivered and reviewed as before
      await deliverAs(p, "other", order.orderId, RELAY_BRANCH, H3, 9);
      await reviewToFix(p, H3);
      p.policy.remote = POOL;
      p.hello("other", FULL);
      p.hello("mate");
      await p.tick();
      p.f.advance(21 * MIN);
      p.hello("other", FULL);
      p.hello("mate");
      expect(await p.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining("一小时内已自动改派过一次（mate → other）") });
      expect(relays(p)).toHaveLength(1);
      expect(getWriteLease(p.f.db, "T1")).toMatchObject({ peer: "other", state: "held" });
    } finally { p.f.close(); }
  }, E2E_MS);

  test("[验收线 7] one handover per card and round: a ripe fixLocalSwap under on, or a live / unknown intent, keeps the relay waiting", async () => {
    const p = await ready();
    try {
      await toPoolFix(p);
      both(p, FULL);
      await p.tick();
      p.f.advance(21 * MIN);
      both(p, FULL);
      const s = autoSnapshot(p.f.db, p.f.task(), { registry: [], maxWorkers: 2, now: p.f.tickDeps.now(), pool: { remote: POOL, borrow: [borrowOf("mate"), borrowOf("other")] } });
      const since = s.events.findLast((e) => e.kind === "stage" && e.data.to === "fix")!.seq;
      const facts = { remote: POOL, repo: "o/r", local: { running: 0, room: true }, pin: null, tried: [], lastPeer: null, writeLeasePeer: "mate",
        locksFree: true, peers: s.pool!.peers.map(peerFacts) };
      expect(s.peerLease).toEqual({ mode: "on" });
      expect(poolRelayAway(s, since, facts, "mate", "等")).toMatchObject({ peer: "other" });
      const swap = { mode: "on", candidate: {}, ripe: true, resumed: false, why: null, openKey: null, endSeq: null } as unknown as LocalSwapFact;
      expect(poolRelayAway({ ...s, localSwap: swap }, since, facts, "mate", "等")).toEqual({ code: "fix_lease_wait", wait: "等" });
      expect(poolRelayAway({ ...s, localSwap: { ...swap, mode: "observe" } }, since, facts, "mate", "等")).toMatchObject({ peer: "other" });
      const unknown = { id: "x", action: "fix_swap", status: "unknown", causalSeq: since + 1 } as unknown as SchedulerIntent;
      expect(poolRelayAway({ ...s, intents: [...s.intents, unknown] }, since, facts, "mate", "等")).toEqual({ code: "fix_lease_wait", wait: "等" });
      expect(poolRelayAway({ ...s, peerLease: { mode: "off" } }, since, facts, "mate", "等")).toBeNull();
      expect(poolRelayAway({ ...s, peerLease: undefined }, since, facts, "mate", "等")).toBeNull(); // other snapshot builders mean off
    } finally { p.f.close(); }
  }, E2E_MS);
});
