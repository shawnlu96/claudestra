/**
 * CINOOP1 · noChange 交付的接收与恢复事务（恢复键 ciNoChangeRecovery）。两个入口（出借交付 ledger-lend-result.ts、本机
 * `ledger deliver --no-change`）共用：先核资格 → 读外部证据（ci-no-change-evidence.ts）→ 一个事务里重核全部再写。
 * - out_of_scope_ci：卡仍在 fix，进 fix 的那次退回是同 head 的 ci_fail 且之后没有别的阶段 / 交付 / 审查；原轮原规格同 head 的正式审查
 *   仍过合并闸（scheduler-merge.ts mergeReviewProof，不另写一份）；同 head 最新 CI 全绿才在一个事务里记 noChange 交付、受控 fix→merge
 *   （round / specRev / head 不变，不经 ledger-stages 的通用跳转表）、结算修复步骤。只取得重新入队资格，合并仍由正常合并闸决定。
 *   每卡同 head + 规格最多成功一次（按台账里的恢复阶段事件数，重启 / 新订单不重置）。
 * - main_already_resolved：MAINRED1 生成的卡（main_red_fix_node、source=mainRedFix、节点仍绑本卡），当前 main 与同 workflow 最新 run 已绿：
 *   原子取消卡、结算步骤与未发出的意图、记解决证据；不进 review / merge，不算修好。
 * 两个入口都要把真实订单交进来：单号、起点 head、这一单的步骤行（step / round / executor）与调用方自己的重核；写事务里步骤行必须恰好结一行。
 * 同单的成功结果按 `no-change:<单号>` 去重键存一份（含摘要），同一份重放返回原 outcome，换理由 / 证据拒覆盖。
 * off：不收（普通交付照旧）；observe：只记一条拟动作，不推阶段、不结算。tests/ci-no-change-recovery.test.ts。
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { defaultNoChangePort, readMainResolved, readOutOfScope, type CiNoChangePort, type Evidence } from "./ci-no-change-evidence.js";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { stepAtStage, stepsOf } from "./ledger-steps.js";
import { currentOrders, type CurrentOrder } from "./order-take.js";
import { refuse } from "./ledger-lend.js";
import { getWorkflow, type TaskWorkflow } from "./ledger-scheduler.js";
import { releaseFinishedCardLeases } from "./ledger-scheduler-lease.js";
import { TERMINAL_STAGES, type LedgerEvent, type LedgerTask } from "./ledger-stages.js";
import { parseExtraRepo } from "./ledger-probes.js";
import { getEventByDedup, LedgerError, listEvents } from "./ledger-store.js";
import { NO_CHANGE_WRITE_PORTS } from "./ledger-write.js";
import { mainRedNodes, nodeState } from "./main-red-fix-place.js";
import { SOURCE, workflowOf } from "./main-red-fix.js";
import { NO_CHANGE_DELIVER_OP, noChangeDedupKey, noChangeDigest, noChangeHeadRefusal, noChangeReplay, noChangeStepRefusal, parseNoChangeText, runRef, type MainAlreadyResolved, type NoChange,
  type OutOfScopeCi } from "./order-no-change.js";
import { noteDefaultOn } from "./recovery-key-defaults.js";
import { decideRecovery, recordObserved, recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import { currentReviewFacts, type ReviewFacts } from "./scheduler-review.js";
import { fixBounce } from "./scheduler-merge-conflict.js";
import { getMergeRun, mergeReviewProof } from "./scheduler-merge.js";

const { transaction: tx, insert: insertEvent } = NO_CHANGE_WRITE_PORTS;

const NO_CHANGE_KEY = "ciNoChangeRecovery" as const;
const SHA = /^[0-9a-f]{40}$/;

export interface NoChangeDeps {
  port: CiNoChangePort;
  policy?: RecoveryPolicyPort;
  /** 原审查有效性：缺省 = 合并闸同一判定（scheduler-merge.ts mergeReviewProof），失效就抛 */
  reviewProof?: (db: Database, task: LedgerTask, workflow: TaskWorkflow) => ReviewFacts;
  now: () => number;
}

/** 这一单在 task_steps 里的那一行（写事务按它结算，结不到恰好一行整笔拒） */
interface NoChangeStep { step: "write" | "fix"; round: number; executor: string }

