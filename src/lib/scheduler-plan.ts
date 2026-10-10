/** Pure T68 interpreter: ledger snapshot in, one deterministic decision out, never I/O. */
import type { LedgerEvent, LedgerTask, Stage } from "./ledger-stages.js";
import { resourceKey, resourcesOverlap, type AuthorFamily, type SchedulerIntent, type TaskWorkflow } from "./ledger-scheduler.js";
import { currentReviewFacts, p1AnyStreak, p1FindingStreak, type ReviewFacts, type ReviewFinding } from "./scheduler-review.js";
import { FLOW_TEMPLATES, nodeAt, restateGate, templateFor, type FlowNode } from "./scheduler-template.js";
import { cardWorkerSlots } from "./scheduler-worker-slot.js";
import { POOL_RECIPIENT, poolRefusalEpoch, type PoolFacts } from "./scheduler-pool-plan.js";
import { poolEpochTag, poolExemptFacts } from "./ledger-pool-refusal-gate.js";
import { epochPeerRefusal, reviewPlacement } from "./scheduler-placement-plan.js";
import { blockedRemoteWork } from "./scheduler-dispatch-block.js";
import { BOUNCE_LIMIT_REASON, bounceLimitHit, fixBounce, reviewAfterBounce, type MergeBounce } from "./scheduler-merge-conflict.js";
import { exemptFacts, exemptSession, refusalEpoch, reviewSwapPlan, reviewerHistory, latestReviewerSwap } from "./scheduler-review-swap.js";
import type { PmUiGate } from "./ledger-ui-approve-verdict.js";
import { uiFixPackage, uiMergeBlock, uiPassStep } from "./scheduler-ui-gate.js";
import { escalationDowngrade, convergeReview, roundCap, type Downgrade, type FixDiff } from "./review-converge.js";
import { planConvergence, strategyWarning } from "./fix-strategy-plan.js";
import { downgradeBrief } from "./review-converge-followup-text.js";
import { availableWriteSlot } from "./scheduler-slot-hold.js";
import { mergeRetryReleased } from "./scheduler-merge-retry.js";
import { fixStartReviewFacts } from "./lend-fix-start-review.js";
import { securityReviewLocalOnly, type SecurityPoolMode } from "./security-pool.js";
import { foreignRepoEscalation } from "./scheduler-foreign-repo.js";

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
  /** Latest delivered head's done remote write/fix evidence; absent/null is unknown, never a workflow default. */
  remoteAuthorFamily?: AuthorFamily | null;
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
  /** PM's ui-approve / ui-reject (scheduler-ui-gate.ts); absent = none. */
  pmUiGate?: PmUiGate;
  /** The card's screenshots go to the owner, not PM; absent = PM accepts. */
  ownerVisual?: boolean;
  /** Shared-pool facts (i28-R9); absent = never pool (observe cards, CLI replans of later nodes). */
  pool?: PoolFacts | null;
  /** Live pool orders of this card no live intent accounts for (scheduler-pool-facts strayPoolOrders); absent = none. */
  strayPoolOrders?: readonly string[];
  /** Last reviewed head → this round's head, from SCOPE_ROUND on (review-converge-scope.ts); absent = no scope demotion. */
  fixDiff?: FixDiff | null;
  /** security 卡审查进池开关（security-pool.ts，autoSnapshot 填）；absent = off，安全卡只在本机审。 */
  securityPool?: SecurityPoolMode;
}

interface WorkOrderFacts { reportPath: string; findings: ReviewFinding[]; fallbackWarning: string | null; bounce?: MergeBounce }
interface PlannedIntent {
  kind: "intent";
  id: string;
  node: string;
  action: "dispatch" | "review" | "stage" | "ask" | "merge" | "verify" | "retire" | "ensure_session" | "review_swap" | "fix_swap" | "arbitrate";
  recipient: string | null;
  resources: string[];
  reason: string;
  observedOnly: boolean;
  targetStage?: Stage;
  workOrder?: WorkOrderFacts;
  sessionRole?: "author" | "reviewer";
  sessionFamily?: AuthorFamily;
  askBind?: { task: string; specRev: number; head: string; screenshotsDigest: string };
  pmNotice?: { task: string; specRev: number; head: string; screenshotsDigest: string; round: number };
  pmDiffNotice?: boolean;
  reviewMode?: "adversarial";
  downgrade?: Downgrade;
}
export type PlannerDecision = PlannedIntent | { kind: "wait"; code: string; reason: string } |
  { kind: "escalate"; code: string; reason: string; reviewSeq?: number; history?: ReviewFinding[][]; downgrade?: Downgrade };

