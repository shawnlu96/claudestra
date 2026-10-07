/**
 * dispatch-recovery-MODELXP2 · 池单拒审的写口（`ledger scheduler-pool-refusal`，scheduler-only）。调度服务只有只读句柄，这里在写锁的
 * 事务里重读全部事实再动手：出借方随 release 交来的结构化类别（只认 failure.class，不读自由文本）、单此刻的状态与租约代数、卡的
 * head / specRev / 轮次 → MODELXP1 的 recognizePoolRefusal / planPoolRefusal。on：撤单（provider_policy_refusal，原件保留）→ 结挂池意图
 * → 记计划事件（模型结果）→ 审查单开池单 epoch（绑单号，不要 reviewer 绑定；带豁免与去处家族；规划器下一轮按它换家族重挂）→ owner 告知
 * 每键一次。manual（豁免单 / 同步骤已换过再被拒）与写单 / 修复单的换作者计划不撤单：记计划与告知，单照旧停给 PM。observe 只记计划。按单号去重。
 * 识别 / 计划是纯函数（scheduler-refusal-pool.ts），这里不改它们。tests/ledger-pool-refusal*.test.ts。
 */
import type { Database } from "bun:sqlite";
import { isCyberPolicy } from "./agent-supervisor-policy.js";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { getLendOrder, type LendOrder } from "./ledger-lend.js";
import { getIntent, getWorkflow, type AuthorFamily, type SchedulerIntent } from "./ledger-scheduler.js";
import { settleIntent } from "./ledger-scheduler-settle.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, LedgerError, listEvents } from "./ledger-store.js";
import { appendEvent, type WriteCtx as Ctx } from "./ledger-write.js";
import type { BorrowEntry } from "./lend-config.js";
import type { LenderFailure, LenderFailureClass } from "./lend-health.js";
import { closeSettledOrderAsks } from "./order-ask-terminal.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import { borrowPeers, poolLinkKey } from "./scheduler-pool-facts.js";
import {
  planPoolRefusal, poolLedgerFacts, poolPlanEventData, poolRefusalKey, recognizePoolRefusal,
  type CardNow, type PlanFacts, type PoolDecision, type PoolOrderFacts,
} from "./scheduler-refusal-pool.js";
import { informKey } from "./scheduler-model-wiring.js";
import { createRefusalApprovalPort } from "./recovery-refusal-approval.js";
import { approvalLapse } from "./scheduler-review-swap.js";
import { poolExemptionText } from "./ledger-pool-refusal-gate.js";

const POOL_REFUSAL_CANCEL = "provider_policy_refusal";
const POOL_EPOCH_OP = "pool_refusal_epoch";
const poolEpochKey = (orderId: string): string => `pool-refusal-epoch:${orderId}`;
const CLASSES: readonly LenderFailureClass[] = ["provider_policy", "usage", "auth", "network", "other"];
const LABEL = { review: "审查", write: "开工", fix: "修复" } as const;

/** release 带来的 failure 字段：类别枚举、会话、失败时刻都合格才算有；否则 null（= 旧对端 / 没有类别） */
function failureField(v: unknown): LenderFailure | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const f = v as Record<string, unknown>;
  if (!CLASSES.includes(f.class as LenderFailureClass) || typeof f.sessionId !== "string" || !f.sessionId || f.sessionId.length > 200 ||
    typeof f.failedAt !== "number" || !Number.isFinite(f.failedAt)) return null;
  return { class: f.class as LenderFailureClass, sessionId: f.sessionId, failedAt: f.failedAt };
}

/** 这张单当前租约代数下出借方报的 release（stopped）记录：leaseLend 写的 note，data.lend.op = release */
export function lenderRelease(db: Database, o: Pick<LendOrder, "project" | "taskId" | "orderId" | "leaseGen">): { event: LedgerEvent; failure: LenderFailure | null } | null {
  const e = listEvents(db, { project: o.project, target: o.taskId }).findLast((x) => {
    const l = x.data.lend as Record<string, unknown> | undefined;
    return x.kind === "note" && !!l && l.orderId === o.orderId && l.op === "release";
  });
  const l = e?.data.lend as Record<string, unknown> | undefined;
  if (!e || !l || l.reason !== "stopped" || l.gen !== o.leaseGen) return null;
  return { event: e, failure: failureField(l.failure) };
}

