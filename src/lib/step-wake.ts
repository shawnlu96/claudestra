/**
 * WAKE1：PM 用 `ledger step` 给本机 agent 派正式单后，叫醒执行者去领单。auto 卡由调度器发唤醒（delivery=wake），
 * 手动卡以前要 PM 另外 send_to_agent，漏了执行者就空等。
 * - 判定（wakeTarget）是纯函数：step 落账成功（不是重放）、kind=agent、执行者在本机 registry 且不是 PM / master / 受保护 agent、
 *   步骤是 restate / write / fix / review / final_review；卡不在 auto 流程（auto 卡的唤醒归调度器，不发第二份）。
 * - 文案用调度器同一个函数（worker-order.ts renderWorkOrder 的 wake 行），单号是手动单号（order-take.ts manualOrderId），不带规格正文。
 * - 去重按 (卡, step 事件 seq)：结果记一条 note（data.op = step_wake，去重键带 seq），已有就不再发；`ledger step` 每跑一次是新 seq，
 *   所以同一张单同一个执行者已经送达过也不再发。投递失败不回滚 step，note 里记「唤醒未送达」，PM 重跑 step 即重试。
 * 投递走 bridge 的 route_to_agent（与调度器 / PM 通知同一通道）；测试注入假投递。tests/step-wake.test.ts。
 */
import type { Database } from "bun:sqlite";
import { bridgeSend } from "./bridge-client.js";
import { getWorkflow } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask, StepName } from "./ledger-stages.js";
import { getEventByDedup, getMeta, listEvents } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import type { WriteCtx } from "./ledger-checks.js";
import { manualOrderId } from "./order-take.js";
import { isMasterName } from "./registry.js";
import { renderWorkOrder } from "./worker-order.js";
import type { WorkOrder } from "./worker-session.js";

export const STEP_WAKE_OP = "step_wake";
const WAKE_STEPS: Partial<Record<StepName, WorkOrder["step"]>> = { restate: "restate", write: "write", fix: "fix", review: "review", final_review: "review" };

/** registry 里一行里判定用得到的部分（manager/core.ts AgentInfo） */
interface WakeAgentRow { kind?: string; role?: string }
export interface WakeFacts {
  task: Pick<LedgerTask, "id">;
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
  return { agent, step, round, orderId, text: wakeLine(f.task.id, as, round, orderId) };
}

/** 调度器唤醒的同一行字（renderWorkOrder 的 wake 分支只读 taskId / step / round / dedupKey） */
function wakeLine(taskId: string, step: WorkOrder["step"], round: number, orderId: string): string {
  return renderWorkOrder({
    taskId, step, round, dedupKey: orderId, delivery: { mode: "wake" },
    specRev: 0, head: null, node: step, inputs: [], outputs: [], acceptance: [], writeBack: "",
  });
}

export type WakeDeliver = (agent: string, text: string) => Promise<{ ok: true } | { ok: false; error: string }>;

/** 真实投递：bridge route_to_agent（一次性消息，与 notifyProjectPm 同口径） */
const bridgeWake: WakeDeliver = async (agent, text) => {
  const r = await bridgeSend({ type: "route_to_agent", targetName: agent, text, fromName: "ledger", oneShot: true }, { timeoutMs: 30_000 });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
};

/** 测试注入点：null = 按进程判（manager 真进程用 bridgeWake，没有通知通道的进程不发） */
let override: WakeDeliver | null = null;
export function setStepWakeDeliver(d: WakeDeliver | null): void { override = d; }
export const stepWakeDeliver = (hasChannel: boolean): WakeDeliver | null => override ?? (hasChannel ? bridgeWake : null);

/** 同一张单（同卡同步骤同轮）同一个执行者已经叫到过：重复执行 step（每次是新的 seq）不重发；上次没送达的，重跑 step 就是重试 */
function wokeBefore(db: Database, project: string, taskId: string, t: WakeTarget): boolean {
  return listEvents(db, { project, target: taskId }).some((e) => e.kind === "note" && e.data.op === STEP_WAKE_OP && e.data.orderId === t.orderId
    && e.data.executor === t.agent && e.data.delivered === true);
}

const wakeKey = (taskId: string, seq: number): string => `${STEP_WAKE_OP}:${taskId}:${seq}`;

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
    const meta = getMeta(i.db, i.project);
    const t = wakeTarget({ task: i.task, event: i.event, duplicate: i.duplicate, agents: i.duplicate ? {} : await i.agents(), pms: meta.pms,
      dispatcher: meta.team?.dispatcher ?? null, workflowMode: getWorkflow(i.db, i.task.id)?.mode ?? null });
    if ("skip" in t) return { sent: false, why: t.skip };
    const key = wakeKey(i.task.id, i.event.seq);
    if (getEventByDedup(i.db, key) || wokeBefore(i.db, i.project, i.task.id, t)) return { sent: false, agent: t.agent, orderId: t.orderId, why: "这张单已经唤醒过" };
    if (!i.deliver) return { sent: false, agent: t.agent, orderId: t.orderId, why: "这个进程没有投递通道" };
    const r = await i.deliver(t.agent, t.text).catch((e: unknown) => ({ ok: false as const, error: (e as Error).message }));
    const data = { op: STEP_WAKE_OP, stepSeq: i.event.seq, step: t.step, round: t.round, executor: t.agent, orderId: t.orderId, delivered: r.ok,
      ...(r.ok ? {} : { error: r.error }) };
    const text = r.ok ? `已唤醒 ${t.agent} 领单 ${t.orderId}` : `唤醒未送达：${t.agent} 没收到 ${t.orderId} 的领单提醒（${r.error}），请手动 send_to_agent`;
    i.assertLease?.();
    tx(i.db, () => {
      if (!getEventByDedup(i.db, key)) insertEvent(i.db, { ...i.ctx, dedupKey: key }, { project: i.project, target: i.task.id, kind: "note", text, data }, true);
    });
    return r.ok ? { sent: true, agent: t.agent, orderId: t.orderId } : { sent: false, agent: t.agent, orderId: t.orderId, why: `唤醒未送达：${r.error}` };
  } catch (e) {
    return { sent: false, why: `唤醒出错：${(e as Error).message}` };
  }
}
