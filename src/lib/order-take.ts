import { convergenceOrderLines } from "./fix-strategy-order.js";
/**
 * 执行者「当前的单」（M2 take_order / deliver 共用，只读台账）：阶段在 build / fix、这一阶段在干活的那一步（stepAtStage）派给了
 * 调用方 agent 的卡；卡上有未退役的作者会话绑定（scheduler_sessions）时，绑定的 agent 与会话也必须就是调用方——
 * 同一 agent 换了会话（/clear 之外的另起一个）就不算，防串单。调用方只来自身份（lib/order-tool-route.ts VerifiedCall）。
 * orderId：调度器派的单 = 那条 dispatch intent 的 id；PM 手动派的单 = `<task>:<step>:r<round>`（T87 的 ORDER_ID 不收 #）。
 * tests/order-take.test.ts。
 */
import type { Database } from "bun:sqlite";
import { getWorkflow } from "./ledger-scheduler.js";
import { getTask, listEvents } from "./ledger-store.js";
import type { LedgerTask } from "./ledger-stages.js";
import { stepAtStage, stepsOf } from "./ledger-steps.js";
import { isFullSha, parseOrderWire, WIRE_LIMITS, type OrderWire } from "./order-wire.js";
import type { SchedulerIntent } from "./ledger-scheduler.js";
import { getSchedulerSession } from "./scheduler-sessions.js";
import type { VerifiedCall } from "./order-tool-route.js";
import { SRC_DIR } from "./repo-root.js";
import { clipWire, fitFindings, wireFindings } from "./order-findings.js";
import { currentReviewFacts } from "./scheduler-review.js";
import { bounceWork, fixBounce } from "./scheduler-merge-conflict.js";
import { uiRejectFixFor } from "./ledger-ui-approve-verdict.js";
import { standardAnswers } from "./order-standard-answers.js";
import { isPoolIntent, POOL_RECIPIENT } from "./scheduler-pool-plan.js";
import { lentAwayText } from "./ledger-lend-relay.js";
import { withMemory } from "./memory-retrieve-order.js";

type WorkStage = "build" | "fix";
export interface CurrentOrder {
  task: LedgerTask;
  stage: WorkStage;
  step: "write" | "fix";
  orderId: string;
  /** 调度器派的单才有 */
  intent: SchedulerIntent | null;
}

const hasTable = (db: Database, t: string): boolean => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);

/** PM 手动派的单：`<task>:<step>:r<round>`（执行者单与审查单同一口径，lib/review-order.ts 也用它） */
export const manualOrderId = (taskId: string, step: string, round: number): string => `${taskId}:${step}:r${round}`;

/** 进入当前阶段的那条 stage 事件的 seq：它之前规划的 dispatch 属于上一轮，不能拿来当这一轮的单号 */
function stageEnteredSeq(db: Database, task: LedgerTask): number {
  const r = db.query("SELECT MAX(seq) AS s FROM events WHERE target = ? AND kind = 'stage' AND json_extract(data, '$.to') = ?").get(task.id, task.stage) as { s: number | null };
  return r?.s ?? 0;
}

/** 这一阶段的调度派单：写 / 修节点的 dispatch intent，规划在进入本阶段之后、specRev 一致、没被取消；多条取最新 */
function currentIntent(db: Database, task: LedgerTask, step: "write" | "fix"): SchedulerIntent | null {
  if (!hasTable(db, "scheduler_intents")) return null;
  const rows = db.query(`SELECT * FROM scheduler_intents WHERE taskId = ? AND action = 'dispatch' AND node = ? AND status != 'cancelled'
    AND specRev = ? AND eventSeq > ? ORDER BY eventSeq DESC LIMIT 1`).all(task.id, step, task.specRev, stageEnteredSeq(db, task)) as SchedulerIntent[];
  return rows[0] ?? null;
}

/** 卡上的作者会话绑定（没退役的）要是调用方本人本会话；没有绑定 = 手动派的卡，只看步骤执行者 */
function bindingAllows(db: Database, taskId: string, call: VerifiedCall): boolean {
  const s = getSchedulerSession(db, taskId, "author");
  if (!s || s.state === "retired") return true;
  return s.agent === call.agent && !!call.sessionId && s.sessionId === call.sessionId;
}

/** 这张卡这一轮的代码在出借方写（i28-RS1）：有未结的写 / 修出借单，或这一阶段的派单意图挂给了 peer（挂池了、还没出单也算） */
export interface LentAway { taskId: string; peer: string; orderId: string; note: string }

function lentAway(db: Database, task: LedgerTask, intent: SchedulerIntent | null): LentAway | null {
  const live = hasTable(db, "lend_orders") ? db.query(`SELECT orderId, peer FROM lend_orders WHERE taskId = ? AND step IN ('write','fix')
    AND status IN ('pooled','claimed','unknown') ORDER BY createdAt DESC LIMIT 1`).get(task.id) as { orderId: string; peer: string } | null : null;
  const away = live ?? (intent && isPoolIntent(intent) ? { orderId: intent.id, peer: (intent.recipient as string).slice(POOL_RECIPIENT.length) } : null);
  return away && { taskId: task.id, ...away, note: lentAwayText(away.peer, away.orderId, task.id) };
}