/** 借入方台账上的单 → 识别用的单事实。结果不明（unknown）且本代 release 是 stopped = 出借方停单时单在 started */
export function poolOrderFacts(db: Database, o: LendOrder): PoolOrderFacts {
  const released = o.status === "unknown" ? lenderRelease(db, o) : null;
  return { orderId: o.orderId, taskId: o.taskId, step: o.step, family: o.family, peer: o.peer, state: released ? "started" : o.status,
    head: o.head, specRev: o.specRev, round: o.round, exempt: exemptOrder(db, o) };
}

/** 这张单是按某个池单 epoch 挂出来的豁免审查单：同窗口的 epoch 早于它的挂单记录 */
function exemptOrder(db: Database, o: LendOrder): boolean {
  if (o.step !== "review") return false;
  const events = listEvents(db, { project: o.project, target: o.taskId });
  const offered = events.find((e) => (e.data.lend as { orderId?: string; op?: string } | undefined)?.orderId === o.orderId &&
    (e.data.lend as { op?: string }).op === "offer");
  return events.some((e) => e.actor === "scheduler" && e.data.op === POOL_EPOCH_OP && e.data.orderId !== o.orderId && e.data.head === o.head &&
    e.data.specRev === o.specRev && e.data.round === o.round && (!offered || e.seq < offered.seq));
}

/** 告知键：沿用 MODELXP1，用 release 原因文本分 cyber_policy / usage_policy（failureReason 对 cyber 写「内容策略拦截」）；分不出 = usage_policy */
const noticeKind = (detail: string): "cyber_policy" | "usage_policy" =>
  detail.includes("内容策略拦截") || isCyberPolicy(detail) ? "cyber_policy" : "usage_policy";

const cardNow = (t: LedgerTask): CardNow => ({ stage: t.stage, headSHA: t.headSHA, specRev: t.specRev, round: t.round });

/** 挂这张单的挂池意图（offer 事务里写的 pool_offer 事件） */
function poolIntentOf(db: Database, o: LendOrder): SchedulerIntent | null {
  const e = listEvents(db, { project: o.project, target: o.taskId }).find((x) => x.kind === "scheduler" && x.data.op === "pool_offer" &&
    x.data.orderId === o.orderId && x.dedupKey === poolLinkKey(String(x.data.id)));
  return e ? getIntent(db, String(e.data.id)) : null;
}

/** 可放的去处：池里 lend-v2 报了空位的 peer（借入配置顺序），再是本机允许的家族 */
function placementsOf(db: Database, o: LendOrder, borrow: readonly BorrowEntry[], local: readonly AuthorFamily[], now: number): PlanFacts["placements"] {
  const role = o.step === "review" ? "review" : "write";
  const peers = borrowPeers(db, o.project, borrow, now).filter((p) => p.v2 && (p.roles ?? []).includes(role) && p.v2.roles.includes(role));
  return [...peers.flatMap((p) => (["claude", "codex"] as const).map((family) =>
    ({ machine: p.peer, family, free: !p.v2!.why && (p.v2!.slots[family] ?? 0) > 0 && p.open < p.maxOpen }))),
    ...local.map((family) => ({ machine: "local", family, free: true }))];
}

export interface PoolRefusalInput { taskId: string; orderId: string; mode: "on" | "observe"; borrow: readonly BorrowEntry[]; localFamilies: readonly AuthorFamily[] }
export interface PoolRefusalResult { duplicate: boolean; decision: Extract<PoolDecision, { kind: "plan" }>; plan: LedgerEvent; epoch: LedgerEvent | null;
  cancelled: boolean; informed: boolean; text: string }

/**
 * 写口本体：一个 BEGIN IMMEDIATE 里重核再执行。mode 由 CLI 现读 CFG（不收调用方的）；off 由 CLI 拒。
 * 拒绝一律 LedgerError（conflict / invalid / not_found）：没有类别、类别不是 provider_policy、单 / 卡已变 → 不动。
 */
