/**
 * dispatch-recovery-PLAN tick: off / observe / on through the injected policy port (missing port = observe, broken = off),
 * the owner's manualAfterMs threshold (null = never send), one notice per blocking picture claimed in the ledger before sending
 * (two connections racing send once), delivery state kept in the ledger (an unsent claim retries with bounded backoff, a sent
 * picture never re-sends), a cooldown for changed pictures, and peer seats matched by max flow over per-project permission edges
 * (one physical pool per peer, a refused project never shrinks it, project order never changes the answer).
 * Temp ledger only; notifyPm is a recorder, no bridge.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import {
  assessPlanGap, fleetIdle, gapFingerprint, PLAN_GAP_RETRY_BASE_MS, PLAN_GAP_RETRY_MAX_MS, planGapKey, planGapPolicy, planGapRetryAfter,
  planGapText, planGapTick, readPlanGapFacts, type PeerSeats, type PlanGapDeps, type PlanGapPolicyPort, type ProjectFacts, type RecoveryPolicy,
  type WorkItem,
} from "../src/lib/recovery-plan-gap.js";
import { SPEC_SETTLE_MS } from "../src/lib/scheduler-autostart.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";

const P = "proj-a", Q = "proj-b", MIN = 60_000;
let dir: string, path: string, db: Database, sent: { project: string; text: string }[];

const item = (key: string, over: Partial<WorkItem> = {}): WorkItem =>
  ({ featureId: "f1", key, taskId: `t-${key}`, version: 1, state: "ready", external: true, why: "就绪", ...over });
/** A peer with `free` physical codex slots; allowed = this project may use them (else seats 0 with a refusal). */
const peer = (name: string, free: number, allowed = true): PeerSeats =>
  ({ peer: name, seats: allowed ? free : 0, why: allowed ? null : "借入名单对该项目不允许 write", free: { codex: free }, allowed: allowed && free > 0 ? ["codex"] : [] });
const pf = (project: string, over: Partial<ProjectFacts> = {}): ProjectFacts =>
  ({ project, work: [item("a"), item("b", { state: "blocked", gate: "lanes", why: "依赖没满足：a" })], drafts: [], localRoom: 1, localWhy: null,
    peers: [peer("mate", 3)], ...over });
const on = (manualAfterMs: number | null = 5 * MIN): PlanGapPolicyPort => () => ({ mode: "on", manualAfterMs });

function deps(over: Partial<PlanGapDeps> = {}, store = db): PlanGapDeps {
  return { db: store, now: 1_000_000, projects: [P], policy: on(), facts: (p) => pf(p), seen: new Map(),
    notifyPm: async (project, text) => void sent.push({ project, text }), ...over };
}
const notes = (store = db) => store.query("SELECT dedupKey FROM events WHERE dedupKey LIKE 'recovery:planGap:%'").all() as { dedupKey: string }[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "recovery-plan-gap-tick-"));
  path = join(dir, "ledger.sqlite");
  db = openLedger(path);
  sent = [];
});
afterEach(() => {
  closeLedger(path);
  rmSync(dir, { recursive: true, force: true });
});

describe("policy port", () => {
  test("missing port observes, broken or throwing port is off with a diagnostic", () => {
    expect(planGapPolicy(undefined, P)).toMatchObject({ mode: "observe", manualAfterMs: null });
    expect(planGapPolicy(() => { throw new Error("cfg 坏了"); }, P)).toMatchObject({ mode: "off", diag: expect.stringContaining("cfg 坏了") });
    expect(planGapPolicy(() => ({ mode: "maybe" }) as unknown as RecoveryPolicy, P)).toMatchObject({ mode: "off" });
    expect(planGapPolicy(() => ({ mode: "on", manualAfterMs: -1 }), P)).toMatchObject({ mode: "off" });
    const asked: string[] = [];
    // CFG's wider signature (every RecoveryKey) is assignable to the narrow port.
    const cfg = (project: string, mechanism: "materials" | "planGap" | "audit"): RecoveryPolicy => (asked.push(`${project}:${mechanism}`), { mode: "on", manualAfterMs: 0 });
    expect(planGapPolicy(cfg, P)).toMatchObject({ mode: "on", manualAfterMs: 0, diag: null });
    expect(asked).toEqual([`${P}:planGap`]);
  });
});