/**
 * 调用方（出借单 / 本机单）绑定的那一单；start = 订单原始快照里的起点 head（出借单 lend_orders.head、本机单派单 plan 事件的 head；没有起点证据的单调用方就拒）；
 * recheck 在写事务里重核调用方自己的身份、会话、租约、撤单、订单仍是当前的单等，不过就抛
 */
export interface NoChangeBinding {
  orderId: string; taskId: string; head: string; start: string; step: NoChangeStep; specRev: number; round: number; repo: string; evidence: string;
  recheck(db: Database): void;
}

export type NoChangeOutcome<T> = { outcome: "recovered" | "cancelled"; eventSeq: number; duplicate: boolean; settled: T };

interface CiPlan { kind: "out_of_scope_ci"; bounceSeq: number; reviewSeq: number; intentId: string; required: string[]; pr: number }
interface MainPlan { kind: "main_already_resolved"; nodeSeq: number; sourceRunId: number; workflowFile: string; event: string | null; workflow: string }
type Plan = CiPlan | MainPlan;

const dedupOf = (b: Pick<NoChangeBinding, "orderId">) => noChangeDedupKey(b.orderId);
const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/;

/** 同一单已入账的 noChange（order-no-change.ts noChangeReplay）：同一份 → 原事件；换了理由 / 证据 → 拒覆盖 */
function replayed(db: Database, orderId: string, nc: NoChange, who: { taskId?: string; head?: string; actor?: string }): (LedgerEvent & { outcome: "recovered" | "cancelled" }) | null {
  const r = noChangeReplay(db, orderId, nc, who);
  if (r.kind === "conflict") refuse("conflict", "这一单已用另一份 noChange 入账，不覆盖");
  return r.kind === "same" ? { ...r.event, outcome: r.outcome } : null;
}

/** 正式单的 noChange 回执（本机入口在核「当前的单」之前先查它：成功后卡已离开 build / fix）；没入账 = null，换了份 = 抛 conflict */
function noChangeReceipt(db: Database, orderId: string, nc: NoChange, who: { head: string; actor: string }):
  { taskId: string; eventSeq: number; outcome: "recovered" | "cancelled" } | null {
  const prev = replayed(db, orderId, nc, who);
  return prev && { taskId: prev.target, eventSeq: prev.seq, outcome: prev.outcome };
}

/** 规格材料：订单原文摘要没变，且持单期间没有规格追加转给对方（lend_relays kind=spec） */
export function orderSnapshotProblem(db: Database, o: { orderId: string; text: string; sha256: string }): string | null {
  if (createHash("sha256").update(o.text, "utf8").digest("hex") !== o.sha256) return "订单原文摘要与挂单快照不一致";
  const relays = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lend_relays'").get();
  if (relays && db.query("SELECT 1 FROM lend_relays WHERE orderId = ? AND kind = 'spec' LIMIT 1").get(o.orderId)) return "持单期间规格有追加，材料与订单快照不一致";
  return null;
}

function cardCommon(db: Database, task: LedgerTask, b: NoChangeBinding): TaskWorkflow {
  if (task.kind !== "code" || TERMINAL_STAGES.includes(task.stage)) refuse("invalid", `卡 ${task.id} 在 ${task.stage}，不收 noChange`);
  if (task.specRev !== b.specRev || task.round !== b.round) refuse("invalid", "卡的规格版本或轮次已不是这一单的");
  const wf = getWorkflow(db, task.id);
  if (!wf || wf.mode !== "auto" || wf.specRev !== task.specRev) refuse("invalid", "卡不在自动流程里（manual / 暂停 / 规格已变），noChange 不清除人工处置");
  const unknown = db.query("SELECT id FROM scheduler_intents WHERE taskId = ? AND status = 'unknown' LIMIT 1").get(task.id) as { id: string } | null;
  if (unknown) refuse("invalid", `调度意图 ${unknown.id} 结果未知（可能有外部合并），交 PM 核对`);
  return wf!;
}

