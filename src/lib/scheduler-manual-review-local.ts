/**
 * dispatch-recovery-AUTOACK2 · the local half of the manual-review adoption (scheduler-manual-review-source.ts): a verdict a local agent
 * submitted over MCP on PM's manual review order is adoptable only when the ledger itself proves who took the order and where it was
 * reviewed — the MCP verdict on this round's order, the PM assignment it answers, the reviewer's own take of that assignment (same
 * session / family / head / spec rev, before or after the verdict), a clean checkout on the head apart from every author, and a family
 * other than the author's (or the recorded exemption). Read only. Switch: recovery key localReviewAdopt. tests/scheduler-manual-review-local*.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { TaskWorkflow } from "./ledger-scheduler.js";
import { actorMayConfigure } from "./ledger-scheduler-settle.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { manualOrderId } from "./order-take.js";
import { recoveryPolicy, type RecoveryMode } from "./recovery-policy.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import type { ReviewFacts } from "./scheduler-review.js";
import { exemptVerdict } from "./scheduler-review-swap.js";

const LOCAL_PREFIX = "本机人工结论缺可核的领单与独立检出证据：";
/** The take record review-manual-evidence.ts writes (kept here so the adoption side never imports the writer). */
export const MANUAL_TAKEN_OP = "manual_review_taken";
const MANUAL_REVIEW_ORDER = /^(.+):(review|final_review):r(\d{1,3})$/;

/** A local manual review order id → its step and round; anything else (intents, write / fix orders) is null. */
export function manualReviewOrder(orderId: string): { taskId: string; step: "review" | "final_review"; round: number } | null {
  const m = MANUAL_REVIEW_ORDER.exec(orderId);
  return m ? { taskId: m[1]!, step: m[2] as "review" | "final_review", round: Number(m[3]) } : null;
}

/** The latest assign of this step and round before `before` (the assignment the verdict answers), or null. */
const lastAssign = (events: readonly LedgerEvent[], step: string, round: number, before: number): LedgerEvent | null =>
  events.findLast((e) => e.seq < before && e.kind === "step" && e.data.op === "assign" && e.data.step === step && e.data.round === round) ?? null;
export type LocalModePort = (project: string) => RecoveryMode;
export const localModeOf: LocalModePort = (project) => recoveryPolicy(project, "localReviewAdopt").mode;

/** What the adoption records beyond the shared fields: the take and the assignment it answers. */
export interface LocalProof { orderId: string; takenSeq: number; assignSeq: number }

const obj = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;

/** Rules a–e of the spec, in order; a string names the first one that fails (always with LOCAL_PREFIX). */
export function localReviewProof(db: Database, task: LedgerTask, workflow: Pick<TaskWorkflow, "authorFamily">, f: ReviewFacts, ev: LedgerEvent,
  events: readonly LedgerEvent[]): LocalProof | string {
  const no = (why: string): string => `${LOCAL_PREFIX}${why}`;
  const orderId = typeof ev.data.orderId === "string" ? ev.data.orderId : "";
  const o = manualReviewOrder(orderId);
  if (ev.data.via !== "mcp" || ev.actor !== f.reviewer || !o || o.taskId !== task.id || orderId !== manualOrderId(task.id, o.step, task.round) ||
    ev.dedupKey !== `verdict:${orderId}@${f.head}`) {
    return no("结论不是审查员本人经 submit_verdict 交的本轮人工审查单（PM 代记、CLI 复制都不算）");
  }
  const assign = lastAssign(events, o.step, task.round, ev.seq);
  if (!assign || assign.data.executor !== f.reviewer || assign.data.executorKind !== "agent") return no(`结论前最近一次派 ${o.step} 的不是 ${f.reviewer}`);
  if (assign.actor === "scheduler" || !actorMayConfigure(db, assign.actor, task.project)) return no(`派活人 ${assign.actor} 现在没有本项目权限`);
  const takes = events.filter((e) => e.seq > assign.seq && e.kind === "scheduler" && e.data.op === MANUAL_TAKEN_OP && e.data.orderId === orderId);
  if (!takes.length) return no(`没有 ${orderId} 在这次派活之后的领单记录`);
  const taken = takes.find((e) => e.actor === f.reviewer && e.data.sessionId === f.reviewerSessionId && e.data.family === f.reviewerFamily &&
    e.data.head === f.head && e.data.specRev === task.specRev && e.data.assignSeq === assign.seq);
  if (!taken) return no("领单记录的审查员、会话、家族、head、规格版本或派活记录和结论对不上");
  const checkout = obj(ev.data.checkout);
  if (!checkout || checkout.ok !== true) return no(`检出证据不成立（${typeof checkout?.why === "string" ? checkout.why : "结论没带检出证据"}）`);
  if (checkout.head !== f.head) return no(`检出 head ${String(checkout.head)} 不是结论的 head`);
  if (f.reviewerFamily === (remoteHeadFamily(db, task) ?? workflow.authorFamily) && !exemptVerdict(db, task, f)) return no("审查员和作者同家族，没有豁免");
  return { orderId, takenSeq: taken.seq, assignSeq: assign.seq };
}