describe("modes and threshold", () => {
  test("off reads no facts and has no side effect", async () => {
    let read = 0;
    const out = await planGapTick(deps({ policy: () => ({ mode: "off", manualAfterMs: 0 }), facts: (p) => (read++, pf(p)) }));
    expect(out).toEqual([{ project: P, mode: "off", diag: null }]);
    expect(read).toBe(0);
    expect(sent).toEqual([]);
    expect(notes()).toEqual([]);
  });

  test("observe reports what it would send and writes nothing", async () => {
    const out = await planGapTick(deps({ policy: () => ({ mode: "observe", manualAfterMs: 0 }) }));
    expect(out[0]).toMatchObject({ mode: "observe", action: "would_notify" });
    expect(sent).toEqual([]);
    expect(notes()).toEqual([]);
  });

  test("no port at all = observe; with no owner threshold nothing is sent", async () => {
    const out = await planGapTick(deps({ policy: undefined }));
    expect(out[0]).toMatchObject({ mode: "observe", action: "none", why: expect.stringContaining("manualAfterMs") });
    expect((await planGapTick(deps({ policy: on(null) })))[0]).toMatchObject({ mode: "on", action: "none" });
    expect(sent).toEqual([]);
  });

  test("the gap must persist for manualAfterMs with the same picture before the first notice", async () => {
    const d = deps();
    expect((await planGapTick(d))[0]).toMatchObject({ action: "none" });
    expect((await planGapTick({ ...d, now: d.now + 4 * MIN }))[0]).toMatchObject({ action: "none" });
    expect((await planGapTick({ ...d, now: d.now + 5 * MIN }))[0]).toMatchObject({ action: "notified" });
    expect(sent).toHaveLength(1);
  });

  test("no idle seat or nothing stuck: no gap, and the persistence clock resets", async () => {
    const seen = new Map();
    await planGapTick(deps({ seen, policy: on(0), facts: (p) => pf(p, { localRoom: 0, peers: [{ ...peer("mate", 3, false), why: "hello 过期" }] }) }));
    await planGapTick(deps({ seen, policy: on(0), facts: (p) => pf(p, { work: [item("a")] }) }));
    expect(sent).toEqual([]);
    expect(seen.size).toBe(0);
  });
});