/** out_of_scope_ci 的资格：只读台账，不过就抛 */
function ciPlan(db: Database, task: LedgerTask, b: NoChangeBinding, nc: OutOfScopeCi, deps: NoChangeDeps): CiPlan {
  const wf = cardCommon(db, task, b);
  if (task.stage !== "fix" || task.headSHA !== b.head) refuse("invalid", "out_of_scope_ci 只收仍在 fix、head 未变的卡");
  const events = listEvents(db, { project: task.project, target: task.id });
  const enter = events.findLast((e) => e.kind === "stage" && e.data.to === "fix");
  const bounce = fixBounce(events, "fix");
  if (!enter || bounce?.cause !== "ci_fail" || bounce.prHead.toLowerCase() !== b.head) refuse("invalid", "进 fix 的不是同 head 的 CI 失败退回（ci_fail），不走此出口");
  const later = events.filter((e) => e.seq > enter!.seq && (e.kind === "stage" || e.kind === "deliver" || e.kind === "review"));
  if (later.length) refuse("invalid", `退回之后已有别的${later[0]!.kind}事件 #${later[0]!.seq}，不是单纯的 CI 退回`);
  if (events.some((e) => e.kind === "stage" && (e.data.noChangeRecovery as { head?: unknown } | undefined)?.head === b.head && e.data.specRev === task.specRev)) {
    refuse("conflict", "本卡同 head / 规格已用 noChange 恢复过一次，这次 CI 再红交 PM");
  }
  const runId = runRef(nc.run)!.runId;
  if (!bounce!.checks.some((c) => runRef(c.link.replace(/\/job\/\d+$/, ""))?.runId === runId)) refuse("invalid", "run 不是退回回执里失败的那个 run");
  const conflict = events.find((e) => e.seq > enter!.seq && e.kind === "scheduler" && e.data.op === "merge_conflict" && e.data.cause === "ci_fail");
  const run = typeof conflict?.data.intentId === "string" ? getMergeRun(db, conflict.data.intentId) : null;
  if (!run) refuse("invalid", "找不到这次退回的合并运行（required 清单），核不了 CI");
  const pr = PR_URL.exec(task.pr ?? "");
  if (!pr || pr[1]!.toLowerCase() !== b.repo.toLowerCase()) refuse("invalid", "卡上没有这一仓库的完整 PR 链接");
  let review: ReviewFacts;
  try { review = (deps.reviewProof ?? mergeReviewProof)(db, task, wf); } catch (e) { return refuse("invalid", `原审查已不能放行：${(e as Error).message}`); }
  if (review.round !== task.round || review.head.toLowerCase() !== b.head || review.eventSeq > enter!.seq) refuse("invalid", "通过的审查不是原轮、同 head、退回之前的那一份");
  return { kind: "out_of_scope_ci", bounceSeq: enter!.seq, reviewSeq: review.eventSeq, intentId: run!.intentId, required: run!.requiredChecks.split(","), pr: Number(pr![2]) };
}

/** main_already_resolved 的资格：真实 MAINRED1 来源且节点仍绑本卡；卡可能还在 build、head 为空 */
function mainPlan(db: Database, task: LedgerTask, b: NoChangeBinding): MainPlan {
  cardCommon(db, task, b);
  if (task.stage !== "build" && task.stage !== "fix") refuse("invalid", "main_already_resolved 只收 build / fix 阶段的卡");
  if ((task.headSHA && task.headSHA !== b.head) || b.start !== b.head) refuse("invalid", "交付 head 不是订单起点 / 卡的当前 head（有新增改动）");
  const node = mainRedNodes(db, task.project).findLast((n) => n.taskId === task.id) as (ReturnType<typeof mainRedNodes>[number] & { source?: unknown }) | undefined;
  if (!node || node.source !== SOURCE || task.featureId !== node.featureId || nodeState(db, node).node?.taskId !== task.id) {
    refuse("invalid", "本卡没有仍然有效的 MAINRED1 来源（main_red_fix_node / source=mainRedFix / 节点绑定）");
  }
  const read = currentReviewFacts(task, listEvents(db, { project: task.project, target: task.id }));
  if (read.kind === "facts" && read.facts.findings.some((f) => f.severity === "P0" || f.severity === "P1")) refuse("invalid", "本卡还有未修的 P0 / P1");
  const w = workflowOf(node!.workflow);
  return { kind: "main_already_resolved", nodeSeq: node!.seq, sourceRunId: node!.runId, workflowFile: w.file, event: w.event, workflow: node!.workflow };
}

const planOf = (db: Database, task: LedgerTask, b: NoChangeBinding, nc: NoChange, deps: NoChangeDeps): Plan =>
  nc.kind === "out_of_scope_ci" ? ciPlan(db, task, b, nc, deps) : mainPlan(db, task, b);

