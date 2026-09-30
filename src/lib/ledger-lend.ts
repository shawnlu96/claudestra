/**
 * The lending instance A's side of remote capacity (docs/design/remote-capacity.md §2.2, §6; table in ledger-lend-schema.ts):
 * PM offers a card's review to one peer, the peer polls / claims it under a lease, renews, releases or lets it expire.
 * Every transition is a CAS under BEGIN IMMEDIATE. An expired lease only ever becomes `unknown` for PM (never re-offered by
 * itself); `released` (worker never started) and PM cancels free the card. The order a peer sees is built once, at offer
 * time, through T87's refuse-first peer gate with the ledger head. Result intake is ledger-lend-result.ts.
 * tests/ledger-lend.test.ts.
 */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { BorrowEntry, LendFamily } from "./lend-config.js";
import { LEASE_MS_DEFAULT, POLL_AFTER_MS, pollLimit, type ClaimRequest, type LeaseRequest, type LeaseState, type LendReceipt, type LendRefusal,
  type OfferSummary, type PollRequest } from "./lend-wire.js";
import { isManager, mustTask, type WriteCtx } from "./ledger-checks.js";
import { LEND_LIVE, type LendOrderStatus } from "./ledger-lend-schema.js";
import { getWorkflow } from "./ledger-scheduler.js";
import { LedgerError, type LedgerErrorCode } from "./ledger-store.js";
import { assignStep } from "./ledger-steps-write.js";
import type { LedgerTask } from "./ledger-stages.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { orderWireOf, parseOrderWire, type OrderWire } from "./order-wire.js";
import { OrderRenderError, redactOrderForPeer, renderOrderWire } from "./order-wire-render.js";

export interface LendOrder {
  orderId: string; taskId: string; project: string; peer: string; family: LendFamily; step: "review"; specRev: number; round: number; head: string;
  repo: string; pr: number | null; wire: OrderWire; text: string; sha256: string; status: LendOrderStatus; worker: string | null; leaseGen: number;
  leaseMs: number; leaseUntil: number | null; resultSha: string | null; receipt: LendReceipt | null; eventSeq: number | null; reason: string | null;
  supersedes: string | null; createdBy: string; createdAt: number; updatedAt: number;
}
/** Told to the card's PM after the transaction commits (the CLI sends it; a lost notice never undoes the state change). */
export interface LendNotice { project: string; taskId: string; text: string }