describe("dedupe", () => {
  test("same picture is sent once across ticks; ticks a minute apart do not re-send", async () => {
    for (let i = 0; i < 5; i++) await planGapTick(deps({ policy: on(0), now: 1_000_000 + i * MIN }));
    expect(sent).toHaveLength(1);
    const key = planGapKey(P, gapFingerprint(pf(P)));
    expect(notes().map((n) => n.dedupKey)).toEqual([key, `${key}:sent`]); // one claimed attempt, marked sent after notifyPm
  });

  test("two connections racing on the same ledger send once", async () => {
    const other = new Database(path);
    try {
      const out = await Promise.all([planGapTick(deps({ policy: on(0) })), planGapTick(deps({ policy: on(0) }, other))]);
      // the second tick sees the first one's attempt in flight (claimed, not yet marked sent) and waits instead of sending
      expect(out.map((o) => (o[0] as { action: string }).action).sort()).toEqual(["notified", "retry_wait"]);
      expect(sent).toHaveLength(1);
    } finally { other.close(); }
  });

  test("a changed picture waits out the cooldown after the last notice, then sends once", async () => {
    await planGapTick(deps({ policy: on(MIN), now: 0, seen: new Map([[P, { fp: gapFingerprint(pf(P)), since: -MIN }]]) }));
    expect(sent).toHaveLength(1);
    const changed = (p: string) => pf(p, { work: [item("a"), item("c", { state: "blocked", gate: "spec", why: "规格卡还没放到正式路径" })] });
    const seen = new Map([[P, { fp: gapFingerprint(changed(P)), since: -MIN }]]);
    expect((await planGapTick(deps({ policy: on(MIN), now: 30_000, facts: changed, seen })))[0]).toMatchObject({ action: "cooldown" });
    expect((await planGapTick(deps({ policy: on(MIN), now: MIN + 1, facts: changed, seen })))[0]).toMatchObject({ action: "notified" });
    expect(sent).toHaveLength(2);
  });

  test("a DAG version bump is a new picture; seat counts are not", () => {
    const base = gapFingerprint(pf(P));
    expect(gapFingerprint(pf(P, { localRoom: 9, peers: [] }))).toBe(base);
    expect(gapFingerprint(pf(P, { work: [item("a"), item("b", { state: "blocked", gate: "lanes", why: "x", version: 2 })] }))).not.toBe(base);
  });

  test("a failed send is not a delivered notice: no per-minute retry, bounded backoff retries it, then dedup", async () => {
    let down = true;
    const fail = deps({ policy: on(0), notifyPm: async (project, text) => { if (down) throw new Error("bridge 不在"); sent.push({ project, text }); } });
    const key = planGapKey(P, gapFingerprint(pf(P)));
    expect((await planGapTick(fail))[0]).toMatchObject({ action: "failed", why: "bridge 不在" });
    expect((await planGapTick({ ...fail, now: fail.now + MIN }))[0]).toMatchObject({ action: "retry_wait" });
    expect((await planGapTick({ ...fail, now: fail.now + PLAN_GAP_RETRY_BASE_MS }))[0]).toMatchObject({ action: "failed" });
    expect((await planGapTick({ ...fail, now: fail.now + PLAN_GAP_RETRY_BASE_MS + MIN }))[0]).toMatchObject({ action: "retry_wait" });
    down = false;
    // a restarted process (fresh seen map) reads the same delivery state from the ledger
    const later = fail.now + PLAN_GAP_RETRY_BASE_MS + planGapRetryAfter(2);
    expect((await planGapTick({ ...fail, now: later, seen: new Map() }))[0]).toMatchObject({ action: "notified" });
    expect((await planGapTick({ ...fail, now: later + 7 * PLAN_GAP_RETRY_MAX_MS }))[0]).toMatchObject({ action: "deduped" });
    expect(sent).toHaveLength(1);
    expect(notes().map((n) => n.dedupKey)).toEqual([key, `${key}#2`, `${key}#3`, `${key}:sent`]);
  });

  test("a claim whose process died before sending is retried after the backoff, across a restart", async () => {
    const hang = deps({ policy: on(0), notifyPm: () => new Promise<void>(() => {}) });
    void planGapTick(hang); // claims attempt 1, then never returns: the process is gone
    await Promise.resolve();
    expect(notes()).toHaveLength(1);
    const again = deps({ policy: on(0), seen: new Map() });
    expect((await planGapTick({ ...again, now: again.now + MIN }))[0]).toMatchObject({ action: "retry_wait" });
    expect((await planGapTick({ ...again, now: again.now + PLAN_GAP_RETRY_BASE_MS }))[0]).toMatchObject({ action: "notified" });
    expect(sent).toHaveLength(1);
  });

  test("retry backoff doubles and is capped", () => {
    expect([1, 2, 3].map(planGapRetryAfter)).toEqual([PLAN_GAP_RETRY_BASE_MS, 2 * PLAN_GAP_RETRY_BASE_MS, 4 * PLAN_GAP_RETRY_BASE_MS]);
    expect(planGapRetryAfter(50)).toBe(PLAN_GAP_RETRY_MAX_MS);
  });

  test("an unsent claim does not start the cooldown for a changed picture", async () => {
    await planGapTick(deps({ policy: on(MIN), now: 0, seen: new Map([[P, { fp: gapFingerprint(pf(P)), since: -MIN }]]),
      notifyPm: async () => { throw new Error("bridge 不在"); } }));
    const changed = (p: string) => pf(p, { work: [item("a"), item("c", { state: "blocked", gate: "spec", why: "缺规格" })] });
    const seen = new Map([[P, { fp: gapFingerprint(changed(P)), since: -MIN }]]);
    expect((await planGapTick(deps({ policy: on(MIN), now: 30_000, facts: changed, seen })))[0]).toMatchObject({ action: "notified" });
  });
});

