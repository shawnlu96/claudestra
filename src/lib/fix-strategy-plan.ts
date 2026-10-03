/** Convergence intercepts only validated review exits and repair dispatches; all other gates remain the base planner's. */
import type { PlannerDecision, PlannerSnapshot } from "./scheduler-plan.js";
import { currentReviewFacts, normalizedFamily } from "./scheduler-review.js";
import { convergeReview, MAX_REVIEW_ROUND } from "./review-converge.js";
import { fixStrategy, FIX_STRATEGY_RULE } from "./fix-strategy.js";
import { arbitrationResults } from "./review-arbiter.js";

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
    if (dispute) return { ...common, id: `arbiter:s${born}:d${dispute.seq}`, node: "arbitration", action: "arbitrate",
      reason: `独立新会话仲裁 finding ${dispute.data.findingId}（争议事件 ${dispute.seq}）` };
  }
  if (s.task.stage !== "fix" || switched || decision.kind !== "intent" || !["dispatch", "ensure_session"].includes(decision.action)) return decision;
  const read = currentReviewFacts(s.task, s.events);
  if (read.kind !== "facts") return decision;
  const configured = s.events.findLast((e) => e.data.op === "workflow" && e.data.specRev === s.task.specRev)?.seq ?? 0;
  const min = s.events.find((e) => e.kind === "review" && e.seq > configured)?.data.round;
  const strategy = fixStrategy(s.events, convergeReview(s.events, read.facts, s.fixDiff).facts, s.workflow.authorFamily,
    typeof min === "number" ? min : 1);
  if (!strategy || strategy.mode === "continue") return decision;
  const mode = strategy.mode;
  const performed = s.events.some((e) => e.kind === "scheduler" && e.data.op === "fix_strategy" && e.data.specRev === s.task.specRev &&
    e.data.mode === mode && typeof e.data.round === "number" && strategy.findings.some(({ finding, streak }) =>
      (e.data.round as number) >= read.facts.round - streak + 1 && Array.isArray(e.data.findings) &&
      e.data.findings.some((f: { findingId?: string; family?: string }) => f.findingId === finding.findingId ||
        typeof f.family === "string" && normalizedFamily(f.family) === normalizedFamily(finding.family))));
  if (performed) return decision;
  return { ...common, id: `fix-swap:s${born}:r${s.task.round}`, node: "fix", action: "fix_swap",
    reason: `${strategy.mode === "other_family" ? "换作者模型家族" : "换修复会话"}；先复现测试失败再修到通过，交付说明写测试名` };
}
