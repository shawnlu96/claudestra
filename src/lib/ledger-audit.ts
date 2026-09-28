/**
 * 台账巡检的规则（T29，docs/architecture/ledger-audit.md）：输入一个项目的快照，输出「可能漏了」的异常，每条带一句建议动作。
 * 纯函数、只 import 类型与纯工具：取数在 ledger-audit-snapshot.ts，落库 / 去重在 ledger-audit-store.ts。
 * 快照里某个来源为 null = 这一轮没取到（tmux 出错、文件坏了）：依赖它的规则不跑、也不列进 evaluated，
 * 这样取数失败不会把上一轮还开着的异常误标成「已解决」。
 */
import { currentStageMark, stageTimeline } from "./ledger-metrics.js";
import { TERMINAL_STAGES, type LedgerEvent, type LedgerTask } from "./ledger-stages.js";

const MIN = 60_000;

/** 阈值（改动同步 docs/architecture/ledger-audit.md 的表） */
export const AUDIT_THRESHOLDS = {
  /** review 阶段没有审查员在跑、也没有 note / review 事件 */
  reviewNoReviewerMs: 20 * MIN,
  /** 本轮审查已 pass、任务还停在 review（等推 merge 或等拍板） */
  reviewPassedIdleMs: 30 * MIN,
  /** build / fix 阶段执行者主回合空闲、会话不再写入 */
  executorIdleMs: 15 * MIN,
  /** 交付后阶段不在 review、也没有审查结论 */
  deliverNoReviewMs: 30 * MIN,
  /** 发给 PM 的消息押着（PM 已空闲）或被 check_inbox 领走没确认 */
  pmHeldMs: 10 * MIN,
  /** merge / live 阶段没有部署 / 验证推进 */
  shipStallMs: 30 * MIN,
  /** 任务结束后执行者还没回收的宽限 */
  reclaimGraceMs: 30 * MIN,
  /** ownerInbox 条目 doing 的时长（从 owner 发话算，条目没记开工时间） */
  ownerInboxDoingMs: 30 * MIN,
  /** agent-task-* 建出来多久还没挂任务才算孤儿（先建窗口、后 task-set --agent 的间隙） */
  orphanGraceMs: 15 * MIN,
  /** 画面认不出时，会话文件这么久内写过就当它在回合中（押后规则不报） */
  recentWriteMs: 3 * MIN,
} as const;

