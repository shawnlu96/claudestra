/** Pure T68 interpreter: ledger snapshot in, one deterministic decision out, never I/O. */
import type { LedgerEvent, LedgerTask, Stage } from "./ledger-stages.js";
import { resourceKey, resourcesOverlap, type AuthorFamily, type SchedulerIntent, type TaskWorkflow } from "./ledger-scheduler.js";
import { currentReviewFacts, p1FamilyStreak, type ReviewFacts, type ReviewFinding } from "./scheduler-review.js";
import { FLOW_TEMPLATES, nodeAt, type FlowNode } from "./scheduler-template.js";

export interface WorkerRef {
  agent: string;
  sessionId: string;
  taskId: string;
  family: AuthorFamily;
  source: "local" | "peer_claim";
}
interface OwnerGate {
  state: "none" | "open" | "approved" | "rejected";
  head?: string;
  specRev?: number;
  screenshotsDigest?: string;
  ownerVerified?: boolean;
}
interface ReviewDispatchProof {
  intentId: string;
  round: number;
  head: string;
  reviewer: string;
  reviewerSessionId: string;
  ackSeq: number;
}
export interface PlannerSnapshot {
  task: LedgerTask;
  workflow: TaskWorkflow | null;
  events: readonly LedgerEvent[];
  intents: readonly SchedulerIntent[];
  blockedBy: readonly string[];
  queueFrozen: boolean;
  fileGlobs: readonly string[];
  heldResources: readonly { resource: string; taskId: string }[];
  workerCount: number;
  maxWorkers: number;
  freeWorkerSlot: string | null;
  author: WorkerRef | null;
  reviewer: WorkerRef | null;
  reviewDispatches: readonly ReviewDispatchProof[];
  uiGate: OwnerGate;
  screenshotsDigest: string | null;
}

interface WorkOrderFacts { reportPath: string; findings: ReviewFinding[]; fallbackWarning: string | null }
interface PlannedIntent {
  kind: "intent";
  id: string;
  node: string;
  action: "dispatch" | "review" | "stage" | "ask" | "merge" | "verify" | "retire" | "ensure_session";
  recipient: string | null;
  resources: string[];
  reason: string;
  observedOnly: boolean;
  targetStage?: Stage;
  workOrder?: WorkOrderFacts;
  sessionRole?: "author" | "reviewer";
  sessionFamily?: AuthorFamily;
  askBind?: { task: string; specRev: number; head: string; screenshotsDigest: string };
  pmDiffNotice?: boolean;
  reviewMode?: "adversarial";
}
export type PlannerDecision = PlannedIntent | { kind: "wait"; code: string; reason: string } |
  { kind: "escalate"; code: string; reason: string; reviewSeq?: number; history?: ReviewFinding[][] };

const wait = (code: string, reason: string): PlannerDecision => ({ kind: "wait", code, reason });
const escalate = (code: string, reason: string, reviewSeq?: number): PlannerDecision => ({ kind: "escalate", code, reason, ...(reviewSeq ? { reviewSeq } : {}) });
const latestSeq = (events: readonly LedgerEvent[], task: LedgerTask): number =>
  events.findLast((e) => e.kind === "stage" && e.data.to === task.stage)?.seq ?? events.find((e) => e.kind === "task")?.seq ?? 0;
const taskResource = (s: PlannerSnapshot): string => `task:s${s.events.find((e) => e.kind === "task")?.seq ?? 0}`;
const familyOtherThan = (family: AuthorFamily): AuthorFamily => family === "claude" ? "codex" : "claude";

function makeIntent(s: PlannerSnapshot, node: FlowNode, action: PlannedIntent["action"], reason: string, resources: string[],
  extra: Partial<PlannedIntent> = {}): PlannedIntent {
  const since = latestSeq(s.events, s.task);
  const attempt = s.intents.filter((i) => i.node === node.id && i.causalSeq >= since).length;
  const key = `t68:s${since}:r${s.task.round}:${node.id}:a${attempt}`;
  return { kind: "intent", id: key, node: node.id, action, reason, resources, recipient: null,
    observedOnly: s.workflow?.mode === "observe", ...extra };
}

function liveIntent(s: PlannerSnapshot, node: FlowNode, action: PlannedIntent["action"]): PlannerDecision | null {
  const since = latestSeq(s.events, s.task);
  const latest = s.intents.filter((i) => i.node === node.id && i.action === action && i.causalSeq >= since).at(-1);
  if (!latest || latest.status === "cancelled") return null;
  if (latest.status === "unknown") return wait("unknown_effect", `外部结果不明：${latest.reason}`);
  return wait("in_flight", `等待 ${node.id} 的台账结果（${latest.status}）`);
}

