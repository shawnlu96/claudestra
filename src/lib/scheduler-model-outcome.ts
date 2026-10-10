/**
 * Model outcomes of a dispatched order (dispatch-recovery-MODEL): capacity, host/transport, or a model safety refusal.
 * Ordinary failures may be re-dispatched formally to an already authorized family + machine once the original order is
 * proven result-less and ended; a safety refusal keeps one real refusal as evidence, holds the card for PM/owner, and
 * blocks every automatic retry or family switch (scheduler-review-swap.ts reads the hold) until a manager resolves it.
 * The one exception is owner approval ask_muumcchk8d0596d05d: an allowed, routine read-only code review refused with no
 * report retries once on the same model in a new session with unchanged materials; a second refusal goes once to another
 * family under a recorded exemption; anything after that, or anything not approved / allowed, stays a manual hold.
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
import { remoteHeadFamily } from "./scheduler-head-family.js";
import { EXEMPT_OP, HOLD_OP, legacyReplacesPlan, openSafetyHold, RESOLVE_OP, RETRY_OP } from "./scheduler-review-swap.js";

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
  /** Only for a reviewer's safety refusal: the approved-continuation facts; absent = manual hold. */
  refusal?: RefusalFacts;
}

/** The owner's approval as the injected port answers it for one card; content must be positively allowed, never assumed. */
export interface RefusalApproval {
  approvalId: string;
  source: string;
  scope: "routine_readonly_review";
  content: "allowed" | "disallowed" | "uncertain";
  revoked: boolean;
  ownerHold: boolean;
}
/** Answers null when the card is outside any approval; this module never decides content eligibility itself. */
export type RefusalApprovalPort = (project: string, taskId: string) => RefusalApproval | null;

/** An earlier reviewer refusal in the same window (same head + spec), as recorded on the ledger. */
interface PriorRefusal { step: "retry_same" | "exempt_review" | "manual"; family: AuthorFamily; digest: string | null; session: string | null; seq: number }

interface RefusalFacts {
  approval: RefusalApproval | null;
  /** Why the approval port could not be read (thrown / garbage); any diag is treated as no approval. */
  approvalDiag?: string;
  /** Reviewer refusals already recorded in this window, oldest first. */
  prior: readonly PriorRefusal[];
  materialDigest: string | null;
  sessionId: string | null;
  /** This review ticket was planned after the last continuation record (a formal new ticket, not the old one replayed). */
  newTicket: boolean;
}

export const EXEMPTION_TEXT = "跨模型审查豁免:原审查模型策略拒审";

export type RecoveryPlan =
  | { kind: "redispatch"; to: Placement; reason: string }
  | { kind: "retry_same"; to: Placement; attempt: 1; newSession: true; approvalId: string; reason: string }
  | { kind: "exempt_review"; to: Placement; attempt: 2; exemption: typeof EXEMPTION_TEXT; crossModel: boolean; approvalId: string; notifyOwner: true; reason: string }
  | { kind: "manual"; code: "model_safety_hold" | "model_recovery_manual"; reason: string };

const safetyHold = (why: string): RecoveryPlan => ({ kind: "manual", code: "model_safety_hold", reason: `模型安全策略拒绝：${why}；停止自动重试和换模型，交 PM / owner 人工处置` });

/** The port's answer is checked field by field: a safety flag must be an explicit false, never a missing one read as false. */
function approvalGap(a: RefusalApproval | null, diag?: string): string | null {
  if (diag) return `批准读取失败（${diag}）`;
  if (!a || typeof a !== "object" || typeof a.approvalId !== "string" || !a.approvalId || typeof a.source !== "string" || !a.source ||
    a.scope !== "routine_readonly_review") return "不在 owner 已批准的常规只读审查范围";
  if (a.revoked !== false) return a.revoked === true ? "批准已撤销" : "批准缺撤销状态，按不可用";
  if (a.ownerHold !== false) return a.ownerHold === true ? "owner 已挂起" : "批准缺 owner 挂起状态，按不可用";
  if (a.content !== "allowed") return a.content === "uncertain" ? "内容是否允许尚未确定" : a.content === "disallowed" ? "内容不允许" : "内容许可状态不合法，按不允许";
  return null;
}

/**
 * Pure, the approved bounded continuation for a reviewer refusal. First refusal → same placement, new session, one retry;
 * second refusal of that same model on the same materials in a new session → once to another family under the recorded
 * exemption; everything else (third refusal, changed materials, same session, not approved / allowed) → manual hold.
 */