const wait = (code: string, reason: string): PlannerDecision => ({ kind: "wait", code, reason });
const escalate = (code: string, reason: string, reviewSeq?: number): PlannerDecision => ({ kind: "escalate", code, reason, ...(reviewSeq ? { reviewSeq } : {}) });
const latestSeq = (events: readonly LedgerEvent[], task: LedgerTask): number =>
  events.findLast((e) => e.kind === "stage" && e.data.to === task.stage)?.seq ?? events.find((e) => e.kind === "task")?.seq ?? 0;
const taskResource = (s: PlannerSnapshot): string => `task:s${s.events.find((e) => e.kind === "task")?.seq ?? 0}`;
const familyOtherThan = (family: AuthorFamily): AuthorFamily => family === "claude" ? "codex" : "claude";
const reviewStartRound = (s: PlannerSnapshot): number => {
  const configured = s.events.findLast((e) => e.kind === "scheduler" && e.data.op === "workflow" &&
    e.data.specRev === s.task.specRev)?.seq ?? 0;
  return (s.events.find((e) => e.kind === "review" && e.seq > configured && typeof e.data.round === "number")?.data.round as number | undefined) ?? 1;
};

function makeIntent(s: PlannerSnapshot, node: FlowNode, action: PlannedIntent["action"], reason: string, resources: string[],
  extra: Partial<PlannedIntent> = {}): PlannedIntent {
  const since = latestSeq(s.events, s.task);
  const attempt = s.intents.filter((i) => i.node === node.id && i.causalSeq >= since).length;
  const key = `t68:s${since}:r${s.task.round}:${node.id}:a${attempt}`;
  return { kind: "intent", id: key, node: node.id, action, reason, resources, recipient: null,
    observedOnly: s.workflow?.mode === "observe", ...extra };
}

/** MODELXW: the latest reviewer swap when it retired a legacy refused ticket — that ticket and its ensure belong to the old reviewer. */
const legacyRetire = (events: readonly LedgerEvent[]) => { const swap = latestReviewerSwap(events); return swap?.data.legacy === true ? swap : null; };
/** floor: a refusal epoch's seq — the refused ticket and its ensure belong to the old epoch, not to this one (MODELX). */
function liveIntent(s: PlannerSnapshot, node: FlowNode, action: PlannedIntent["action"], floor = 0): PlannerDecision | null {
  const since = Math.max(latestSeq(s.events, s.task), floor);
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
    if (role === "reviewer") { const swap = reviewSwapPlan(s, node.id, reviewPlacement); if (swap) return swap; }
    // A pooled round's reviewer is a one-shot peer worker, not a session this card could keep: a local session may follow it.
    const priorReviewer = reviewerHistory(s)[0];
    if (role === "reviewer" && priorReviewer && (priorReviewer.data.reviewerSessionId !== session.sessionId ||
      priorReviewer.data.reviewer !== session.agent)) return escalate("reviewer_replaced", "同卡复验必须沿用原审查 session");
    const exempt = role === "reviewer" && exemptSession(s.events, s.task, session.sessionId, session.family); // MODELX exemption, this round only
    if (role === "reviewer" && (session.agent === s.author?.agent || (session.family === s.workflow?.authorFamily && !exempt) ||
      (securityReviewLocalOnly(s.workflow, s.securityPool) && session.source !== "local"))) return escalate("reviewer_independence", "审查者不是独立的跨模型家族 session");
    return null;
  }
  const epoch = role === "reviewer" ? refusalEpoch(s.events, s.task) : null;
  const prior = liveIntent(s, node, "ensure_session", Math.max(epoch?.seq ?? 0, role === "reviewer" ? legacyRetire(s.events)?.seq ?? 0 : 0));
  if (prior) return prior;
  const family = role === "author" ? s.workflow?.authorFamily : epoch ? epoch.data.toFamily as AuthorFamily : familyOtherThan(s.workflow!.authorFamily);
  return makeIntent(s, node, "ensure_session", `为 ${role} 建本卡独立 session`, [taskResource(s)],
    { sessionRole: role, sessionFamily: family });
}

