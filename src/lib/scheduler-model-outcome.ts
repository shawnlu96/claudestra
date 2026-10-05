/**
 * Model outcomes of a dispatched order (dispatch-recovery-MODEL): capacity, host/transport, or a model safety refusal.
 * Ordinary failures may be re-dispatched formally to an already authorized family + machine once the original order is
 * proven result-less and ended; a safety refusal keeps one real refusal as evidence, holds the card for PM/owner, and
 * blocks every automatic retry or family switch (scheduler-review-swap.ts reads the hold) until a manager resolves it.
 * The mode comes from an injected recovery-policy port; no port = observe (records only, changes nothing).
 * tests/scheduler-model-outcome.test.ts.
 */
import type { Database } from "bun:sqlite";
import { isCyberPolicy } from "./agent-supervisor-policy.js";
import { isManager, mustTask, type WriteCtx } from "./ledger-checks.js";
import { getIntent, type AuthorFamily, type SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { busyAsLedgerError, getEventByDedup, LedgerError, listEvents } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import { HOLD_OP, openSafetyHold, RESOLVE_OP } from "./scheduler-review-swap.js";

type RecoveryMode = "on" | "observe" | "off";
type RecoveryKey = "materials" | "localFallback" | "localDelivery" | "modelOutcome" | "askReminder" | "manualStall" | "planGap" | "audit";
export interface RecoveryPolicy { mode: RecoveryMode; manualAfterMs: number | null }
/** CFG's `recoveryPolicy(project, mechanism)`, injected; this module never reads the config store itself. */
export type RecoveryPolicyPort = (project: string, mechanism: RecoveryKey) => RecoveryPolicy;

const MODES: readonly RecoveryMode[] = ["on", "observe", "off"];

/** Missing port → observe; a port that throws or answers garbage → off, with the reason kept for the record. */
export function modelOutcomePolicy(port: RecoveryPolicyPort | undefined, project: string): RecoveryPolicy & { diag?: string } {
  if (!port) return { mode: "observe", manualAfterMs: null, diag: "缺恢复策略 port，按 observe" };
  try {
    const p = port(project, "modelOutcome");
    const ms = p?.manualAfterMs;
    if (!p || !MODES.includes(p.mode) || !(ms === null || (Number.isFinite(ms) && ms >= 0))) {
      return { mode: "off", manualAfterMs: null, diag: "恢复策略返回值不合法，按 off" };
    }
    return { mode: p.mode, manualAfterMs: ms };
  } catch (e) {
    return { mode: "off", manualAfterMs: null, diag: `读恢复策略失败，按 off：${(e as Error).message}`.slice(0, 300) };
  }
}

export type ModelOutcomeClass = "capacity" | "host" | "safety";

/** What the worker / transport reported for the order; the message is the host's own text, never a paraphrase. */
export interface OutcomeSignal {
  failure?: { kind: "quota" | "auth" | "error"; message: string };
  /** delivered:false = the transport refused before anything left; "unknown" may have arrived. */
  send?: { delivered: false | "unknown"; reason: string };
  offline?: boolean;
}

/** Claude's usage-policy refusal, an API stop_reason refusal, or Codex's cyber-policy cut (agent-supervisor-policy.ts). */
const CLAUDE_REFUSAL_RE = /violates? (?:our|the|Anthropic's) Usage Polic|stop_reason["']?\s*[:=]\s*["']?refusal\b/i;
const CAPACITY_RE = /\boverloaded|rate[ _-]?limit|\b429\b|\b529\b|capacity|usage limit/i;

const isSafetyRefusal = (message: string): boolean => isCyberPolicy(message) || CLAUDE_REFUSAL_RE.test(message);

/**
 * Safety is checked first: a refusal worded next to "rate limit" is still a refusal. auth needs the owner's login and an
 * unknown send may have arrived, so neither is auto-recoverable; null = nothing to classify.
 */
export function classifyModelOutcome(s: OutcomeSignal): { cls: ModelOutcomeClass; recoverable: boolean; message: string } | null {
  const f = s.failure;
  if (f) {
    if (isSafetyRefusal(f.message)) return { cls: "safety", recoverable: false, message: f.message };
    if (f.kind === "quota" || CAPACITY_RE.test(f.message)) return { cls: "capacity", recoverable: true, message: f.message };
    return { cls: "host", recoverable: f.kind !== "auth", message: f.message };
  }
  if (s.send) return { cls: "host", recoverable: s.send.delivered === false, message: s.send.reason };
  return s.offline ? { cls: "host", recoverable: true, message: "worker 不在线" } : null;
}

interface Placement { family: AuthorFamily; machine: string }

export interface RecoveryFacts {
  role: "author" | "reviewer";
  authorFamily: AuthorFamily;
  failed: Placement;
  /** Already authorized placements, in preference order; recovery never adds one. */
  authorized: readonly Placement[];
  /** The original order has no deliver / review on the ledger for its round. */
  noResult: boolean;
  /** The original turn is over (failed, refused before send, or the intent cancelled). */
  ended: boolean;
}

export type RecoveryPlan =
  | { kind: "redispatch"; to: Placement; reason: string }
  | { kind: "manual"; code: "model_safety_hold" | "model_recovery_manual"; reason: string };

/**
 * Pure: the one next step for a classified outcome. An author keeps its family (a new family would silently move the
 * review's independence); a reviewer must differ from the author family — a second Claude after a Claude author is not
 * cross-model. The failed placement itself is skipped, since its host or account just failed.
 */
export function planModelRecovery(cls: ModelOutcomeClass, recoverable: boolean, f: RecoveryFacts): RecoveryPlan {
  if (cls === "safety") return { kind: "manual", code: "model_safety_hold", reason: "模型安全策略拒绝：停止自动重试和换模型，交 PM / owner 人工处置" };
  if (!recoverable) return { kind: "manual", code: "model_recovery_manual", reason: "这类故障不能自动恢复（需登录或投递结果不明）" };
  if (!f.noResult || !f.ended) return { kind: "manual", code: "model_recovery_manual", reason: "原单未确认无结果且已终止，不能重派" };
  const fits = (p: Placement) => (f.role === "author" ? p.family === f.authorFamily : p.family !== f.authorFamily) &&
    !(p.family === f.failed.family && p.machine === f.failed.machine);
  const to = f.authorized.find(fits);
  if (!to) return { kind: "manual", code: "model_recovery_manual", reason: "已授权的家族 / 机器里没有符合跨模型要求的去处" };
  return { kind: "redispatch", to, reason: `${cls === "capacity" ? "容量不足" : "宿主或运输故障"}，按已授权配置重派到 ${to.machine}（${to.family}）` };
}

/** Read + appendEvent in one immediate transaction; events go only through appendEvent, never the raw ledger-tx writer. */
const atomic = <T>(db: Database, fn: () => T): T => busyAsLedgerError("写入", () => db.transaction(fn).immediate());

const outcomeKey = (intentId: string, mode: RecoveryMode) => `model-outcome:${intentId}:${mode}`;

/** Any deliver / review written for the order's round after it was planned counts as a result. */
function orderHasResult(db: Database, task: LedgerTask, intent: SchedulerIntent): boolean {
  const kind = intent.action === "review" ? "review" : "deliver";
  return listEvents(db, { project: task.project, target: task.id }).some((e) => e.kind === kind && e.seq > intent.eventSeq);
}

export interface OutcomeInput {
  intentId: string;
  signal: OutcomeSignal;
  failed: Placement & { agent: string };
  authorized: readonly Placement[];
  /** The caller saw the turn end (failed result / refused send / offline); a cancelled intent also counts. */
  ended: boolean;
}

export type OutcomeRecord =
  | { kind: "off"; diag?: string }
  | { kind: "none"; reason: string }
  | { kind: "recorded"; mode: "on" | "observe"; cls: ModelOutcomeClass; plan: RecoveryPlan; event: LedgerEvent; duplicate: boolean; materials: string };

/**
 * Check + write in one immediate transaction, keyed per intent and mode, so a restarted or concurrent tick replays the
 * first record instead of adding a second. observe writes a note of what on would do; on writes the escalate (hold or
 * manual) or the recovery decision the formal planner re-dispatches from. A task already held gets no new evidence.
 */
export function recordModelOutcome(db: Database, ctx: WriteCtx, input: OutcomeInput, port?: RecoveryPolicyPort): OutcomeRecord {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "模型结果只由调度服务记录");
  const pre = getIntent(db, input.intentId);
  if (!pre) throw new LedgerError("not_found", "缺原调度意图");
  const policy = modelOutcomePolicy(port, pre.project);
  if (policy.mode === "off") return { kind: "off", ...(policy.diag ? { diag: policy.diag } : {}) };
  const mode = policy.mode;
  const c = classifyModelOutcome(input.signal);
  if (!c) return { kind: "none", reason: "没有可分类的失败" };
  return atomic(db, () => {
    const intent = getIntent(db, input.intentId)!, task = mustTask(db, intent.taskId), key = outcomeKey(intent.id, mode);
    const prev = getEventByDedup(db, key);
    if (prev) return recorded(mode, c.cls, prev.data.plan as RecoveryPlan, prev, true);
    if (intent.action !== "dispatch" && intent.action !== "review") throw new LedgerError("invalid", "只处理派单 / 派审意图的模型结果");
    const events = listEvents(db, { project: task.project, target: task.id });
    const held = mode === "on" ? openSafetyHold(events) : null;
    if (held) return { kind: "none", reason: `本卡已有未处置的安全拒绝留证（#${held.seq}），不再追加、不自动重试` };
    if (orderHasResult(db, task, intent)) return { kind: "none", reason: "原单已有交付 / 审查结果，不算失败" };
    const authorFamily = (db.query("SELECT authorFamily FROM task_workflows WHERE taskId = ?").get(task.id) as { authorFamily: AuthorFamily } | null)
      ?.authorFamily ?? input.failed.family;
    const plan = planModelRecovery(c.cls, c.recoverable, { role: intent.action === "review" ? "reviewer" : "author", authorFamily,
      failed: input.failed, authorized: input.authorized, noResult: true, ended: input.ended || intent.status === "cancelled" });
    const data = { op: mode === "on" && c.cls === "safety" ? HOLD_OP : "model_outcome", mode, cls: c.cls, intentId: intent.id,
      action: intent.action, agent: input.failed.agent, family: input.failed.family, machine: input.failed.machine,
      round: task.round, head: task.headSHA, specRev: task.specRev, noResult: true, noReport: true, verdict: null,
      evidence: c.message.slice(0, 600), plan, ...(policy.diag ? { diag: policy.diag } : {}) };
    const kind = mode === "observe" ? "note" : plan.kind === "manual" ? "escalate" : "note";
    const text = `${mode === "observe" ? "[观察] " : ""}${CLASS_LABEL[c.cls]}：${plan.reason}`;
    const { event } = appendEvent(db, { ...ctx, dedupKey: key }, { project: task.project, target: task.id, kind, text, data });
    return recorded(mode, c.cls, plan, event, false);
  });
}

const CLASS_LABEL: Record<ModelOutcomeClass, string> = { capacity: "容量不足", host: "宿主或运输故障", safety: "模型安全策略拒绝" };

function recorded(mode: "on" | "observe", cls: ModelOutcomeClass, plan: RecoveryPlan, event: LedgerEvent, duplicate: boolean): OutcomeRecord {
  return { kind: "recorded", mode, cls, plan, event, duplicate, materials: outcomeMaterials(event) };
}

/** What PM / owner needs to decide the next step: the facts on the record, not a verdict and not a retry. */
function outcomeMaterials(e: LedgerEvent): string {
  const d = e.data, plan = d.plan as RecoveryPlan;
  return [`${e.target} ${CLASS_LABEL[d.cls as ModelOutcomeClass]}（${d.mode}）：${d.agent} / ${d.family} @ ${d.machine}，意图 ${d.intentId}`,
    `第 ${d.round} 轮，head ${String(d.head ?? "（无）").slice(0, 12)}；原单无交付 / 无审查报告，没有结论（不是 pass）`,
    `原文：${String(d.evidence)}`,
    plan.kind === "redispatch" ? `下一步：${plan.reason}` : `下一步：人工处置——${plan.reason}${d.op === HOLD_OP ? "；处置后用 resolve 解除" : ""}`,
  ].join("\n");
}

/** Only the project's manager / owner lifts a hold; the resolution is its own decision event, the evidence stays. */
export function resolveSafetyHold(db: Database, ctx: WriteCtx, input: { taskId: string; text: string }): { event: LedgerEvent; duplicate: boolean } {
  return atomic(db, () => {
    const task = mustTask(db, input.taskId);
    if (ctx.actor !== "owner" && !isManager(db, ctx.actor, task)) throw new LedgerError("forbidden", "安全拒绝的处置只由 PM / owner 决定");
    const hold = openSafetyHold(listEvents(db, { project: task.project, target: task.id }));
    if (!hold) throw new LedgerError("conflict", "本卡没有未处置的安全拒绝");
    const text = input.text.trim();
    if (!text || text.length > 600) throw new LedgerError("invalid", "处置说明为空或太长");
    return appendEvent(db, { ...ctx, dedupKey: `model-outcome:resolve:${hold.seq}` },
      { project: task.project, target: task.id, kind: "decision", text, data: { op: RESOLVE_OP, holdSeq: hold.seq } });
  });
}
