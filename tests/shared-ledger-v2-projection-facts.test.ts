/** S2F9: center review / restate conclusions land as facts the home planner reads, only for a central card (synthetic center, temp ledger). */
import { afterEach, describe, expect, test } from "bun:test";
import { getTask } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { configureCenterFactRoute } from "../src/lib/scheduler-center-facts.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { currentReviewFacts } from "../src/lib/scheduler-review.js";
import { schedulerV2Route } from "../src/lib/scheduler-v2-pass.js";
import { writeExecutionProjection } from "../src/lib/shared-ledger-v2-projection.js";
import { PROJECTION_ACTOR, withProjectionScope } from "../src/lib/shared-ledger-v2-write-gate.js";
import { executionMode, HEAD_A, HEAD_B, intent, ledger, ref, step, task, view, workflow, type Ledger } from "./shared-ledger-v2-stage2-projection-fixture.test.js";

type Obj = Record<string, any>;
const central = (yes: boolean) => configureCenterFactRoute((id) => yes && id === "T1");
afterEach(() => configureCenterFactRoute((id) => schedulerV2Route(id) === "central"));

const reviewer = { kind: "agent", instanceId: "local", agentId: "rv" };
const reviewTask = (patch: Obj = {}) => task("T1", { stage: "review", review: { verdict: "pass", reviewedHead: HEAD_A, reportArtifactId: "report-1" }, ...patch });
const reviewStep = (patch: Obj = {}) => step("T1", { step: "review", executor: reviewer, state: "done", verdict: "pass", headTo: HEAD_A,
  verified: { author: null, independentReviewer: true, verifiedHead: HEAD_A, evidenceArtifactIds: ["report-1"] },
  claims: { family: "codex", model: null, summary: "" }, ...patch });
const reviewDone = intent("rv1", "T1", { node: "adversarial_review", action: "review", status: "done", resources: [] });
const reviewView = (seq: number, t: Obj = reviewTask(), s: Obj[] = [reviewStep()]) =>
  view(seq, { tasks: [t], steps: s, workflows: [workflow("T1")], intents: [reviewDone] });
const restateView = (seq: number) => view(seq, { tasks: [task("T1", { stage: "restate", round: 0 })], workflows: [workflow("T1", { templateVersion: 3 })] });

const plan = (l: Ledger) => planScheduler(autoSnapshot(l.db, getTask(l.db, "T1")!, { registry: [], maxWorkers: 2, now: 9000 }));
const facts = (l: Ledger, kind: string) => l.rows("SELECT actor, text, data, dedupKey FROM events WHERE target='T1' AND kind=?", kind)
  .map(e => ({ ...e, data: JSON.parse(e.data as string) }) as Obj);
/** A raw (ungated) event, standing for a local writer's record on the same card. */
const rawEvent = (l: Ledger, actor: string, kind: string, data: Obj, dedupKey: string | null = null) =>
  l.db.query("INSERT INTO events (ts, actor, project, target, kind, text, data, dedupKey) VALUES (9000, ?, 'p', 'T1', ?, '', ?, ?)")
    .run(actor, kind, JSON.stringify(data), dedupKey);
function projected(views: Obj[]): Ledger {
  const l = ledger();
  l.setMode(executionMode);
  for (const v of views) writeExecutionProjection(l.db, v, ref);
  return l;
}
const IN_FLIGHT = { kind: "wait" as const, code: "in_flight", reason: "等待 adversarial_review 的台账结果（done）" };