function planRefusal(f: RecoveryFacts): RecoveryPlan {
  const r = f.refusal;
  if (f.role !== "reviewer" || !r) return safetyHold("不在已批准的审查接续范围");
  const gap = approvalGap(r.approval, r.approvalDiag);
  if (gap) return safetyHold(gap);
  if (!f.noResult || !f.ended) return safetyHold("原审查回合未确认无结果且已终止");
  if (!r.materialDigest || !r.sessionId) return safetyHold("缺材料摘要或会话，无法证明原样接续");
  const approvalId = r.approval!.approvalId, last = r.prior.at(-1);
  const authorized = (p: Placement) => f.authorized.some((a) => a.family === p.family && a.machine === p.machine);
  if (!last) {
    if (!authorized(f.failed)) return safetyHold("原审查位置不在已授权配置内");
    return { kind: "retry_same", to: f.failed, attempt: 1, newSession: true, approvalId,
      reason: `审查被误拒且无报告：按 owner 批准 ${approvalId}，同一模型新会话、原材料不改，正式新票据只重试一次` };
  }
  if (last.step !== "retry_same" || r.prior.length !== 1) return safetyHold(last.step === "exempt_review" ? "豁免审查后再次拒绝，不再换提供方" : "本窗口已按人工处置");
  if (last.family !== f.failed.family) return safetyHold("第二次拒绝不是同一模型的重试");
  if (last.digest !== r.materialDigest) return safetyHold("重试材料与原审查材料摘要不一致");
  if (last.session === r.sessionId || !r.newTicket) return safetyHold("重试未在新会话 / 新审查票据上进行");
  const to = f.authorized.find((p) => p.family !== f.failed.family);
  if (!to) return safetyHold("已授权配置里没有另一家族可做豁免审查");
  return { kind: "exempt_review", to, attempt: 2, exemption: EXEMPTION_TEXT, crossModel: to.family !== f.authorFamily, approvalId, notifyOwner: true,
    reason: `同一模型新会话再次误拒：${EXEMPTION_TEXT}（批准 ${approvalId}），由 ${to.machine}（${to.family}）独立审查一次${to.family === f.authorFamily ? "，与作者同家族，不算跨模型" : ""}，通知 owner` };
}

/**
 * Pure: the one next step for a classified outcome. An author keeps its family (a new family would silently move the
 * review's independence); a reviewer must differ from the author family — a second Claude after a Claude author is not
 * cross-model. The failed placement itself is skipped, since its host or account just failed.
 */
export function planModelRecovery(cls: ModelOutcomeClass, recoverable: boolean, f: RecoveryFacts): RecoveryPlan {
  if (cls === "safety") return planRefusal(f);
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

/** A refusal has its own key: an earlier ordinary record of the same intent must not swallow the first real refusal. */
const outcomeKey = (intentId: string, mode: RecoveryMode, cls: ModelOutcomeClass) => `model-outcome:${intentId}:${mode}${cls === "safety" ? ":safety" : ""}`;

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
  /** A review turn's session and the digest of its complete materials; required for the approved refusal continuation. */
  review?: { sessionId: string; materialDigest: string };
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
export function recordModelOutcome(db: Database, ctx: WriteCtx, input: OutcomeInput, port?: RecoveryPolicyPort, approvalPort?: RefusalApprovalPort): OutcomeRecord {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "模型结果只由调度服务记录");
  const pre = getIntent(db, input.intentId);
  if (!pre) throw new LedgerError("not_found", "缺原调度意图");
  const policy = modelOutcomePolicy(port, pre.project);
  if (policy.mode === "off") return { kind: "off", ...(policy.diag ? { diag: policy.diag } : {}) };
  const mode = policy.mode;
  const c = classifyModelOutcome(input.signal);
  if (!c) return { kind: "none", reason: "没有可分类的失败" };
  return atomic(db, () => {
    const intent = getIntent(db, input.intentId)!, task = mustTask(db, intent.taskId), key = outcomeKey(intent.id, mode, c.cls);
    // The intent's refusal outranks everything; an ordinary record replays only for another ordinary failure.
    const prev = getEventByDedup(db, outcomeKey(intent.id, mode, "safety")) ?? (c.cls === "safety" ? null : getEventByDedup(db, key));
    if (prev) return recorded(mode, prev.data.cls as ModelOutcomeClass, prev.data.plan as RecoveryPlan, prev, true);
    if (intent.action !== "dispatch" && intent.action !== "review") throw new LedgerError("invalid", "只处理派单 / 派审意图的模型结果");
    const events = listEvents(db, { project: task.project, target: task.id });
    const held = mode === "on" ? openSafetyHold(events) : null;
    if (held) return { kind: "none", reason: `本卡已有未处置的安全拒绝留证（#${held.seq}），不再追加、不自动重试` };
    if (orderHasResult(db, task, intent)) return { kind: "none", reason: "原单已有交付 / 审查结果，不算失败" };
    // A reviewer must differ from whoever actually wrote the head (a lender's family first, as the swap / bind / snapshot read it);
    // an author recovery keeps the workflow's own family.
    const role = intent.action === "review" ? "reviewer" : "author";
    const authorFamily = (role === "reviewer" ? remoteHeadFamily(db, task) : null) ?? (db.query("SELECT authorFamily FROM task_workflows WHERE taskId = ?")
      .get(task.id) as { authorFamily: AuthorFamily } | null)?.authorFamily ?? input.failed.family;
    // A different head or spec is a new window: the attempt count restarts there, never across it. The window is the
    // ticket's own (immutable head / spec at planning), so a late refusal of an obsolete ticket never lands in the current one.
    const window = `${intent.specRev}:${intent.head ?? ""}`;
    const stale = c.cls === "safety" && role === "reviewer" && (intent.specRev !== task.specRev || (intent.head ?? "") !== (task.headSHA ?? ""));
    const refusal = c.cls === "safety" && role === "reviewer" ? refusalFacts(events, mode, window, intent, input, approvalPort, task) : undefined;
    const plan: RecoveryPlan = stale ? { kind: "manual", code: "model_recovery_manual",
      reason: "过期审查票据（head / spec 已变）的迟到拒绝：只在原窗口留证，不接续、不占当前窗口；当前 head 由正式新审查票据处理" }
      : planModelRecovery(c.cls, c.recoverable, { role, authorFamily,
        failed: input.failed, authorized: input.authorized, noResult: true, ended: input.ended || intent.status === "cancelled", ...(refusal ? { refusal } : {}) });
    const a = refusal?.approval;
    const op = mode === "observe" ? "model_outcome" : stale ? STALE_OP : OUTCOME_OP[plan.kind] ?? (c.cls === "safety" ? HOLD_OP : "model_outcome");
    const data = { op, mode, cls: c.cls, stale,
      intentId: intent.id, action: intent.action, role, window, agent: input.failed.agent, family: input.failed.family, machine: input.failed.machine,
      round: task.round, head: intent.head, specRev: intent.specRev, currentHead: task.headSHA, currentSpecRev: task.specRev, noResult: true, noReport: true, verdict: null,
      evidence: c.message.slice(0, 600), plan, ...(policy.diag ? { diag: policy.diag } : {}),
      ...(refusal ? { session: refusal.sessionId, materialDigest: refusal.materialDigest, approvalId: a?.approvalId ?? null, approvalSource: a?.source ?? null,
        oldSession: refusal.prior.at(-1)?.session ?? null, attempt: refusal.prior.length + 1, ...(refusal.approvalDiag ? { approvalDiag: refusal.approvalDiag } : {}) } : {}) };
    const kind = mode === "observe" || stale || plan.kind === "redispatch" || plan.kind === "retry_same" ? "note" : "escalate";
    const text = `${mode === "observe" ? "[观察] " : ""}${CLASS_LABEL[c.cls]}：${plan.reason}`;
    const { event } = appendEvent(db, { ...ctx, dedupKey: key }, { project: task.project, target: task.id, kind, text, data });
    return recorded(mode, c.cls, plan, event, false);
  });
}