export function writePoolRefusal(db: Database, ctx: WriteCtx, input: PoolRefusalInput): PoolRefusalResult {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "池单拒审接续只由调度服务执行");
  return db.transaction(() => {
    const key = poolRefusalKey(input.orderId, input.mode), done = getEventByDedup(db, key);
    const o = getLendOrder(db, input.orderId);
    if (!o || o.taskId !== input.taskId) throw new LedgerError("not_found", `任务 ${input.taskId} 没有出借单 ${input.orderId}`);
    if (done) return { duplicate: true, decision: { kind: "plan" as const, mode: input.mode, plan: done.data.plan as never, key }, plan: done,
      epoch: getEventByDedup(db, poolEpochKey(o.orderId)), cancelled: o.status === "cancelled", informed: false, text: done.text };
    const task = mustTask(db, o.taskId), workflow = getWorkflow(db, task.id);
    if (workflow?.mode !== "auto") throw new LedgerError("conflict", "卡不在自动流程");
    const released = o.status === "unknown" ? lenderRelease(db, o) : null;
    if (!released) throw new LedgerError("conflict", `单是 ${o.status}，没有本代出借方停单记录`);
    if (!released.failure) throw new LedgerError("invalid", "出借方没带结构化失败类别（旧对端），只记疑似，不撤单");
    if (released.failure.class !== "provider_policy") throw new LedgerError("invalid", `出借方报的类别是 ${released.failure.class}，不是提供方策略拒审`);
    const order = poolOrderFacts(db, o);
    const r = recognizePoolRefusal(order, cardNow(task), { source: "lender_declared", category: released.failure.class,
      sessionId: released.failure.sessionId, failedAt: released.failure.failedAt, doubt: null, message: String((released.event.data.lend as { detail?: unknown }).detail ?? "") });
    if (r.kind !== "confirmed") throw new LedgerError("conflict", r.kind === "suspected" ? r.note : "不是提供方策略拒审");
    const confirmed = { ...r, refusal: noticeKind(r.message) }; // 只分告知键（通知去重），不参与撤单判断
    const now = ctx.now ?? Date.now();
    const d = planPoolRefusal({ mode: input.mode, order, confirmed, authorFamily: remoteHeadFamily(db, task) ?? workflow.authorFamily,
      security: workflow.template === "security", placements: placementsOf(db, o, input.borrow, input.localFamilies, now),
      ...poolLedgerFacts(db, task.project, order, input.mode) });
    if (d.kind !== "plan") throw new LedgerError("conflict", "modelOutcome 为 off");
    const p = d.plan, s = { actor: ctx.actor, now };
    const plan = put(db, { ...s, dedupKey: key }, { project: task.project, target: task.id, kind: "note",
      text: `${input.mode === "observe" ? "[observe] 池单拒审计划（未执行）" : "池单拒审"}：${p.reason}`,
      data: poolPlanEventData(d, order, `出借方声明 ${released.failure.class}（会话 ${released.failure.sessionId}，失败于 ${released.failure.failedAt}；release #${released.event.seq}）`) });
    if (input.mode === "observe") return { duplicate: false, decision: d, plan, epoch: null, cancelled: false, informed: false, text: plan.text };
    let cancelled = false, epoch: LedgerEvent | null = null;
    // 写单 / 修复单换作者家族要规划器改作者家族（本卡范围外）：只记计划与告知，单照旧停给 PM，不撤单（不会同模型重派）
    // 豁免审查要 owner 规矩批准（同本地 MODELX）：批准无效 / 撤销 / 挂起 → 不撤单，单照旧停给 PM
    const approval = p.kind === "replace" && p.step === "review" ? readApproval(db, task) : null;
    if (approval && "lapse" in approval) return { duplicate: false, decision: d, plan, epoch: null, cancelled: false, informed: false,
      text: `${plan.text}；未执行（model_safety_hold，单 ${o.orderId}）：${approval.lapse}` };
    if (p.kind === "replace" && p.step === "review" && approval && "id" in approval) {
      cancelled = cancelOrder(db, s, o, `${POOL_REFUSAL_CANCEL}：${p.reason}`.slice(0, 600), now);
      const intent = poolIntentOf(db, o);
      if (intent && (intent.status === "pending" || intent.status === "submitted")) {
        settleIntent(db, s, { id: intent.id, from: intent.status, to: "cancelled", receipt: `出借单 ${o.orderId} 遭提供方策略拒审，已撤单（台账 #${plan.seq}）` });
      }
      epoch = put(db, { ...s, dedupKey: poolEpochKey(o.orderId) }, { project: task.project, target: task.id, kind: "note",
        text: `池单拒审 epoch：${LABEL[p.step]}单 ${o.orderId}（${o.peer} ${o.family}）被拒，换 ${p.to ? `${p.to.machine}（${p.to.family}）` : `${p.from.family === "claude" ? "codex" : "claude"}（等空位）`}` +
          `；${poolExemptionText(approval.id)}`,
        data: { op: POOL_EPOCH_OP, orderId: o.orderId, step: p.step, planSeq: plan.seq, fromFamily: o.family, fromPeer: o.peer,
          toFamily: p.from.family === "claude" ? "codex" : "claude", to: p.to, exemption: poolExemptionText(approval.id), approvalId: approval.id, crossModel: p.crossModel,
          nextReviewFamily: p.nextReviewFamily, head: o.head, specRev: o.specRev, round: o.round } });
    }
    const refusal = confirmed.refusal, informed = p.inform.first && !getEventByDedup(db, informKey(task.id, refusal));
    if (informed) {
      put(db, { ...s, dedupKey: informKey(task.id, refusal) }, { project: task.project, target: task.id, kind: "note",
        text: `[调度引擎] ${task.id} 池单${LABEL[o.step]}被模型提供方策略拒绝（${refusal}）：${p.kind === "replace" ? `已按 owner 规矩换家族：${p.reason}` : "本卡暂停，交 PM / owner 处置"}；台账 #${plan.seq}`,
        data: { audience: "owner", op: "refusal_owner_inform", kind: "inform", refusal, recordSeq: plan.seq, ...(epoch ? { epochSeq: epoch.seq } : {}) } });
    }
    if (p.kind === "manual" && !getEventByDedup(db, `model-refusal-manual:${task.id}`)) {
      put(db, { ...s, dedupKey: `model-refusal-manual:${task.id}` }, { project: task.project, target: task.id, kind: "note",
        text: `[调度引擎] ${task.id} ${p.reason}（台账 #${plan.seq}）`, data: { audience: "owner", op: "refusal_owner_manual", kind: "action", recordSeq: plan.seq } });
    }
    return { duplicate: false, decision: d, plan, epoch, cancelled, informed, text: plan.text };
  }).immediate();
}