describe("S2F9 center review facts", () => {
  test("[验收线 1] complete center pass evidence: currentReviewFacts is facts and the planner moves to merge instead of waiting", () => {
    const l = projected([reviewView(10)]);
    try {
      central(true);
      const [fact] = facts(l, "review");
      expect(fact!.actor).toBe(PROJECTION_ACTOR);
      expect(fact!.data).toMatchObject({ source: "center-projection", round: 2, head: HEAD_A, verdict: "pass", reviewer: "rv",
        reviewerSessionId: null, reviewerFamily: "codex", path: "center-artifact:report-1", findings: [], findingsKnown: false,
        p0: 0, p1: 0, p2: null, countsFrom: "verdict", centerSeq: 10 });
      const read = currentReviewFacts(getTask(l.db, "T1")!, autoSnapshot(l.db, getTask(l.db, "T1")!, { registry: [], maxWorkers: 2 }).events);
      expect(read.kind).toBe("facts");
      expect(plan(l)).toMatchObject({ kind: "intent", node: "adversarial_review", action: "stage", targetStage: "merge" });
    } finally { l.close(); }
  });

  test("[验收线 2] one piece missing (head / report / round / independence): no review fact, the planner keeps waiting", () => {
    const cases: [string, Obj][] = [
      ["head", reviewView(10, reviewTask({ review: { verdict: "pass", reviewedHead: HEAD_B, reportArtifactId: "report-1" } }))],
      ["report", reviewView(10, reviewTask({ review: { verdict: "pass", reviewedHead: HEAD_A, reportArtifactId: null } }))],
      ["round", reviewView(10, reviewTask(), [reviewStep({ round: 1 })])],
      ["verdict", reviewView(10, reviewTask(), [reviewStep({ verdict: "changes" })])],
      ["independent", reviewView(10, reviewTask(), [reviewStep({ verified: { author: null, independentReviewer: false, verifiedHead: HEAD_A, evidenceArtifactIds: [] } })])],
    ];
    for (const [name, v] of cases) {
      const l = projected([v]);
      try {
        central(true);
        expect([name, facts(l, "review")]).toEqual([name, []]);
        expect([name, plan(l)]).toEqual([name, IN_FLIGHT]);
      } finally { l.close(); }
    }
  });

  test("[验收线 2] the review step did not verify this head / report: no review fact, the planner keeps waiting", () => {
    const verified = (head: string, ids: string[]) => ({ author: null, independentReviewer: true, verifiedHead: head, evidenceArtifactIds: ids });
    const cases: [string, Obj][] = [
      ["no evidence", reviewView(10, reviewTask(), [reviewStep({ verified: verified(HEAD_A, []) })])],
      ["other report", reviewView(10, reviewTask(), [reviewStep({ verified: verified(HEAD_A, ["report-2"]) })])],
      ["other head", reviewView(10, reviewTask(), [reviewStep({ headTo: HEAD_B, verified: verified(HEAD_B, ["report-1"]) })])],
      ["verifiedHead", reviewView(10, reviewTask(), [reviewStep({ verified: verified(HEAD_B, ["report-1"]) })])],
      ["headTo", reviewView(10, reviewTask(), [reviewStep({ headTo: HEAD_B })])],
    ];
    for (const [name, v] of cases) {
      const l = projected([v]);
      try {
        central(true);
        expect([name, facts(l, "review")]).toEqual([name, []]);
        expect([name, plan(l)]).toEqual([name, IN_FLIGHT]);
      } finally { l.close(); }
    }
  });

  test("[验收线 2] a newer snapshot no longer proves the pass (same generation, or a restored center): the old fact is not taken", () => {
    const gone = reviewTask({ review: { verdict: null, reviewedHead: null, reportArtifactId: null } });
    for (const [name, later] of [
      ["seq 10→11", reviewView(11, gone, [])],
      ["generation 1→2, seq 10→1", { ...reviewView(1, gone, []), serviceGeneration: 2 }],
    ] as const) {
      const l = projected([reviewView(10), later]);
      try {
        central(true);
        expect([name, facts(l, "review").length]).toEqual([name, 1]); // the earlier fact stays on record, revoked by the newer card event
        expect([name, currentReviewFacts(getTask(l.db, "T1")!, autoSnapshot(l.db, getTask(l.db, "T1")!, { registry: [], maxWorkers: 2 }).events).kind])
          .not.toEqual([name, "facts"]);
        // Read as any unbacked record: no home session, so it stops instead of merging on a pass the center no longer holds.
        expect([name, plan(l)]).toEqual([name, { kind: "escalate", code: "review_invalid", reason: "审查结论缺结构化字段或报告路径" }]);
      } finally { l.close(); }
    }
  });

  test("[验收线 2] the same evidence back after a gap: the one fact is taken again, nothing rewritten", () => {
    const gone = reviewTask({ review: { verdict: null, reviewedHead: null, reportArtifactId: null } });
    const l = projected([reviewView(10), reviewView(11, gone, []), reviewView(12)]);
    try {
      central(true);
      expect(facts(l, "review")).toHaveLength(1);
      expect(plan(l)).toMatchObject({ kind: "intent", node: "adversarial_review", action: "stage", targetStage: "merge" });
    } finally { l.close(); }
  });

  test("[验收线 1] a restored center backs an earlier fact again after another review (A→B→A): the backed fact drives merge", () => {
    const report = (r: string, head = HEAD_A) => reviewView(0, reviewTask({ head, review: { verdict: "pass", reviewedHead: head, reportArtifactId: r } }),
      [reviewStep({ headTo: head, verified: { author: null, independentReviewer: true, verifiedHead: head, evidenceArtifactIds: [r] } })]);
    const at = (v: Obj, serverSeq: number, serviceGeneration = 1) => ({ ...v, serverSeq, serviceGeneration });
    for (const [name, middle] of [["head A / report-2", report("report-2")], ["head B / report-2", report("report-2", HEAD_B)]] as const) {
      const l = projected([at(report("report-1"), 10), at(middle, 11), at(report("report-1"), 1, 2)]);
      try {
        central(true);
        expect([name, facts(l, "review").length]).toEqual([name, 2]); // report-1's fact is not rewritten on restore
        expect([name, plan(l)]).toMatchObject([name, { kind: "intent", node: "adversarial_review", action: "stage", targetStage: "merge" }]);
        writeExecutionProjection(l.db, at(report("report-1"), 2, 2), ref);
        expect([name, facts(l, "review").length, plan(l)]).toMatchObject([name, 2, { kind: "intent", action: "stage", targetStage: "merge" }]);
      } finally { l.close(); }
    }
  });

  test("[验收线 3] v3 card the center moved to restate: a projected stage fact, the planner no longer reports restate_missing", () => {
    const l = projected([restateView(10)]);
    try {
      central(true);
      const [fact] = facts(l, "stage");
      expect(fact!.data).toMatchObject({ source: "center-projection", from: "spec", to: "restate", specRev: 1 });
      expect(fact!.text).toContain("serverSeq 10");
      expect(plan(l)).toMatchObject({ kind: "intent", node: "approve_restate", action: "stage", targetStage: "build" });
    } finally { l.close(); }
  });

  test("[验收线 4] the same center state synced again (newer serverSeq): one review fact and one stage fact", () => {
    const l = projected([reviewView(10), reviewView(11), reviewView(12, reviewTask({ rev: 2, updatedAt: 2000 }))]);
    const r = projected([restateView(10), restateView(11)]);
    try {
      expect(facts(l, "review")).toHaveLength(1);
      expect(facts(r, "stage")).toHaveLength(1);
    } finally { l.close(); r.close(); }
  });
});

