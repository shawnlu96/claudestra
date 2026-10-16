/**
 * 卡片状态的统一投影（agents-ACTIONSTATE1）：一张卡 / 一行待做 → 五个组之一（要你做 / 出问题 / 在做 / 排队 / 能用）加健康、在等谁、可做的动作。
 * 纯函数：输入显式带 now 和全部事实，不读库、文件、时钟或全局，不改输入；同样的输入永远得到同样的输出。
 * 事实收集在 ledger-action-state.ts。「卡住」的边界照 web/features/collab/collab-model.ts（STUCKVIEW1·2）：
 * fix 精确停满 FIX_STUCK_MS 才算问题；等待阶段严格超过 STUCK_MS；冻结、观察期、跨实例委托不因时长变红；
 * 明确故障（受阻、回滚、检查没过、断联、心跳过期、当前 head 连续 CI 失败）不受冻结 / 观察期 / 暂停影响。
 * 缺事实不猜：没有心跳记录 = unknown，不当正常也不当断联；时刻未知或是导入推断的近似值 = 不拿它判时长。tests/action-state*.test.ts。
 */
import { FIX_STUCK_MS, STUCK_MS } from "./action-state-thresholds.js";
import type { Stage } from "./ledger-stages.js";

export type ActionGroup = "owner" | "problem" | "active" | "queued" | "usable";
type ActionHealth = "normal" | "failed" | "disconnected" | "stale" | "unknown";
type WaitingOn = "owner" | "review" | "ci" | "dependency" | "peer" | "none";
type HeartbeatState = "live" | "stale" | "disconnected";

/** 当前 head 连续这么多次记录在案的 CI 失败才算反复失败 */
export const CI_REPEAT_FAILS = 3;

/** 与本卡关联的一条 ask；forOwner = 收件人是 owner（ask-audience.ts 同一口径）。只带判组要的字段，不带正文 */
export interface ActionAsk { id: string; kind: string; source: string; forOwner: boolean; state: string; expiresAt: number; createdAt: number }
/** 当前合并运行的 CI：head = 最近一次合并运行审过的 head；failStreak = 这个 head 上最近连续几次 CI 失败退回 */
export interface ActionCi { phase: string | null; head: string | null; failStreak: number; since: number | null }
export interface ActionPlacement { where: "local" | "peer"; peer: string | null; family: string | null }
/** 动作只是现有对象的稳定引用：答 / 批走 ask 的 answer 端点，暂停 / 恢复走 card-pause 端点；这里不发请求、不带凭据 */
interface ActionRef { kind: "answer" | "approve" | "pause" | "resume"; askId?: string; taskId?: string }

export interface ActionInput {
  now: number;
  taskId: string | null;
  /** null = 没建卡的 DAG 待做行 */
  stage: Stage | null;
  /** spec 卡已经派出复述（scheduler 意图 restate 已投递 / 已完成） */
  restating: boolean;
  stageSince: number | null;
  stageSinceApprox: boolean;
  asks: readonly ActionAsk[];
  mergePhase: string | null;
  ci: ActionCi | null;
  /** 既有租约 / 订单判定出的心跳；null = 没有心跳记录 */
  heartbeat: { state: HeartbeatState; at: number | null } | null;
  placement: ActionPlacement | null;
  instance: string | null;
  frozen: boolean;
  observationUntil: number | null;
  blockedBy: readonly string[];
  /** 没建卡的待做行：规格是否就绪；有卡时不看 */
  specReady: boolean;
  paused: boolean;
  /** 本机没有执行者、交给别的实例（extra.delegate） */
  delegated: boolean;
  lastEvent: { kind: string; ts: number; result?: unknown } | null;
  /** 现有暂停通道可用（开关开着、阶段可暂停由这里再判） */
  canPause: boolean;
}

