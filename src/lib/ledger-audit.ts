/**
 * 台账巡检的规则（T29，docs/architecture/ledger-audit.md）：输入一个项目的快照，输出「可能漏了」的异常，每条带一句建议动作。
 * 纯函数、只 import 类型与纯工具：取数在 ledger-audit-snapshot.ts，落库 / 去重在 ledger-audit-store.ts。
 * 快照里某个来源为 null = 这一轮没取到（tmux 出错、文件坏了）：依赖它的规则不跑、也不列进 evaluated，
 * 这样取数失败不会把上一轮还开着的异常误标成「已解决」。
 */
import { owesAdversarial, type SpecPolicy } from "./ledger-handler.js";
import { currentStageMark, stageTimeline } from "./ledger-metrics.js";
import type { ExecutorKind } from "./ledger-steps.js";
import { TERMINAL_STAGES, type LedgerEvent, type LedgerTask } from "./ledger-stages.js";
import { blockFindings, type GateInputs } from "./scheduler-dispatch-block.js";
import { diagnoseManual, manualResumeMode, type ManualResumeMode } from "./manual-reason.js";
import { recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import { MERGE_READY_RULES, mergeReadyAudit } from "./ledger-audit-merge-ready.js";
import { LEND_GRANT_RULES, lendGrantAudit } from "./ledger-audit-lend-grant.js";
import { MERGE_PM_RULES, mergePmAudit } from "./ledger-audit-merge-pm.js";
import { WAIT_RULES, waitAudit, waitNotificationFindings, type WaitGraph } from "./ledger-deadlock.js";
import { reviewReassigned, reviewVerdictFinding } from "./ledger-audit-verdict.js";
import { trainSlots, type MergeTrainInputs, type TrainSlot } from "./ledger-audit-train.js";
import { idleRules, type IdleFactInputs, type IdleRules } from "./ledger-audit-idle.js";
import type { WorkflowMode } from "./ledger-scheduler.js";

const MIN = 60_000;

/** 阈值（改动同步 docs/architecture/ledger-audit.md 的表） */
export const AUDIT_THRESHOLDS = {
  /** review 阶段没有审查员在跑、也没有 note / review 事件 */
  reviewNoReviewerMs: 20 * MIN,
  /** 本轮审查已派给 peer / 人（看不到对方会话）还没有结论：从派出时算，note 不重置 */
  reviewAssignedStaleMs: 120 * MIN,
  /** 本轮审查已 pass、任务还停在 review（等推 merge 或等拍板） */
  reviewPassedIdleMs: 30 * MIN,
  /** manual / 没有 workflow：结论 5 分钟没处理；auto / observe：changes / block 20 分钟 */
  reviewVerdictIdleMs: { manual: 5 * MIN, auto: 20 * MIN, observe: 20 * MIN },
  /** build / fix 阶段执行者主回合空闲、会话不再写入 */
  executorIdleMs: 15 * MIN,
  /** 交付后阶段不在 review、也没有审查结论 */
  deliverNoReviewMs: 30 * MIN,
  /** 发给 PM 的消息押着（PM 已空闲）或被 check_inbox 领走没确认 */
  pmHeldMs: 10 * MIN,
  /** merge 阶段没有部署推进（从进入 merge / 解冻 / 依赖放行里最晚的那个算） */
  mergeStallMs: 30 * MIN,
  /** live 阶段没有验证推进：PM 部署完通常马上 verify，给足 60 分钟 */
  liveStallMs: 60 * MIN,
  /** 任务结束后执行者还没回收的宽限 */
  reclaimGraceMs: 30 * MIN,
  /** ownerInbox 条目 doing 的时长（从 owner 发话算，条目没记开工时间） */
  ownerInboxDoingMs: 30 * MIN,
  /** agent-task-* 建出来多久还没挂任务才算孤儿（先建窗口、后 task-set --agent 的间隙） */
  orphanGraceMs: 15 * MIN,
  /** 画面认不出时，会话文件这么久内写过就当它在回合中（押后规则不报） */
  recentWriteMs: 3 * MIN,
  /** 从自动进了 manual、却没有可用理由（manual-reason.ts）：只报警，不改模式 */
  manualReasonMissingMs: 30 * MIN,
} as const;

const AUDIT_RULES = [
  "review_no_reviewer", "review_assigned_stale", "review_passed_idle", "review_verdict_idle", "executor_idle", "deliver_not_in_review", "pm_held",
  "ship_stalled", "reclaim_executor", "task_agent_missing", "orphan_executor", "owner_inbox_stale", "merge_unknown", "review_witness_mismatch",
  "dispatch_blocked", "manual_reason_missing", "manual_would_resume", ...MERGE_READY_RULES, ...WAIT_RULES,
  ...LEND_GRANT_RULES, ...MERGE_PM_RULES,
] as const;
export type AuditRule = (typeof AUDIT_RULES)[number];

/** 审查、交付相关的推给调度助理（没有就推 PM），其余推 PM */
const DISPATCH_RULES: readonly AuditRule[] = ["review_no_reviewer", "executor_idle", "deliver_not_in_review"];
/** 执行者窗口的名字前缀：孤儿 / 回收只看这类临时执行者，常驻 agent（codex、relay）不算 */
const EXECUTOR_PREFIX = "agent-task-";
/** 执行者还在干活的阶段（「执行者不在 registry」只在这些阶段报） */
const EXECUTOR_STAGES: readonly LedgerTask["stage"][] = ["restate", "build", "review", "fix"];

export type MainTurn = "busy" | "idle" | "compacting" | "unknown";

export interface AuditAgent {
  /** registry 键（agent-xxx） */
  name: string;
  projectId?: string;
  /** tmux 窗口在不在；null = 没列出窗口（tmux 出错） */
  windowAlive: boolean | null;
  turn: MainTurn;
  /** 会话文件最近写入时刻；没有 / 没取 = null */
  lastWriteAt: number | null;
  /** 会话文件的创建时刻（≈ agent 建出来的时间）；没有 / 没取 = null */
  startedAt?: number | null;
}

export interface AuditHeld {
  /** 收件的 PM（registry 键） */
  to: string;
  messageId: string;
  from: string;
  heldAt: number;
  /** check_inbox 领走的时刻；没领 = null */
  leaseAt: number | null;
}

export interface AuditInboxEntry {
  ts: number | null;
  text: string;
  status: string;
  to: string;
}

export interface AuditSnapshot {
  project: string;
  pms: readonly string[];
  /** 本项目的任务，各自带 target = 任务 id 的事件（seq 升序）；blockedBy = 依赖上还挡着它的前置任务（ledger-deps.ts） */
  tasks: readonly AuditTask[];
  agents: readonly AuditAgent[] | null;
  /** 在跑的审查员审的任务（本项目各 agent 的 subagents 解析出来，任务号一律小写） */
  reviewers: readonly { taskId: string; round: number | null }[] | null;
  /** 编排班子（meta.team，T30）：开了才按规格卡判「还欠对抗式」；dispatcher 有值就用它认调度助理，不再按名字猜 */
  team?: { dispatcher: string | null } | null;
  /** 合并队列冻结中（meta.queueFrozen）：merge 停着是预期的 */
  queueFrozen?: boolean;
  /** 调度引擎合并 journal 停在 unknown 的记录（scheduler_merges）；没有这张表 = 空 */
  mergeUnknown?: readonly { intentId: string; taskId: string; reason: string; since: number }[];
  /** 最近一次解冻（unfreeze 事件）的时刻：merge 停滞从它之后算 */
  unfrozenAt?: number | null;
  held: readonly AuditHeld[] | null;
  ownerInbox: readonly AuditInboxEntry[] | null;
  /** 只读等待图（ledger-deadlock.ts）；没取 = 等待规则不跑也不列 skipped，图里有 unknown = 不进 evaluated */
  waitGraph?: WaitGraph;
  /** 只有完整扫描建立过基线的等待规则，才可在不完整扫描时通知。 */
  waitBaseline?: readonly string[] | null;
  /** 为 null 的来源各是为什么取不到（写进 skipped，不悄悄跳过）；windows = tmux 没列出窗口 */
  unavailable?: Partial<Record<"agents" | "reviewers" | "held" | "ownerInbox" | "windows", string>>;
}

export interface AuditFinding {
  /** 全局唯一：项目 + 规则 + 对象 + 状态指纹；状态变了（新一轮 review、换了阶段）就是新 key，会再推一次 */
  key: string;
  project: string;
  taskId: string | null;
  rule: AuditRule;
  /** 异常从什么时候开始算 */
  since: number;
  detail: string;
  suggestion: string;
  /** 推给谁；项目没有 PM 名单 = null（只落库不推） */
  notify: string | null;
}

export interface AuditResult {
  findings: AuditFinding[];
  /** 这一轮真正跑过的规则：只有这些规则下、这次没再出现的旧异常才标已解决 */
  evaluated: AuditRule[];
  /** 没跑的规则和原因 */
  skipped: { rule: AuditRule; reason: string }[];
  /** 这一轮判不出、但不该当成已解决的 key（押着的消息在 PM 忙时照样押着）：对账时保持打开 */
  keep: string[];
}

const byName = (name: string) => /dispatch/.test(name);

/** dispatcher = meta.team.dispatcher：有就只认它；没配班子 / 没设调度助理才退回按名字里的 dispatch 猜 */
export function auditRecipient(rule: AuditRule, pms: readonly string[], teamDispatcher?: string | null): string | null {
  const isDispatcher = teamDispatcher ? (p: string) => p === teamDispatcher : byName;
  const pm = pms.find((p) => !isDispatcher(p)) ?? null;
  const dispatcher = pms.find(isDispatcher) ?? null;
  return DISPATCH_RULES.includes(rule) ? (dispatcher ?? pm) : (pm ?? dispatcher);
}

const mins = (ms: number) => `${Math.floor(ms / MIN)} 分钟`;

/**
 * blockedBy = 依赖上还挡着它的前置任务；unblockedAt = 依赖最后一次放行的时刻（merge 停滞从它之后算）；
 * specPolicy = 规格卡的审查策略（task-spec.ts specPolicyOf），只在开了班子的项目里取，找不到规格卡记 null（与合并闸门一样不拦）
 */
type AuditTask = {
  task: LedgerTask; events: readonly LedgerEvent[]; blockedBy?: readonly string[]; unblockedAt?: number | null; specPolicy?: SpecPolicy;
  workflowMode?: WorkflowMode | null;
  /** 本轮（step round = task.round）显式派了、还没记结论的审查那一步；at = 派出时刻（ledger-audit-snapshot.ts pendingReview） */
  reviewStep?: { executor: string; executorKind: ExecutorKind; at: number } | null;
  /** This card's own gate inputs (scheduler-dispatch-block.ts gateInputs), build / fix only; absent = unknown. */
  gate?: GateInputs | null;
};

interface TaskFacts extends AuditTask {
  /** 进入当前阶段的时刻；导入推断的近似时间 = null（不拿它判超时） */
  stageSince: number | null;
}

function facts(t: AuditTask, now: number): TaskFacts {
  const approx = currentStageMark(t.events)?.data.approxTime === true;
  const from = stageTimeline(t.events, now).at(-1)?.from ?? null;
  return { ...t, stageSince: approx ? null : from };
}

const lastOf = (events: readonly LedgerEvent[], kinds: readonly string[], after = -Infinity) =>
  events.findLast((e) => kinds.includes(e.kind) && e.ts >= after);

type Emit = (f: Omit<AuditFinding, "project" | "notify" | "key"> & { keyParts: (string | number)[]; notify?: string | null }) => void;
type Keep = (rule: AuditRule, keyParts: (string | number)[]) => void;

/** 判了通过、但这一轮还欠对抗式（或说不清）：不是等推 merge，而是交调度助理派对抗式（与 review --to merge 闸门同一判定） */
function owedAfterPass(t: TaskFacts, pass: LedgerEvent, now: number, emit: Emit): void {
  const owes = owesAdversarial(t.specPolicy, t.events, t.task.round);
  if (owes === false || now - pass.ts <= AUDIT_THRESHOLDS.reviewNoReviewerMs) return;
  const { id, round } = t.task;
  emit({ rule: "review_no_reviewer", taskId: id, since: pass.ts, keyParts: [id, `r${round}`, "adversarial", pass.seq],
    detail: `${id} 第 ${round} 轮审查判了通过 ${mins(now - pass.ts)}，规格卡要求对抗式，${owes === true ? "这一轮、当前 head 上还没有对抗式通过" : "但说不清还欠不欠"}`,
    suggestion: owes === true ? "还欠对抗式，派对抗式" : "按规格卡核对还欠不欠对抗式，欠就派对抗式" });
}

/**
 * review 还没结论：派给 peer / 人的看不到对方会话，从派出时按更长阈值报 review_assigned_stale；派给本机 agent 且它主回合在跑不报；
 * 没派、或派的本机 agent 没在跑，照旧 20 分钟报 review_no_reviewer（note / review 推后计时）
 */
function reviewWaiting(t: TaskFacts, stageSince: number, agents: ReadonlyMap<string, AuditAgent>, now: number, emit: Emit): void {
  const { task, events, reviewStep: step } = t;
  if (step && step.executorKind !== "agent") {
    const since = Math.max(stageSince, step.at);
    if (now - since <= AUDIT_THRESHOLDS.reviewAssignedStaleMs) return;
    emit({ rule: "review_assigned_stale", taskId: task.id, since, keyParts: [task.id, `r${task.round}`, step.executor, step.at],
      detail: `${task.id} 第 ${task.round} 轮审查派给了 ${step.executor}，已 ${mins(now - since)}没有结论`, suggestion: `问 ${step.executor} 审到哪了，不回就收回改派` });
    return;
  }
  if (step && turnBusy(agents.get(step.executor), now)) return;
  const since = Math.max(stageSince, lastOf(events, ["note", "review"], stageSince)?.ts ?? stageSince);
  if (now - since <= AUDIT_THRESHOLDS.reviewNoReviewerMs) return;
  const who = step ? `审查派给了 ${step.executor}，但它的会话没在跑` : "没有审查员在跑";
  emit({ rule: "review_no_reviewer", taskId: task.id, since, keyParts: [task.id, `r${task.round}`, stageSince],
    detail: `${task.id} 在 review（第 ${task.round} 轮）已 ${mins(now - since)}，${who}，也没有新的 note / review`,
    suggestion: step ? `核对 ${step.executor} 在不在审，不在就重派` : "派审查员" });
}

function reviewRules(ts: readonly TaskFacts[], reviewers: NonNullable<AuditSnapshot["reviewers"]>, agents: ReadonlyMap<string, AuditAgent>, team: boolean, now: number, emit: Emit): void {
  const reviewing = new Set(reviewers.map((r) => r.taskId.toLowerCase()));
  for (const t of ts) {
    const { task, events, stageSince } = t;
    if (reviewing.has(task.id.toLowerCase())) continue;
    const latestReview = task.stage === "review" && stageSince !== null ? lastOf(events, ["review"], stageSince) : undefined;
    const lastReview = latestReview && (latestReview.ts !== stageSince || latestReview.seq > (currentStageMark(events)?.seq ?? 0)) ? latestReview : undefined;
    // 结论后同一轮又派了审查：按新派的那一步等结论，恢复等待审查报警；peer 结论不回写步骤行，只能按派出先后分
    const settled = lastReview && !reviewReassigned(events, lastReview, task.round, t.reviewStep?.at);
    const passed = settled && lastReview.data.verdict === "pass";
    const verdictIdle = AUDIT_THRESHOLDS.reviewVerdictIdleMs[t.workflowMode ?? "manual"];
    if (settled && (lastReview.data.verdict === "changes" || lastReview.data.verdict === "block")) {
      const f = reviewVerdictFinding(task, lastReview, now, verdictIdle);
      if (f) emit(f);
    } else if (passed && team && owesAdversarial(t.specPolicy, events, task.round) !== false) {
      owedAfterPass(t, lastReview, now, emit);
    } else if (passed) {
      // 审查已通过：该推 merge 或等 owner 拍板，不是再派审查员；从 pass 算起，PM 写 note 不重开
      const threshold = !t.workflowMode || t.workflowMode === "manual" ? verdictIdle : AUDIT_THRESHOLDS.reviewPassedIdleMs;
      if (now - lastReview.ts > threshold) {
        emit({ rule: "review_passed_idle", taskId: task.id, since: lastReview.ts, keyParts: [task.id, `r${task.round}`, lastReview.seq],
          detail: `${task.id} 第 ${task.round} 轮审查已通过 ${mins(now - lastReview.ts)}，还停在 review`, suggestion: "审查已通过，推进 merge 或等拍板" });
      }
    } else if (task.stage === "review" && stageSince !== null) {
      reviewWaiting(t, stageSince, agents, now, emit);
    }
    // 只管「交付记了、阶段没跟着进 review」：交付晚于进入当前 build / fix。PM 跳过审查直接 merge、退回 fix、blocked 都不算
    if ((task.stage !== "build" && task.stage !== "fix") || stageSince === null) continue;
    const lastDeliver = lastOf(events, ["deliver"]);
    const reviewedAfter = lastDeliver && lastOf(events, ["review"], lastDeliver.ts);
    if (lastDeliver && lastDeliver.ts > stageSince && !reviewedAfter && now - lastDeliver.ts > AUDIT_THRESHOLDS.deliverNoReviewMs) {
      emit({ rule: "deliver_not_in_review", taskId: task.id, since: lastDeliver.ts, keyParts: [task.id, lastDeliver.seq],
        detail: `${task.id} 交付后 ${mins(now - lastDeliver.ts)} 没有审查结论，阶段却是 ${task.stage}（不在 review）`,
        suggestion: "核对阶段：该审的推回 review 并派审查员" });
    }
  }
}

type Idle = IdleRules<TaskFacts>;
function executorIdle(ts: readonly TaskFacts[], agents: ReadonlyMap<string, AuditAgent>, now: number, emit: Emit, idle: Idle): void {
  for (const { task, events, stageSince } of ts) {
    if ((task.stage !== "build" && task.stage !== "fix") || stageSince === null) continue;
    const delivered = !!lastOf(events, ["deliver"], stageSince);
    // AUDLEND1（ledger-audit-idle.ts）：出借在途的卡按出借单的心跳判，不看本机会话
    if (idle.lent({ task, stageSince, delivered }, now, emit) || !task.agent) continue;
    const a = agents.get(task.agent);
    // 画面认不出（unknown）照样按会话写入时间判：15 分钟一行不写本身就是强信号，只有明确在忙才放过
    if (!a || a.turn === "busy" || a.turn === "compacting" || delivered) continue;
    const since = Math.max(stageSince, a.lastWriteAt ?? stageSince);
    if (now - since <= AUDIT_THRESHOLDS.executorIdleMs) continue;
    const bg = idle.local(task, since, now); // 后台 shell 在跑：阈值放宽到 60 分钟
    if (bg.hold) continue;
    emit({ rule: "executor_idle", taskId: task.id, since, keyParts: [task.id, task.stage, stageSince, since],
      detail: `${task.id} 在 ${task.stage}，执行者 ${task.agent} 已空闲 ${mins(now - since)}，还没交付${bg.note}`, suggestion: "问执行者卡在哪（可能在等你回复）" });
  }
}

type Train = (task: LedgerTask) => TrainSlot;
function shipStalled(ts: readonly TaskFacts[], frozen: boolean, unfrozenAt: number | null, now: number, emit: Emit, keep: Keep, train: Train): void {
  for (const { task, events, stageSince, blockedBy, unblockedAt } of ts) {
    if ((task.stage !== "merge" && task.stage !== "live") || stageSince === null) continue;
    // merge 停着是预期的：依赖上还在等前置任务上线（T8h：code 上线才算满足）
    if (task.stage === "merge" && (blockedBy?.length ?? 0) > 0) continue;
    // 从最后一个障碍消失时算：进 merge 之后才解冻 / 前置才上线，停着的时间不算它的
    // AUDTRAIN1（ledger-audit-train.ts）：排队等列车的卡与冻结同样不报、keep 住原 key；列车空着时从它最近一次空出起算
    const slot = train(task), parked = frozen || slot.parked;
    const cleared = task.stage === "merge" ? Math.max(unfrozenAt ?? -Infinity, unblockedAt ?? -Infinity, slot.freedAt ?? -Infinity) : -Infinity;
    const moved = Math.max(stageSince, lastOf(events, ["deploy", "verify"], stageSince)?.ts ?? stageSince);
    const since = Math.max(moved, cleared), limit = task.stage === "merge" ? AUDIT_THRESHOLDS.mergeStallMs : AUDIT_THRESHOLDS.liveStallMs;
    // AUDN1：冻结中 / 解冻后宽限期里只是因冻结不报，不算已解决——不撇冻结也停够了的 key 保持打开，解冻后不当新发现重推
    // key 带上最后一次 deploy / verify：真推进过就是新 key，旧 key 不会被 keep 住（推进后哪怕错过了巡检窗口也一样）
    const keyParts = moved > stageSince ? [task.id, task.stage, stageSince, moved] : [task.id, task.stage, stageSince];
    const stalledSansFreeze = now - Math.max(moved, unblockedAt ?? -Infinity) > limit;
    if (task.stage === "merge" && (parked || now - since <= limit) && stalledSansFreeze) keep("ship_stalled", keyParts);
    if ((task.stage === "merge" && parked) || now - since <= limit) continue;
    const want = task.stage === "merge" ? "合并部署" : "线上验证";
    emit({ rule: "ship_stalled", taskId: task.id, since, keyParts,
      detail: `${task.id} 在 ${task.stage} 已 ${mins(now - since)} 没推进${slot.note}`, suggestion: `补做${want}，做完推阶段` });
  }
}

/** unknown 不会自愈，且在结清前挡住所有 update；冻结又让 ship_stalled 静音，所以单列一条推给 PM，直到人工结清 */
function mergeUnknown(runs: NonNullable<AuditSnapshot["mergeUnknown"]>, emit: Emit): void {
  for (const r of runs) {
    emit({ rule: "merge_unknown", taskId: r.taskId, since: r.since, keyParts: [r.intentId],
      detail: r.reason.startsWith("部署：") ? `${r.taskId} 自动部署结果不明（部署进程已确认不在，不挡 update）：${r.reason.slice(3, 203)}`
        : `${r.taskId} 自动合并结果不明（结清前挡 update）：${r.reason.slice(0, 200)}`,
      suggestion: `核对 PR 后 ledger scheduler-merge-resolve ${r.intentId} --outcome done|failed|cancelled --receipt <证据>，再 unfreeze` });
  }
}

/** An auto card's verdict whose recorded evidence (tmux window, process chain, cwd) does not fit the bound reviewer. */
function witnessMismatches(ts: readonly TaskFacts[], emit: Emit): void {
  for (const t of ts) {
    for (const e of t.events) {
      const miss = e.kind === "review" ? (e.data.witness as { mismatch?: unknown } | undefined)?.mismatch : undefined;
      if (!Array.isArray(miss) || !miss.length) continue;
      emit({ rule: "review_witness_mismatch", taskId: t.task.id, since: e.ts, keyParts: [t.task.id, e.seq],
        detail: `${t.task.id} 第 ${String(e.data.round)} 轮结论记在 ${String(e.data.reviewer)} 名下（${String(e.data.verdict)}），旁证对不上：${miss.map(String).join("；").slice(0, 300)}`,
        suggestion: "核对这条结论是不是审查员本人写的；不是就 workflow-set --mode manual --reason 接管，按人工重审" });
    }
  }
}

/**
 * manual 理由与恢复观察（MAN1）：只产出巡检发现（落库去重 / 推 PM），不改流程、不派单、不碰容量或合并。
 * 没有可用理由的 manual 超 30 分钟报一次；observe 下解除条件在只读事实上看似满足，按状态版本报一次 would-resume。
 */
function manualRules(s: AuditSnapshot, ts: readonly TaskFacts[], resume: ManualResumeMode, now: number, emit: Emit): void {
  const unknown = s.mergeUnknown?.map((r) => r.taskId);
  for (const t of ts) {
    const d = diagnoseManual({ task: t.task, events: t.events, blockedBy: t.blockedBy, mergeUnknown: unknown });
    if (!d) continue;
    const entry = t.events.find((e) => e.seq === d.entrySeq);
    const since = entry?.ts ?? now;
    const gaps = d.gaps.join("；").slice(0, 300) || "无";
    if (!d.code && now - since > AUDIT_THRESHOLDS.manualReasonMissingMs) {
      emit({ rule: "manual_reason_missing", taskId: t.task.id, since, keyParts: [t.task.id, d.entrySeq],
        detail: `${t.task.id} 进 manual（#${d.entrySeq}）已 ${mins(now - since)}，理由：${d.text || "（空）"}；解除节点：${d.node}；证据缺口：${gaps}（只报警，不改模式、不派单）`,
        suggestion: d.next });
    }
    if (d.wouldResume && resume !== "off") {
      emit({ rule: "manual_would_resume", taskId: t.task.id, since, keyParts: [t.task.id, d.entrySeq, d.fingerprint],
        detail: `${t.task.id} manual（${d.label}：${d.text}）的解除条件「${d.release}」在只读事实上看似已满足（观察报告，本巡检不执行恢复）`,
        suggestion: d.next });
    }
  }
}

function registryRules(s: AuditSnapshot, ts: readonly TaskFacts[], agents: ReadonlyMap<string, AuditAgent>, now: number, emit: Emit, idle: Idle): void {
  const skip = (name: string) => s.pms.includes(name) || name === "master" || name === "owner";
  const byAgent = new Map<string, TaskFacts[]>();
  for (const t of ts) if (t.task.agent) byAgent.set(t.task.agent, [...(byAgent.get(t.task.agent) ?? []), t]);
  for (const t of ts) {
    const agent = t.task.agent;
    // 只看还要执行者干活的阶段：merge 之后执行者被回收是正常的，spec 时可能还没建
    if (!agent || skip(agent) || !EXECUTOR_STAGES.includes(t.task.stage) || agents.has(agent)) continue;
    emit({ rule: "task_agent_missing", taskId: t.task.id, since: t.stageSince ?? now, keyParts: [t.task.id, agent],
      detail: `${t.task.id}（${t.task.stage}）的执行者 ${agent} 不在 registry`, suggestion: "核对执行者：改派或 task-set --agent" });
  }
  for (const a of agents.values()) {
    if (!a.name.startsWith(EXECUTOR_PREFIX) || a.projectId !== s.project || skip(a.name)) continue;
    const relay = idle.relay(a.name), mine = byAgent.get(a.name) ?? []; // AUDLEND1：出借卡的本机复述会话，卡算它的任务
    const own = [...new Set([...mine, ...relay.own])];
    if (!own.length) {
      // 建出来的时间取不到（会话文件还没有）= 刚建，先不报
      if (a.startedAt == null || now - a.startedAt <= AUDIT_THRESHOLDS.orphanGraceMs) continue;
      emit({ rule: "orphan_executor", taskId: null, since: now, keyParts: [a.name],
        detail: `${a.name} 属于本项目，台账里没有它的任务${relay.orphanNote}`, suggestion: "补建任务或回收执行者" });
      continue;
    }
    if (a.windowAlive !== true || mine.some((t) => !TERMINAL_STAGES.includes(t.task.stage)) || relay.going) continue;
    const last = own.reduce((x, y) => ((y.stageSince ?? 0) > (x.stageSince ?? 0) ? y : x));
    const ended = last.stageSince ?? 0;
    if (now - ended <= AUDIT_THRESHOLDS.reclaimGraceMs) continue;
    emit({ rule: "reclaim_executor", taskId: last.task.id, since: ended, keyParts: [a.name, last.task.id],
      detail: `${a.name} 的任务 ${last.task.id} 已 ${last.task.stage}，窗口还在${relay.reclaimNote}`, suggestion: "回收执行者（kill）" });
  }
}

/** 主回合在跑：画面明说在忙，或画面认不出但会话文件刚写过 */
function turnBusy(a: AuditAgent | undefined, now: number): boolean {
  if (!a) return false;
  if (a.turn === "busy" || a.turn === "compacting") return true;
  return a.turn === "unknown" && a.lastWriteAt !== null && now - a.lastWriteAt < AUDIT_THRESHOLDS.recentWriteMs;
}

function pmHeld(s: AuditSnapshot, held: readonly AuditHeld[], agents: ReadonlyMap<string, AuditAgent>, now: number, emit: Emit, keep: Keep): void {
  for (const h of held) {
    if (!s.pms.includes(h.to)) continue;
    const leased = h.leaseAt !== null;
    const since = leased ? (h.leaseAt as number) : h.heldAt;
    if (now - since <= AUDIT_THRESHOLDS.pmHeldMs) continue;
    const keyParts = [h.to, h.messageId, leased ? `lease${since}` : "held"];
    // 没领走的只在对方空闲时才算：回合中押着是正常的，Stop 时会投。已报过的这时保持打开，免得忙闲交替时关了又开、重复推
    if (!leased && turnBusy(agents.get(h.to), now)) {
      keep("pm_held", keyParts);
      continue;
    }
    emit({ rule: "pm_held", taskId: null, since, keyParts,
      detail: leased
        ? `${h.from} 发给 ${h.to} 的消息被 check_inbox 领走 ${mins(now - since)} 还没确认`
        : `${h.from} 发给 ${h.to} 的消息押了 ${mins(now - since)}，${h.to} 已空闲仍没投出`,
      suggestion: "check_inbox 领回并处理" });
  }
}

function ownerInbox(entries: readonly AuditInboxEntry[], now: number, emit: Emit): void {
  for (const m of entries) {
    if ((m.status !== "doing" && m.status !== "in_progress") || m.ts === null || now - m.ts <= AUDIT_THRESHOLDS.ownerInboxDoingMs) continue;
    const head = [...m.text.trim()].slice(0, 40).join("");
    emit({ rule: "owner_inbox_stale", taskId: null, since: m.ts, keyParts: [m.ts, head],
      detail: `owner 的要求「${head}」${m.to ? `（→ ${m.to}）` : ""}处理中已 ${mins(now - m.ts)}`, suggestion: "核对进度：做完标 done，卡住就回 owner" });
  }
}

/** 一个项目一轮巡检；policy = 恢复策略 port，正式巡检（ledger audit）用 CFG 的文件版，单测注入假的 */
export function auditLedger(s: AuditSnapshot & MergeTrainInputs & IdleFactInputs, now: number, policy: RecoveryPolicyPort = recoveryPolicy): AuditResult {
  const findings: AuditFinding[] = [];
  const evaluated: AuditRule[] = [];
  const skipped: AuditResult["skipped"] = [];
  const kept: string[] = [];
  const keyOf = (rule: AuditRule, parts: (string | number)[]) => [s.project, rule, ...parts].join("|");
  const keep: Keep = (rule, parts) => void kept.push(keyOf(rule, parts));
  const why = (src: keyof NonNullable<AuditSnapshot["unavailable"]>) => s.unavailable?.[src] ?? "取不到";
  const skip = (reason: string, ...rs: AuditRule[]) => rs.forEach((rule) => skipped.push({ rule, reason }));
  const emit: Emit = ({ keyParts, notify, ...f }) => // notify：规则自带收件人（MQWATCH1 与调度主提醒同一位 PM），没有才按通用收件人
    findings.push({ ...f, project: s.project, key: keyOf(f.rule, keyParts), notify: notify ?? auditRecipient(f.rule, s.pms, s.team?.dispatcher) });
  const ts = s.tasks.map((t) => facts(t, now));
  const agents = new Map((s.agents ?? []).map((a) => [a.name, a]));
  if (s.reviewers) {
    reviewRules(ts, s.reviewers, agents, !!s.team, now, emit);
    evaluated.push("review_no_reviewer", "review_assigned_stale", "review_passed_idle", "review_verdict_idle", "deliver_not_in_review");
  } else skip(why(s.agents ? "reviewers" : "agents"), "review_no_reviewer", "review_assigned_stale", "review_passed_idle", "review_verdict_idle", "deliver_not_in_review");
  if (s.agents) {
    const idle = idleRules(s, ts, policy, AUDIT_THRESHOLDS.executorIdleMs);
    executorIdle(ts, agents, now, emit, idle);
    registryRules(s, ts, agents, now, emit, idle);
    evaluated.push("executor_idle", "task_agent_missing", "orphan_executor");
    if (s.agents.every((a) => a.windowAlive !== null)) evaluated.push("reclaim_executor");
    else skip(why("windows"), "reclaim_executor");
  } else skip(why("agents"), "executor_idle", "task_agent_missing", "orphan_executor", "reclaim_executor");
  shipStalled(ts, s.queueFrozen === true, s.unfrozenAt ?? null, now, emit, keep, trainSlots(s, policy));
  evaluated.push("ship_stalled");
  mergeUnknown(s.mergeUnknown ?? [], emit); evaluated.push("merge_unknown");
  witnessMismatches(ts, emit); evaluated.push("review_witness_mismatch");
  // 外发闸拒收后的派单阻塞：只看台账事件，不靠本机会话在不在（scheduler-dispatch-block.ts）
  for (const t of ts) { const b = blockFindings(t.task, t.events, t.gate); if (b) emit({ rule: "dispatch_blocked", taskId: t.task.id, ...b }); }
  evaluated.push("dispatch_blocked");
  mergeReadyAudit(s, now, policy, { emit, evaluated, skip }); // MAINP2 验收线 7（ledger-audit-merge-ready.ts）
  lendGrantAudit(s, now, { emit, evaluated, keep }); // LGR1：出借授权快到期 / 已没了（ledger-audit-lend-grant.ts）
  mergePmAudit(s, now, { emit, evaluated, skip, keep }); // MQWATCH1（ledger-audit-merge-pm.ts）
  // would-resume 的模式经唯一 RecoveryPolicyPort（CFG manualStall）现读；off、策略读不了或不认识都按 off，不报也不对账
  const resume = manualResumeMode(policy, s.project);
  manualRules(s, ts, resume, now, emit);
  evaluated.push("manual_reason_missing");
  if (resume === "off") skip("manual 恢复观察为 off（恢复策略 manualStall 为 off 或读不了）", "manual_would_resume");
  else evaluated.push("manual_would_resume");
  if (s.held && s.agents) {
    pmHeld(s, s.held, agents, now, emit, keep);
    evaluated.push("pm_held");
  } else skip(why(s.agents ? "held" : "agents"), "pm_held");
  if (s.ownerInbox) {
    ownerInbox(s.ownerInbox, now, emit);
    evaluated.push("owner_inbox_stale");
  } else skip(why("ownerInbox"), "owner_inbox_stale");
  const wait = waitAudit(s.waitGraph, now);
  wait.findings.forEach(emit);
  evaluated.push(...wait.evaluated);
  skipped.push(...wait.skipped);
  return { findings: waitNotificationFindings(findings, s.waitGraph, s.waitBaseline), evaluated, skipped, keep: kept };
}

/** 推给 PM / 调度助理的一条通知（bridge/ledger-audit-service.ts 发）：一轮新出现的合成一条，每条一行「对象 · 建议 — 现象」 */
export function auditNoticeText(list: readonly Pick<AuditFinding, "project" | "taskId" | "detail" | "suggestion">[], cmd: string): string {
  const lines = list.map((f, i) => `${i + 1}. ${f.taskId ?? f.project} · ${f.suggestion} — ${f.detail}`);
  return [
    `[🔎 台账巡检] 新发现 ${list.length} 条可能漏了的事（只报新出现的，同一条不会重复推；不用回复）：`,
    ...lines,
    `全部未解决的：${cmd}`,
  ].join("\n");
}