async function evidenceOf(plan: Plan, b: NoChangeBinding, nc: NoChange, port: CiNoChangePort): Promise<Evidence<Record<string, unknown>>> {
  if (plan.kind === "out_of_scope_ci") {
    const r = await readOutOfScope(port, { repo: b.repo, pr: plan.pr, head: b.head, required: plan.required }, nc as OutOfScopeCi);
    return r.ok ? { ok: true, facts: { ...r.facts, checks: r.facts.checks.map((c) => `${c.name}:${c.conclusion}`) } } : r;
  }
  const r = await readMainResolved(port, { repo: b.repo, workflowFile: plan.workflowFile, event: plan.event, sourceRunId: plan.sourceRunId, head: b.head, start: b.start },
    nc as MainAlreadyResolved);
  return r.ok ? { ok: true, facts: { ...r.facts } } : r;
}

const policyMode = (deps: NoChangeDeps, project: string) => (deps.policy ?? recoveryPolicy)(project, NO_CHANGE_KEY);

/**
 * 入口：资格 → 证据 → 事务（重核调用方绑定、策略、卡 rev、资格与原计划一致，再写；settle 是调用方在同一事务里的结算——签回执、
 * 结出借单——它抛错整笔回滚）。未恢复一律抛 lend 码：unavailable = 证据未定 / 期间有变，可待变化后重交；invalid / conflict = 不收。
 */
export async function admitNoChange<T>(db: Database, ctx: WriteCtx, b: NoChangeBinding, nc: NoChange, deps: NoChangeDeps,
  settle: (eventSeq: number, duplicate: boolean) => T): Promise<NoChangeOutcome<T>> {
  if (!SHA.test(b.head)) refuse("invalid", "noChange 交付的 head 要是小写完整 40 位 SHA");
  const who = { taskId: b.taskId, head: b.head };
  const prev = replayed(db, b.orderId, nc, who);
  if (prev) return { outcome: prev.outcome, eventSeq: prev.seq, duplicate: true, settled: settle(prev.seq, true) };
  if (nc.kind === "out_of_scope_ci" && b.start !== b.head) refuse("invalid", "out_of_scope_ci 的交付 head 必须就是订单起点");
  const now = deps.now();
  const task = mustTask(db, b.taskId);
  const policy = noteDefaultOn(db, { project: task.project, mechanism: NO_CHANGE_KEY }, policyMode(deps, task.project), now);
  const decision = decideRecovery(policy);
  if (decision.kind === "skip") refuse("invalid", `${NO_CHANGE_KEY} 是 off（${decision.reason}）：不收 noChange 交付，未恢复`);
  const plan = planOf(db, task, b, nc, deps);
  const ev = await evidenceOf(plan, b, nc, deps.port);
  if (!ev.ok) return refuse(ev.code, `未恢复：${ev.why}`);
  const facts = ev.facts;
  if (decision.kind === "observe") {
    recordObserved(db, { project: task.project, mechanism: NO_CHANGE_KEY, target: task.id, actionKey: `${nc.kind}:${b.head}:s${b.specRev}`,
      action: nc.kind === "out_of_scope_ci" ? "同轮 fix→merge 恢复" : "取消已由 main 解决的修复卡", data: { orderId: b.orderId, plan } }, now);
    refuse("unavailable", `${NO_CHANGE_KEY} 是 observe：只记了拟动作，卡未恢复`);
  }
  return tx(db, () => {
    const again = replayed(db, b.orderId, nc, who);
    if (again) return { outcome: again.outcome, eventSeq: again.seq, duplicate: true, settled: settle(again.seq, true) };
    b.recheck(db);
    if (policyMode(deps, task.project).mode !== "on") refuse("unavailable", `${NO_CHANGE_KEY} 策略已变，未恢复`);
    const cur = mustTask(db, b.taskId);
    if (cur.rev !== task.rev) refuse("unavailable", "核对外部证据期间卡被改过，未恢复；稍后重交");
    const fresh = planOf(db, cur, b, nc, deps);
    if (JSON.stringify(fresh) !== JSON.stringify(plan)) refuse("unavailable", "核对期间退回 / 审查 / 来源变了，未恢复；稍后重交");
    const ctxNow = { ...ctx, now: ctx.now ?? now };
    const eventSeq = fresh.kind === "out_of_scope_ci" ? writeRecovered(db, ctxNow, cur, b, nc as OutOfScopeCi, fresh, facts)
      : writeCancelled(db, ctxNow, cur, b, nc as MainAlreadyResolved, fresh, facts);
    return { outcome: fresh.kind === "out_of_scope_ci" ? "recovered" : "cancelled", eventSeq, duplicate: false, settled: settle(eventSeq, false) } as NoChangeOutcome<T>;
  });
}

