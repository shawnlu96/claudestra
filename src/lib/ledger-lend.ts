import { unifiedBorrow } from "./scheduler-agent-pool-context.js";
/**
 * Lending-side CAS transitions under BEGIN IMMEDIATE; expired delivery becomes unknown, never automatically re-offered.
 * Write leases stay with the peer until merge/reclaim; authorization loss or pool timeout returns the card to local work.
 * Orders pass the refuse-first peer gate once at offer; result intake lives in ledger-lend-result.ts.
 * See docs/design/remote-capacity.md and tests/ledger-lend{,-write}.test.ts.
 */
import { clearPeerCooldown, cooldownReleaseNotices } from "./lend-peer-cooldown.js"; import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { BorrowEntry, LendFamily } from "./lend-config.js";
import { LEASE_MS_DEFAULT, POLL_AFTER_MS, pollLimit, type ClaimRequest, type LeaseRequest, type LeaseState, type LendReceipt, type LendRefusal,
  type OfferSummary, type PollRequest } from "./lend-wire.js";
import { isManager, mustTask, type WriteCtx } from "./ledger-checks.js";
import { endWriteLease, forPeer, holdWriteLease, lastReviewOf, writeOfferBranch, writeOrderWire, type WriteLease as WriteLeaseRow, type WriteOffer } from "./ledger-lend-lease.js";
import { LEND_LIVE, type LendOrderStatus } from "./ledger-lend-schema.js";
import { markRelayBaseline, restateFacts } from "./ledger-lend-relay.js";
import { queueTimeoutDue, sweepPushTtl } from "./ledger-lend-peers-ttl.js";
import { getWorkflow } from "./ledger-scheduler.js";
import { uiRejectLend } from "./ledger-ui-approve-verdict.js";
import { LedgerError, listEvents, type LedgerErrorCode } from "./ledger-store.js";
import { claimConvergenceStep } from "./lend-arbiter-claim.js";
import { setTask } from "./ledger-write.js";
import type { LedgerTask } from "./ledger-stages.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { isWriteStep, roleOfStep, stepOfStage, type LendStep } from "./lend-git.js";
import { orderWireOf, parseOrderWire, type OrderWire } from "./order-wire.js";
import { withDeliverScope } from "./order-deliver-scope.js";
import { chunkInputs, wholeInputs, type InputSplit } from "./order-wire-chunks.js";
import { OrderRenderError, redactOrderForPeer, renderOrderWire } from "./order-wire-render.js";
import { fitFindings } from "./order-findings.js";
import { standardAnswers } from "./order-standard-answers.js";
import { uiReviewBasis } from "./ui-acceptance.js";
import { prevReview } from "./review-order.js";
import { convergeOrderLines } from "./review-converge-order.js";
import { bounceReviewLine, bounceWork, fixBounce, reviewAfterBounce } from "./scheduler-merge-conflict.js";
export interface LendOrder {
  orderId: string; taskId: string; project: string; peer: string; family: LendFamily; step: LendStep; specRev: number; round: number; head: string;
  repo: string; pr: number | null; wire: OrderWire; text: string; sha256: string; status: LendOrderStatus; worker: string | null; leaseGen: number;
  leaseMs: number; leaseUntil: number | null; resultSha: string | null; receipt: LendReceipt | null; eventSeq: number | null; reason: string | null;
  supersedes: string | null; createdBy: string; createdAt: number; updatedAt: number;
  /** write / fix only: the one branch the peer may push (lend/<task>-<fp4>) and the base it was cut from */
  branch: string | null; base: string | null;
}
/** Told to the card's PM after the transaction commits (the CLI sends it; a lost notice never undoes the state change). */
export interface LendNotice { project: string; taskId: string; text: string }

const LEDGER_CODE: Record<LendRefusal, LedgerErrorCode> = {
  unauthorized: "forbidden", not_borrowed: "forbidden", not_found: "not_found", taken: "conflict", cancelled: "conflict", lease_expired: "conflict",
  stale_gen: "conflict", conflict: "conflict", max_open: "conflict", invalid: "invalid", unavailable: "conflict",
};
/** The wire code rides in `current.lend`, so the bridge answers the peer with it, not with the coarser ledger code. */
export const refuse = (code: LendRefusal, message: string): never => { throw new LedgerError(LEDGER_CODE[code], message, { lend: code }); };

