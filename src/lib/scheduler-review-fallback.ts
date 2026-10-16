/**
 * RVF-1 · when the cross-family reviewer's family cannot run (quota, a review turn that failed on capacity / transport, the
 * reviewer's create failing), the round falls back to an adversarial reviewer of the author's family instead of going to PM.
 * The fallback is a reviewer_swap event with a `fallback` field — the same epoch shape as MODELX's refusal epoch
 * (scheduler-review-swap.ts reads both), so planner, bind, verdict gate and both merge gates need no rule of their own.
 * One per head / spec / round window and never next to a refusal epoch: a later round tries the cross family again (the
 * ordinary family swap). Pure reads only; the write is scheduler-recovery-write.ts writeReviewFallback under `reviewFallback`.
 * docs/architecture/scheduler-review-fallback.md; tests/scheduler-review-fallback*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { getIntent, getWorkflow, type AuthorFamily, type SchedulerIntent, type TaskWorkflow } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { getTask, listEvents } from "./ledger-store.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";

/** planModelRecovery's reason when no authorized placement differs from the author family (the old way to PM). */
export const NO_CROSS_PLACE = "已授权的家族 / 机器里没有符合跨模型要求的去处";
export const FALLBACK_EXEMPTION = "跨模型审查豁免:跨族审查员不可用，本轮降级同族对抗审查";
/** What a handoff to the repository owner says about a fallback verdict (scheduler-merge-handoff.ts evidence). */
export const HANDOFF_NOTE = "本机跨族审查降级，跨族交仓库方队列";
/** Clean (residue-free) reviewer create failures in a row before a failure that is not quota falls back. */
export const CREATE_FAIL_LIMIT = 3;

type Placement = { family: AuthorFamily; machine: string };
export type FallbackTrigger = "review_capacity" | "review_host" | "create_quota" | "create_streak";
const TRIGGER_LABEL: Record<FallbackTrigger, string> = { review_capacity: "审查回合撞额度", review_host: "审查回合宿主 / 投递故障",
  create_quota: "建审查会话撞额度", create_streak: `建审查会话连续 ${CREATE_FAIL_LIMIT} 次失败` };
const FALLBACK_TRIGGERS: readonly string[] = Object.keys(TRIGGER_LABEL);

export interface FallbackMark {
  trigger: FallbackTrigger;
  /** The host's / create's own text, cut to 600 characters, never a paraphrase. */
  reason: string;
  failedAgent: string;
  exemption: string;
  crossModel: false;
  placement: Placement;
}

export const fallbackKey = (intentId: string): string => `review-fallback:${intentId}`;

export function fallbackOf(e: LedgerEvent | null | undefined): FallbackMark | null {
  const f = e?.kind === "scheduler" && e.data.op === "reviewer_swap" ? e.data.fallback : null;
  return f && typeof f === "object" && !Array.isArray(f) ? f as FallbackMark : null;
}

/** A fallback that retired no binding (the cross-family reviewer never got bound, e.g. its create failed). */
export const freshFallback = (e: LedgerEvent | null | undefined): boolean => !!fallbackOf(e) && !e!.data.sessionId;

type Window = Pick<LedgerTask, "headSHA" | "specRev" | "round">;
const inWindow = (e: LedgerEvent, t: Window): boolean => e.data.head === t.headSHA && e.data.specRev === t.specRev && e.data.round === t.round;
const isEpoch = (e: LedgerEvent): boolean => e.kind === "scheduler" && e.data.op === "reviewer_swap" && (!!e.data.refusal || !!e.data.fallback);

/** Seq of the card's newest fallback epoch (0 = none): a reviewer's create-failure streak restarts there. */
export function lastFallbackSeq(db: Database, taskId: string): number {
  const task = getTask(db, taskId);
  return task ? listEvents(db, { project: task.project, target: task.id }).findLast((e) => !!fallbackOf(e))?.seq ?? 0 : 0;
}