const LEDGER_CODE: Record<LendRefusal, LedgerErrorCode> = {
  unauthorized: "forbidden", not_borrowed: "forbidden", not_found: "not_found", taken: "conflict", cancelled: "conflict", lease_expired: "conflict",
  stale_gen: "conflict", conflict: "conflict", max_open: "conflict", invalid: "invalid",
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

/** The review binding a claim wrote; cancelling or releasing the order takes it back so the old peer holds nothing. */
function unbindStep(db: Database, o: LendOrder): void {
  if (!o.worker) return;
  db.prepare("DELETE FROM task_steps WHERE taskId = ? AND step = 'review' AND round = ? AND executorKind = 'peer' AND executor = ? AND state = 'assigned'")
    .run(o.taskId, o.round, `${o.worker}@${o.peer}`);
}

export interface OfferInput { taskId: string; peer: string; family: LendFamily; repo: string; pr: number | null; spec: string; borrow: BorrowEntry | null; supersedes?: string }

function reviewOrder(task: LedgerTask, orderId: string, input: OfferInput): OrderWire {
  const head = task.headSHA as string;
  return orderWireOf({
    taskId: task.id, specRev: task.specRev, head, round: task.round, node: "adversarial_review", step: "review", dedupKey: orderId,
    inputs: [`规格原文（specRev ${task.specRev}）：\n${input.spec}`],
    outputs: ["逐项结论（findingId / family / severity / probe / description）", "报告正文（markdown），随结论一起交"],
    acceptance: ["对抗式：专找能打穿规格保证的路径", "只审标题里的 head：只读，不改、不提交、不推送"],
    writeBack: "用 submit_verdict（M3 前是 lend submit）交结论和报告正文，单号见标题",
  }, { repo: input.repo, pr: input.pr });
}

/** PM puts the card's current review round in the pool for one peer; the order text is fixed here and never rebuilt. */
export function offerLend(db: Database, ctx: WriteCtx, input: OfferInput): LendOrder {
  return tx(db, () => {
    const task = mustTask(db, input.taskId);
    if (!isManager(db, ctx.actor, task)) throw new LedgerError("forbidden", `挂单要项目 ${task.project} 的 PM / master / owner（你是 ${ctx.actor}）`);
    if (task.stage !== "review") throw new LedgerError("invalid", `任务 ${task.id} 在 ${task.stage}，只有 review 阶段的卡能借出去审`);
    if (!task.headSHA || !/^[0-9a-f]{40}$/.test(task.headSHA)) throw new LedgerError("invalid", "卡上没有完整的 40 位 head，借不出去");
    if (getWorkflow(db, task.id)?.mode === "auto") throw new LedgerError("invalid", "自动流程的卡由调度器派单，v1 只借 PM 手动挂的卡");
    if (!input.borrow || !input.borrow.projects.includes(task.project) || !input.borrow.roles.includes("review")) {
      throw new LedgerError("forbidden", `lend.json 的 borrow 里没有允许把项目 ${task.project} 的审查借给 ${input.peer}`);
    }
    const live = db.query(`SELECT orderId FROM lend_orders WHERE taskId = ? AND status IN ('pooled','claimed','unknown')`).get(task.id) as { orderId: string } | null;
    if (live) throw new LedgerError("conflict", `这张卡已有未结的出借单 ${live.orderId}（先 lend-cancel，或 lend-reoffer）`);
    const n = (db.query("SELECT COUNT(*) AS n FROM lend_orders WHERE taskId = ? AND round = ?").get(task.id, task.round) as { n: number }).n;
    const orderId = `lend:${task.id}:s${task.specRev}:r${task.round}:a${n}`;
    let wire: OrderWire;
    let text: string;
    try {
      wire = redactOrderForPeer(reviewOrder(task, orderId, input), task.headSHA).order;
      text = renderOrderWire(wire, { audience: "peer", ledgerHead: task.headSHA });
    } catch (e) {
      if (e instanceof OrderRenderError) throw new LedgerError("invalid", `派单没过外发闸（拒绝优先，留在本机审）：${e.message}`);
      throw e;
    }
    const parsed = parseOrderWire(JSON.parse(JSON.stringify(wire)));
    if (!parsed.ok) throw new LedgerError("invalid", `派单格式不合格：${parsed.error}`);
    const now = ctx.now ?? Date.now();
    db.prepare(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo, pr, wire, text, sha256, status, leaseMs,
      supersedes, createdBy, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 'review', ?, ?, ?, ?, ?, ?, ?, ?, 'pooled', ?, ?, ?, ?, ?)`).run(
      orderId, task.id, task.project, input.peer, input.family, task.specRev, task.round, task.headSHA, input.repo, input.pr, JSON.stringify(parsed.value),
      text, sha256(text), LEASE_MS_DEFAULT, input.supersedes ?? null, ctx.actor, now, now,
    );
    note(db, ctx, { project: task.project, taskId: task.id, orderId, peer: input.peer }, `出借：审查挂给 ${input.peer}（${input.family}）`, { op: "offer" });
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

/** Cancel the live order and offer the card again under a new orderId, in one transaction (the old one is recorded as replaced). */
export function reofferLend(db: Database, ctx: WriteCtx, input: OfferInput & { reason: string }): LendOrder {
  return tx(db, () => {
    const old = cancelLend(db, ctx, { taskId: input.taskId, reason: `重挂：${input.reason}` });
    return offerLend(db, ctx, { ...input, supersedes: old.orderId });
  });
}

/** Leases past their deadline become `unknown` for PM, in their own transaction so a refusal that follows keeps them. */
export function sweepLend(db: Database, ctx: WriteCtx): LendNotice[] {
  const now = ctx.now ?? Date.now();
  return tx(db, () => {
    const due = (db.query("SELECT * FROM lend_orders WHERE status = 'claimed' AND leaseUntil < ?").all(now) as Record<string, unknown>[]).map(toOrder);
    return due.map((o) => {
      setStatus(db, o, "unknown", now, "租约过期：对方超过租约没有续租");
      note(db, ctx, o, `出借：${o.peer} 的租约过期，结果不明，不自动重派`, { op: "expire", gen: o.leaseGen });
      const text = `出借单 ${o.orderId}（${o.taskId} 审查，${o.peer}）租约过期，结果不明。不会自动重派：核对后 ledger lend-reoffer ${o.taskId} 或 lend-cancel`;
      return { project: o.project, taskId: o.taskId, text };
    });
  });
}

export function pollLend(db: Database, peer: string, req: PollRequest, borrow: (project: string) => BorrowEntry | null): { orders: OfferSummary[]; pollAfterMs: number } {
  const c = req.capacity;
  const open = (f: LendFamily) => (c.families[f] ?? 0) > (c.busy[f] ?? 0);
  const rows = (db.query("SELECT * FROM lend_orders WHERE peer = ? AND status = 'pooled' ORDER BY createdAt").all(peer) as Record<string, unknown>[]).map(toOrder);
  const orders = c.ordersLeftToday <= 0 || !c.roles.includes("review") ? [] : rows
    .filter((o) => c.repos.includes(o.repo) && open(o.family) && !!borrow(o.project)?.roles.includes("review"))
    .slice(0, pollLimit(rows.length))
    .map((o) => ({ orderId: o.orderId, taskId: o.taskId, step: o.step, family: o.family, repo: o.repo, pr: o.pr, head: o.head, round: o.round,
      specRev: o.specRev, offeredAt: o.createdAt }));
  return { orders, pollAfterMs: POLL_AFTER_MS };
}

/** The card must still be what the order was cut from; otherwise the order is dead and the peer is told `cancelled`. */
const cardMoved = (task: LedgerTask, o: LendOrder): boolean =>
  task.stage !== "review" || task.headSHA !== o.head || task.specRev !== o.specRev || task.round !== o.round;

/** One transition per call: an idempotent re-claim by the holder returns the same order and the current lease unchanged. */
export function claimLend(db: Database, ctx: WriteCtx, peer: string, req: ClaimRequest, borrow: (project: string) => BorrowEntry | null) {
  return tx(db, () => {
    const now = ctx.now ?? Date.now();
    const o = getLendOrder(db, req.orderId);
    if (!o || o.peer !== peer) return refuse("not_found", "没有挂给你的这一单");
    if (o.status === "claimed") {
      if ((o.leaseUntil ?? 0) < now) return refuse("lease_expired", "租约已过期，这一单交 PM 核对");
      return { order: o.wire, text: o.text, sha256: o.sha256, lease: lease(o) };
    }
    if (o.status === "unknown") return refuse("lease_expired", "这一单已过期或已报停，交 PM 核对");
    if (o.status === "done") return refuse("conflict", "这一单的结论已入账");
    if (o.status !== "pooled") return refuse("cancelled", "这一单已撤销");
    const b = borrow(o.project);
    if (!b?.roles.includes("review")) return refuse("not_borrowed", "本机的 borrow 已不再允许把这个项目借给你");
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
    assignStep(db, ctx, { taskId: o.taskId, step: "review", executor: `${req.worker}@${peer}`, executorKind: "peer", round: o.round });
    note(db, ctx, o, `出借：${peer} 领了审查（${req.worker}）`, { op: "claim", worker: req.worker, gen: o.leaseGen + 1 });
    const c = getLendOrder(db, o.orderId) as LendOrder;
    return { order: c.wire, text: c.text, sha256: c.sha256, lease: lease(c) };
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
    const text = started ? `出借单 ${o.orderId}（${o.taskId} 审查）${peer} 报 worker 已停${why}，结果不明，交你核对：ledger lend-reoffer ${o.taskId} 或 lend-cancel`
      : `出借单 ${o.orderId}（${o.taskId} 审查）${peer} 没起得来 worker${why}，这一单已释放；要再借就 ledger lend-offer ${o.taskId}`;
    return { lease: null, notices: [{ project: o.project, taskId: o.taskId, text }] };
  });
}
