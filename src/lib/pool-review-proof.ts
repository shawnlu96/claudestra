/**
 * dispatch-recovery-POOLRV1: when a verdict that reached the merge gate came from the lend pool, it counts only as the engine's
 * own pool round, proven from the ledger's tickets: the scheduler's review intent and its pool link, the lend order (step review,
 * status done, this card's specRev / round / head), the peer's claim note (take_review: worker + lease generation), and the
 * signed receipt writeLendResult left on the order (submit_verdict: the review event's seq, dedup key and body digest). The
 * reviewer, session and family on the verdict must be the ones that order recorded, and the family must differ from the head's
 * actual author family. There is no same-family exemption here: MODEL's exemption plan has no MODELX execution record to read
 * (scheduler-model-wiring.ts), so a same-family pool verdict is refused like any other.
 * A CLI-recorded review, an order nobody offered (no_order), or a `peer:` reviewer the pool never answered is not a pool
 * receipt; it stays with the manual queue, and nothing here writes, re-reviews or backfills a ticket. Read-only: callers run it
 * inside their own BEGIN IMMEDIATE (planIntent, beginMergeRun), so checking and entering share one transaction.
 * tests/pool-review-proof*.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { TaskWorkflow } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import { POOL_RECIPIENT } from "./scheduler-pool-plan.js";
import type { ReviewFacts } from "./scheduler-review.js";

/** The session id writeLendResult gives a pool verdict; a claimed reviewer session with this shape is a pool claim. */
const LEND_SESSION = /^lend:/;

interface OrderRow {
  orderId: string; taskId: string; peer: string; family: string; step: string; status: string; specRev: number; round: number; head: string;
  worker: string | null; leaseGen: number; resultSha: string | null; receipt: string | null; eventSeq: number | null; createdBy: string;
}
interface EventRow { seq: number; kind: string; target: string; dedupKey: string | null; data: string }

const obj = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const parse = (s: string | null): Record<string, unknown> | null => {
  if (!s) return null;
  try { return obj(JSON.parse(s)); } catch { return null; }
};
const hasLendTable = (db: Database): boolean => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lend_orders'").get();

/** Does this reviewer claim (CLI flags or a verdict's facts) present itself as a pool verdict? */
export const claimsPoolReview = (c: { reviewer?: string | null; session?: string | null }): boolean =>
  !!c.reviewer?.startsWith(POOL_RECIPIENT) || LEND_SESSION.test(c.session ?? "");