const toOrder = (r: Record<string, unknown>): LendOrder => ({
  ...(r as unknown as LendOrder), wire: JSON.parse(r.wire as string) as OrderWire, receipt: r.receipt ? JSON.parse(r.receipt as string) as LendReceipt : null,
});

export function getLendOrder(db: Database, orderId: string): LendOrder | null {
  const r = db.query("SELECT * FROM lend_orders WHERE orderId = ?").get(orderId) as Record<string, unknown> | null;
  return r ? toOrder(r) : null;
}

export function listLendOrders(db: Database, taskId: string): LendOrder[] {
  return (db.query("SELECT * FROM lend_orders WHERE taskId = ? ORDER BY createdAt").all(taskId) as Record<string, unknown>[]).map(toOrder);
}

/** 只读 Reader 不迁移：迁到 T93 之前的库没有这张表，也就不可能有出借单（tests/ledger-steps.test.ts 的 v5 库） */
const hasLendTable = (db: Database): boolean => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lend_orders'").get();

/** A step a lend order holds (claimed, stalled for PM, or answered): only lend/result may write its review / stage / pr. */
export function lendManaged(db: Database, taskId: string, round: number): boolean {
  if (!hasLendTable(db)) return false;
  return !!db.query("SELECT 1 FROM lend_orders WHERE taskId = ? AND round = ? AND status IN ('claimed','unknown','done') LIMIT 1").get(taskId, round);
}

type StepKey = { taskId: string; step: string; round: number; executor: string; executorKind: string };

/**
 * Is this the exact step row a lend order holds (same task / step / round / worker@peer; claimed, stalled or answered)?
 * Such a row is not a T46 delegation: peer-ledger neither shows it nor lets it grant anything, whatever round the card is in now.
 * tests/ledger-lend.test.ts「the old peer-ledger door」.
 */
export function lendBoundStep(db: Database): (s: StepKey) => boolean {
  if (!hasLendTable(db)) return () => false;
  const q = db.query(`SELECT 1 FROM lend_orders WHERE taskId = ? AND step = ? AND round = ? AND worker || '@' || peer = ? AND status IN ('claimed','unknown','done') LIMIT 1`);
  return (s) => s.executorKind === "peer" && !!q.get(s.taskId, s.step, s.round, s.executor);
}

const lease = (o: Pick<LendOrder, "leaseGen" | "leaseUntil" | "leaseMs">): LeaseState => ({ gen: o.leaseGen, expiresAt: o.leaseUntil ?? 0, ms: o.leaseMs });
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

function setStatus(db: Database, o: LendOrder, to: LendOrderStatus, now: number, reason: string | null): void {
  db.prepare("UPDATE lend_orders SET status = ?, reason = ?, updatedAt = ? WHERE orderId = ? AND status = ?").run(to, reason, now, o.orderId, o.status);
}

function note(db: Database, ctx: WriteCtx, o: Pick<LendOrder, "project" | "taskId" | "orderId" | "peer">, text: string, data: Record<string, unknown> = {}): void {
  insertEvent(db, ctx, { project: o.project, target: o.taskId, kind: "note", text, data: { lend: { orderId: o.orderId, peer: o.peer, ...data } } }, false);
}

/** The step binding a claim wrote; cancelling or releasing the order takes it back so the old peer holds nothing. */
function unbindStep(db: Database, o: LendOrder): void {
  if (!o.worker) return;
  db.prepare("DELETE FROM task_steps WHERE taskId = ? AND step = ? AND round = ? AND executorKind = 'peer' AND executor = ? AND state = 'assigned'")
    .run(o.taskId, o.step, o.round, `${o.worker}@${o.peer}`);
}

const LABEL: Record<LendStep, string> = { review: "审查", write: "开工单", fix: "修复单" };
/**
 * A write order still pooled this long after the peer first saw it (or after the offer, if it never did) could not go back to that
 * peer (offline, full, owner not approving): the card returns to local work. Counting from first sight, not every poll, bounds it.
 */
