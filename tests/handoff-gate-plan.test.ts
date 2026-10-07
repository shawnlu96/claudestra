/**
 * HDG-1 pure side: the planner with handoff gate facts (hold vs queueFrozen, feature batch, order, both gates), and the batch
 * function of spec clarification 1. Facts read from a real ledger: handoff-gate.test.ts; the auto tick: handoff-gate-tick.test.ts.
 */
import { describe, expect, test } from "bun:test";
import type { LedgerEvent, LedgerTask, Stage } from "../src/lib/ledger-stages.js";
import type { SchedulerIntent, TaskWorkflow } from "../src/lib/ledger-scheduler.js";
import { planScheduler, type PlannerSnapshot, type WorkerRef } from "../src/lib/scheduler-plan.js";
import { batchWith, featureBatch, handoffGateWait, type FeatureGate, type GateNode, type NodeState } from "../src/lib/handoff-gate-plan.js";

const HEAD = "a".repeat(40);
const author: WorkerRef = { agent: "agent-author", sessionId: "s-a", taskId: "T1", family: "claude", source: "local" };
const reviewer: WorkerRef = { agent: "agent-review", sessionId: "s-r", taskId: "T1", family: "codex", source: "local" };
const event = (seq: number, kind: LedgerEvent["kind"], data: Record<string, unknown> = {}): LedgerEvent =>
  ({ seq, kind, data, ts: seq, actor: "x", project: "p", target: "T1", text: "", dedupKey: null });
const task = (stage: Stage, round: number): LedgerTask => ({
  id: "T1", project: "p", itemId: null, title: "t", kind: "code", stage, stageBefore: null, round, agent: author.agent, assigneeKind: "agent",
  assignee: author.agent, pm: "pm", branch: "b", pr: null, headSHA: HEAD, spec: null, specRev: 1, model: null, rev: 1, extra: {}, createdAt: 1, updatedAt: 1,
});
const workflow: TaskWorkflow = { taskId: "T1", project: "p", template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude",
  fallback: "人工", specRev: 1, rev: 1, createdAt: 1, updatedAt: 1 };
const sentReview: SchedulerIntent = { id: "review-r1", taskId: "T1", project: "p", node: "adversarial_review", action: "review", recipient: reviewer.agent,
  causalSeq: 14, eventSeq: 15, taskRev: 1, specRev: 1, head: HEAD, templateVersion: 2, status: "done", attempts: 0, receipt: null, reason: "x", createdAt: 1, updatedAt: 1 };
const passed = (findings: unknown[] = []) => event(20, "review", { round: 1, head: HEAD, reviewer: reviewer.agent, reviewerSessionId: reviewer.sessionId,
  reviewerFamily: "codex", path: "r.md", verdict: "pass", findings, p0: 0, p1: 0, p2: 0 });

const base = (): Omit<PlannerSnapshot, "task" | "events"> => ({ workflow: { ...workflow }, intents: [], blockedBy: [], queueFrozen: false, fileGlobs: ["src/lib/*.ts"],
  heldResources: [], workerCount: 0, maxWorkers: 2, freeWorkerSlot: "slot:p:0", author, reviewer, reviewDispatches: [],
  uiGate: { state: "none" }, screenshotsDigest: null });

/** A card that passed review at HEAD and sits in merge: without gates the planner plans its merge (handoff). */
function inMerge(): PlannerSnapshot {
  return { ...base(), task: task("merge", 1), intents: [sentReview],
    reviewDispatches: [{ intentId: "review-r1", round: 1, head: HEAD, reviewer: reviewer.agent, reviewerSessionId: reviewer.sessionId, ackSeq: 16 }],
    events: [event(1, "task", { op: "new" }), event(11, "stage", { to: "review", round: 1 }), event(12, "deliver", { round: 1, headSHA: HEAD }),
      passed(), event(31, "stage", { from: "review", to: "merge", round: 1 })] };
}
/** A card in build with its restate approved: the planner dispatches the write order. */
const inBuild = (): PlannerSnapshot => ({ ...base(), task: task("build", 0),
  events: [event(1, "task", { op: "new" }), event(5, "stage", { from: "restate", to: "build", round: 0 })] });

const HOLD = { hold: { on: true, reason: "本地继续做，交接排队", by: "pm", since: 1 }, feature: null };
const node = (key: string, state: NodeState, deps: string[] = [], stage: GateNode["stage"] = state === "pending" ? "build" : "merge"): GateNode =>
  ({ key, taskId: `X-${key}`, deps, state, stage, head: state === "pending" ? null : HEAD, round: 1 });
const feature = (self: string, nodes: GateNode[]): FeatureGate => ({ featureId: "f-HDG", version: 2, self, nodes });

describe("A. handoff hold", () => {
  test("#2 hold on: the reviewed card waits in merge with the reason, no merge plan; build still dispatches where queueFrozen stops", () => {
    expect(planScheduler(inMerge())).toMatchObject({ kind: "intent", action: "merge" });
    const held = { ...inMerge(), handoffGate: HOLD };
    expect(planScheduler(held)).toEqual({ kind: "wait", code: "handoff_hold", reason: "项目暂停交接（pm）：本地继续做，交接排队" });

    const build = inBuild();
    expect(planScheduler({ ...build, handoffGate: HOLD })).toMatchObject({ kind: "intent", action: "dispatch", recipient: author.agent });
    expect(planScheduler({ ...build, queueFrozen: true })).toMatchObject({ kind: "wait", code: "queue_frozen" });
    expect(planScheduler({ ...inMerge(), queueFrozen: true })).toMatchObject({ kind: "wait", code: "queue_frozen" });
  });

  test("#3 hold off: the same snapshot plans the merge again, nothing to resume by hand", () => {
    expect(planScheduler({ ...inMerge(), handoffGate: { hold: null, feature: null } })).toMatchObject({ kind: "intent", action: "merge" });
  });

  test("#4 a handoff already recorded in this merge stay is followed, not recalled, by either gate", () => {
    const s = inMerge();
    s.events = [...s.events, event(40, "scheduler", { op: "merge_handoff" })];
    const pending = feature("A", [node("A", "ready"), node("B", "pending")]);
    expect(planScheduler({ ...s, handoffGate: { ...HOLD, feature: pending } })).toMatchObject({ kind: "intent", action: "merge" });
    // back in merge after a fix: the old record belongs to the old stay
    s.events = [...s.events, event(50, "stage", { from: "fix", to: "merge", round: 1 })];
    expect(planScheduler({ ...s, handoffGate: HOLD })).toMatchObject({ kind: "wait", code: "handoff_hold" });
  });
});