describe("assessment", () => {
  test("a peer borrowed by two projects keeps one set of seats", () => {
    const two = (p: string) => pf(p, { localRoom: 0, work: [item("a"), item("b"), item("x", { state: "blocked", gate: "spec", why: "缺规格" })] });
    const [a, b] = assessPlanGap([two(P), two(Q)]);
    // 3 seats: P places 2, Q gets the last 1 of its 2 — nothing idle anywhere, not 3 + 3 seats summed.
    expect(a).toMatchObject({ peerSeats: 3, idle: 0, sharedPeers: ["mate"] });
    expect(b).toMatchObject({ idle: 0, sharedPeers: ["mate"] });
    expect(fleetIdle([two(P), two(Q)])).toBe(0);
    const one = (p: string) => pf(p, { localRoom: 0, work: [item("a"), item("x", { state: "blocked", gate: "spec", why: "缺规格" })] });
    const [c, d] = assessPlanGap([one(P), one(Q)]);
    expect([c.idle, d.idle]).toEqual([1, 1]); // the same leftover seat, visible to both
    expect(fleetIdle([one(P), one(Q)])).toBe(1);
  });

  test("a project refused by a shared peer does not zero the pool for the project that is allowed", () => {
    const gap = (p: string, allowed: boolean) => pf(p, { localRoom: 0, work: [item("x", { state: "blocked", gate: "spec", why: "缺规格" })], peers: [peer("mate", 3, allowed)] });
    for (const order of [[gap(P, true), gap(Q, false)], [gap(Q, false), gap(P, true)]]) {
      const byP = Object.fromEntries(assessPlanGap(order).map((g) => [g.project, g]));
      expect(byP[P]).toMatchObject({ idle: 3, peerSeats: 3, sharedPeers: [] });
      expect(byP[Q]).toMatchObject({ idle: 0, peerSeats: 0 });
      expect(fleetIdle(order)).toBe(3);
    }
  });

  test("ready work is matched, not placed greedily: project order never invents a shortage", () => {
    const stuck = item("x", { state: "blocked", gate: "spec", why: "缺规格" });
    const a = pf(P, { localRoom: 0, work: [item("a"), stuck], peers: [peer("shared", 1), peer("only-a", 1)] });
    const b = pf(Q, { localRoom: 0, work: [item("b"), stuck], peers: [peer("shared", 1)] });
    for (const order of [[a, b], [b, a]]) {
      expect(fleetIdle(order)).toBe(0);
      expect(assessPlanGap(order).map((g) => g.idle)).toEqual([0, 0]);
    }
  });

  test("per-project idle: seats the project could still fill with every other project's ready work placed", () => {
    const stuck = item("x", { state: "blocked", gate: "spec", why: "缺规格" });
    const a = pf(P, { localRoom: 0, work: [item("a"), stuck], peers: [peer("x", 1), peer("y", 1)] });
    const b = pf(Q, { localRoom: 0, work: [stuck], peers: [peer("y", 1)] });
    for (const order of [[a, b], [b, a]]) {
      const byP = Object.fromEntries(assessPlanGap(order).map((g) => [g.project, g.idle]));
      expect(byP).toEqual({ [P]: 1, [Q]: 1 });
      expect(fleetIdle(order)).toBe(1);
    }
  });

  test("a project's budget on a peer caps only its own edge; fleet idle never counts seats nobody may fill", () => {
    const stuck = item("x", { state: "blocked", gate: "spec", why: "缺规格" });
    const capped = pf(Q, { localRoom: 0, work: [stuck], peers: [{ ...peer("mate", 3), seats: 1, budget: 1 }] });
    expect(fleetIdle([capped])).toBe(1);
    expect(assessPlanGap([capped])[0]).toMatchObject({ idle: 1, peerSeats: 1 });
    const open = pf(P, { localRoom: 0, work: [stuck], peers: [peer("mate", 3)] });
    for (const order of [[open, capped], [capped, open]]) {
      expect(Object.fromEntries(assessPlanGap(order).map((g) => [g.project, g.idle]))).toEqual({ [P]: 3, [Q]: 1 });
      expect(fleetIdle(order)).toBe(3);
    }
  });

  test("local-only ready work uses local room first; it never takes a peer seat", () => {
    const [g] = assessPlanGap([pf(P, { localRoom: 1, work: [item("lo", { external: false }), item("lo2", { external: false }), item("e")] })]);
    expect(g).toMatchObject({ ready: 3, readyLocalOnly: 2, readyExternal: 1, idle: 2 });
  });

  test("notice text lists blockers, holds and drafts and never picks a scope", () => {
    const [g] = assessPlanGap([pf(P, {
      work: [item("b", { state: "blocked", gate: "lanes", why: "依赖没满足：a" }), item("r5", { state: "hold", hold: "superseded", why: "规格写明已被 W7 替代" })],
      drafts: [{ name: "t-new", title: "新卡", flags: ["missing_deps"], why: ["没写前置节点"] }],
    })]);
    const text = planGapText(g);
    expect(text).toContain("t-b");
    expect(text).toContain("已被替代");
    expect(text).toContain("t-new「新卡」 [缺依赖]");
    expect(text).toContain("不会自动选范围");
  });
});