export const WRITE_POOL_TTL_MS = 30 * 60_000;
/** The sweep's predicate (bound: now - WRITE_POOL_TTL_MS); the bridge's minute check uses the same text. */
export const STALE_WRITE_SQL = "status = 'pooled' AND step IN ('write','fix') AND COALESCE(seenAt, createdAt) < ?";

export interface OfferInput {
  taskId: string; peer: string; family: LendFamily; repo: string; pr: number | null; spec: string; borrow: BorrowEntry | null; supersedes?: string;
  /** build / fix cards: the peer's fingerprint, the base and (fix) the last review report, prepared by the CLI outside the transaction */
  write?: WriteOffer;
}

/**
 * The pool's review order, built from the same ledger facts as the local one (review-order.ts): from round 2 the previous round's
 * findings (fitted, report path when cut) so the reviewer can re-check them by id, and after a merge bounce the targeted line.
 */
function reviewOrder(db: Database, task: LedgerTask, orderId: string, input: OfferInput, split: InputSplit = chunkInputs): OrderWire {
  const head = task.headSHA as string;
  const events = listEvents(db, { project: task.project, target: task.id });
  const prev = prevReview(events, task.round);
  const bounce = reviewAfterBounce(events);
  return withDeliverScope(db, task, orderWireOf({
    taskId: task.id, specRev: task.specRev, head, round: task.round, node: "adversarial_review", step: "review", dedupKey: orderId,
    inputs: [...split([[`规格原文（specRev ${task.specRev}）`, input.spec]]), ...(bounce ? [bounceReviewLine(bounce)] : []), standardAnswers("review", uiReviewBasis(db, task, input.spec))],
    outputs: ["逐项结论（findingId / family / severity / probe / description）", "报告正文（markdown），随结论一起交"],
    acceptance: ["对抗式：专找能打穿规格保证的路径", "只审标题里的 head：只读，不改、不提交、不推送", ...convergeOrderLines(task.round, events, head)],
    writeBack: "用 submit_verdict（M3 前是 lend submit）交结论和报告正文，单号见标题", findings: prev.findings,
  }, { repo: input.repo, pr: input.pr }), (w) => fitFindings(w, prev.report));
}

/**
 * The order for the card's current step: the review round as before, a build / fix round as a write order on the lend branch.
 * `whole` is the same order with every source unsplit, only for the peer gate's secret scan (never stored or sent).
 */
function orderFor(db: Database, task: LedgerTask, step: LendStep, orderId: string, input: OfferInput):
  { wire: OrderWire; whole: OrderWire; branch: string | null; base: string | null } {
  if (step === "review") return { wire: reviewOrder(db, task, orderId, input), whole: reviewOrder(db, task, orderId, input, wholeInputs), branch: null, base: null };
  if (!input.write) throw new LedgerError("invalid", "写单缺出借方指纹与基线（CLI 备好再挂）");
  const branch = writeOfferBranch(db, task, step, input.peer, input.write);
  const head = step === "write" ? input.write.baseSha as string : task.headSHA as string;
  const b = step === "fix" ? fixBounce(listEvents(db, { project: task.project, target: task.id }), task.stage) : null;
  // Peer free text cannot carry full SHAs (the secret gate rejects them); keep refs short, as in bounceReviewLine.
  const shortRef = (sha: string): string => sha.slice(0, 12);
  const bounce = b ? bounceWork({ ...b, prHead: shortRef(b.prHead), mainHead: b.mainHead ? shortRef(b.mainHead) : null }) : null;
  const findings = step === "fix" && !bounce ? (uiRejectLend(db, task)?.findings ?? lastReviewOf(db, task).findings) : [];
  const events = step === "write" ? listEvents(db, { project: task.project, target: task.id }) : [];
  const facts = step === "write" ? restateFacts(events, task.specRev) : null;
  const restate = facts && !facts.answered ? facts.text : null; // 复述交了、PM 还没答：复述随单带上，答复之后推（i28-RS1）
  const o = { orderId, step, head, branch, base: input.write.base, spec: input.spec, report: input.write.report, findings, repo: input.repo, pr: input.pr, bounce, restate };
  return { wire: writeOrderWire(task, o), whole: writeOrderWire(task, o, wholeInputs), branch, base: input.write.base };
}