describe("S2F9 guard rails", () => {
  test("(a) not central: the projected fact is not taken; the planner reads it as before (invalid: no home session)", () => {
    const l = projected([reviewView(10)]);
    try {
      central(false);
      expect(plan(l)).toEqual({ kind: "escalate", code: "review_invalid", reason: "审查结论缺结构化字段或报告路径" });
    } finally { l.close(); }
  });

  test("(a) central but no projection marker: the same data, or a full local review, still needs the receipt and session", () => {
    const base = { round: 2, head: HEAD_A, verdict: "pass", reviewer: "rv", reviewerFamily: "codex", path: "/r.md", findings: [], p0: 0, p1: 0, p2: 0 };
    for (const [actor, data, key, want] of [
      ["rv", { ...base, source: "center-projection", reviewerSessionId: null }, "center-fact:review:T1:x", "review_invalid"],
      [PROJECTION_ACTOR, { ...base, reviewerSessionId: null }, "center-fact:review:T1:y", "review_invalid"],
      [PROJECTION_ACTOR, { ...base, source: "center-projection", reviewerSessionId: null }, "other:T1", "review_invalid"],
      ["rv", { ...base, reviewerSessionId: "s-rv" }, null, "review_unsolicited"],
    ] as const) {
      const l = projected([reviewView(10, reviewTask({ review: { verdict: null, reviewedHead: null, reportArtifactId: null } }))]);
      try {
        central(true);
        rawEvent(l, actor, "review", data, key);
        expect(plan(l)).toMatchObject({ kind: "escalate", code: want });
      } finally { l.close(); }
    }
  });

  test("(a) restate: a projected stage fact on a card that is not central reads as no record", () => {
    const l = projected([restateView(10)]);
    try {
      central(false);
      expect(plan(l)).toMatchObject({ kind: "escalate", code: "restate_missing" });
    } finally { l.close(); }
  });

  test("(b) marker right but the head moved on: the fact is not taken", () => {
    const l = projected([reviewView(10), reviewView(11, reviewTask({ head: HEAD_B, rev: 2, updatedAt: 2000 }))]);
    try {
      central(true);
      expect(facts(l, "review")).toHaveLength(1);
      expect(plan(l)).toEqual({ kind: "escalate", code: "review_invalid", reason: "审查结论的完整 head 与任务不一致" });
    } finally { l.close(); }
  });
});

