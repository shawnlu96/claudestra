/**
 * `ledger step` 给本机 agent 派正式单后叫醒执行者（auto 卡归调度器）。文案与投递方式用调度器同一套函数（deliveryFor / workOrderFor /
 * renderWorkOrder）：write / fix / review 发 wake 行让它领单，restate 没有领单工具，发调度器那份复述单（只指向 ledger show，不带正文）。
 * 只发一次：投递前用 appendEvent 的 dedupKey 原子认领（同单同执行者第 n 次尝试一个键），并发 step 只有一个认领得到；
 * 结果再记一条 note。送达 / 结果不明（bridge 已发出没回执）/ 认领了没结果都不再发，只有确定没发出去的（rejected）重跑 step 才重试。
 * tests/step-wake.test.ts。
 */
import type { Database } from "bun:sqlite";
import { bridgeSend } from "./bridge-client.js";
import { getWorkflow, type SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask, StepName } from "./ledger-stages.js";
import { getMeta, getTask, listEvents } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import type { WriteCtx } from "./ledger-checks.js";
import { manualOrderId } from "./order-take.js";
import { isMasterName } from "./registry.js";
import { workOrderFor } from "./scheduler-work-order.js";
import { renderWorkOrder } from "./worker-order.js";
import { deliveryFor, type SessionRef, type WorkOrder } from "./worker-session.js";

export const STEP_WAKE_OP = "step_wake";
const WAKE_STEPS: Partial<Record<StepName, WorkOrder["step"]>> = { restate: "restate", write: "write", fix: "fix", review: "review", final_review: "review" };

/** registry 里一行里判定用得到的部分（manager/core.ts AgentInfo） */
interface WakeAgentRow { kind?: string; role?: string }
export interface WakeFacts {
  task: Pick<LedgerTask, "id" | "specRev" | "headSHA">;
  event: Pick<LedgerEvent, "seq" | "data">;
  duplicate: boolean;
  agents: Record<string, WakeAgentRow>;
  pms: readonly string[];
  dispatcher: string | null;
  workflowMode: string | null;
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
  if (isMasterName(agent) || f.pms.includes(agent) || agent === f.dispatcher || row.role === "pm" || row.role === "dispatcher" || row.kind === "main") {
    return { skip: `${agent} 是 PM / master / 受保护 agent` };
  }
  const orderId = manualOrderId(f.task.id, step, round);
  return { agent, step, round, orderId, text: wakeText(f.task, as, step, round, orderId, agent) };
}

/**
 * 调度器给 channel 会话（本机 registry 的 Claude Code / Pi）派单的同一份字：deliveryFor 定 wake / text，workOrderFor 出单，renderWorkOrder 渲染。
 * 手动卡没有调度意图，这里按手动单号拼一个只给 workOrderFor 读 id / node / specRev / head 的意图。
 */
function wakeText(task: WakeFacts["task"], as: WorkOrder["step"], step: StepName, round: number, orderId: string, agent: string): string {
  const delivery = deliveryFor("channel", as);
  const head = { taskId: task.id, step: as, round, dedupKey: orderId, delivery };
  if (delivery.mode === "wake") { // wake 行只读这几项
    return renderWorkOrder({ ...head, specRev: task.specRev, head: null, node: step, inputs: [], outputs: [], acceptance: [], writeBack: "" });
  }
  const intent = { id: orderId, taskId: task.id, node: step, specRev: task.specRev, head: task.headSHA } as SchedulerIntent;
  const ref = { taskId: task.id, role: "author", agent, sessionId: "" } as SessionRef;
  const order = workOrderFor({ ...task, round } as LedgerTask, intent, null, ref);
  return renderWorkOrder({ ...order!, ...head });
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

const claimKey = (orderId: string, agent: string, attempt: number): string => `${STEP_WAKE_OP}:${orderId}:${agent}:${attempt}`;

/** 同单同执行者的下一次尝试号；上一次送达 / 结果不明 / 认领了没结果（进程中途没了）时给出不发的原因 */
function nextAttempt(db: Database, project: string, taskId: string, t: WakeTarget): number | { blocked: string } {
  const mine = listEvents(db, { project, target: taskId }).filter((e) => e.kind === "note" && e.data.op === STEP_WAKE_OP
    && e.data.orderId === t.orderId && e.data.executor === t.agent);
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
      dispatcher: meta.team?.dispatcher ?? null, workflowMode: getWorkflow(i.db, i.task.id)?.mode ?? null });
    if ("skip" in t) return { sent: false, why: t.skip };
    const who = { agent: t.agent, orderId: t.orderId };
    if (!i.deliver) return { sent: false, ...who, why: "这个进程没有投递通道" };
    const attempt = nextAttempt(i.db, i.project, task.id, t);
    if (typeof attempt !== "number") return { sent: false, ...who, why: attempt.blocked };
    const key = claimKey(t.orderId, t.agent, attempt);
    const base = { op: STEP_WAKE_OP, stepSeq: i.event.seq, step: t.step, round: t.round, executor: t.agent, orderId: t.orderId, attempt };
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