/** PM puts the card's current round in the pool for one peer; the order text is fixed here and never rebuilt. */
export function offerLend(db: Database, ctx: WriteCtx, input: OfferInput): LendOrder {
  return tx(db, () => {
    const task = mustTask(db, input.taskId);
    if (!isManager(db, ctx.actor, task)) throw new LedgerError("forbidden", `挂单要项目 ${task.project} 的 PM / master / owner（你是 ${ctx.actor}）`);
    if (getWorkflow(db, task.id)?.mode === "auto") throw new LedgerError("invalid", "自动流程的卡由调度器派单，v1 只借 PM 手动挂的卡");
    return offerLendCore(db, ctx, input);
  });
}

/**
 * The offer itself, without offerLend's two gates (PM identity, manual cards only): the scheduler (i28-R9) calls it for auto cards
 * under its own identity, which its CLI checks. Stage / head / borrow / live-order checks, T87's peer gate and the wire check all stay.
 */
export function offerLendCore(db: Database, ctx: WriteCtx, input: OfferInput): LendOrder {
  return tx(db, () => {
    const task = mustTask(db, input.taskId);
    const step = stepOfStage(task.stage);
    if (!step) throw new LedgerError("invalid", `任务 ${task.id} 在 ${task.stage}，只有 review / build / fix 阶段的卡能借出去`);
    if (step === "review" && (!task.headSHA || !/^[0-9a-f]{40}$/.test(task.headSHA))) throw new LedgerError("invalid", "卡上没有完整的 40 位 head，借不出去");
    input = { ...input, borrow: unifiedBorrow(task.project, input.borrow) };
    const role = roleOfStep(step) as "review" | "write";
    if (!input.borrow || !input.borrow.projects.includes(task.project) || !input.borrow.roles.includes(role)) {
      throw new LedgerError("forbidden", `lend.json 的 borrow 里没有允许把项目 ${task.project} 的${role === "write" ? "写代码" : "审查"}借给 ${input.peer}`);
    }
    const live = db.query(`SELECT orderId FROM lend_orders WHERE taskId = ? AND status IN ('pooled','claimed','unknown')`).get(task.id) as { orderId: string } | null;
    if (live) throw new LedgerError("conflict", `这张卡已有未结的出借单 ${live.orderId}（先 lend-cancel，或 lend-reoffer）`);
    const n = (db.query("SELECT COUNT(*) AS n FROM lend_orders WHERE taskId = ? AND round = ?").get(task.id, task.round) as { n: number }).n;
    const orderId = `lend:${task.id}:s${task.specRev}:r${task.round}:a${n}`;
    const made = forPeer(db, ctx, task, orderFor(db, task, step, orderId, input)); // card heads shortened, refused finding ids aliased (i28-GATE2)
    const head = made.wire.head as string;
    let wire: OrderWire;
    let text: string;
    try {
      redactOrderForPeer(made.whole, head); // secrets are judged on the unsplit sources: a key wrapped across two parts still refuses
      wire = redactOrderForPeer(made.wire, head).order;
      text = renderOrderWire(wire, { audience: "peer", ledgerHead: head });
    } catch (e) {
      if (e instanceof OrderRenderError) throw new LedgerError("invalid", `派单没过外发闸（拒绝优先，留在本机做）：${e.message}`);
      throw e;
    }
    const parsed = parseOrderWire(JSON.parse(JSON.stringify(wire)));
    if (!parsed.ok) throw new LedgerError("invalid", `派单格式不合格：${parsed.error}`);
    const now = ctx.now ?? Date.now();
    db.prepare(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo, pr, wire, text, sha256, status, leaseMs,
      supersedes, createdBy, createdAt, updatedAt, branch, base) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pooled', ?, ?, ?, ?, ?, ?, ?)`).run(
      orderId, task.id, task.project, input.peer, input.family, step, task.specRev, task.round, head, input.repo, input.pr, JSON.stringify(parsed.value),
      text, sha256(text), LEASE_MS_DEFAULT, input.supersedes ?? null, ctx.actor, now, now, made.branch, made.base,
    );
    if (made.branch) holdWriteLease(db, task, { peer: input.peer, fp: input.write!.fp.toLowerCase(), branch: made.branch, repo: input.repo }, now);
    markRelayBaseline(db, task, { orderId, taskId: task.id, project: task.project, peer: input.peer, step, specRev: task.specRev }, input.spec, now);
    note(db, ctx, { project: task.project, taskId: task.id, orderId, peer: input.peer }, `出借：${LABEL[step]}挂给 ${input.peer}（${input.family}）`,
      { op: "offer", step, ...(made.branch ? { branch: made.branch } : {}) });
    return getLendOrder(db, orderId) as LendOrder;
  });
}