function moveCard(db: Database, task: LedgerTask, to: "merge" | "cancelled", now: number): void {
  const r = db.prepare("UPDATE tasks SET stage = ?, stageBefore = NULL, rev = rev + 1, updatedAt = ? WHERE id = ? AND rev = ? AND stage = ?").run(to, now, task.id, task.rev, task.stage);
  if (r.changes !== 1) refuse("unavailable", "卡在写入时已变，未恢复");
}

/** 结算这一单的步骤行：必须恰好一行仍是 assigned（步骤被删 / 已结 / 换人都整笔拒，阶段不能脱离步骤单独推） */
function settleStep(db: Database, task: LedgerTask, s: NoChangeStep, state: "delivered" | "done", head: string | null, now: number): void {
  const r = db.prepare(`UPDATE task_steps SET state = ?, headFrom = COALESCE(?, headFrom), headTo = COALESCE(?, headTo), rev = rev + 1, updatedAt = ?
    WHERE taskId = ? AND step = ? AND round = ? AND executor = ? AND state = 'assigned'`).run(state, head, head, now, task.id, s.step, s.round, s.executor);
  if (r.changes !== 1) refuse("invalid", `这一单的 ${s.step} 步骤（第 ${s.round} 次、${s.executor}）已不是待交状态，未恢复`);
}

/** 记 noChange 交付 → 受控 fix→merge（轮次 / 规格 / head 不变）→ 修复步骤记为已交（head 不变）；返回交付事件号 */
function writeRecovered(db: Database, ctx: WriteCtx & { now: number }, task: LedgerTask, b: NoChangeBinding, nc: OutOfScopeCi, plan: CiPlan, facts: Record<string, unknown>): number {
  const base = { project: task.project, target: task.id };
  const d = insertEvent(db, { ...ctx, dedupKey: dedupOf(b) }, { ...base, kind: "deliver", text: `无需改码交付（out_of_scope_ci，单号 ${b.orderId}）：${nc.reason.slice(0, 300)}`,
    data: { op: NO_CHANGE_DELIVER_OP, round: task.round, headSHA: b.head, evidence: b.evidence, noChange: nc, noChangeDigest: noChangeDigest(nc), noChangeHead: b.head,
      orderId: b.orderId } }, true);
  moveCard(db, task, "merge", ctx.now);
  settleStep(db, task, b.step, "delivered", b.head, ctx.now);
  insertEvent(db, ctx, { ...base, kind: "step", data: { op: "deliver", step: b.step.step, round: b.step.round, headFrom: b.head, headTo: b.head, noChange: true } }, false);
  insertEvent(db, ctx, { ...base, kind: "stage", text: "无需改码：原审查仍有效、同 head 最新 CI 全绿，同轮恢复到 merge（重新入队，合并仍由合并闸决定）",
    data: { from: "fix", to: "merge", round: task.round, specRev: task.specRev, head: b.head, noChangeRecovery: { deliverSeq: d.seq, bounceSeq: plan.bounceSeq,
      reviewSeq: plan.reviewSeq, intentId: plan.intentId, head: b.head, orderId: b.orderId, count: 1, ...facts } } }, false);
  releaseFinishedCardLeases(db, task.id);
  return d.seq;
}

