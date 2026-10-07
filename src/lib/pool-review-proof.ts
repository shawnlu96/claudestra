/**
 * dispatch-recovery-POOLRV1: a lend-pool verdict counts as a merge source only when the ledger proves the engine's own pool round
 * (scheduler intent → done review order on this head/specRev/round → peer claim → signed receipt → B's submit_verdict ticket, checked
 * against the pinned key at entry → the intact received request it came in) and a cross-family reviewer.
 * No same-family exemption (no MODELX record). CLI / no_order / bare `peer:` verdicts stay manual; nothing is written or backfilled.
 * Read-only; callers run it in their own BEGIN IMMEDIATE. tests/pool-review-proof*.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { TaskWorkflow } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { actorMayConfigure } from "./ledger-scheduler-settle.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import { poolExemptVerdict } from "./ledger-pool-refusal-gate.js"; // MODELXP2：池单拒审豁免（与 exemptVerdict 同一谓词）
import { POOL_RECIPIENT } from "./scheduler-pool-plan.js";
import type { ReviewFacts } from "./scheduler-review.js";
import { readRawResult, type RawRef } from "./pool-review-proof-raw.js";
import { logicalSha, parseReviewTicket, ticketProblem } from "./pool-review-proof-ticket.js";

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

/**
 * null = proven (or not a pool verdict at all: the caller's local-session rules apply); otherwise why the pool verdict is refused.
 * `pmOffered` (MCRY1, formal main-carry only): the order is instead one a project PM put up with `ledger lend-offer` (its offer note,
 * its own id) and has no scheduler intent; every other check is the same. Each origin refuses the other's orders.
 */
export function poolReviewRefusal(db: Database, task: Pick<LedgerTask, "id" | "project" | "headSHA" | "round" | "specRev">,
  workflow: Pick<TaskWorkflow, "authorFamily">, facts: ReviewFacts, opts: { pmOffered?: boolean } = {}): string | null {
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
  if (!opts.pmOffered && o.createdBy !== "scheduler") return why(`出借单 ${orderId} 不是调度器派的（${o.createdBy}）`);
  if (opts.pmOffered && !pmOffer(db, task, o)) return why(`出借单 ${orderId} 不是项目 PM 用 lend-offer 挂的（${o.createdBy}）`);
  if (o.head !== task.headSHA || facts.head !== o.head || o.round !== task.round || facts.round !== o.round || o.specRev !== task.specRev) {
    return why(`出借单 ${orderId} 的 head / 轮次 / specRev 与卡上当前的不一致`);
  }
  // The receipt writeLendResult signed in the verdict's own transaction, naming this very event.
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
  const evidence = ticketEvidence(lend, o, task);
  if (evidence) return why(`出借单 ${orderId} ${evidence}`);
  // The claim of this order with the worker and lease generation the verdict was entered under.
  const claimed = db.query(`SELECT seq FROM events WHERE target = ? AND kind = 'note' AND seq < ? AND json_extract(data, '$.lend.orderId') = ?
    AND json_extract(data, '$.lend.op') = 'claim' AND json_extract(data, '$.lend.peer') = ? AND json_extract(data, '$.lend.worker') = ?
    AND json_extract(data, '$.lend.gen') = ? ORDER BY seq DESC LIMIT 1`).get(task.id, ev.seq, orderId, o.peer, o.worker, o.leaseGen) as { seq: number } | null;
  if (!claimed) return why(`出借单 ${orderId} 缺对方领单（${o.worker}，代数 ${o.leaseGen}）的记录`);
  // The scheduler's own review intent that offered this order, sent before the claim (a PM order's offer note was checked above).
  const link = opts.pmOffered ? null : db.query(`SELECT json_extract(data, '$.id') AS id FROM events WHERE target = ? AND kind = 'scheduler'
    AND json_extract(data, '$.orderId') = ? AND dedupKey = 'scheduler:' || json_extract(data, '$.id') || ':pool' LIMIT 1`)
    .get(task.id, orderId) as { id: string } | null;
  const intent = link ? db.query("SELECT action, recipient, head, specRev, status, eventSeq FROM scheduler_intents WHERE id = ? AND taskId = ?")
    .get(link.id, task.id) as { action: string; recipient: string | null; head: string | null; specRev: number; status: string; eventSeq: number | null } | null : null;
  if (!opts.pmOffered && (!intent || intent.action !== "review" || intent.recipient !== `${POOL_RECIPIENT}${o.peer}` || intent.head !== o.head ||
    intent.specRev !== o.specRev || !["submitted", "done"].includes(intent.status) || !intent.eventSeq || intent.eventSeq >= claimed.seq)) {
    return why(`出借单 ${orderId} 没有对应的调度器派审意图`);
  }
  const author = remoteHeadFamily(db, task) ?? workflow.authorFamily;
  if (o.family === author && !poolExemptVerdict(db, task, facts)) return why(`审查家族 ${o.family} 与实际作者家族相同（无正式 MODELX 豁免记录）`);
  return null;
}

/** A PM order (offerLend): its own id, made by a project PM / master / owner (not the dispatcher, never the scheduler), with that PM's offer note. */
const pmOffer = (db: Database, task: Pick<LedgerTask, "id" | "project">, o: OrderRow): boolean => o.createdBy !== "scheduler" &&
  actorMayConfigure(db, o.createdBy, task.project) && o.orderId.replace(/:a\d+$/, "") === `lend:${task.id}:s${o.specRev}:r${o.round}` &&
  !!db.query(`SELECT 1 FROM events WHERE target = ? AND kind = 'note' AND actor = ? AND json_extract(data, '$.lend.orderId') = ?
    AND json_extract(data, '$.lend.op') = 'offer' AND json_extract(data, '$.lend.step') = 'review'`).get(task.id, o.createdBy, o.orderId);

/** B's submit_verdict ticket as the writer admitted it, re-checked against the archived received request (its bytes, ticket and digest). */
function ticketEvidence(lend: Record<string, unknown>, o: OrderRow, task: Pick<LedgerTask, "id">): string | null {
  if (typeof lend.ticketRefusal === "string") return `的票据入账时没通过（${lend.ticketRefusal}）`;
  const ticket = parseReviewTicket(lend.ticket);
  if (!ticket) return "缺 submit_verdict 票据（旧版 peer 或 CLI lend submit 交的）";
  const ref = obj(lend.raw) as RawRef | null;
  if (!ref || ref.sha256 !== o.resultSha) return `缺收到的原件（${typeof lend.rawRefusal === "string" ? lend.rawRefusal : "没有记录"}）`;
  const text = readRawResult(ref);
  const body = text === null ? null : parse(text);
  if (!body) return "的原件缺失、被改或读不到";
  const session = obj(body.session)?.id;
  if (body.orderId !== o.orderId || JSON.stringify(parseReviewTicket(body.ticket)) !== JSON.stringify(ticket) || typeof session !== "string") {
    return "的原件与入账的票据不一致";
  }
  const bad = ticketProblem(ticket, { orderId: o.orderId, gen: o.leaseGen, taskId: task.id, head: o.head, specRev: o.specRev, round: o.round,
    family: o.family, worker: o.worker ?? "", session, payloadSha: logicalSha(body) }, ticket.key);
  return bad ? `的票据不成立（${bad}）` : null;
}