/** PM withdraws a live order (pooled, claimed or unknown); a later result for it is refused with `cancelled`. */
export function cancelLend(db: Database, ctx: WriteCtx, input: { taskId: string; reason: string }): LendOrder {
  return tx(db, () => {
    const task = mustTask(db, input.taskId);
    if (!isManager(db, ctx.actor, task)) throw new LedgerError("forbidden", `撤单要项目 ${task.project} 的 PM / master / owner（你是 ${ctx.actor}）`);
    const o = listLendOrders(db, task.id).find((x) => LEND_LIVE.includes(x.status));
    if (!o) throw new LedgerError("not_found", `任务 ${task.id} 没有未结的出借单`);
    const now = ctx.now ?? Date.now();
    setStatus(db, o, "cancelled", now, input.reason);
    unbindStep(db, o);
    note(db, ctx, o, `出借：撤单（原状态 ${o.status}）：${input.reason}`, { op: "cancel", from: o.status });
    return getLendOrder(db, o.orderId) as LendOrder;
  });
}

/**
 * The scheduler's timeout withdraw (i28-R9): one CAS pooled → cancelled. An order already claimed, settled or cancelled comes back
 * as it is with nothing written (withdrawn: false). No manager check here: the caller's CLI gates the scheduler identity.
 * A write order withdrawn this way also ends the card's write lease, as a send-back does, so a later fix order is not tied to that peer.
 */
export function withdrawPooledLend(db: Database, ctx: WriteCtx, input: { orderId: string; reason: string }): { withdrawn: boolean; order: LendOrder } {
  return tx(db, () => {
    const o = getLendOrder(db, input.orderId);
    if (!o) throw new LedgerError("not_found", `没有出借单 ${input.orderId}`);
    const now = ctx.now ?? Date.now();
    const r = db.prepare("UPDATE lend_orders SET status = 'cancelled', reason = ?, updatedAt = ? WHERE orderId = ? AND status = 'pooled'").run(input.reason, now, o.orderId);
    if (r.changes === 0) return { withdrawn: false, order: o };
    if (isWriteStep(o.step)) endWriteLease(db, o.taskId, input.reason, now);
    note(db, ctx, o, `出借：撤单（原状态 pooled）：${input.reason}`, { op: "cancel", from: "pooled", withdrawnBy: ctx.actor });
    return { withdrawn: true, order: getLendOrder(db, o.orderId) as LendOrder };
  });
}

/** Cancel the live order and offer the card again under a new orderId, in one transaction (the old one is recorded as replaced). */
export function reofferLend(db: Database, ctx: WriteCtx, input: OfferInput & { reason: string }): LendOrder {
  return tx(db, () => {
    const old = cancelLend(db, ctx, { taskId: input.taskId, reason: `重挂：${input.reason}` });
    return (clearPeerCooldown(db, old.peer, old.family, input), offerLend(db, ctx, { ...input, supersedes: old.orderId }));
  });
}

