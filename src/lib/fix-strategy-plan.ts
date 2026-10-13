/** Convergence intercepts only validated review exits and repair dispatches; all other gates remain the base planner's. */
import type { PlannerDecision, PlannerSnapshot } from "./scheduler-plan.js";
import { fixStartReviewFacts } from "./lend-fix-start-review.js";
import { convergeReview, MAX_REVIEW_ROUND } from "./review-converge.js";
import { fixStrategy, FIX_STRATEGY_RULE } from "./fix-strategy.js";
import { specReviewStart, strategyPerformed } from "./fix-strategy-review-range.js";
import { arbitrationResults } from "./review-arbiter.js";
import { attemptKey } from "./intent-attempt.js";
import { gateBlock } from "./scheduler-dispatch-block.js";

export const strategyWarning = (streak: number, round: number): string | null => streak >= 2 || round >= MAX_REVIEW_ROUND - 1 ? FIX_STRATEGY_RULE : null;

export function pendingDispute(s: Pick<PlannerSnapshot, "events" | "task">) {
  const resolved = new Set(arbitrationResults(s.events, s.task.specRev).map((r) => r.disputeSeq));
  return s.events.find((e) => e.kind === "scheduler" && e.data.op === "finding_dispute" &&
    e.data.specRev === s.task.specRev && !resolved.has(e.seq));
}

export function convergenceSnapshot(s: PlannerSnapshot): PlannerSnapshot {
  const switched = s.events.findLast((e) => e.kind === "scheduler" && e.data.op === "fix_strategy" &&
    e.data.specRev === s.task.specRev && e.data.round === s.task.round);
  const family = switched?.data.family;
  if (s.task.stage === "fix" && s.workflow && (family === "claude" || family === "codex")) {
    s = { ...s, workflow: { ...s.workflow, authorFamily: family },
      ...(s.pool ? { pool: { ...s.pool, remote: { ...s.pool.remote, writeFamilies: [family], localAuthorRuntime: family } } } : {}) };
  }
  return s;
}

export function planConvergence(s: PlannerSnapshot, base: (s: PlannerSnapshot) => PlannerDecision): PlannerDecision {
  s = convergenceSnapshot(s);
  const switched = s.events.findLast((e) => e.kind === "scheduler" && e.data.op === "fix_strategy" &&
    e.data.specRev === s.task.specRev && e.data.round === s.task.round);
  const decision = base(s);
  if (s.workflow?.mode === "manual" || !s.workflow || s.intents.some((i) => ["pending", "submitted", "unknown"].includes(i.status))) return decision;
  const born = s.events.find((e) => e.kind === "task")?.seq ?? 0;
  const common = { kind: "intent" as const, recipient: null, resources: [`task:s${born}`], observedOnly: s.workflow.mode === "observe" };
  if (s.task.stage === "review" && decision.kind === "intent" && decision.action === "stage") {
    const dispute = pendingDispute(s);
    if (dispute) return { ...common, id: attemptKey(`arbiter:s${born}:d${dispute.seq}`, s.task.id, s.intents), node: "arbitration", action: "arbitrate",
      reason: `独立新会话仲裁 finding ${dispute.data.findingId}（争议事件 ${dispute.seq}）` };
  }
  if (s.task.stage !== "fix" || switched || decision.kind !== "intent" || !["dispatch", "ensure_session"].includes(decision.action)) return decision;
  const read = fixStartReviewFacts(s.task, s.events);
  if (read.kind !== "facts") return decision;
  const facts = convergeReview(s.events, read.facts, s.fixDiff).facts, min = specReviewStart(s.events, s.task.specRev).round;
  const strategy = fixStrategy(s.events, facts, s.workflow.authorFamily, min);
  if (!strategy || strategy.mode === "continue") return decision;
  const performed = strategyPerformed(s.events, s.task.specRev, strategy.mode, strategy.findings.map((f) => f.finding), read.facts.round, min);
  if (performed) return decision;
  // A fix_swap can go out through remoteFixFallback even when the base decision is a local dispatch, so the same refused
  // material waits here too: a new attempt key is no new material. Only a changed material or gate handler re-arms it.
  if (gateBlock(s.task, s.events, s.gate)?.state === "blocked") return { kind: "wait", code: "dispatch_blocked_gate",
    reason: "安全材料阻塞：外发闸拒收过同一份材料，换修复会话不再外发；材料或外发闸处理器版本变了才换新尝试号" };
  return { ...common, id: attemptKey(`fix-swap:s${born}:r${s.task.round}`, s.task.id, s.intents), node: "fix", action: "fix_swap",
    reason: `${strategy.mode === "other_family" ? "换作者模型家族" : "换修复会话"}；先复现测试失败再修到通过，交付说明写测试名` };
}
