/**
 * REVSEAT1 at the planner and the tick hook: real temp ledger snapshots (autoSnapshot) with the agent-pool path and a v2 peer put in
 * the pool facts, the production tick hook trackReviewSeatWait writing the window notes, and pure snapshots for the verdict side
 * (PMHAND1 control). End to end through scheduler-pool and B's real tools: tests/scheduler-review-seat-lend-proof.test.ts.
 */
import { rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import type { SchedulerIntent, TaskWorkflow } from "../src/lib/ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "../src/lib/ledger-stages.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { HANDBACK_REVIEW_TAG } from "../src/lib/pm-handback.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { planScheduler, type PlannerSnapshot, type WorkerRef } from "../src/lib/scheduler-plan.js";
import { seatWindow } from "../src/lib/scheduler-review-seat-lend.js";
import { trackReviewSeatWait } from "../src/lib/scheduler-review-seat-wait.js";
import { autoFixture, H2 } from "./scheduler-auto-helpers.js";
import { addSeat, reviewEffect } from "./scheduler-review-seat-fixture.test.js";

const MIN = 60_000;
const MATE = { peer: "mate", open: 0, maxOpen: 1, v2: { why: null, roles: ["review"], repos: ["o/r"], slots: { claude: 0, codex: 1 } } };
type Peer = typeof MATE | { peer: string; open: number; maxOpen: number; v2: { why: null; roles: string[]; repos: string[]; slots: { claude: number; codex: number } } };

afterEach(() => { rmSync(RECOVERY_POLICY_PATH, { force: true }); });
const setKey = (mode: "on" | "observe" | "off") =>
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { reviewSeatLend: mode } } } }));