/** A write order that cannot reach its peer: cancelled, the write lease ended, and PM told the card is back to local work. */
function sendBack(db: Database, ctx: WriteCtx, o: LendOrder, why: string, now: number): LendNotice {
  if (LEND_LIVE.includes(o.status)) setStatus(db, o, "cancelled", now, why);
  unbindStep(db, o);
  endWriteLease(db, o.taskId, why, now);
  note(db, ctx, o, `出借：${LABEL[o.step]}派不回 ${o.peer}（${why}），写租约结束，退回本机`, { op: "send_back", from: o.status });
  return { project: o.project, taskId: o.taskId, text: `出借单 ${o.orderId}（${o.taskId} ${LABEL[o.step]}）派不回 ${o.peer}：${why}。写租约已结束，这张卡退回本机做` };
}
/**
 * Leases past their deadline become `unknown` for PM, in their own transaction so a refusal that follows keeps them.
 * Write orders nobody claimed within WRITE_POOL_TTL_MS go back to local work (the peer is offline or out of slots).
 */
export function sweepLend(db: Database, ctx: WriteCtx): LendNotice[] {
  const now = ctx.now ?? Date.now();
  return tx(db, () => {
    const due = (db.query("SELECT * FROM lend_orders WHERE status = 'claimed' AND leaseUntil < ?").all(now) as Record<string, unknown>[]).map(toOrder);
    const expired = due.map((o) => {
      setStatus(db, o, "unknown", now, "租约过期：对方超过租约没有续租");
      note(db, ctx, o, `出借：${o.peer} 的租约过期，结果不明，不自动重派`, { op: "expire", gen: o.leaseGen });
      const text = `出借单 ${o.orderId}（${o.taskId} ${LABEL[o.step]}，${o.peer}）租约过期，结果不明。不会自动重派：核对后 ledger lend-reoffer ${o.taskId} 或 lend-cancel`;
      return { project: o.project, taskId: o.taskId, text };
    });
    const stale = (db.query(`SELECT * FROM lend_orders WHERE ${STALE_WRITE_SQL}`).all(now - WRITE_POOL_TTL_MS) as Record<string, unknown>[]).map(toOrder);
    const why = `挂出或对方看到后 ${WRITE_POOL_TTL_MS / 60_000} 分钟没人领（对方离线、名额满或没批）`;
    return [...expired, ...stale.filter((o) => queueTimeoutDue(db, o.orderId, now - WRITE_POOL_TTL_MS)).map((o) => sendBack(db, ctx, o, why, now)),
      ...sweepPushTtl(db, now, (orderId, reason) => withdrawPooledLend(db, ctx, { orderId, reason }).withdrawn)];
  });
}

/**
 * PM takes a card's write work back: the live order (if any) is cancelled, the write lease ends, and the card's assignee goes back to
 * what it was before lending when it still names the peer's worker. A later deliver for the old order is refused (`cancelled`).
 */
export function reclaimLend(db: Database, ctx: WriteCtx, input: { taskId: string; reason: string }): { lease: WriteLeaseRow | null; cancelled: string | null } {
  return tx(db, () => {
    const task = mustTask(db, input.taskId);
    if (!isManager(db, ctx.actor, task)) throw new LedgerError("forbidden", `收回要项目 ${task.project} 的 PM / master / owner（你是 ${ctx.actor}）`);
    const now = ctx.now ?? Date.now();
    const o = listLendOrders(db, task.id).find((x) => LEND_LIVE.includes(x.status) && isWriteStep(x.step));
    if (o) {
      setStatus(db, o, "cancelled", now, `PM 收回：${input.reason}`);
      unbindStep(db, o);
    }
    const lease = endWriteLease(db, task.id, `PM 收回：${input.reason}`, now);
    if (!lease && !o) throw new LedgerError("not_found", `任务 ${task.id} 没有写租约，也没有未结的写单`);
    if (lease && task.assigneeKind === "peer_agent" && task.assignee?.startsWith(`${lease.fp}/`)) {
      const back = lease.prevAssigneeKind === "agent" ? { agent: lease.prevAssignee } : { assigneeKind: lease.prevAssigneeKind, assignee: lease.prevAssignee };
      setTask(db, ctx, { id: task.id, rev: task.rev, patch: back as never });
    }
    note(db, ctx, { project: task.project, taskId: task.id, orderId: o?.orderId ?? "", peer: lease?.peer ?? o?.peer ?? "" },
      `出借：PM 收回写代码（${input.reason}）`, { op: "reclaim", ...(o ? { cancelled: o.orderId } : {}) });
    return { lease, cancelled: o?.orderId ?? null };
  });
}

