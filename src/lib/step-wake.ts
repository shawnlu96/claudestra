/**
 * `ledger step` 给本机 agent 派正式单后叫醒执行者（auto 卡归调度器）。文案是调度器 wake 行（renderWorkOrder 同一函数），只叫领单、不带正文，restate 也一样；
 * 单号取领单工具此刻现算的那张（take_order / take_review 领不到就不叫，推了阶段重跑 step 再叫）。
 * 只发一次：按有效派单（同一步同一轮连续派给同一人的第一条 step 事件 seq）在投递前用 dedupKey 原子认领；换过人再派回来是新派单。
 * 送达 / 结果不明 / 认领了没结果都不再发，只有确定没发出去（rejected）重跑 step 才重试。tests/step-wake.test.ts。
 */
import type { Database } from "bun:sqlite";
import { bridgeSend } from "./bridge-client.js";
import { getWorkflow } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask, StepName } from "./ledger-stages.js";
import { getMeta, getTask, listEvents } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import type { WriteCtx } from "./ledger-checks.js";
import { stepAtStage, stepsOf } from "./ledger-steps.js";
import { currentOrders, manualOrderId } from "./order-take.js";
import { isMasterName } from "./registry.js";
import { slotByOrderId } from "./review-order.js";
import { getSchedulerSession } from "./scheduler-sessions.js";
import { setWorkerKind, type KindEvidence } from "./worker-kind.js";
import { renderWorkOrder } from "./worker-order.js";
import type { WorkOrder } from "./worker-session.js";

export const STEP_WAKE_OP = "step_wake";
const WAKE_STEPS: Partial<Record<StepName, WorkOrder["step"]>> = { restate: "restate", write: "write", fix: "fix", review: "review", final_review: "review" };

/** registry 里一行里判定用得到的部分（manager/core.ts AgentInfo） */
interface WakeAgentRow { kind?: string; role?: string }
/** 执行者此刻用领单工具领得到的那张单（领单工具同一口径现算）；领不到给原因 */
type Pickup = { orderId: string; step: StepName; round: number } | { none: string };
export interface WakeFacts {
  task: Pick<LedgerTask, "id" | "specRev" | "headSHA">;
  event: Pick<LedgerEvent, "seq" | "data">;
  duplicate: boolean;
  agents: Record<string, WakeAgentRow>;
  pms: readonly string[];
  dispatcher: string | null;
  workflowMode: string | null;
  pickup: (agent: string, step: StepName, round: number) => Pickup;
}
export type WakeTarget = { agent: string; step: StepName; round: number; orderId: string; text: string };

/** 该不该叫、叫谁、发什么；不叫给原因（只留在返回值里，不记台账） */
export function wakeTarget(f: WakeFacts): WakeTarget | { skip: string } {
  if (f.duplicate) return { skip: "step 是重放，不重发" };
  const d = f.event.data;
  const agent = String(d.executor ?? ""), step = d.step as StepName, round = Number(d.round);
  if (d.op !== "assign" || d.executorKind !== "agent") return { skip: `执行者类型 ${String(d.executorKind)} 不由本机唤醒` };
  const as = WAKE_STEPS[step];
  if (!as) return { skip: `步骤 ${String(step)} 不发唤醒` };
  if (f.workflowMode === "auto") return { skip: "auto 卡由调度器唤醒" };
  const row = f.agents[agent];
  if (!row) return { skip: `${agent} 不在本机 registry` };
  // 受保护判定与 worker-kind 同一口径（master / codex / role=pm 不能标成 worker），再加 kind=main、项目 PM / dispatcher
  const guarded = !setWorkerKind({ [agent]: { ...row } as KindEvidence }, agent, "worker");
  if (guarded || f.pms.includes(agent) || agent === f.dispatcher || row.role === "dispatcher" || row.kind === "main") {
    return { skip: `${agent} 是 PM / master / 受保护 agent` };
  }
  const p = f.pickup(agent, step, round);
  if ("none" in p) return { skip: p.none };
  return { agent, step: p.step, round: p.round, orderId: p.orderId, text: wakeText(f.task, WAKE_STEPS[p.step]!, p.step, p.round, p.orderId) };
}