function fileResources(s: PlannerSnapshot): string[] | null {
  const keys = s.fileGlobs.map(resourceKey);
  if (!keys.length || keys.includes(null)) return null;
  return [...new Set(keys as string[])].sort();
}

function resourceGate(s: PlannerSnapshot, resources: readonly string[]): PlannerDecision | null {
  for (const resource of resources) {
    const held = s.heldResources.find((h) => h.taskId !== s.task.id && resourcesOverlap(resource, resourceKey(h.resource) ?? h.resource.toLowerCase()));
    if (held) return wait("resource_busy", `资源 ${resource} 与 ${held.resource} 冲突，先等 ${held.taskId}`);
  }
  return null;
}

function sessionGate(s: PlannerSnapshot, node: FlowNode, role: "author" | "reviewer"): PlannerDecision | null {
  const session = role === "author" ? s.author : s.reviewer;
  if (session) {
    if (session.taskId !== s.task.id || !session.agent || !session.sessionId) return escalate("session_mismatch", `${role} session 不属于本卡`);
    if (role === "author" && (session.family !== s.workflow?.authorFamily || (s.task.agent && session.agent !== s.task.agent))) {
      return escalate("author_family", "执行 session 与任务作者或模型家族不一致");
    }
    const priorReviewer = s.events.find((e) => e.kind === "review");
    if (role === "reviewer" && priorReviewer && (priorReviewer.data.reviewerSessionId !== session.sessionId ||
      priorReviewer.data.reviewer !== session.agent)) return escalate("reviewer_replaced", "同卡复验必须沿用原审查 session");
    if (role === "reviewer" && (session.agent === s.author?.agent || session.family === s.workflow?.authorFamily ||
      (s.workflow?.template === "security" && session.source !== "local"))) return escalate("reviewer_independence", "审查者不是独立的跨模型家族 session");
    return null;
  }
  const prior = liveIntent(s, node, "ensure_session");
  if (prior) return prior;
  const family = role === "author" ? s.workflow?.authorFamily : familyOtherThan(s.workflow!.authorFamily);
  return makeIntent(s, node, "ensure_session", `为 ${role} 建本卡独立 session`, [taskResource(s)],
    { sessionRole: role, sessionFamily: family });
}

function dispatchWork(s: PlannerSnapshot, node: FlowNode): PlannerDecision {
  const prior = liveIntent(s, node, "dispatch");
  if (prior) return prior;
  const fix = node.stage === "fix" ? fixPackage(s) : null;
  if (fix && "kind" in fix) return fix;
  const session = sessionGate(s, node, "author");
  if (session) return session;
  if (s.workerCount >= s.maxWorkers || !s.freeWorkerSlot) return wait("capacity", "项目 worker 槽已满");
  const files = fileResources(s);
  if (!files) return escalate("file_scope", "自动卡缺明确的文件范围 glob");
  const resources = [taskResource(s), s.freeWorkerSlot, ...files].map(resourceKey);
  if (resources.includes(null)) return escalate("resource_name", "worker 槽或资源名不合法");
  const busy = resourceGate(s, resources as string[]);
  if (busy) return busy;
  return makeIntent(s, node, "dispatch", `派 ${node.step} 给 ${s.author!.agent}`, resources as string[],
    { recipient: s.author!.agent, ...(fix ? { workOrder: fix } : {}) });
}

function fixPackage(s: PlannerSnapshot): WorkOrderFacts | PlannerDecision {
  const read = currentReviewFacts(s.task, s.events);
  if (read.kind !== "facts") return escalate("fix_report", "修复阶段缺上一轮完整审查报告");
  const families = [...new Set(read.facts.findings.filter((f) => f.severity === "P1").map((f) => f.family))];
  if (!families.length) return escalate("fix_report", "修复阶段没有 P1，需 PM 核对为什么退回");
  const streaks = families.map((f) => p1FamilyStreak(s.events, f, read.facts.round));
  if (streaks.includes(null) || streaks.some((n) => (n as number) >= 3)) return escalate("fix_history", "同类 P1 轮次无法自动续派", read.facts.eventSeq);
  return { reportPath: read.facts.reportPath, findings: read.facts.findings,
    fallbackWarning: streaks.some((n) => n === 2) ? `再不行退到：${s.workflow!.fallback}` : null };
}