describe("S2F9 write gate", () => {
  let seq = 50; // each token a newer watermark, so only the shape decides
  const ok = { source: "center-projection", round: 2 };
  function attempt(l: Ledger, kind: string, data: Obj, dedupKey: string, target = "T1", actor = PROJECTION_ACTOR, scoped = true): unknown {
    const write = () => insertEvent(l.db, { actor, now: 9000, dedupKey }, { project: "p", target, kind: kind as never, data }, true);
    try { scoped ? withProjectionScope(l.db, { featureId: "F", centerSeq: ++seq, serviceGeneration: 1 }, write) : write(); return "written"; }
    catch (e) { return (e as { code?: string }).code; }
  }

  test("only the two center fact shapes under a center-fact: key pass the projection token", () => {
    const l = projected([view(10, { tasks: [task("T1")] })]);
    try {
      l.db.query("INSERT INTO tasks (id, project, title, kind, stage, round, extra, createdAt, updatedAt) VALUES ('G1', 'p', 'g', 'code', 'build', 0, ?, 1, 1)")
        .run(JSON.stringify({ sharedFeatureId: "G" }));
      expect(attempt(l, "review", ok, "center-fact:review:T1:a")).toBe("written");
      expect(attempt(l, "stage", { ...ok, from: "spec", to: "restate" }, "center-fact:stage:T1:1:restate")).toBe("written");
      expect(attempt(l, "review", { round: 2 }, "center-fact:review:T1:b")).toBe("forbidden");
      expect(attempt(l, "review", ok, "review:T1:c")).toBe("forbidden");
      expect(attempt(l, "stage", { ...ok, from: "restate", to: "build" }, "center-fact:stage:T1:1:build")).toBe("forbidden");
      expect(attempt(l, "merge", ok, "center-fact:merge:T1")).toBe("forbidden");
      expect(attempt(l, "note", ok, "center-fact:note:T1")).toBe("forbidden");
      expect(attempt(l, "review", ok, "center-fact:review:G1:d", "G1")).toBe("forbidden");
      // Non-projection actors: unchanged (an execution card refuses local writes; the projection identity needs its token).
      expect(attempt(l, "review", ok, "center-fact:review:T1:e", "T1", "rv", false)).toBe("forbidden");
      expect(attempt(l, "review", ok, "center-fact:review:T1:f", "T1", PROJECTION_ACTOR, false)).toBe("forbidden");
      expect(attempt(l, "review", ok, "center-fact:review:T1:g", "T1", "rv")).toBe("forbidden");
    } finally { l.close(); }
  });
});