function dispatchWork(s: PlannerSnapshot, node: FlowNode): PlannerDecision {
  const prior = liveIntent(s, node, "dispatch");
  if (prior) return prior;
  const away = blockedRemoteWork(s, latestSeq(s.events, s.task), node.stage === "fix" ? "fix" : "write"); // a gate-refused material waits (dispatch-recovery-R1)
  if (away && "wait" in away) return wait(away.code ?? "placement", away.wait);
  if (away && "escalate" in away) return escalate("placement_lease", away.escalate);
  const fix = node.stage === "fix" ? bouncePackage(fixBounce(s.events, s.task.stage)) ?? uiFixPackage(s, () => fixPackage(s)) : null;
  if (fix && "kind" in fix) return fix;
  const scope = fileResources(s); // no scope: the local path below escalates it, a peer never writes unlocked
  if (away && scope) return makeIntent(s, node, "dispatch", away.reason, [taskResource(s), ...scope],
    { recipient: `${POOL_RECIPIENT}${away.peer}`, ...(fix ? { workOrder: fix } : {}) });
  const session = sessionGate(s, node, "author");
  if (session) return session;
  const ownedSlots = cardWorkerSlots(s.heldResources, s.task.id);
  if (ownedSlots.length > 1 || (ownedSlots[0] && !ownedSlots[0].startsWith(`slot:${s.task.project}:`))) {
    return escalate("worker_slot_invalid", "本卡 worker 槽不唯一或项目不符，交 PM 核对");
  }
  const slot = ownedSlots[0] ?? availableWriteSlot(s);
  if (!slot) return wait("capacity", "项目 worker 槽已满");
  const files = fileResources(s);
  if (!files) return escalate("file_scope", "自动卡缺明确的文件范围 glob");
  const resources = [taskResource(s), slot as string, ...files].map(resourceKey);
  if (resources.includes(null)) return escalate("resource_name", "worker 槽或资源名不合法");
  const busy = resourceGate(s, resources as string[]);
  if (busy) return busy;
  return makeIntent(s, node, "dispatch", `派 ${node.step} 给 ${s.author!.agent}`, resources as string[],
    { recipient: s.author!.agent, ...(fix ? { workOrder: fix } : {}) });
}

/** A merge bounce (conflict / red CI) is not a P1 fix: no review report, no P1 streak (scheduler-merge-conflict.ts). */
const bouncePackage = (bounce: MergeBounce | null): WorkOrderFacts | null => bounce && { reportPath: "", findings: [], fallbackWarning: null, bounce };

function fixPackage(s: PlannerSnapshot): WorkOrderFacts | PlannerDecision {
  const read = fixStartReviewFacts(s.task, s.events);
  if (read.kind !== "facts") return escalate("fix_report", "修复阶段缺上一轮完整审查报告");
  const facts = convergeReview(s.events, read.facts, s.fixDiff).facts;
  const p1 = facts.findings.filter((f) => f.severity === "P1");
  if (!p1.length) return escalate("fix_report", "修复阶段没有 P1，需 PM 核对为什么退回");
  const minRound = reviewStartRound(s);
  const streaks = p1.map((f) => p1FindingStreak(s.events, f, facts.round, minRound));
  const total = p1AnyStreak(s.events, facts.round, minRound);
  if (total === null || streaks.includes(null)) {
    return escalate("fix_history", "P1 轮次无法自动续派", facts.eventSeq);
  }
  return { reportPath: facts.reportPath, findings: facts.findings,
    fallbackWarning: strategyWarning(Math.max(...(streaks as number[])), facts.round) };
}