/** Write orders handed out here get their first-seen time (seenAt) so the unclaimed timeout starts when the peer could act on them. */
export function pollLend(db: Database, peer: string, req: PollRequest, borrow: (project: string) => BorrowEntry | null, now = Date.now()):
  { orders: OfferSummary[]; pollAfterMs: number } {
  const c = req.capacity;
  const open = (f: LendFamily) => (c.families[f] ?? 0) > (c.busy[f] ?? 0);
  const rows = (db.query("SELECT * FROM lend_orders WHERE peer = ? AND status = 'pooled' ORDER BY createdAt").all(peer) as Record<string, unknown>[]).map(toOrder);
  const role = (o: LendOrder) => roleOfStep(o.step) as "review" | "write";
  const orders = c.ordersLeftToday <= 0 ? [] : rows
    .filter((o) => c.repos.includes(o.repo) && open(o.family) && c.roles.includes(role(o)) && !!unifiedBorrow(o.project, borrow(o.project))?.roles.includes(role(o)))
    .slice(0, pollLimit(rows.length))
    .map((o) => ({ orderId: o.orderId, taskId: o.taskId, step: o.step, family: o.family, repo: o.repo, pr: o.pr, head: o.head, round: o.round,
      specRev: o.specRev, offeredAt: o.createdAt }));
  const seen = db.prepare("UPDATE lend_orders SET seenAt = ? WHERE orderId = ? AND status = 'pooled' AND seenAt IS NULL");
  for (const o of orders) if (isWriteStep(o.step)) seen.run(now, o.orderId);
  return { orders, pollAfterMs: POLL_AFTER_MS };
}

/**
 * The card must still be what the order was cut from; otherwise the order is dead and the peer is told `cancelled`.
 * A build order's head is the base it starts from, not the card's head (the card has none yet); review / fix start from the card's head.
 */
export const cardMoved = (task: LedgerTask, o: Pick<LendOrder, "step" | "head" | "specRev" | "round">): boolean =>
  stepOfStage(task.stage) !== o.step || task.specRev !== o.specRev || task.round !== o.round || (o.step !== "write" && task.headSHA !== o.head);

/** What a claim hands the peer; a write order also names the one branch it may push and the base it was cut from. */
const claimed = (o: LendOrder) => ({ order: o.wire, text: o.text, sha256: o.sha256, lease: lease(o),
  ...(o.branch && o.base ? { write: { branch: o.branch, base: o.base } } : {}) });