/** main 已解决：记解决证据（note，不冒充交付）→ 取消卡 → 当前步骤结掉、未发出的意图撤销；返回证据事件号 */
function writeCancelled(db: Database, ctx: WriteCtx & { now: number }, task: LedgerTask, b: NoChangeBinding, nc: MainAlreadyResolved, plan: MainPlan, facts: Record<string, unknown>): number {
  const base = { project: task.project, target: task.id };
  const n = insertEvent(db, { ...ctx, dedupKey: dedupOf(b) }, { ...base, kind: "note", text: `main 已解决（MAINRED1 run ${plan.sourceRunId}），无需改码，取消本卡：${nc.reason.slice(0, 300)}`,
    data: { op: "no_change_resolved", noChange: nc, noChangeDigest: noChangeDigest(nc), noChangeHead: b.head, orderId: b.orderId, nodeSeq: plan.nodeSeq, ...facts } }, true);
  moveCard(db, task, "cancelled", ctx.now);
  settleStep(db, task, b.step, "done", null, ctx.now);
  const open = db.query("SELECT id, status FROM scheduler_intents WHERE taskId = ? AND status IN ('pending','submitted')").all(task.id) as { id: string; status: string }[];
  for (const i of open) {
    db.prepare("UPDATE scheduler_intents SET status = 'cancelled', receipt = ?, updatedAt = ? WHERE id = ?").run(`main 已解决，noChange 取消（#${n.seq}）`, ctx.now, i.id);
    db.prepare("DELETE FROM scheduler_resources WHERE intentId = ? AND scope = 'intent'").run(i.id);
    insertEvent(db, ctx, { ...base, kind: "scheduler", text: "调度意图 cancelled", data: { op: "settle", id: i.id, from: i.status, to: "cancelled", receipt: `noChange #${n.seq}` } }, false);
  }
  insertEvent(db, ctx, { ...base, kind: "stage", text: "main 已解决、无需改码：取消（不是修好，不进 review / merge）",
    data: { from: task.stage, to: "cancelled", round: task.round, specRev: task.specRev, noChangeResolved: { noteSeq: n.seq, nodeSeq: plan.nodeSeq, orderId: b.orderId, ...facts } } }, false);
  releaseFinishedCardLeases(db, task.id);
  return n.seq;
}

const repoOfTask = (task: LedgerTask): string | null => {
  const pr = PR_URL.exec(task.pr ?? "");
  if (pr) return pr[1]!.toLowerCase();
  try { return parseExtraRepo(task.extra?.repo); } catch { return null; /* 坏的 extra.repo 等于没有仓库坐标：下面按缺仓库拒，不猜 */ }
};

/** 本机的「当前的单」（order-take.ts 同一口径：步骤派给调用方、会话绑定、派单意图 / 手动单号、没借出去）；不是就抛 */
function localOrder(db: Database, taskId: string, actor: string, session: string | null, orderId: string): { order: CurrentOrder; step: NoChangeStep } {
  const cur = currentOrders(db, { agent: actor, sessionId: session, family: null, channelId: "" }).find((o) => o.orderId === orderId && o.task.id === taskId);
  if (!cur) refuse("invalid", `${orderId} 不是 ${actor} 在 ${taskId} 上当前的单（会话 / 步骤 / 派单不对，或卡已被收回）`);
  const at = stepAtStage(stepsOf(db, cur!.task), cur!.task);
  if (!at || at.derived || at.state !== "assigned" || at.step !== cur!.step) refuse("invalid", "这一单没有待交的步骤行，不收 noChange");
  return { order: cur!, step: { step: cur!.step, round: at!.round, executor: at!.executor } };
}

/**
 * 本机单的原始快照 = 调度派单意图的 plan 事件（ledger-scheduler-write.ts 落意图时同笔写、按 `scheduler:<意图>` 去重，之后不改）：起点 head、规格版本、轮次
 * 都取它，再与意图行、当前卡逐项比较；手动单（没有派单快照）、派单时卡上没有 head（证明不了执行副本没有新增改动）都拒，不拿当前卡 head 或 main 祖先顶替。
 * 本机单的规格材料随 specRev 走（改规格 = 回 spec、specRev+1），所以 specRev 一致即材料与派单时一致。返回起点 head。
 */
function orderStart(db: Database, o: CurrentOrder, actor: string): string {
  if (!o.intent) refuse("invalid", "这一单是手动派的，没有派单快照（起点 head / 规格版本），不收 noChange：请 PM 处置");
  const i = o.intent!, plan = getEventByDedup(db, `scheduler:${i.id}`);
  const d = plan?.kind === "scheduler" && plan.target === o.task.id && plan.data.op === "plan" && plan.data.id === i.id ? plan.data : null;
  if (!d || i.recipient !== actor) refuse("invalid", `找不到 ${i.id} 派给 ${actor} 的派单快照，不收 noChange`);
  if (typeof d!.head !== "string" || !SHA.test(d!.head)) refuse("invalid", "派单时卡上没有起点 head：证明不了执行副本没有新增改动，不收 noChange");
  const start = d!.head as string;
  if (i.head !== start || i.specRev !== d!.specRev || d!.specRev !== o.task.specRev || d!.round !== o.task.round) {
    refuse("invalid", "派单快照的起点 / 规格版本 / 轮次与意图或当前卡不一致，不收 noChange");
  }
  if (o.task.headSHA !== start) refuse("invalid", `卡的当前 head 已不是派单起点 ${start.slice(0, 12)}（有新增改动），不收 noChange`);
  return start;
}