const AUDIT_RULES = [
  "review_no_reviewer", "review_passed_idle", "executor_idle", "deliver_not_in_review", "pm_held",
  "ship_stalled", "reclaim_executor", "task_agent_missing", "orphan_executor", "owner_inbox_stale",
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
  /** 合并队列冻结中（meta.queueFrozen）：merge 停着是预期的 */
  queueFrozen?: boolean;
  /** 最近一次解冻（unfreeze 事件）的时刻：merge 停滞从它之后算 */
  unfrozenAt?: number | null;
  held: readonly AuditHeld[] | null;
  ownerInbox: readonly AuditInboxEntry[] | null;
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

const isDispatcher = (name: string) => /dispatch/.test(name);

export function auditRecipient(rule: AuditRule, pms: readonly string[]): string | null {
  const pm = pms.find((p) => !isDispatcher(p)) ?? null;
  const dispatcher = pms.find(isDispatcher) ?? null;
  return DISPATCH_RULES.includes(rule) ? (dispatcher ?? pm) : (pm ?? dispatcher);
}

const mins = (ms: number) => `${Math.floor(ms / MIN)} 分钟`;

/** blockedBy = 依赖上还挡着它的前置任务；unblockedAt = 依赖最后一次放行的时刻（merge 停滞从它之后算） */
type AuditTask = { task: LedgerTask; events: readonly LedgerEvent[]; blockedBy?: readonly string[]; unblockedAt?: number | null };

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

type Emit = (f: Omit<AuditFinding, "project" | "notify" | "key"> & { keyParts: (string | number)[] }) => void;
type Keep = (rule: AuditRule, keyParts: (string | number)[]) => void;

function reviewRules(ts: readonly TaskFacts[], reviewers: NonNullable<AuditSnapshot["reviewers"]>, now: number, emit: Emit): void {
  const reviewing = new Set(reviewers.map((r) => r.taskId.toLowerCase()));
  for (const { task, events, stageSince } of ts) {
    if (reviewing.has(task.id.toLowerCase())) continue;
    const lastReview = task.stage === "review" && stageSince !== null ? lastOf(events, ["review"], stageSince) : undefined;
    if (lastReview?.data.verdict === "pass") {
      // 审查已通过：该推 merge 或等 owner 拍板，不是再派审查员；从 pass 算起，PM 写 note 不重开
      if (now - lastReview.ts > AUDIT_THRESHOLDS.reviewPassedIdleMs) {
        emit({ rule: "review_passed_idle", taskId: task.id, since: lastReview.ts, keyParts: [task.id, `r${task.round}`, lastReview.seq],
          detail: `${task.id} 第 ${task.round} 轮审查已通过 ${mins(now - lastReview.ts)}，还停在 review`, suggestion: "审查已通过，推进 merge 或等拍板" });
      }
    } else if (task.stage === "review" && stageSince !== null) {
      const since = Math.max(stageSince, lastOf(events, ["note", "review"], stageSince)?.ts ?? stageSince);
      if (now - since > AUDIT_THRESHOLDS.reviewNoReviewerMs) {
        emit({ rule: "review_no_reviewer", taskId: task.id, since, keyParts: [task.id, `r${task.round}`, stageSince],
          detail: `${task.id} 在 review（第 ${task.round} 轮）已 ${mins(now - since)}，没有审查员在跑，也没有新的 note / review`, suggestion: "派审查员" });
      }
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

function executorIdle(ts: readonly TaskFacts[], agents: ReadonlyMap<string, AuditAgent>, now: number, emit: Emit): void {
  for (const { task, events, stageSince } of ts) {
    if ((task.stage !== "build" && task.stage !== "fix") || stageSince === null || !task.agent) continue;
    const a = agents.get(task.agent);
    // 画面认不出（unknown）照样按会话写入时间判：15 分钟一行不写本身就是强信号，只有明确在忙才放过
    if (!a || a.turn === "busy" || a.turn === "compacting" || lastOf(events, ["deliver"], stageSince)) continue;
    const since = Math.max(stageSince, a.lastWriteAt ?? stageSince);
    if (now - since <= AUDIT_THRESHOLDS.executorIdleMs) continue;
    emit({ rule: "executor_idle", taskId: task.id, since, keyParts: [task.id, task.stage, stageSince, since],
      detail: `${task.id} 在 ${task.stage}，执行者 ${task.agent} 已空闲 ${mins(now - since)}，还没交付`, suggestion: "问执行者卡在哪（可能在等你回复）" });
  }
}

function shipStalled(ts: readonly TaskFacts[], frozen: boolean, unfrozenAt: number | null, now: number, emit: Emit): void {
  for (const { task, events, stageSince, blockedBy, unblockedAt } of ts) {
    if ((task.stage !== "merge" && task.stage !== "live") || stageSince === null) continue;
    // merge 停着是预期的：合并队列冻结，或依赖上还在等前置任务上线（T8h：code 上线才算满足）
    if (task.stage === "merge" && (frozen || (blockedBy?.length ?? 0) > 0)) continue;
    // 从最后一个障碍消失时算：进 merge 之后才解冻 / 前置才上线，停着的时间不算它的
    const cleared = task.stage === "merge" ? Math.max(unfrozenAt ?? -Infinity, unblockedAt ?? -Infinity) : -Infinity;
    const since = Math.max(stageSince, cleared, lastOf(events, ["deploy", "verify"], stageSince)?.ts ?? stageSince);
    if (now - since <= AUDIT_THRESHOLDS.shipStallMs) continue;
    const want = task.stage === "merge" ? "合并部署" : "线上验证";
    emit({ rule: "ship_stalled", taskId: task.id, since, keyParts: [task.id, task.stage, stageSince],
      detail: `${task.id} 在 ${task.stage} 已 ${mins(now - since)} 没推进`, suggestion: `补做${want}，做完推阶段` });
  }
}

function registryRules(s: AuditSnapshot, ts: readonly TaskFacts[], agents: ReadonlyMap<string, AuditAgent>, now: number, emit: Emit): void {
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
    const own = byAgent.get(a.name) ?? [];
    if (!own.length) {
      // 建出来的时间取不到（会话文件还没有）= 刚建，先不报
      if (a.startedAt == null || now - a.startedAt <= AUDIT_THRESHOLDS.orphanGraceMs) continue;
      emit({ rule: "orphan_executor", taskId: null, since: now, keyParts: [a.name],
        detail: `${a.name} 属于本项目，台账里没有它的任务`, suggestion: "补建任务或回收执行者" });
      continue;
    }
    if (a.windowAlive !== true || own.some((t) => !TERMINAL_STAGES.includes(t.task.stage))) continue;
    const last = own.reduce((x, y) => ((y.stageSince ?? 0) > (x.stageSince ?? 0) ? y : x));
    const ended = last.stageSince ?? 0;
    if (now - ended <= AUDIT_THRESHOLDS.reclaimGraceMs) continue;
    emit({ rule: "reclaim_executor", taskId: last.task.id, since: ended, keyParts: [a.name, last.task.id],
      detail: `${a.name} 的任务 ${last.task.id} 已 ${last.task.stage}，窗口还在`, suggestion: "回收执行者（kill）" });
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

/** 一个项目一轮巡检 */
export function auditLedger(s: AuditSnapshot, now: number): AuditResult {
  const findings: AuditFinding[] = [];
  const evaluated: AuditRule[] = [];
  const skipped: AuditResult["skipped"] = [];
  const kept: string[] = [];
  const keyOf = (rule: AuditRule, parts: (string | number)[]) => [s.project, rule, ...parts].join("|");
  const keep: Keep = (rule, parts) => void kept.push(keyOf(rule, parts));
  const why = (src: keyof NonNullable<AuditSnapshot["unavailable"]>) => s.unavailable?.[src] ?? "取不到";
  const skip = (reason: string, ...rs: AuditRule[]) => rs.forEach((rule) => skipped.push({ rule, reason }));
  const emit: Emit = ({ keyParts, ...f }) =>
    findings.push({ ...f, project: s.project, key: keyOf(f.rule, keyParts), notify: auditRecipient(f.rule, s.pms) });
  const ts = s.tasks.map((t) => facts(t, now));
  const agents = new Map((s.agents ?? []).map((a) => [a.name, a]));
  if (s.reviewers) {
    reviewRules(ts, s.reviewers, now, emit);
    evaluated.push("review_no_reviewer", "review_passed_idle", "deliver_not_in_review");
  } else skip(why(s.agents ? "reviewers" : "agents"), "review_no_reviewer", "review_passed_idle", "deliver_not_in_review");
  if (s.agents) {
    executorIdle(ts, agents, now, emit);
    registryRules(s, ts, agents, now, emit);
    evaluated.push("executor_idle", "task_agent_missing", "orphan_executor");
    if (s.agents.every((a) => a.windowAlive !== null)) evaluated.push("reclaim_executor");
    else skip(why("windows"), "reclaim_executor");
  } else skip(why("agents"), "executor_idle", "task_agent_missing", "orphan_executor", "reclaim_executor");
  shipStalled(ts, s.queueFrozen === true, s.unfrozenAt ?? null, now, emit);
  evaluated.push("ship_stalled");
  if (s.held && s.agents) {
    pmHeld(s, s.held, agents, now, emit, keep);
    evaluated.push("pm_held");
  } else skip(why(s.agents ? "held" : "agents"), "pm_held");
  if (s.ownerInbox) {
    ownerInbox(s.ownerInbox, now, emit);
    evaluated.push("owner_inbox_stale");
  } else skip(why("ownerInbox"), "owner_inbox_stale");
  return { findings, evaluated, skipped, keep: kept };
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