function reviewDispatch(s: PlannerSnapshot, node: FlowNode): PlannerDecision {
  const prior = liveIntent(s, node, "review");
  if (prior) return prior;
  const gate = sessionGate(s, node, "reviewer");
  if (gate) return gate;
  const reviewer = s.reviewer as WorkerRef;
  const resources = [taskResource(s), `reviewer:${reviewer.sessionId}`].map(resourceKey);
  if (resources.includes(null)) return escalate("resource_name", "审查 session 的资源名不合法");
  const busy = resourceGate(s, resources as string[]);
  if (busy) return busy;
  return makeIntent(s, node, "review", `派对抗式跨模型审查给 ${reviewer.agent}`, resources as string[],
    { recipient: reviewer.agent, reviewMode: FLOW_TEMPLATES[s.workflow!.template].reviewMode });
}

function reviewHistory(s: PlannerSnapshot, facts: ReviewFacts, families: readonly string[]): ReviewFinding[][] {
  return s.events.filter((e) => e.kind === "review" && typeof e.data.round === "number" && e.data.round <= facts.round)
    .slice(-3).map((e) => (Array.isArray(e.data.findings) ? e.data.findings as ReviewFinding[] : []))
    .map((rows) => rows.filter((f) => families.includes(f.family)));
}

function fixDecision(s: PlannerSnapshot, node: FlowNode, facts: ReviewFacts): PlannerDecision {
  const p1 = facts.findings.filter((f) => f.severity === "P1");
  const families = [...new Set(p1.map((f) => f.family))];
  const streaks = families.map((f) => p1FamilyStreak(s.events, f, facts.round));
  if (streaks.includes(null)) return escalate("review_history", "历轮结构化结论不完整，无法判断同类 P1", facts.eventSeq);
  if (streaks.some((n) => (n as number) >= 3)) return {
    kind: "escalate", code: "three_p1_rounds", reason: `同类 P1 连续三轮；按规格退到：${s.workflow!.fallback}`,
    reviewSeq: facts.eventSeq, history: reviewHistory(s, facts, families),
  };
  const warning = streaks.some((n) => n === 2) ? `再不行退到：${s.workflow!.fallback}` : null;
  return makeIntent(s, node, "stage", `P1 ${p1.length} 项，自动进入 fix`, [taskResource(s)], {
    targetStage: "fix", workOrder: { reportPath: facts.reportPath, findings: facts.findings, fallbackWarning: warning },
  });
}

function reviewPass(s: PlannerSnapshot, node: FlowNode, facts: ReviewFacts): PlannerDecision {
  if (s.workflow?.template === "ui") {
    const gate = s.uiGate;
    if (!s.screenshotsDigest || !/^[a-f0-9]{64}$/i.test(s.screenshotsDigest)) {
      return escalate("ui_missing_screenshots", "前后截图摘要缺失，不能请 owner 看旧图", facts.eventSeq);
    }
    if (gate.state === "rejected") return escalate("ui_rejected", "owner 未批准前后截图", facts.eventSeq);
    if (gate.state !== "none" && (gate.head !== s.task.headSHA || gate.specRev !== s.task.specRev ||
      gate.screenshotsDigest !== s.screenshotsDigest)) {
      return escalate("ui_stale", "截图许可绑定的 head/specRev 已过期", facts.eventSeq);
    }
    if (gate.state === "open") return wait("owner_screenshot", "等待 owner 看前后截图");
    if (gate.state === "approved" && !gate.ownerVerified) return escalate("ui_unverified", "截图许可缺已认证的 owner 答复", facts.eventSeq);
    if (gate.state === "none") return makeIntent(s, node, "ask", "请 owner 看前后截图", [taskResource(s)], {
      askBind: { task: s.task.id, specRev: s.task.specRev, head: s.task.headSHA as string, screenshotsDigest: s.screenshotsDigest },
    });
  }
  return makeIntent(s, node, "stage", "审查通过，进入合并队列", [taskResource(s)], {
    targetStage: "merge", pmDiffNotice: facts.findings.some((f) => f.severity === "P2"),
  });
}