/** 领单工具此刻给不给得出这张单：这一步要是当前阶段在干活的那一步，再按 take_order / take_review 同一函数现算单号 */
function pickupOf(db: Database, task: LedgerTask, agent: string, step: StepName, round: number): Pickup {
  const at = stepAtStage(stepsOf(db, task), task);
  const later = `；推到对应阶段后重跑 step 再叫`;
  if (!at || at.step !== step || at.round !== round || at.executorKind !== "agent" || at.executor !== agent) {
    return { none: `卡在 ${task.stage}，这一步现在不是在干活的那一步，领单工具领不到${later}` };
  }
  if (step === "restate") {
    return task.stage === "spec" || task.stage === "restate" ? { orderId: manualOrderId(task.id, step, round), step, round } : { none: `卡在 ${task.stage}，复述单领不到${later}` };
  }
  if (step === "review" || step === "final_review") {
    const orderId = manualOrderId(task.id, step, round);
    return slotByOrderId(db, orderId, { agent, sessionId: null, family: null }) ? { orderId, step, round } : { none: `卡在 ${task.stage}，take_review 领不到${later}` };
  }
  const bound = getSchedulerSession(db, task.id, "author");
  const o = currentOrders(db, { agent, sessionId: bound?.agent === agent ? bound.sessionId : null, family: null, channelId: "" }).find((x) => x.task.id === task.id);
  return o ? { orderId: o.orderId, step: o.step, round: o.task.round } : { none: `卡在 ${task.stage}，take_order 领不到这张单${later}` };
}

/** 有效派单：同一步同一轮连续派给同一执行者的那串 assign 事件里第一条的 seq（原样重跑 = 同一张；换过人再派回 = 新的） */
function assignSeqOf(db: Database, project: string, taskId: string, ev: WakeFacts["event"]): number {
  const d = ev.data;
  const same = (e: LedgerEvent) => e.data.executor === d.executor && e.data.executorKind === d.executorKind;
  const runs = listEvents(db, { project, target: taskId }).filter((e) => e.kind === "step" && e.data.op === "assign" && e.data.step === d.step
    && Number(e.data.round) === Number(d.round) && e.seq <= ev.seq).sort((a, b) => b.seq - a.seq);
  let anchor = ev.seq;
  for (const e of runs) {
    if (!same(e)) break;
    anchor = e.seq;
  }
  return anchor;
}

/**
 * 调度器 wake 行同一个函数（renderWorkOrder 的 wake 分支）：只说有新单、单号、用哪个工具领，不带单据正文（验收线 3）。
 * restate 也发这一行，不走调度器复述单全文那条 text 分支。
 */
function wakeText(task: WakeFacts["task"], as: WorkOrder["step"], step: StepName, round: number, orderId: string): string {
  return renderWorkOrder({ taskId: task.id, step: as, round, dedupKey: orderId, delivery: { mode: "wake" },
    specRev: task.specRev, head: null, node: step, inputs: [], outputs: [], acceptance: [], writeBack: "" });
}

/** sent = 对方收下了；rejected = 确定没发出去，可以再发；unknown = 发出去了没回执，可能已收到，不能盲目重发 */
type WakeOutcome = { status: "sent" } | { status: "rejected" | "unknown"; error: string };
export type WakeDeliver = (agent: string, text: string) => Promise<WakeOutcome>;

/** 真实投递：bridge route_to_agent（一次性消息，与 notifyProjectPm 同口径）；bridgeSend 的 sent 字段区分没发出与结果不明 */
const bridgeWake: WakeDeliver = async (agent, text) => {
  const r = await bridgeSend({ type: "route_to_agent", targetName: agent, text, fromName: "ledger", oneShot: true }, { timeoutMs: 15_000 });
  return r.ok ? { status: "sent" } : { status: r.sent ? "unknown" : "rejected", error: r.error };
};

/** 测试注入点：null = 按进程判（manager 真进程用 bridgeWake，没有通知通道的进程不发） */
let override: WakeDeliver | null = null;
export function setStepWakeDeliver(d: WakeDeliver | null): void { override = d; }
export const stepWakeDeliver = (hasChannel: boolean): WakeDeliver | null => override ?? (hasChannel ? bridgeWake : null);

const claimKey = (taskId: string, assignSeq: number, attempt: number): string => `${STEP_WAKE_OP}:${taskId}:${assignSeq}:${attempt}`;