function scanOrders(db: Database, call: VerifiedCall): { orders: CurrentOrder[]; away: LentAway[] } {
  const ids = db.query("SELECT id FROM tasks WHERE stage IN ('build', 'fix') ORDER BY updatedAt DESC, id").all() as { id: string }[];
  const out: CurrentOrder[] = [];
  const away: LentAway[] = [];
  for (const { id } of ids) {
    const task = getTask(db, id);
    if (!task || (task.stage !== "build" && task.stage !== "fix")) continue;
    const at = stepAtStage(stepsOf(db, task), task);
    if (!at || at.executorKind !== "agent" || at.executor !== call.agent) continue;
    if (!bindingAllows(db, task.id, call)) continue;
    const step = task.stage === "fix" ? "fix" : "write";
    const intent = currentIntent(db, task, step);
    // 写单挂给了 peer（或已被 peer 领走）：本机会话只做复述，不把这张单发给它，换成说明（i28-RS1）
    const lent = lentAway(db, task, intent);
    if (lent) {
      away.push(lent);
      continue;
    }
    out.push({ task, stage: task.stage, step, orderId: intent?.id ?? manualOrderId(task.id, step, task.round), intent });
  }
  return { orders: out, away };
}

export const currentOrders = (db: Database, call: VerifiedCall): CurrentOrder[] => scanOrders(db, call).orders;

/**
 * take_order 的结果（bridge/order-tools.ts）：当前的单，多张时取最近动过的一张、其余单号一并给；没有单但有借出去的卡时，order 为空、
 * note 是固定说明（「本卡代码由 <peer> 写…」），不是一张空单。
 */
export function takeOrderResult(db: Database | null, call: VerifiedCall):
  { ok: true; order: OrderWire | null; otherOrderIds?: string[]; note?: string } | { ok: false; error: string } {
  if (!db) return { ok: true, order: null };
  const { orders, away } = scanOrders(db, call);
  if (!orders.length) return { ok: true, order: null, ...(away.length ? { note: away.map((a) => a.note).join("\n") } : {}) };
  const w = orderWireFor(db, orders[0]);
  if (!w.ok) return w;
  return { ok: true, order: w.order, ...(orders.length > 1 ? { otherOrderIds: orders.slice(1).map((o) => o.orderId) } : {}) };
}

function dagVersionOf(db: Database, task: LedgerTask): number | null {
  if (!task.featureId || !hasTable(db, "features")) return null;
  const r = db.query("SELECT currentVersion FROM features WHERE id = ?").get(task.featureId) as { currentVersion: number } | null;
  return r && r.currentVersion > 0 ? r.currentVersion : null;
}

const CLI = `bun ${SRC_DIR}/manager.ts ledger`;

/**
 * 修复单要带上这一轮审查的逐项结论与报告路径（和调度器 fixPackage 同一口径：currentReviewFacts 取本轮、本 head 的结论）；
 * 唤醒派单时执行者只看得到 take_order 的单，缺了它就只知道「要修」不知道修什么。写单 / 结论不完整时不带。
 */
function fixContext(db: Database, t: LedgerTask, step: "write" | "fix"): { findings: OrderWire["findings"]; report: string | null; bounce?: ReturnType<typeof bounceWork> } {
  if (step !== "fix") return { findings: [], report: null };
  const events = listEvents(db, { project: t.project, target: t.id });
  const bounce = fixBounce(events, t.stage); // 合并退回（冲突 / CI 红）不是修 P1：不带审查报告（scheduler-merge-conflict.ts）
  if (bounce) return { findings: [], report: null, bounce: bounceWork(bounce) };
  const ui = uiRejectFixFor(db, t, events, getWorkflow(db, t.id)?.template); // 同一退回来源的代码 findings / 报告与 PM 截图意见一起带上
  if (ui) return { findings: wireFindings(ui.findings), report: ui.reportPath };
  const read = currentReviewFacts(t, events);
  return read.kind === "facts" ? { findings: wireFindings(read.facts.findings), report: read.facts.reportPath } : { findings: [], report: null };
}

/** 给执行者的单：字段按 T87 OrderWire，交出去之前过一遍 parseOrderWire（台账里的脏值宁可报错，不发半张单） */
export function orderWireFor(db: Database, o: CurrentOrder): { ok: true; order: OrderWire } | { ok: false; error: string } {
  const t = o.task;
  const head = t.headSHA && isFullSha(t.headSHA) ? t.headSHA : null;
  const fix = fixContext(db, t, o.step);
  const fallback = getWorkflow(db, t.id)?.fallback ?? null;
  const wire = {
    v: 1, orderId: o.orderId, taskId: t.id, specRev: t.specRev, dagVersion: dagVersionOf(db, t), node: o.intent?.node ?? o.step, step: o.step, round: t.round,
    head, repo: null, pr: null,
    inputs: [`规格与验收：${CLI} show ${t.id}`, ...(t.spec ? [`规格卡：${t.spec}`] : []), ...(t.branch ? [`分支：${t.branch}`] : []),
      ...(fix.report ? [`上一轮审查报告：${fix.report}`] : []), ...(fix.bounce?.inputs ?? []), ...convergenceOrderLines(db, t), standardAnswers("author")],
    outputs: ["分支上的提交，已推到 origin（完整 head SHA）", "证据报告路径"],
    acceptance: fix.bounce?.acceptance ?? ["规格里的验收线逐条自查"],
    writeBack: `用 deliver 工具回写：orderId ${o.orderId}，head = 本卡分支在 origin 上的完整 SHA（bridge 会核对）。CLI 仍可用：${CLI} deliver ${t.id} --from ${o.stage} --head <完整 SHA> --evidence <报告路径>`,
    findings: fix.findings, fallback: fallback ? clipWire(`再不行退到：${fallback}`, WIRE_LIMITS.fallback) : null,
  };
  // 项目记忆一节最后放、只用剩余预算（memory-retrieve-order.ts）
  const parsed = parseOrderWire(withMemory(db, t, "write", head, fitFindings(wire, fix.report)));
  return parsed.ok ? { ok: true, order: parsed.value } : { ok: false, error: `台账里这张单的字段不合 OrderWire：${parsed.error}` };
}