function reviewDispatch(s: PlannerSnapshot, node: FlowNode): PlannerDecision {
  const epoch = refusalEpoch(s.events, s.task), legacy = legacyRetire(s.events);
  const prior = liveIntent(s, node, "review", Math.max(epoch?.seq ?? 0, legacy?.seq ?? 0));
  if (prior) return prior;
  // A peer may still hold this review through such an order: a local reviewer now would be a second dispatch of the node.
  if (s.strayPoolOrders?.length) return escalate("pool_order_open", `池单 ${s.strayPoolOrders.join("，")} 仍在对方手里或待领，先对账`);
  const swap = reviewSwapPlan(s, node.id, reviewPlacement); if (swap) return swap;
  const pe = epoch || legacy ? null : poolRefusalEpoch(s); // MODELXP2：池单审查被拒 → 按 epoch 的去处换家族重挂一次，带豁免
  const hold = pe && (pe.redo ? "换家族重挂已用过" : !pe.to ? "另一家族暂无池位" : pe.to.machine === "local" ? "去处是本机（不改本机绑定）"
    : epochPeerRefusal(s, latestSeq(s.events, s.task), pe.to.machine, pe.to.family)); // 去处按现行放置约束重核，不绕过 remote / 安全卡
  if (pe && hold) return escalate("model_safety_hold", `model_safety_hold：池单 ${String(pe.epoch.data.orderId)} 审查遭策略拒审（#${pe.epoch.seq}），${hold}，交 PM / owner`);
  if (pe) return makeIntent(s, node, "review", `${String(pe.epoch.data.exemption)}：${poolEpochTag(pe.epoch.seq)}，换 ${pe.to!.machine} 的 ${pe.to!.family} 独立审一次`,
    [taskResource(s)], { recipient: `${POOL_RECIPIENT}${pe.to!.machine}`, reviewMode: FLOW_TEMPLATES[s.workflow!.template].reviewMode });
  const pool = epoch || legacy ? null : reviewPlacement(s, latestSeq(s.events, s.task));
  if (pool && "wait" in pool) return wait("placement", pool.wait);
  if (pool) return makeIntent(s, node, "review", pool.reason,
    [taskResource(s)], { recipient: `${POOL_RECIPIENT}${pool.peer}`, reviewMode: FLOW_TEMPLATES[s.workflow!.template].reviewMode });
  const gate = sessionGate(s, node, "reviewer");
  if (gate) return gate;
  const reviewer = s.reviewer as WorkerRef;
  const resources = [taskResource(s), `reviewer:${reviewer.sessionId}`].map(resourceKey);
  if (resources.includes(null)) return escalate("resource_name", "审查 session 的资源名不合法");
  const busy = resourceGate(s, resources as string[]);
  if (busy) return busy;
  const bounce = bouncePackage(reviewAfterBounce(s.events));
  return makeIntent(s, node, "review", `派对抗式跨模型审查给 ${reviewer.agent}`, resources as string[],
    { recipient: reviewer.agent, reviewMode: FLOW_TEMPLATES[s.workflow!.template].reviewMode, ...(bounce ? { workOrder: bounce } : {}) });
}

function fixDecision(s: PlannerSnapshot, node: FlowNode, facts: ReviewFacts, downgrade: Downgrade | null): PlannerDecision {
  const cap = roundCap(s.events, facts);
  if (cap) return wait(cap.code, cap.reason);
  const p1 = facts.findings.filter((f) => f.severity === "P1");
  const minRound = reviewStartRound(s);
  const streaks = p1.map((f) => p1FindingStreak(s.events, f, facts.round, minRound));
  const total = p1AnyStreak(s.events, facts.round, minRound);
  if (total === null || streaks.includes(null)) return escalate("review_history", "历轮结构化结论不完整，无法判断 P1 连续轮次", facts.eventSeq);
  const warning = strategyWarning(Math.max(...(streaks as number[])), facts.round);
  return makeIntent(s, node, "stage", `P1 ${p1.length} 项，自动进入 fix`, [taskResource(s)], {
    targetStage: "fix", workOrder: { reportPath: facts.reportPath, findings: facts.findings, fallbackWarning: warning }, ...(downgrade ? { downgrade } : {}),
  });
}

function reviewPass(s: PlannerSnapshot, node: FlowNode, facts: ReviewFacts, downgrade: Downgrade | null): PlannerDecision {
  if (s.workflow?.template === "ui") {
    const ui = uiPassStep(s, node.id, facts.eventSeq);
    const bind = { task: s.task.id, specRev: s.task.specRev, head: s.task.headSHA as string, screenshotsDigest: s.screenshotsDigest as string };
    if (ui.kind === "wait") return wait(ui.code, ui.reason);
    if (ui.kind === "escalate") return escalate(ui.code, ui.reason, facts.eventSeq);
    if (ui.kind === "ask_owner") return makeIntent(s, node, "ask", "请 owner 看前后截图", [taskResource(s)], { askBind: bind });
    if (ui.kind === "notify_pm") return makeIntent(s, node, "ask", "请 PM 看前后截图", [taskResource(s)], { pmNotice: { ...bind, round: s.task.round } });
    if (ui.kind === "fix") {
      return makeIntent(s, node, "stage", "PM 未通过前后截图，进入 fix", [taskResource(s)], { targetStage: "fix", ...(downgrade ? { downgrade } : {}) });
    }
  }
  return makeIntent(s, node, "stage", downgrade ? `审查通过（${downgrade.items.length} 项 P1 降为 P2：${downgradeBrief(downgrade)}），进入合并队列` : "审查通过，进入合并队列", [taskResource(s)], {
    targetStage: "merge", pmDiffNotice: facts.findings.some((f) => f.severity === "P2"), ...(downgrade ? { downgrade } : {}),
  });
}