/** The session the fallback epoch bound: a reviewer bind after it, marked with its seq, of its target family. */
export const fallbackBound = (events: readonly LedgerEvent[], epoch: LedgerEvent, sessionId: string, family: AuthorFamily): boolean =>
  epoch.data.toFamily === family && events.some((e) => e.seq > epoch.seq && e.kind === "scheduler" && e.data.op === "session_bind" &&
    e.data.role === "reviewer" && e.data.sessionId === sessionId && e.data.family === family && e.data.fallbackEpoch === epoch.seq);

export const fallbackBindMarks = (epoch: LedgerEvent): Record<string, unknown> =>
  ({ fallbackEpoch: epoch.seq, crossModel: false, exemption: fallbackOf(epoch)!.exemption });

/** The fresh fallback a reviewer ensure_session (planned after it, in its window) binds under; null = not such a bind. */
export function freshFallbackEpoch(db: Database, intentId: string): LedgerEvent | null {
  const intent = getIntent(db, intentId), task = intent && getTask(db, intent.taskId);
  if (!intent || !task || intent.action !== "ensure_session" || intent.node !== "adversarial_review") return null;
  const swap = listEvents(db, { project: task.project, target: task.id }).findLast((e) => e.kind === "scheduler" && e.data.op === "reviewer_swap");
  return swap && freshFallback(swap) && inWindow(swap, task) && intent.eventSeq > swap.seq ? swap : null;
}

/** Why a fallback epoch still in flight may no longer run (refusalEpochLapse's answer for it), or null. No approval to lapse. */
export function fallbackLapse(db: Database, task: LedgerTask, epoch: LedgerEvent, families?: readonly AuthorFamily[]): string | null {
  const workflow = getWorkflow(db, task.id);
  if (workflow?.mode !== "auto" || workflow.specRev !== task.specRev || task.stage !== "review") return "卡已不在本轮自动审查";
  const to = epoch.data.toFamily as AuthorFamily;
  return families && !families.includes(to) ? `降级审查家族 ${to} 已不在本机授权配置内` : null;
}

/** The reviewer binding row as scheduler-sessions.ts keeps it (passed in: this module sits below the session writer). */
interface Row { agent: string; sessionId: string; family: AuthorFamily; transport: string; state: string }

export interface FallbackInput {
  intent: SchedulerIntent;
  failed: Placement & { agent: string };
  authorized: readonly Placement[];
  /** The failure's text: a review turn's host message, or a create's cancelled receipt. */
  message: string;
  /** classifyModelOutcome's answer for the message (null = nothing to classify). */
  cls: "capacity" | "host" | "safety" | null;
  recoverable: boolean;
  /** Review turn: the failed turn's session. */
  sessionId?: string;
  /** Create: the receipt is a clean create failure, and how many of those in a row since the last fallback. */
  cleanCreate?: boolean;
  createStreak?: number;
  row: Row | null;
}

export interface FallbackFacts { task: LedgerTask; workflow: TaskWorkflow; trigger: FallbackTrigger; to: Placement; authorFamily: AuthorFamily; row: Row | null }

/** Which trigger fires for this failed order, or why none: review turns per MODEL's class, creates per quota / streak. */
function trigger(i: FallbackInput, authorFamily: AuthorFamily): FallbackTrigger | string {
  const failedHere = (p: Placement) => p.family === i.failed.family && p.machine === i.failed.machine;
  if (i.intent.action === "review") {
    if ((i.cls !== "capacity" && i.cls !== "host") || !i.recoverable) return "不是可恢复的额度 / 宿主故障";
    if (i.authorized.some((p) => p.family !== authorFamily && !failedHere(p))) return "还有别的跨族去处，走 MODEL 重派";
    const r = i.row;
    if (!r || r.state !== "active" || r.agent !== i.failed.agent || r.sessionId !== i.sessionId || r.family !== i.failed.family || r.transport === "peer") {
      return "失败的审查员已不是本卡当前本机绑定";
    }
    return i.cls === "capacity" ? "review_capacity" : "review_host";
  }
  if (i.intent.action !== "ensure_session" || i.intent.status !== "cancelled" || !i.cleanCreate) return "不是干净失败的建审查会话";
  if (i.row?.state === "active") return "本卡已有在用的审查员";
  if (i.cls === "capacity") return "create_quota";
  return (i.createStreak ?? 0) >= CREATE_FAIL_LIMIT ? "create_streak" : `建会话失败未满 ${CREATE_FAIL_LIMIT} 次且不是额度类`;
}