/** 一条台账事件（ledger-write appendEvent：note，带 dedupKey 的按键去重；外层已在写事务里，它嵌套成保存点） */
const put = (db: Database, ctx: Ctx, e: { project: string; target: string; kind: "note"; text: string; data: Record<string, unknown> }): LedgerEvent =>
  appendEvent(db, ctx, e).event;

/** owner 规矩的批准（REFA 同一个口）与 approvalLapse 同一口径 */
function readApproval(db: Database, task: LedgerTask): { id: string } | { lapse: string } {
  let id: string | undefined;
  try { id = createRefusalApprovalPort(db)(task.project, task.id)?.approvalId; } catch (e) { return { lapse: `读批准失败：${(e as Error).message}` }; }
  const lapse = approvalLapse(db, task, id);
  return lapse || !id ? { lapse: lapse ?? "没有批准" } : { id };
}

/** 撤单（结果不明 → cancelled，CAS），收掉 worker 的卡、借步骤绑定；原件（wire / text）保留 */
function cancelOrder(db: Database, ctx: WriteCtx, o: LendOrder, reason: string, now: number): boolean {
  const r = db.prepare("UPDATE lend_orders SET status = 'cancelled', reason = ?, updatedAt = ? WHERE orderId = ? AND status = ?").run(reason, now, o.orderId, o.status);
  if (r.changes === 0) throw new LedgerError("conflict", `出借单 ${o.orderId} 状态已变`);
  closeSettledOrderAsks(db, o.orderId, now);
  if (o.worker) db.prepare("DELETE FROM task_steps WHERE taskId = ? AND step = ? AND round = ? AND executorKind = 'peer' AND executor = ? AND state = 'assigned'")
    .run(o.taskId, o.step, o.round, `${o.worker}@${o.peer}`);
  put(db, ctx, { project: o.project, target: o.taskId, kind: "note", text: `出借：撤单（原状态 ${o.status}）：${reason}`,
    data: { lend: { orderId: o.orderId, peer: o.peer, op: "cancel", from: o.status, code: POOL_REFUSAL_CANCEL } } });
  return true;
}