/** 同一有效派单的下一次尝试号；上一次送达 / 结果不明 / 认领了没结果（进程中途没了）时给出不发的原因 */
function nextAttempt(db: Database, project: string, taskId: string, assignSeq: number): number | { blocked: string } {
  const mine = listEvents(db, { project, target: taskId }).filter((e) => e.kind === "note" && e.data.op === STEP_WAKE_OP && e.data.assignSeq === assignSeq);
  const last = mine.filter((e) => e.data.phase === "claim").reduce((n, e) => Math.max(n, Number(e.data.attempt) || 0), 0);
  if (!last) return 1;
  const result = mine.find((e) => e.data.phase === "result" && e.data.attempt === last)?.data.status;
  if (result === "rejected") return last + 1;
  return { blocked: result === "sent" ? "这张单已经唤醒过" : result === "unknown" ? "上次唤醒结果不明（可能已收到），核对后手动 send_to_agent"
    : "上次唤醒已认领、还没记结果（可能正在发，或发送进程中途没了），核对后再手动 send_to_agent" };
}

export interface StepWakeInput {
  db: Database;
  ctx: WriteCtx;
  project: string;
  task: Pick<LedgerTask, "id">;
  event: Pick<LedgerEvent, "seq" | "data">;
  duplicate: boolean;
  agents: () => Promise<Record<string, WakeAgentRow>>;
  deliver: WakeDeliver | null;
  assertLease?: () => void;
}
export type StepWakeResult = { sent: true; agent: string; orderId: string } | { sent: false; agent?: string; orderId?: string; why: string };

/** step 成功落账之后调；永不抛（唤醒出错不能让已落账的 step 报失败） */
export async function wakeAfterStep(i: StepWakeInput): Promise<StepWakeResult> {
  try {
    const task = getTask(i.db, i.task.id);
    if (!task) return { sent: false, why: `台账里没有卡 ${i.task.id}` };
    const meta = getMeta(i.db, i.project);
    const t = wakeTarget({ task, event: i.event, duplicate: i.duplicate, agents: i.duplicate ? {} : await i.agents(), pms: meta.pms,
      dispatcher: meta.team?.dispatcher ?? null, workflowMode: getWorkflow(i.db, i.task.id)?.mode ?? null,
      pickup: (agent, step, round) => pickupOf(i.db, task, agent, step, round) });
    if ("skip" in t) return { sent: false, why: t.skip };
    const who = { agent: t.agent, orderId: t.orderId };
    if (!i.deliver) return { sent: false, ...who, why: "这个进程没有投递通道" };
    const assignSeq = assignSeqOf(i.db, i.project, task.id, i.event);
    const attempt = nextAttempt(i.db, i.project, task.id, assignSeq);
    if (typeof attempt !== "number") return { sent: false, ...who, why: attempt.blocked };
    const key = claimKey(task.id, assignSeq, attempt);
    const base = { op: STEP_WAKE_OP, stepSeq: i.event.seq, assignSeq, step: t.step, round: t.round, executor: t.agent, orderId: t.orderId, attempt };
    i.assertLease?.();
    const claim = appendEvent(i.db, { ...i.ctx, dedupKey: key }, { project: i.project, target: task.id, kind: "note",
      text: `唤醒 ${t.agent} 领单 ${t.orderId}（第 ${attempt} 次）`, data: { ...base, phase: "claim" } });
    if (claim.duplicate) return { sent: false, ...who, why: "这张单的唤醒已被另一次 step 认领" };
    const r: WakeOutcome = await i.deliver(t.agent, t.text).catch((e: unknown) => ({ status: "unknown" as const, error: (e as Error).message }));
    const text = r.status === "sent" ? `已唤醒 ${t.agent} 领单 ${t.orderId}`
      : r.status === "rejected" ? `唤醒未送达：${t.agent} 没收到 ${t.orderId} 的领单提醒（${r.error}），重跑 step 会重试，或手动 send_to_agent`
      : `唤醒结果不明：${t.agent} 可能已收到 ${t.orderId} 的领单提醒（${r.error}），不会自动重发，请核对后手动 send_to_agent`;
    i.assertLease?.();
    appendEvent(i.db, { ...i.ctx, dedupKey: `${key}:result` }, { project: i.project, target: task.id, kind: "note", text,
      data: { ...base, phase: "result", status: r.status, ...(r.status === "sent" ? {} : { error: r.error }) } });
    return r.status === "sent" ? { sent: true, ...who } : { sent: false, ...who, why: text };
  } catch (e) {
    return { sent: false, why: `唤醒出错：${(e as Error).message}` };
  }
}