/** T1 in review round 2 on H2, reviewer agent-rv-t1 bound here, every codex seat (8) taken by other cards' authors. */
function setup(remoteOver: Partial<RemotePolicy> = {}) {
  const f = autoFixture();
  f.db.query("UPDATE tasks SET stage='review',round=2,headSHA=?,pr='https://github.com/o/r/pull/7' WHERE id='T1'").run(H2);
  for (let n = 0; n < 8; n++) addSeat(f.db, `author${n}`, "author", "build");
  f.db.query(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
    VALUES ('T1','reviewer','agent-rv-t1','s-rv','codex','acp','active','earlier',0,0)`).run();
  const remote: RemotePolicy = { agents: { claude: 0, codex: 8 }, mode: "balance", roles: ["review"], poolTimeoutMin: 15, ...remoteOver };
  const snapshot = (peers: readonly Peer[] = [MATE], edit?: (s: PlannerSnapshot) => void) => {
    const s = autoSnapshot(f.reader.get()!, f.task(), { registry: [], maxWorkers: 8, now: f.tickDeps.now(), pool: { remote, borrow: [] } });
    s.pool = { ...s.pool!, peers: peers as never };
    edit?.(s);
    return s;
  };
  const run = async (peers?: readonly Peer[], edit?: (s: PlannerSnapshot) => void) => {
    const s = snapshot(peers, edit), plan = planScheduler(s);
    await trackReviewSeatWait(f.reader.get()!, f.task(), s, plan, f.tickDeps);
    return plan;
  };
  const notes = (seat?: string) => listEvents(f.db, { target: "T1" }).filter((e) => e.data.mechanism === "reviewSeatLend" && (!seat || e.data.seat === seat));
  const freeSeats = () => f.db.query("UPDATE tasks SET stage='merge' WHERE id LIKE 'author%'").run();
  return { ...f, snapshot, run, notes, freeSeats };
}
const lent = { kind: "intent", action: "review", recipient: "peer:mate" };

describe("[验收线 2] the window: reviewer gone, restart, head / specRev / round", () => {
  test("a bound reviewer whose session is retiring lends at 30 minutes even after a local seat frees", async () => {
    const f = setup();
    try {
      f.db.query("UPDATE scheduler_sessions SET state='retiring' WHERE taskId='T1' AND role='reviewer'").run();
      expect(await f.run()).toMatchObject({ kind: "wait", code: "placement" });
      expect(f.notes("start")).toEqual([expect.objectContaining({ data: expect.objectContaining({ evidence: "reviewer_gone", reviewer: "agent-rv-t1" }) })]);
      f.freeSeats();
      f.advance(29 * MIN);
      expect(await f.run()).not.toMatchObject(lent);
      f.advance(MIN);
      const plan = await f.run();
      expect(plan).toMatchObject(lent);
      expect(plan.kind === "intent" && plan.reason).toContain("原审查会话已不在");
    } finally { f.close(); }
  });

  test("the start survives a restart (fresh reader, no process clock) and is not re-written", async () => {
    const f = setup();
    try {
      await f.run(); f.advance(20 * MIN);
      f.reader.close(); await f.run();
      f.reader.close(); f.advance(10 * MIN);
      expect(await f.run()).toMatchObject(lent);
      expect(f.notes("start")).toHaveLength(1);
    } finally { f.close(); }
  });

  for (const [what, sql] of [["head", "headSHA='3333333333333333333333333333333333333333'"], ["specRev", "specRev=specRev+1"], ["round", "round=3"]] as const) {
    test(`a ${what} change starts a new window: the old start can never lend`, async () => {
      const f = setup();
      try {
        await f.run(); f.advance(20 * MIN);
        f.db.query(`UPDATE tasks SET ${sql} WHERE id='T1'`).run();
        if (what === "specRev") f.db.query("UPDATE task_workflows SET specRev=specRev+1 WHERE taskId='T1'").run();
        await f.run(); f.advance(15 * MIN);
        expect(await f.run()).not.toMatchObject(lent);
        expect(new Set(f.notes("start").map((e) => e.data.window)).size).toBe(2);
        f.advance(15 * MIN);
        expect(await f.run()).toMatchObject(lent);
      } finally { f.close(); }
    });
  }
});

describe("[验收线 3] no double lend, no lend beside a live review, quiet waits", () => {
  test("a review in flight neither starts a window nor lends, whatever the clock says", async () => {
    const f = setup();
    try {
      reviewEffect(f.db, "T1", "submitted");
      await f.run(); f.advance(60 * MIN); await f.run();
      expect(f.notes()).toEqual([]);
      expect(await f.run()).not.toMatchObject(lent);
    } finally { f.close(); }
  });

  test("no eligible peer: stays an auto wait with one reason note over many ticks, no PM notice", async () => {
    const f = setup();
    try {
      const busy = { ...MATE, v2: { ...MATE.v2, slots: { claude: 0, codex: 0 } } };
      const first = await f.run([busy]);
      f.advance(30 * MIN);
      for (let n = 0; n < 5; n++) { expect(await f.run([busy])).toEqual(first); f.advance(MIN); }
      expect(f.notes("nopeer")).toHaveLength(1);
      expect(f.notices).toEqual([]);
    } finally { f.close(); }
  });

  test("a freed local seat ends the window (local review planned); a later wait starts a new 30 minutes", async () => {
    const f = setup();
    try {
      await f.run(); f.advance(20 * MIN);
      f.freeSeats();
      expect(await f.run()).toMatchObject({ kind: "intent", recipient: "agent-rv-t1" });
      expect(f.notes("end")).toHaveLength(1);
      f.db.query("UPDATE tasks SET stage='build' WHERE id LIKE 'author%'").run();
      await f.run(); f.advance(15 * MIN);
      expect(await f.run()).not.toMatchObject(lent);
      f.advance(15 * MIN);
      expect(await f.run()).toMatchObject(lent);
      expect(f.notes("start")).toHaveLength(2);
    } finally { f.close(); }
  });

  test("a seat freed after the threshold keeps the review local (the planner re-checks the evidence)", async () => {
    const f = setup();
    try {
      await f.run(); f.advance(31 * MIN);
      f.freeSeats();
      expect(planScheduler(f.snapshot())).toMatchObject({ kind: "intent", recipient: "agent-rv-t1" });
    } finally { f.close(); }
  });
});

describe("[验收线 5] the limits the lend never bypasses", () => {
  const overdue = async (f: ReturnType<typeof setup>, peers?: readonly Peer[], edit?: (s: PlannerSnapshot) => void) => {
    await f.run(peers, edit); f.advance(31 * MIN);
    return f.run(peers, edit);
  };

  test("cross-family: a peer with only the author's family free is not a candidate", async () => {
    const f = setup();
    try {
      expect(await overdue(f, [{ ...MATE, v2: { ...MATE.v2, slots: { claude: 3, codex: 0 } } }])).toMatchObject({ kind: "wait", code: "placement" });
    } finally { f.close(); }
  });

  test("an unauthorized repository is not a candidate", async () => {
    const f = setup();
    try {
      expect(await overdue(f, [{ ...MATE, v2: { ...MATE.v2, repos: ["elsewhere/r"] } }])).toMatchObject({ kind: "wait", code: "placement" });
    } finally { f.close(); }
  });

  test("remote off keeps the review here", async () => {
    const f = setup({ mode: "off" });
    try {
      expect(await overdue(f)).not.toMatchObject(lent);
    } finally { f.close(); }
  });

  test("a local-only security card opens no window", async () => {
    const f = setup();
    try {
      const sec = (s: PlannerSnapshot) => { s.workflow = { ...s.workflow!, template: "security" }; };
      expect(await overdue(f, [MATE], sec)).not.toMatchObject(lent);
      expect(seatWindow(f.snapshot([MATE], sec))).toBeNull();
      expect(f.notes()).toEqual([]);
    } finally { f.close(); }
  });

  test("an open model safety hold opens no window and is not lent around", async () => {
    const f = setup();
    try {
      const hold = (s: PlannerSnapshot) => {
        s.events = [...s.events, { seq: 9_999, ts: 0, actor: "scheduler", project: "p", target: "T1", kind: "scheduler", text: "", dedupKey: null,
          data: { op: "model_safety_hold" } }];
      };
      expect(await overdue(f, [MATE], hold)).not.toMatchObject(lent);
      expect(seatWindow(f.snapshot([MATE], hold))).toBeNull();
    } finally { f.close(); }
  });

  test("a start note from anyone but the scheduler identity does not count", async () => {
    const f = setup();
    try {
      const w = seatWindow(f.snapshot())!;
      f.db.query(`INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (?,'pm','p','T1','note','',?)`).run(f.tickDeps.now(),
        JSON.stringify({ op: "recovery_observe", mechanism: "reviewSeatLend", window: w.digest, seat: "start", evidence: "reviewer_gone" }));
      f.advance(31 * MIN);
      expect(planScheduler(f.snapshot())).toMatchObject({ kind: "wait", code: "placement" });
    } finally { f.close(); }
  });
});

describe("[验收线 6] reviewSeatLend=off", () => {
  test("an overdue start under off: the same decision, reason and diagnostics as a snapshot without any seat-lend note", async () => {
    const f = setup();
    try {
      await f.run(); f.advance(31 * MIN);
      setKey("off");
      const without = (s: PlannerSnapshot) => { s.events = s.events.filter((e) => e.data.mechanism !== "reviewSeatLend"); };
      const off = planScheduler(f.snapshot()), legacy = planScheduler(f.snapshot([MATE], without));
      expect(JSON.stringify(off)).toBe(JSON.stringify(legacy));
      expect(off).toMatchObject({ kind: "wait", code: "placement" });
      const before = f.notes().length;
      for (let n = 0; n < 3; n++) { await f.run(); f.advance(30 * MIN); }
      expect(f.notes()).toHaveLength(before);
      expect(f.notices).toEqual([]);
    } finally { f.close(); }
  });

  test("off from the start writes nothing; observe records the would-lend once and never lends", async () => {
    const f = setup();
    try {
      setKey("off");
      await f.run(); f.advance(40 * MIN); await f.run();
      expect(f.notes()).toEqual([]);
      setKey("observe");
      await f.run(); f.advance(31 * MIN);
      expect(await f.run()).toMatchObject({ kind: "wait", code: "placement" });
      await f.run();
      expect(f.notes("would")).toHaveLength(1);
    } finally { f.close(); }
  });
});

// Pure snapshots for the verdict side, in the shape autoSnapshot gives a pooled round (pm-handback.test.ts's card, round 1).
const HEAD = "a".repeat(40);
const local: WorkerRef = { agent: "agent-review", sessionId: "session-review", taskId: "T1", family: "codex", source: "local" };
const pooled: WorkerRef = { agent: "peer:mate", sessionId: "lend:mate:lend:T1:s1:r1:a0", taskId: "T1", family: "codex", source: "peer_claim" };
const ev = (seq: number, kind: LedgerEvent["kind"], data: Record<string, unknown>, actor = "agent-author"): LedgerEvent =>
  ({ seq, kind, data, ts: seq, actor, project: "p", target: "T1", text: "", dedupKey: null });
const card: LedgerTask = { id: "T1", project: "p", itemId: null, title: "REVSEAT1", kind: "code", stage: "review", stageBefore: null, round: 1,
  agent: "agent-author", assigneeKind: "agent", assignee: "agent-author", pm: "agent-pm", branch: "task/T1", pr: null,
  headSHA: HEAD, spec: null, specRev: 1, model: null, rev: 1, extra: {}, createdAt: 1, updatedAt: 1 };
const workflow: TaskWorkflow = { taskId: "T1", project: "p", template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude",
  fallback: "收窄为只报错", specRev: 1, rev: 1, createdAt: 1, updatedAt: 1 };
const verdict = (seq: number, who: WorkerRef, over: Record<string, unknown> = {}) => ev(seq, "review", { round: 1, head: HEAD, reviewer: who.agent,
  reviewerSessionId: who.sessionId, reviewerFamily: who.family, path: "reviews/T1-r1/report.md", verdict: "pass", findings: [], p0: 0, p1: 0, p2: 0, ...over }, who.agent);
const handback = (seq: number) => ev(seq, "scheduler", { op: "workflow_resume", from: "manual", specRev: 1, manual: true }, "agent-pm");
const poolIntent: SchedulerIntent = { id: "rv-lend", taskId: "T1", project: "p", node: "adversarial_review", action: "review", recipient: "peer:mate",
  causalSeq: 20, eventSeq: 21, taskRev: 1, specRev: 1, head: HEAD, templateVersion: 2, status: "done", attempts: 0, receipt: null,
  reason: "挂池：本机审查员 agent-review 久等 30 分钟（本机审查名额满），本轮借审给 mate 的 codex worker", createdAt: 21, updatedAt: 40 } as SchedulerIntent;
const proof = { intentId: "rv-lend", round: 1, head: HEAD, reviewer: pooled.agent, reviewerSessionId: pooled.sessionId, ackSeq: 25 };
const verdictSnap = (reviewer: WorkerRef, after: LedgerEvent[], over: Partial<PlannerSnapshot> = {}): PlannerSnapshot => ({
  task: card, workflow, events: [ev(1, "task", { op: "new" }), ev(11, "stage", { from: "build", to: "review", round: 1 }), ev(19, "deliver", { round: 1, headSHA: HEAD }), ...after],
  intents: [poolIntent], blockedBy: [], queueFrozen: false, fileGlobs: ["src/lib/*.ts"], heldResources: [], workerCount: 0, maxWorkers: 2,
  freeWorkerSlot: "slot:p:0", author: { ...local, agent: "agent-author", sessionId: "session-author", family: "claude" }, reviewer,
  reviewDispatches: [proof], uiGate: { state: "none" }, screenshotsDigest: null, ...over,
});
const toMerge = { kind: "intent", action: "stage", targetStage: "merge" };

describe("[验收线 4] a lent verdict is this round's, before and after a later PM hand-back", () => {
  test("the peer's same-head pass with its dispatch proof goes on to merge, also with a PM hand-back after it", () => {
    expect(planScheduler(verdictSnap(pooled, [verdict(30, pooled)]))).toMatchObject(toMerge);
    expect(planScheduler(verdictSnap(pooled, [verdict(30, pooled), handback(40)]))).toMatchObject(toMerge);
  });

  test("control: a PM hand-dispatched verdict before the hand-back is still re-reviewed (PMHAND1)", () => {
    const d = planScheduler(verdictSnap(local, [verdict(30, local), handback(40)], { intents: [], reviewDispatches: [] }));
    expect(d).toMatchObject({ kind: "intent", action: "review" });
    expect(d.kind === "intent" && d.reason.startsWith(HANDBACK_REVIEW_TAG)).toBe(true);
  });
});

describe("[验收线 5] lent verdicts that do not prove themselves", () => {
  const cases: [string, PlannerSnapshot][] = [
    ["wrong head", verdictSnap(pooled, [verdict(30, pooled, { head: "b".repeat(40) })])],
    ["wrong round", verdictSnap(pooled, [verdict(30, pooled, { round: 0 })])],
    ["forged source (no scheduler pool intent)", verdictSnap(pooled, [verdict(30, pooled)], { intents: [] })],
    ["missing claim receipt", verdictSnap(pooled, [verdict(30, pooled)], { reviewDispatches: [] })],
    ["wrong order id", verdictSnap(pooled, [verdict(30, { ...pooled, sessionId: "lend:mate:lend:T1:s1:r1:a9" })])],
  ];
  for (const [what, s] of cases) {
    test(`${what}: never merged on it`, () => {
      expect(planScheduler(s)).not.toMatchObject(toMerge);
    });
  }
});