/**
 * 本机入口（`ledger deliver <task> --no-change <json> --head <sha> --order <单号> [--session <id>]`；MCP deliver 带 noChange 时由 bridge 以执行者身份、
 * 用调用方的单号与会话调它）：必须是调用方本人当前的、调度派出的单，起点 = 派单快照的 head（orderStart）；单号、会话、步骤、快照起点与 --rev / --branch
 * 在写事务里重核。同单已入账的先按单号回放（卡已到 merge / cancelled，当前单核对会误拒原样重试）。
 */
export async function deliverNoChangeLocal(db: Database, ctx: WriteCtx, task: LedgerTask, flags: Record<string, string | undefined>, now: () => number,
  deps: Partial<NoChangeDeps> = {}): Promise<Record<string, unknown>> {
  const nc = parseNoChangeText(flags["no-change"] ?? "");
  if (!nc.ok) throw new LedgerError("invalid", nc.error);
  if (flags.from !== undefined || flags["ui-evidence"] !== undefined || flags.disputes !== undefined) throw new LedgerError("invalid", "--no-change 不和 --from / --ui-evidence / --disputes 同用");
  const { head, order: orderId } = flags;
  if (!head) throw new LedgerError("invalid", "--no-change 要带 --head（卡的当前 head，不推空提交）");
  if (!orderId) throw new LedgerError("invalid", "--no-change 要带 --order <你当前的单号>（take_order 给的 orderId）");
  const done = noChangeReceipt(db, orderId, nc.value, { head, actor: ctx.actor });
  if (done && done.taskId !== task.id) refuse("conflict", "这个单号已用在别的卡上");
  if (done) return { ok: true, task: mustTask(db, task.id), duplicate: true, eventSeq: done.eventSeq, noChange: { outcome: done.outcome, eventSeq: done.eventSeq } };
  const session = flags.session ?? null;
  const bound = localOrder(db, task.id, ctx.actor, session, orderId);
  const stepBad = noChangeStepRefusal(bound.step.step, nc.value);
  if (stepBad) throw new LedgerError("invalid", stepBad);
  const start = orderStart(db, bound.order, ctx.actor);
  const bad = noChangeHeadRefusal(start, head, nc.value);
  if (bad) throw new LedgerError("invalid", bad);
  const repo = repoOfTask(task);
  if (!repo) throw new LedgerError("invalid", "卡上没有完整 PR 链接或 extra.repo，核不了外部 CI");
  const rev = flags.rev === undefined ? undefined : Number(flags.rev);
  if (rev !== undefined && task.rev !== rev) refuse("unavailable", "卡已不是 --rev 给的版本，重新核对后再交");
  const binding: NoChangeBinding = { orderId, taskId: task.id, head, start, step: bound.step, specRev: task.specRev, round: task.round,
    repo, evidence: flags.evidence ?? "", recheck: (d) => {
      const again = localOrder(d, task.id, ctx.actor, session, orderId);
      if (JSON.stringify(again.step) !== JSON.stringify(bound.step) || orderStart(d, again.order, ctx.actor) !== start) refuse("unavailable", "核对期间这一单的步骤或起点变了，未恢复");
      if ((rev !== undefined && again.order.task.rev !== rev) || (flags.branch !== undefined && again.order.task.branch !== flags.branch)) refuse("unavailable", "卡在核对之后被改过，重新核对后再交");
    } };
  const r = await admitNoChange(db, { actor: ctx.actor, now: ctx.now }, binding, nc.value,
    { port: deps.port ?? defaultNoChangePort(), policy: deps.policy, reviewProof: deps.reviewProof, now }, () => null);
  return { ok: true, task: mustTask(db, task.id), duplicate: r.duplicate, eventSeq: r.eventSeq, noChange: { outcome: r.outcome, eventSeq: r.eventSeq } };
}