/** Every precondition of a fallback for this failed review order, read now; a string says why not. */
export function fallbackFacts(db: Database, i: FallbackInput): FallbackFacts | string {
  if (i.intent.node !== "adversarial_review") return "不是对抗审查的单";
  const task = getTask(db, i.intent.taskId), workflow = task && getWorkflow(db, task.id);
  if (!task || !workflow || workflow.mode !== "auto" || workflow.specRev !== task.specRev || task.stage !== "review") return "卡不在当前规格的自动审查";
  if (i.intent.specRev !== task.specRev || i.intent.head !== task.headSHA) return "单的 head / specRev 已不是当前";
  const authorFamily = remoteHeadFamily(db, task) ?? workflow.authorFamily;
  if (i.failed.family === authorFamily) return "失败的不是跨族审查员";
  const t = trigger(i, authorFamily);
  if (!FALLBACK_TRIGGERS.includes(t)) return t;
  const events = listEvents(db, { project: task.project, target: task.id });
  if (events.some((e) => e.seq > i.intent.eventSeq && e.kind === "review")) return "单已有审查结论";
  if (events.some((e) => isEpoch(e) && inWindow(e, task))) return "本轮已降级或豁免过，同一轮不再切换";
  const to = i.authorized.find((p) => p.family === authorFamily && p.machine === "local");
  if (!to) return `本机授权配置里没有作者家族 ${authorFamily}`;
  return { task, workflow, trigger: t as FallbackTrigger, to: { family: to.family, machine: to.machine }, authorFamily, row: i.row };
}

/** What the would-be fallback says (the observe sample's action and the epoch's text). */
export const fallbackAction = (f: FallbackFacts, i: FallbackInput): string =>
  `${FALLBACK_EXEMPTION}：${i.failed.agent}（${i.failed.family}）${TRIGGER_LABEL[f.trigger]}，第 ${f.task.round} 轮改派 ${f.to.family} 独立对抗审查，` +
  `与作者同家族，不算跨模型；下一轮先回跨族`;

/** The epoch event's text and data (op reviewer_swap; intentId = the failed order, retired binding named when there was one). */
export function fallbackEpochEvent(f: FallbackFacts, i: FallbackInput): { text: string; data: Record<string, unknown> } {
  const mark: FallbackMark = { trigger: f.trigger, reason: i.message.replace(/\s+/g, " ").trim().slice(0, 600), failedAgent: i.failed.agent,
    exemption: FALLBACK_EXEMPTION, crossModel: false, placement: f.to };
  return { text: fallbackAction(f, i).slice(0, 1000), data: { op: "reviewer_swap", intentId: i.intent.id, fromFamily: i.failed.family, toFamily: f.to.family,
    agent: f.row?.state === "active" ? f.row.agent : null, sessionId: f.row?.state === "active" ? f.row.sessionId : null,
    round: f.task.round, head: f.task.headSHA, specRev: f.task.specRev, fallback: mark } };
}

/** The verdict facts the handoff evidence carries (ReviewFacts' slice; structural, this module sits below scheduler-review.ts). */
interface VerdictFacts { eventSeq: number; round: number; head: string; reviewerSessionId: string; reviewerFamily: AuthorFamily }

/**
 * A handoff's note on its verdict when the round's fallback epoch bound that verdict's session (the same reading as exemptFacts),
 * so the repository owner's queue knows the cross-family review is still theirs; null for any other verdict.
 */
export function fallbackHandoff(events: readonly LedgerEvent[], task: Window, f: VerdictFacts): Record<string, unknown> | null {
  const swap = events.findLast((e) => e.kind === "scheduler" && e.data.op === "reviewer_swap"), mark = fallbackOf(swap);
  if (!swap || !mark || !inWindow(swap, { ...task, headSHA: f.head }) || f.eventSeq <= swap.seq || f.round !== swap.data.round ||
    !fallbackBound(events, swap, f.reviewerSessionId, f.reviewerFamily)) return null;
  return { epochSeq: swap.seq, trigger: mark.trigger, reason: mark.reason, crossModel: false, note: HANDOFF_NOTE };
}
