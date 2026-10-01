/**
 * What an auto card's worker is told, and how the ledger proves it answered. The order names the exact write-back
 * command (the reviewer's includes its own session and family, which the ledger checks), and a result counts only when
 * it is a ledger event written after this intent was planned — a chat reply never finishes a step.
 */
import type { Database } from "bun:sqlite";
import { getIntent, type SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { listEvents } from "./ledger-store.js";
import { statePath } from "./paths.js";
import { SRC_DIR } from "./repo-root.js";
import type { PlannerDecision } from "./scheduler-plan.js";
import { bounceReviewLine, bounceWork } from "./scheduler-merge-conflict.js";
import type { OrderProbe, SessionRef, WorkOrder } from "./worker-session.js";

type Planned = Extract<PlannerDecision, { kind: "intent" }>;
const STEP_OF: Record<string, WorkOrder["step"]> = { restate: "restate", write: "write", fix: "fix", adversarial_review: "review" };
/** Absolute: a worker's cwd is its own worktree or project, not necessarily this repository. */
const CLI = `bun ${SRC_DIR}/manager.ts ledger`;
/** The merge gate already waits on the PR's required CI checks; a loaded host's wait-type timeouts must not park a card in fix. */
const AUTHOR_ACCEPTANCE = ["交付前跑 GUARD_STRICT=1 bun run check：tsc、guard 必须绿，所有入口 build",
  "bun test 里本机负载造成的等待型超时、且在 base 上同样复现的，不算不过；在证据报告里列出文件名", "全量测试以 PR head 上 CI 必过项全绿为准"];
const REVIEW_CI_RULE = "全量测试只看 PR head 的 CI；不跑全量，本机超时不判 P1";

export const stepOfNode = (node: string): WorkOrder["step"] | null => STEP_OF[node] ?? null;

export function workOrderFor(task: LedgerTask, intent: SchedulerIntent, plan: Planned | null, ref: SessionRef, checkout?: string): WorkOrder | null {
  const step = stepOfNode(intent.node);
  if (!step) return null;
  const w = plan?.workOrder;
  const spec = `规格与验收：${CLI} show ${task.id}`;
  const base = { taskId: task.id, specRev: intent.specRev, head: intent.head, round: task.round, node: intent.node, step, dedupKey: intent.id,
    ...(w ? { findings: w.findings, fallbackWarning: w.fallbackWarning } : {}) };
  if (step === "restate") {
    return { ...base, inputs: [spec], outputs: ["≤20 行复述：范围、不做、验收"], acceptance: ["复述与规格一致，PM 放行后才开写"],
      writeBack: `${CLI} stage ${task.id} --from spec --to restate --text <复述>` };
  }
  if (step === "review") {
    const report = `${statePath("ledger", "reviews", `${task.id}-r${task.round}`)}/report.md`;
    const where = checkout ? [`审查目录：${checkout}（已固定在这个 head；只读，不改、不提交、不推送）`] : [];
    const targeted = w?.bounce ? [bounceReviewLine(w.bounce)] : [];
    return { ...base, inputs: [spec, `只审 head ${intent.head ?? "（无）"}`, ...targeted, ...where], outputs: ["逐项结论 JSON（findingId / family / severity / probe）", `报告：${report}`],
      acceptance: ["对抗式：专找能打穿规格保证的路径", "同类问题沿用上一轮的 findingId", REVIEW_CI_RULE],
      writeBack: `${CLI} review ${task.id} --reviewer ${ref.agent} --verdict pass|changes|block --p0 N --p1 N --p2 N --head ${intent.head ?? "<head>"}` +
        ` --session ${ref.sessionId} --family ${ref.family} --findings <逐项结论.json> --path ${report}（不要带 --to，阶段由调度器推）` };
  }
  const bounce = w?.bounce ? bounceWork(w.bounce) : null;
  return { ...base, inputs: [spec, ...(bounce ? bounce.inputs : w?.reportPath ? [`上一轮审查报告：${w.reportPath}`] : [])],
    outputs: ["分支上的提交（完整 head SHA）", "证据报告路径"], acceptance: [...(bounce?.acceptance ?? []), ...AUTHOR_ACCEPTANCE],
    writeBack: `${CLI} deliver ${task.id} --from ${step === "fix" ? "fix" : "build"} --head <完整 SHA> --evidence <报告路径>` };
}

/** The first ledger answer to this intent: a deliver / restate move from the author, or a same-head verdict from the reviewer. */
export function ledgerResult(db: Database, ref: SessionRef, probe: OrderProbe): { outcome: "delivered" | "reviewed"; eventSeq: number } | null {
  const intent = getIntent(db, probe.dedupKey);
  if (!intent || intent.taskId !== ref.taskId) return null;
  const events = listEvents(db, { project: intent.project, target: intent.taskId }).filter((e) => e.seq > intent.eventSeq);
  if (probe.step === "review") {
    const hit = events.find((e) => e.kind === "review" && e.data.head === probe.head && e.data.reviewerSessionId === ref.sessionId);
    return hit ? { outcome: "reviewed", eventSeq: hit.seq } : null;
  }
  const hit = probe.step === "restate" ? events.find((e) => e.kind === "stage" && e.data.from === "spec" && e.data.to === "restate")
    : events.find((e) => e.kind === "deliver");
  return hit ? { outcome: "delivered", eventSeq: hit.seq } : null;
}