/** One transition per call: an idempotent re-claim by the holder returns the same order and the current lease unchanged. */
export function claimLend(db: Database, ctx: WriteCtx, peer: string, req: ClaimRequest, borrow: (project: string) => BorrowEntry | null) {
  return tx(db, () => {
    const now = ctx.now ?? Date.now();
    const o = getLendOrder(db, req.orderId);
    if (!o || o.peer !== peer) return refuse("not_found", "没有挂给你的这一单");
    if (o.status === "claimed") {
      if ((o.leaseUntil ?? 0) < now) return refuse("lease_expired", "租约已过期，这一单交 PM 核对");
      return claimed(o);
    }
    if (o.status === "unknown") return refuse("lease_expired", "这一单已过期或已报停，交 PM 核对");
    if (o.status === "done") return refuse("conflict", "这一单的结论已入账");
    if (o.status !== "pooled") return refuse("cancelled", "这一单已撤销");
    const b = unifiedBorrow(o.project, borrow(o.project));
    if (!b?.roles.includes(roleOfStep(o.step) as "review" | "write")) return refuse("not_borrowed", "本机的 borrow 已不再允许把这个项目借给你");
    const held = (db.query("SELECT COUNT(*) AS n FROM lend_orders WHERE peer = ? AND status = 'claimed'").get(peer) as { n: number }).n;
    if (held >= b.maxOpen) return refuse("max_open", `你已持有 ${held} 单，达到上限 ${b.maxOpen}`);
    const task = mustTask(db, o.taskId);
    if (cardMoved(task, o)) {
      setStatus(db, o, "cancelled", now, "卡已推进（阶段、head、specRev 或轮次变了）");
      note(db, ctx, o, "出借：卡已推进，旧单作废", { op: "cancel", from: "pooled", stale: true });
      return { stale: true as const };
    }
    const until = now + o.leaseMs;
    db.prepare(`UPDATE lend_orders SET status = 'claimed', reason = NULL, worker = ?, leaseGen = leaseGen + 1, leaseUntil = ?, updatedAt = ?
      WHERE orderId = ? AND status = 'pooled'`).run(req.worker, until, now, o.orderId);
    claimConvergenceStep(db, ctx, o, req.worker, peer);
    note(db, ctx, o, `出借：${peer} 领了${LABEL[o.step]}（${req.worker}）`, { op: "claim", worker: req.worker, gen: o.leaseGen + 1 });
    return claimed((clearPeerCooldown(db, o.peer, o.family), getLendOrder(db, o.orderId) as LendOrder));
  });
}

/** Renew (heartbeat) or release; `stopped` parks the order as unknown for PM, `not_started` frees the card for PM to re-offer. */
export function leaseLend(db: Database, ctx: WriteCtx, peer: string, req: LeaseRequest): { lease: LeaseState | null; notices: LendNotice[] } {
  return tx(db, () => {
    const now = ctx.now ?? Date.now();
    const o = getLendOrder(db, req.orderId);
    if (!o || o.peer !== peer || !o.worker) return refuse("not_found", "你没有持有这一单");
    if (o.status === "unknown") return refuse("lease_expired", "租约已过期或已报停，停下 worker");
    if (o.status === "done") return refuse("conflict", "这一单的结论已入账");
    if (o.status !== "claimed") return refuse("cancelled", "这一单已撤销，停下 worker");
    if ((o.leaseUntil ?? 0) < now) return refuse("lease_expired", "租约已过期，停下 worker");
    if (req.gen !== o.leaseGen) return refuse("stale_gen", `租约代数是 ${o.leaseGen}，不是 ${req.gen}`);
    if (req.action === "renew") {
      db.prepare("UPDATE lend_orders SET leaseUntil = ?, updatedAt = ? WHERE orderId = ?").run(now + o.leaseMs, now, o.orderId);
      return { lease: lease({ ...o, leaseUntil: now + o.leaseMs }), notices: [] };
    }
    const why = req.detail ? `：${req.detail}` : "";
    const started = req.reason === "stopped";
    setStatus(db, o, started ? "unknown" : "released", now, `${req.reason}${why}`);
    if (!started) unbindStep(db, o);
    note(db, ctx, o, `出借：${peer} 报 ${req.reason}${why}`, { op: "release", reason: req.reason, gen: o.leaseGen });
    // 写单没起得来（没有推送权限、clone 不下来…）= 派不回这个出借方：写租约结束，卡退回本机
    if (!started && isWriteStep(o.step)) return { lease: null, notices: cooldownReleaseNotices(db, o, why, now, [sendBack(db, ctx, { ...o, status: "released" }, `对方没起得来 worker${why}`, now)]) };
    const label = LABEL[o.step];
    const text = started ? `出借单 ${o.orderId}（${o.taskId} ${label}）${peer} 报 worker 已停${why}，结果不明，交你核对：ledger lend-reoffer ${o.taskId} 或 lend-cancel`
      : `出借单 ${o.orderId}（${o.taskId} ${label}）${peer} 没起得来 worker${why}，这一单已释放；要再借就 ledger lend-offer ${o.taskId}`;
    return { lease: null, notices: started ? [{ project: o.project, taskId: o.taskId, text }] : cooldownReleaseNotices(db, o, why, now, [{ project: o.project, taskId: o.taskId, text }]) };
  });
}