function hasReviewDispatchProof(s: PlannerSnapshot, facts: ReviewFacts): boolean {
  const swap = latestReviewerSwap(s.events);
  const entered = s.events.findLast((e) => e.kind === "stage" && e.data.to === "review" && e.data.round === facts.round)?.seq ?? 0;
  const dispatched = s.intents.findLast((i) => i.node === "adversarial_review" && i.action === "review" &&
    i.eventSeq > entered && i.eventSeq < facts.eventSeq &&
    i.eventSeq > (swap?.seq ?? 0) && (!swap || i.specRev === s.task.specRev) &&
    i.head === facts.head && i.recipient === facts.reviewer && (i.status === "submitted" || i.status === "done"));
  return !!dispatched && s.reviewDispatches.some((p) => p.intentId === dispatched.id && p.round === facts.round &&
    p.head === facts.head && p.reviewer === facts.reviewer && p.reviewerSessionId === facts.reviewerSessionId &&
    p.ackSeq > dispatched.eventSeq && p.ackSeq < facts.eventSeq);
}

function reviewerMatches(s: PlannerSnapshot, facts: ReviewFacts): boolean {
  return !!s.reviewer && facts.reviewer === s.reviewer.agent && facts.reviewerSessionId === s.reviewer.sessionId &&
    facts.reviewerFamily === s.reviewer.family && (facts.reviewerFamily !== s.workflow?.authorFamily || exemptFacts(s.events, s.task, facts) || poolExemptFacts(s.events, s.task, facts)) &&
    !(securityReviewLocalOnly(s.workflow, s.securityPool) && s.reviewer.source !== "local");
}

function epochReviewFacts(s: PlannerSnapshot) {
  const after = latestReviewerSwap(s.events)?.seq ?? 0;
  return currentReviewFacts(s.task, s.events.filter((e) => e.kind !== "review" || e.seq > after));
}

function mergeReviewGate(s: PlannerSnapshot): PlannerDecision | null {
  const found = epochReviewFacts(s);
  if (found.kind !== "facts") return escalate("merge_review_missing", "合并前缺本轮同 head 的结构化审查结论");
  const facts = convergeReview(s.events, found.facts, s.fixDiff).facts;
  if (!hasReviewDispatchProof(s, facts) || !reviewerMatches(s, facts)) {
    return escalate("merge_review_unproven", "合并前缺本轮跨模型审查 session 与派单回执", facts.eventSeq);
  }
  if (facts.verdict === "block" || facts.findings.some((f) => f.severity === "P0" || f.severity === "P1") ||
    (facts.verdict === "changes" && !facts.findings.some((f) => f.severity === "P2"))) {
    return escalate("merge_review_changes", "审查结论尚未通过合并闸", facts.eventSeq);
  }
  const ui = s.workflow?.template === "ui" ? uiMergeBlock(s) : null;
  if (ui) return escalate("merge_ui_unapproved", ui, facts.eventSeq);
  return null;
}

function reviewStep(s: PlannerSnapshot, node: FlowNode): PlannerDecision {
  const found = epochReviewFacts(s);
  if (found.kind === "invalid") return escalate("review_invalid", found.reason);
  if (found.kind === "none") return reviewDispatch(s, node);
  const { facts: f, downgrade } = convergeReview(s.events, found.facts, s.fixDiff);
  if (!hasReviewDispatchProof(s, f)) return escalate("review_unsolicited", "审查结论找不到本轮、同 head 与 session 的派单回执", f.eventSeq);
  const transition = s.intents.filter((i) => i.node === node.id && i.causalSeq >= f.eventSeq &&
    i.action === "stage").at(-1);
  if (transition && transition.status !== "cancelled") return wait("review_transition", `审查结论的后续动作仍在 ${transition.status}`);
  if (!reviewerMatches(s, f)) {
    return escalate("reviewer_mismatch", "审查结论不是本卡跨模型家族 reviewer session 的产物", f.eventSeq);
  }
  if (f.findings.some((x) => x.severity === "P0") || f.verdict === "block") return escalate("review_block", "P0 或审查阻塞，交 PM", f.eventSeq);
  if (f.verdict === "pass" && f.findings.some((x) => x.severity === "P1")) return escalate("review_inconsistent", "pass 与 P1 逐项结论矛盾", f.eventSeq);
  if (f.findings.some((x) => x.severity === "P1")) return fixDecision(s, node, f, downgrade);
  if (f.verdict === "changes" && !f.findings.some((x) => x.severity === "P2")) return escalate("review_inconsistent", "changes 却无 P1/P2", f.eventSeq);
  return reviewPass(s, node, f, downgrade);
}