/** on-mode op per plan; a manual safety plan falls through to the hold. The exemption escalates so PM / owner are told. */
const OUTCOME_OP: Partial<Record<RecoveryPlan["kind"], string>> = { retry_same: RETRY_OP, exempt_review: EXEMPT_OP };
/** Evidence of an obsolete ticket's refusal: kept, but neither a hold nor a continuation (openRefusal ignores it). */
const STALE_OP = "model_refusal_stale";

/** Reads the window's earlier reviewer refusals of this mode and the approval port; a broken port counts as no approval. */
function refusalFacts(events: readonly LedgerEvent[], mode: RecoveryMode, window: string, intent: SchedulerIntent, input: OutcomeInput,
  port: RefusalApprovalPort | undefined, task: LedgerTask): RefusalFacts {
  const prior = events.filter((e) => e.data.cls === "safety" && e.data.mode === mode && e.data.role === "reviewer" &&
    e.data.window === window && !e.data.stale && !legacyReplacesPlan(events, e))
    .map((e): PriorRefusal => {
      const k = (e.data.plan as RecoveryPlan).kind;
      return { step: k === "retry_same" || k === "exempt_review" ? k : "manual", family: e.data.family as AuthorFamily,
        digest: (e.data.materialDigest as string | null) ?? null, session: (e.data.session as string | null) ?? null, seq: e.seq };
    });
  let approval: RefusalApproval | null = null, approvalDiag: string | undefined;
  if (!port) approvalDiag = "缺批准 port";
  else {
    try { approval = port(task.project, task.id); } catch (e) { approvalDiag = `读批准失败：${(e as Error).message}`.slice(0, 300); }
  }
  const last = prior.at(-1);
  return { approval, ...(approvalDiag ? { approvalDiag } : {}), prior, materialDigest: input.review?.materialDigest || null,
    sessionId: input.review?.sessionId || null, newTicket: !last || intent.eventSeq > last.seq };
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
    ...(d.role === "reviewer" && d.cls === "safety" ? [`第 ${d.attempt} 次拒审；材料摘要 ${d.materialDigest ?? "（缺）"}；` +
      `本次会话 ${d.session ?? "（缺）"}，上次会话 ${d.oldSession ?? "（无）"}；批准 ${d.approvalId ?? "（无）"}${d.approvalSource ? ` / ${d.approvalSource}` : ""}`] : []),
    plan.kind === "manual" ? `下一步：人工处置——${plan.reason}${d.op === HOLD_OP ? "；处置后用 resolve 解除" : ""}` : `下一步：${plan.reason}`,
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