export interface ActionState {
  flow: Stage;
  health: ActionHealth;
  waitingOn: WaitingOn;
  actions: ActionRef[];
  since: number | null;
  instance: string | null;
  group: ActionGroup;
  tag: string | null;
  reason: string;
  ci: Omit<ActionCi, "since"> | null;
  placement: ActionPlacement | null;
  eta?: number;
}

const WAIT_STAGES: ReadonlySet<Stage> = new Set(["restate", "review", "merge", "live", "blocked"]);
const WORK_STAGES: ReadonlySet<Stage> = new Set(["restate", "build", "fix", "review", "merge"]);
const USABLE_STAGES: ReadonlySet<Stage> = new Set(["live", "verified", "done"]);
const PAUSABLE: ReadonlySet<Stage> = new Set(["spec", "restate", "build", "review", "fix"]);
const WORK_WORD: Partial<Record<Stage, string>> = { restate: "复述中", build: "开发中", fix: "返工中", review: "审查中", merge: "合并中" };
const USABLE_WORD: Partial<Record<Stage, string>> = { live: "已上线", verified: "已验证", done: "已完成" };

interface Hit { reason: string; since: number | null }

const flowOf = (i: ActionInput): Stage => (i.stage === null ? "spec" : i.stage === "spec" && i.restating ? "restate" : i.stage);
/** 精确的停留时长；起点未知或近似 = null（不拿它判时长） */
const dwell = (i: ActionInput): number | null => (i.stageSince === null || i.stageSinceApprox ? null : Math.max(0, i.now - i.stageSince));
const exactSince = (i: ActionInput): number | null => (i.stageSinceApprox ? null : i.stageSince);
const observing = (i: ActionInput): boolean => i.stage === "live" && i.observationUntil !== null && i.now < i.observationUntil;
const ownerAsks = (i: ActionInput): ActionAsk[] => i.asks.filter((a) => a.forOwner && a.state === "open" && a.expiresAt > i.now);

/** 和时长无关的故障证据：冻结、观察期、暂停都盖不掉 */
function hardProblem(i: ActionInput): (Hit & { health: ActionHealth }) | null {
  if (i.heartbeat?.state === "disconnected") return { reason: "执行端断联", since: i.heartbeat.at, health: "disconnected" };
  if (i.heartbeat?.state === "stale") return { reason: "心跳过期", since: i.heartbeat.at, health: "stale" };
  if (i.stage === "blocked") return { reason: "受阻", since: exactSince(i), health: "failed" };
  const e = i.lastEvent;
  if (e?.kind === "rollback") return { reason: "已回滚", since: e.ts, health: "failed" };
  if (e?.kind === "verify" && e.result !== "pass") return { reason: "检查没过", since: e.ts, health: "failed" };
  if (i.ci && i.ci.failStreak >= CI_REPEAT_FAILS) return { reason: `当前 head 连续 ${i.ci.failStreak} 次 CI 失败`, since: i.ci.since, health: "failed" };
  return null;
}

/** 按时长判的问题（collab-model fixStalled / isStuck 同一边界）：冻结不变红；观察期到点即超时；委托给别的实例不算 */
function timedProblem(i: ActionInput): Hit | null {
  if (i.stage === null || i.frozen || i.stageSinceApprox) return null;
  const d = dwell(i);
  if (i.stage === "fix") return d !== null && d >= FIX_STUCK_MS ? { reason: "返工停满 2 小时", since: i.stageSince } : null;
  if (i.stage === "live" && i.observationUntil !== null) return observing(i) ? null : { reason: "观察期已到", since: i.observationUntil };
  if (i.delegated) return null;
  return WAIT_STAGES.has(i.stage) && d !== null && d > STUCK_MS ? { reason: "等待超过 30 分钟", since: i.stageSince } : null;
}