function stageStep(s: PlannerSnapshot, node: FlowNode): PlannerDecision {
  if (node.gate === "ci_and_review") {
    const inFlight = liveIntent(s, node, "merge");
    if (inFlight) return inFlight;
    const foreign = foreignRepoEscalation(s); if (foreign) return foreign; // i28-SECPOOL4: another repository's card goes to PM (scheduler-foreign-repo.ts)
    const since = latestSeq(s.events, s.task);
    const cancelled = s.intents.findLast((i) => i.node === node.id && i.action === "merge" &&
      i.causalSeq >= since && i.status === "cancelled");
    if (cancelled && bounceLimitHit(s.events, cancelled.id)) return escalate("merge_bounce_limit", BOUNCE_LIMIT_REASON, cancelled.eventSeq);
    if (cancelled && !mergeRetryReleased(s.task, s.events, cancelled)) return escalate("merge_retry_requires_pm", `合并意图 ${cancelled.id} 已取消，先由 PM 核对外部结果`, cancelled.eventSeq);
    const proof = mergeReviewGate(s);
    if (proof) return proof;
  }
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
  return makeIntent(s, node, node.action, `${node.id}：${node.next ?? "执行"}`,
    node.action === "merge" ? [taskResource(s), `merge:${s.task.project}`] : [taskResource(s)],
    { ...(node.next ? { targetStage: node.next } : {}) });
}

/** A blocked or ambiguous snapshot never emits work; every emitted action has a stable dedup key and explicit cause. */
function planSchedulerBase(s: PlannerSnapshot): PlannerDecision {
  const { task, workflow } = s;
  if (!workflow || workflow.mode === "manual") return wait("manual", "任务由 PM 人工推进");
  if (task.kind !== "code" || !templateFor(workflow.template, workflow.templateVersion) || workflow.taskId !== task.id || workflow.specRev !== task.specRev) {
    return escalate("workflow_drift", "流程模板、任务类型或规格版本已变，自动推进暂停");
  }
  if (!["claude", "codex"].includes(workflow.authorFamily) || !workflow.fallback.trim()) return escalate("spec_missing", "作者模型家族或退路方案缺失");
  if (!s.events.some((e) => e.kind === "task" && e.data.op === "new")) return escalate("task_origin", "任务缺建卡事件，无法给资源生成稳定标识");
  if (task.stage === "done" || task.stage === "cancelled") return wait("terminal", "任务已结束");
  if (task.stage === "blocked") return wait("blocked", "任务已阻塞，等 PM 解除");
  if (s.queueFrozen && ["spec", "build", "fix", "merge"].includes(task.stage)) return wait("queue_frozen", "项目队列已冻结，不派新活");
  if (s.blockedBy.length) return wait("dependency", `等待前置任务：${s.blockedBy.join("、")}`);
  const template = templateFor(workflow.template, workflow.templateVersion);
  const node = template && nodeAt(template, task.stage);
  if (!node) return escalate("stage_unknown", `模板 ${workflow.template} 不认识阶段 ${task.stage}`);
  const restate = restateGate(template!, node, task, s.events, s.intents);
  if (restate) return restate;
  const decision = task.stage === "spec" || task.stage === "build" || task.stage === "fix" ? dispatchWork(s, node)
    : task.stage === "review" ? reviewStep(s, node) : stageStep(s, node);
  const active = s.intents.find((i) => i.status === "pending" || i.status === "submitted" || i.status === "unknown");
  return escalationDowngrade(decision.kind === "intent" && active ? wait("intent_in_flight", `先结清调度意图 ${active.id}（${active.status}）`) : decision, task, s.events, s.fixDiff);
}

export const planScheduler = (s: PlannerSnapshot): PlannerDecision => planConvergence(s, planSchedulerBase);