test("end to end on a real ledger: facts → tick → one notice naming the stuck node", async () => {
  const now = 10_000_000;
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  setMeta(db, { actor: "owner", now: 500 }, { project: P, key: "pms", value: ["agent-pm"] });
  createFeature(db, { actor: "agent-pm", now }, { project: P, slug: "i28", title: "t" });
  initDag(db, { actor: "agent-pm", now: now + 1 }, { id: "ab12-i28", rev: 1, nodes: [
    { key: "a", oneLine: "a", fileGlobs: ["src/a.ts"], deps: [] }, { key: "b", oneLine: "b", fileGlobs: ["src/b.ts"], deps: ["a"] },
  ] });
  const spec = { mtimeMs: now - SPEC_SETTLE_MS - 1, text: "# s\n模板：code\n\n## x\n" };
  const facts = (project: string) => readPlanGapFacts(db, project, {
    now, svc: { autoDispatch: true, projects: [P], maxWorkers: () => 3 }, pool: () => ({ remote: null, borrow: [] }),
    readSpec: (id) => (id === "i28-a" || id === "i28-b" ? spec : null), drafts: () => [],
  });
  const out = await planGapTick(deps({ now, policy: on(0), facts }));
  expect(out[0]).toMatchObject({ action: "notified", gap: { ready: 1, localRoom: 3, idle: 2 } });
  expect(sent[0].text).toContain("i28-b");
  expect(sent[0].text).toContain("依赖没满足");
});

test("real read path: a legacy project's borrow maxOpen is its own budget, never the peer's physical pool", async () => {
  const { recordHello } = await import("../src/lib/ledger-lend-peers.js");
  const now = 10_000_000;
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  for (const [project, slug] of [[P, "pa"], [Q, "pb"]]) {
    setMeta(db, { actor: "owner", now: 500 }, { project, key: "pms", value: ["agent-pm"] });
    createFeature(db, { actor: "agent-pm", now }, { project, slug, title: "t" });
    initDag(db, { actor: "agent-pm", now: now + 1 }, { id: `ab12-${slug}`, rev: 1, nodes: [{ key: "x", oneLine: "x", fileGlobs: [`src/${slug}.ts`], deps: [] }] });
  }
  recordHello(db, "mate", null, { v: 1, proto: 2, boot: "b", seq: 1, paused: null,
    grant: { until: now + 86_400_000, roles: ["review", "write"], repos: ["a/b"], ordersPerDay: 50, ordersLeftToday: 50 },
    slots: { codex: { total: 3, busy: 0 }, claude: { total: 0, busy: 0 } } }, now);
  const borrow = [{ peer: "mate", projects: [P, Q], roles: ["review", "write"] as ("review" | "write")[], maxOpen: 1 }];
  const base = { mode: "balance" as const, roles: ["review", "write"] as ("review" | "write")[], poolTimeoutMin: 15, repo: "a/b", localPriority: "off" as const };
  const remotes: Record<string, RemotePolicy> = { [P]: { ...base, agents: { codex: 3, claude: 0 } }, [Q]: base };
  const facts = [P, Q].map((project) => readPlanGapFacts(db, project, {
    now, svc: { autoDispatch: true, projects: [P, Q], maxWorkers: () => 3 }, pool: (p) => ({ remote: remotes[p], borrow }),
    readSpec: () => null, drafts: () => [],
  }));
  // one hello, one physical pool: both projects read the same 3 free codex slots; the legacy maxOpen=1 is only Q's budget
  expect(facts.map((f) => f.peers[0].free.codex)).toEqual([3, 3]);
  expect(facts.map((f) => f.peers[0].seats)).toEqual([3, 1]);
  for (const order of [facts, [...facts].reverse()]) {
    const byP = Object.fromEntries(assessPlanGap(order).map((g) => [g.project, g.idle]));
    expect(byP).toEqual({ [P]: 3, [Q]: 1 });
    expect(fleetIdle(order)).toBe(3);
  }
});