function reviewStep(s: PlannerSnapshot, node: FlowNode): PlannerDecision {
  const found = currentReviewFacts(s.task, s.events);
  if (found.kind === "invalid") return escalate("review_invalid", found.reason);
  if (found.kind === "none") return reviewDispatch(s, node);
  const f = found.facts;
  const dispatched = s.intents.findLast((i) => i.node === node.id && i.action === "review" &&
    i.causalSeq >= latestSeq(s.events, s.task) && i.eventSeq < f.eventSeq &&
    i.head === f.head && i.recipient === f.reviewer && (i.status === "submitted" || i.status === "done"));
  const proof = s.reviewDispatches.find((p) => p.intentId === dispatched?.id && p.round === f.round && p.head === f.head &&
    p.reviewer === f.reviewer && p.reviewerSessionId === f.reviewerSessionId && p.ackSeq > (dispatched?.eventSeq ?? 0) && p.ackSeq < f.eventSeq);
  if (!dispatched || !proof) return escalate("review_unsolicited", "审查结论找不到本轮、同 head 与 session 的派单回执", f.eventSeq);
  const transition = s.intents.filter((i) => i.node === node.id && i.causalSeq >= f.eventSeq &&
    (i.action === "stage" || i.action === "ask")).at(-1);
  if (transition && transition.status !== "cancelled") return wait("review_transition", `审查结论的后续动作仍在 ${transition.status}`);
  if (!s.reviewer || f.reviewer !== s.reviewer.agent || f.reviewerSessionId !== s.reviewer.sessionId ||
    f.reviewerFamily !== s.reviewer.family || f.reviewerFamily === s.workflow?.authorFamily ||
    (s.workflow?.template === "security" && s.reviewer.source !== "local")) {
    return escalate("reviewer_mismatch", "审查结论不是本卡跨模型家族 reviewer session 的产物", f.eventSeq);
  }
  if (f.findings.some((x) => x.severity === "P0") || f.verdict === "block") return escalate("review_block", "P0 或审查阻塞，交 PM", f.eventSeq);
  if (f.verdict === "pass" && f.findings.some((x) => x.severity === "P1")) return escalate("review_inconsistent", "pass 与 P1 逐项结论矛盾", f.eventSeq);
  if (f.findings.some((x) => x.severity === "P1")) return fixDecision(s, node, f);
  if (f.verdict === "changes" && !f.findings.some((x) => x.severity === "P2")) return escalate("review_inconsistent", "changes 却无 P1/P2", f.eventSeq);
  return reviewPass(s, node, f);
}

function stageStep(s: PlannerSnapshot, node: FlowNode): PlannerDecision {
  if (node.gate === "pm_restate") {
    const approved = s.events.findLast((e) => e.kind === "decision" && e.seq > latestSeq(s.events, s.task) &&
      e.data.op === "restate_approved" && e.data.specRev === s.task.specRev);
    if (!approved) return wait("pm_restate", "等待 PM 放行复述");
  }
  if (node.stage === "live" && s.events.some((e) => e.kind === "verify" && e.seq >= latestSeq(s.events, s.task) && e.data.result !== "pass")) {
    return escalate("verify_failed", "完成检查单未通过，不能自动重跑");
  }
  const prior = liveIntent(s, node, node.action);
  if (prior) return prior;
  return makeIntent(s, node, node.action, `${node.id}：${node.next ?? "执行"}`, [taskResource(s)],
    { ...(node.next ? { targetStage: node.next } : {}) });
}

/** A blocked or ambiguous snapshot never emits work; every emitted action has a stable dedup key and explicit cause. */
export function planScheduler(s: PlannerSnapshot): PlannerDecision {
  const { task, workflow } = s;
  if (!workflow || workflow.mode === "manual") return wait("manual", "任务由 PM 人工推进");
  if (task.kind !== "code" || workflow.templateVersion !== 2 || workflow.taskId !== task.id || workflow.specRev !== task.specRev) {
    return escalate("workflow_drift", "流程模板、任务类型或规格版本已变，自动推进暂停");
  }
  if (!["claude", "codex"].includes(workflow.authorFamily) || !workflow.fallback.trim()) return escalate("spec_missing", "作者模型家族或退路方案缺失");
  if (!s.events.some((e) => e.kind === "task" && e.data.op === "new")) return escalate("task_origin", "任务缺建卡事件，无法给资源生成稳定标识");
  if (task.stage === "done" || task.stage === "cancelled") return wait("terminal", "任务已结束");
  if (task.stage === "blocked") return wait("blocked", "任务已阻塞，等 PM 解除");
  if (s.queueFrozen && ["spec", "build", "fix", "merge"].includes(task.stage)) return wait("queue_frozen", "项目队列已冻结，不派新活");
  if (s.blockedBy.length) return wait("dependency", `等待前置任务：${s.blockedBy.join("、")}`);
  const template = FLOW_TEMPLATES[workflow.template];
  const node = template && nodeAt(template, task.stage);
  if (!node) return escalate("stage_unknown", `模板 ${workflow.template} 不认识阶段 ${task.stage}`);
  const decision = task.stage === "spec" || task.stage === "build" || task.stage === "fix" ? dispatchWork(s, node)
    : task.stage === "review" ? reviewStep(s, node) : stageStep(s, node);
  const active = s.intents.find((i) => i.status === "pending" || i.status === "submitted" || i.status === "unknown");
  return decision.kind === "intent" && active ? wait("intent_in_flight", `先结清调度意图 ${active.id}（${active.status}）`) : decision;
}