describe("B. feature batch", () => {
  test("#5 a sibling in build / fix / review keeps the card waiting, naming node keys and cards; ready / handed / done pass", () => {
    for (const stage of ["build", "fix", "review"] as const) {
      const f = feature("A", [node("A", "ready"), node("B", "pending", [], stage), node("C", "done", [], "live")]);
      expect(planScheduler({ ...inMerge(), handoffGate: { hold: null, feature: f } })).toEqual({ kind: "wait", code: "feature_siblings_pending",
        reason: `feature f-HDG v2 同批还有节点没审过：B（X-B ${stage}）` });
    }
    const planned = feature("A", [node("A", "ready"), { ...node("B", "pending"), taskId: null, stage: "planned" }]);
    expect(handoffGateWait({ hold: null, feature: planned })?.reason).toContain("B（未开卡）");
    const ok = feature("A", [node("A", "ready"), node("B", "ready"), node("C", "handed"), node("D", "done", [], "verified")]);
    expect(planScheduler({ ...inMerge(), handoffGate: { hold: null, feature: ok } })).toMatchObject({ kind: "intent", action: "merge" });
  });

  test("#6 dependencies go first: a ready upstream node not yet handed holds its successor; the batch lists card@head in order", () => {
    const f = feature("B", [node("B", "ready", ["A"]), node("A", "ready")]);
    expect(handoffGateWait({ hold: null, feature: f })).toEqual({ code: "feature_handoff_order", reason: "feature f-HDG 按依赖先交被依赖的：A（X-A merge）" });
    expect(handoffGateWait({ hold: null, feature: { ...f, nodes: [node("B", "ready", ["A"]), node("A", "handed")] } })).toBeNull();
    const batch = feature("C", [node("C", "ready", ["B"]), node("D", "ready"), node("B", "handed", ["A"]), node("A", "done", [], "live")]);
    expect(featureBatch(batch)).toEqual([`X-C@${HEAD}`, `X-D@${HEAD}`]);
    expect(featureBatch(feature("D", [node("D", "ready"), node("E", "handed"), node("F", "pending")]))).toEqual([`X-D@${HEAD}`, `X-E@${HEAD}`]);
  });

  test("#5–#7 an upstream node not reviewed (sent back after it went out) holds its successor, whatever its batch", () => {
    for (const stage of ["build", "fix", "review"] as const) {
      const f = feature("B", [node("B", "ready", ["A"]), node("A", "pending", [], stage)]);
      expect(handoffGateWait({ hold: null, feature: f })).toEqual({ code: "feature_siblings_pending",
        reason: `feature f-HDG v2 依赖的节点没审过：A（X-A ${stage}）` });
    }
    const far = feature("C", [node("C", "ready", ["B"]), node("B", "done", ["A"], "live"), node("A", "pending", [], "fix")]);
    expect(handoffGateWait({ hold: null, feature: far })?.reason).toBe("feature f-HDG v2 依赖的节点没审过：A（X-A fix）");
  });

  test("#9 hold and feature together: the stricter (both reasons) wins, the hold's code first", () => {
    const f = feature("A", [node("A", "ready"), node("B", "pending")]);
    expect(planScheduler({ ...inMerge(), handoffGate: { ...HOLD, feature: f } })).toEqual({ kind: "wait", code: "handoff_hold",
      reason: "项目暂停交接（pm）：本地继续做，交接排队；feature f-HDG v2 同批还有节点没审过：B（X-B build）" });
  });

  test("#8 no feature facts: unchanged", () => {
    expect(planScheduler({ ...inMerge(), handoffGate: null })).toMatchObject({ kind: "intent", action: "merge" });
    expect(handoffGateWait({ hold: null, feature: null })).toBeNull();
  });
});

describe("batchWith (spec clarification 1: successors start only once their dependency is live)", () => {
  const nodes = [node("A", "ready"), node("B", "ready", ["A"]), node("C", "ready"), node("D", "ready", ["B"])];
  test("a node something depends on goes alone; the rest go with every node they have no path to", () => {
    expect(batchWith(nodes, "A")).toEqual(["A"]);
    expect(batchWith(nodes, "B")).toEqual(["B"]);
    expect(batchWith(nodes, "D")).toEqual(["C", "D"]);
    expect(batchWith(nodes, "C")).toEqual(["A", "B", "C", "D"]);
  });
  test("so a dependency never waits on its own successor (no deadlock)", () => {
    const f = feature("A", [node("A", "ready"), node("B", "pending", ["A"], "planned")]);
    expect(handoffGateWait({ hold: null, feature: f })).toBeNull();
    expect(handoffGateWait({ hold: null, feature: { ...f, self: "C", nodes: [...f.nodes, node("C", "ready")] } })?.code).toBe("feature_siblings_pending");
  });
});