/** null = proven (or not a pool verdict at all: the caller's local-session rules apply); otherwise why the pool verdict is refused. */
export function poolReviewRefusal(db: Database, task: Pick<LedgerTask, "id" | "project" | "headSHA" | "round" | "specRev">,
  workflow: Pick<TaskWorkflow, "authorFamily">, facts: ReviewFacts): string | null {
  const ev = db.query("SELECT seq, kind, target, dedupKey, data FROM events WHERE seq = ?").get(facts.eventSeq) as EventRow | null;
  const lend = obj(parse(ev?.data ?? null)?.lend);
  if (!lend && !claimsPoolReview({ reviewer: facts.reviewer, session: facts.reviewerSessionId })) return null;
  const why = (s: string): string => `出借池审查回执不成立：${s}；不算引擎回执，走人工队列`;
  if (!ev || ev.kind !== "review" || ev.target !== task.id || !lend || typeof lend.orderId !== "string") return why("结论不是 lend-write 入账的（无单号 / no_order）");
  const orderId = lend.orderId;
  const o = hasLendTable(db) ? db.query(`SELECT orderId, taskId, peer, family, step, status, specRev, round, head, worker, leaseGen, resultSha, receipt,
    eventSeq, createdBy FROM lend_orders WHERE orderId = ?`).get(orderId) as OrderRow | null : null;
  if (!o || o.taskId !== task.id) return why(`没有本卡的出借单 ${orderId}`);
  if (o.step !== "review") return why(`出借单 ${orderId} 不是审查单（${o.step}）`);
  if (o.status !== "done") return why(`出借单 ${orderId} 状态是 ${o.status}，不是 done`);
  if (o.createdBy !== "scheduler") return why(`出借单 ${orderId} 不是调度器派的（${o.createdBy}）`);
  if (o.head !== task.headSHA || facts.head !== o.head || o.round !== task.round || facts.round !== o.round || o.specRev !== task.specRev) {
    return why(`出借单 ${orderId} 的 head / 轮次 / specRev 与卡上当前的不一致`);
  }
  // submit_verdict: the receipt writeLendResult signed in the verdict's own transaction, naming this very event.
  const receipt = parse(o.receipt);
  if (o.eventSeq !== ev.seq || ev.dedupKey !== `lend:${orderId}` || !o.resultSha || lend.sha256 !== o.resultSha || !receipt ||
    receipt.orderId !== orderId || receipt.taskId !== task.id || receipt.eventSeq !== ev.seq || receipt.sha256 !== o.resultSha ||
    typeof receipt.key !== "string" || !receipt.key || typeof receipt.sig !== "string" || !receipt.sig) {
    return why(`出借单 ${orderId} 缺与这条结论对应的入账回执`);
  }
  const claim = obj(lend.claim);
  if (lend.peer !== o.peer || lend.gen !== o.leaseGen || !o.worker || facts.reviewer !== `${POOL_RECIPIENT}${o.peer}` ||
    facts.reviewerSessionId !== `lend:${o.peer}:${orderId}` || facts.reviewerFamily !== o.family || claim?.family !== o.family ||
    typeof claim.session !== "string" || !claim.session) {
    return why(`结论的提供方 / 会话 / 家族 / 租约代数与出借单 ${orderId} 不一致`);
  }
  // take_review: the peer's claim of this order with the worker and lease generation the verdict was entered under.
  const claimed = db.query(`SELECT seq FROM events WHERE target = ? AND kind = 'note' AND seq < ? AND json_extract(data, '$.lend.orderId') = ?
    AND json_extract(data, '$.lend.op') = 'claim' AND json_extract(data, '$.lend.peer') = ? AND json_extract(data, '$.lend.worker') = ?
    AND json_extract(data, '$.lend.gen') = ? ORDER BY seq DESC LIMIT 1`).get(task.id, ev.seq, orderId, o.peer, o.worker, o.leaseGen) as { seq: number } | null;
  if (!claimed) return why(`出借单 ${orderId} 缺对方领单（${o.worker}，代数 ${o.leaseGen}）的记录`);
  // The scheduler's own review intent that offered this order, sent before the claim.
  const link = db.query(`SELECT json_extract(data, '$.id') AS id FROM events WHERE target = ? AND kind = 'scheduler'
    AND json_extract(data, '$.orderId') = ? AND dedupKey = 'scheduler:' || json_extract(data, '$.id') || ':pool' LIMIT 1`)
    .get(task.id, orderId) as { id: string } | null;
  const intent = link ? db.query("SELECT action, recipient, head, specRev, status, eventSeq FROM scheduler_intents WHERE id = ? AND taskId = ?")
    .get(link.id, task.id) as { action: string; recipient: string | null; head: string | null; specRev: number; status: string; eventSeq: number | null } | null : null;
  if (!intent || intent.action !== "review" || intent.recipient !== `${POOL_RECIPIENT}${o.peer}` || intent.head !== o.head ||
    intent.specRev !== o.specRev || !["submitted", "done"].includes(intent.status) || !intent.eventSeq || intent.eventSeq >= claimed.seq) {
    return why(`出借单 ${orderId} 没有对应的调度器派审意图`);
  }
  const author = remoteHeadFamily(db, task) ?? workflow.authorFamily;
  if (o.family === author) return why(`审查家族 ${o.family} 与实际作者家族相同（无正式 MODELX 豁免记录）`);
  return null;
}