/** 排队：尚未开工、依赖没满足、已暂停、已冻结；压过普通进行态。已经能用的卡不归这里 */
function queuedHit(i: ActionInput): (Hit & { tag: string | null }) | null {
  if (i.stage !== null && USABLE_STAGES.has(i.stage)) return null;
  if (i.paused) return { reason: "已暂停", since: null, tag: "已暂停" };
  if (i.frozen) return { reason: "已冻结", since: null, tag: "冻结" };
  if (i.blockedBy.length) return { reason: `等 ${i.blockedBy.length} 个前置`, since: null, tag: null };
  if (i.stage === null) return { reason: i.specReady ? "未开工" : "缺规格", since: null, tag: null };
  if (i.stage === "spec" && !i.restating) return { reason: "未开工", since: exactSince(i), tag: null };
  return null;
}

function waitingOnOf(i: ActionInput, owner: boolean): WaitingOn {
  if (owner) return "owner";
  if (i.blockedBy.length) return "dependency";
  if (i.mergePhase === "await_ci") return "ci";
  if (i.stage === "review") return "review";
  if (i.delegated) return "peer";
  return "none";
}

/** 没有心跳记录时，在跑的卡的执行端状态就是不知道；没在跑的卡没有执行端要看 */
function healthOf(i: ActionInput, hard: { health: ActionHealth } | null): ActionHealth {
  if (hard) return hard.health;
  const running = i.stage !== null && (WORK_STAGES.has(i.stage) || i.restating);
  return running && !i.heartbeat ? "unknown" : "normal";
}

function actionsOf(i: ActionInput, asks: readonly ActionAsk[]): ActionRef[] {
  const out: ActionRef[] = asks.map((a) => ({ kind: a.kind === "authorize" || a.source === "permission" ? "approve" : "answer", askId: a.id }));
  if (i.taskId && i.paused) out.push({ kind: "resume", taskId: i.taskId });
  else if (i.taskId && i.canPause && i.stage !== null && PAUSABLE.has(i.stage)) out.push({ kind: "pause", taskId: i.taskId });
  return out;
}

type Verdict = Pick<ActionState, "group" | "reason" | "since" | "tag">;

function verdictOf(i: ActionInput, asks: readonly ActionAsk[], hard: Hit | null): Verdict {
  if (asks.length) {
    return { group: "owner", reason: asks.length > 1 ? `有 ${asks.length} 件事等你处理` : "有一件事等你处理", tag: null,
      since: Math.min(...asks.map((a) => a.createdAt)) };
  }
  const problem = hard ?? timedProblem(i);
  if (problem) return { group: "problem", reason: problem.reason, since: problem.since, tag: null };
  const queued = queuedHit(i);
  if (queued) return { group: "queued", reason: queued.reason, since: queued.since, tag: queued.tag };
  const flow = flowOf(i);
  if (USABLE_STAGES.has(flow)) {
    return { group: "usable", reason: USABLE_WORD[flow]!, since: exactSince(i), tag: observing(i) ? "观察中" : null };
  }
  const ci = i.mergePhase === "await_ci";
  return { group: "active", reason: ci ? "等 CI" : WORK_WORD[flow] ?? "进行中", since: ci ? i.ci?.since ?? null : exactSince(i), tag: null };
}

export function actionState(i: ActionInput): ActionState {
  const ci = i.ci ? { phase: i.ci.phase, head: i.ci.head, failStreak: i.ci.failStreak } : null;
  const placement = i.placement ? { ...i.placement } : null;
  const base = { flow: flowOf(i), instance: i.instance, ci, placement };
  if (i.stage === "cancelled") {
    return { ...base, health: "normal", waitingOn: "none", actions: [], since: exactSince(i), group: "queued", tag: "已取消", reason: "已取消" };
  }
  const asks = ownerAsks(i);
  const hard = hardProblem(i);
  const v = verdictOf(i, asks, hard);
  return { ...base, health: healthOf(i, hard), waitingOn: waitingOnOf(i, asks.length > 0), actions: actionsOf(i, asks), ...v };
}
