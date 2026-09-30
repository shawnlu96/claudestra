/**
 * 执行者「当前的单」（M2 take_order / deliver 共用，只读台账）：阶段在 build / fix、这一阶段在干活的那一步（stepAtStage）派给了
 * 调用方 agent 的卡；卡上有未退役的作者会话绑定（scheduler_sessions）时，绑定的 agent 与会话也必须就是调用方——
 * 同一 agent 换了会话（/clear 之外的另起一个）就不算，防串单。调用方只来自身份（lib/order-tool-route.ts VerifiedCall）。
 * orderId：调度器派的单 = 那条 dispatch intent 的 id；PM 手动派的单 = `<task>:<step>:r<round>`（T87 的 ORDER_ID 不收 #）。
 * tests/order-take.test.ts。
 */
import type { Database } from "bun:sqlite";
import { getTask } from "./ledger-store.js";
import type { LedgerTask } from "./ledger-stages.js";
import { stepAtStage, stepsOf } from "./ledger-steps.js";
import { isFullSha, parseOrderWire, type OrderWire } from "./order-wire.js";
import type { SchedulerIntent } from "./ledger-scheduler.js";
import { getSchedulerSession } from "./scheduler-sessions.js";
import type { VerifiedCall } from "./order-tool-route.js";
import { SRC_DIR } from "./repo-root.js";

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

export function currentOrders(db: Database, call: VerifiedCall): CurrentOrder[] {
  const ids = db.query("SELECT id FROM tasks WHERE stage IN ('build', 'fix') ORDER BY updatedAt DESC, id").all() as { id: string }[];
  const out: CurrentOrder[] = [];
  for (const { id } of ids) {
    const task = getTask(db, id);
    if (!task || (task.stage !== "build" && task.stage !== "fix")) continue;
    const at = stepAtStage(stepsOf(db, task), task);
    if (!at || at.executorKind !== "agent" || at.executor !== call.agent) continue;
    if (!bindingAllows(db, task.id, call)) continue;
    const step = task.stage === "fix" ? "fix" : "write";
    const intent = currentIntent(db, task, step);
    out.push({ task, stage: task.stage, step, orderId: intent?.id ?? manualOrderId(task.id, step, task.round), intent });
  }
  return out;
}

function dagVersionOf(db: Database, task: LedgerTask): number | null {
  if (!task.featureId || !hasTable(db, "features")) return null;
  const r = db.query("SELECT currentVersion FROM features WHERE id = ?").get(task.featureId) as { currentVersion: number } | null;
  return r && r.currentVersion > 0 ? r.currentVersion : null;
}

const CLI = `bun ${SRC_DIR}/manager.ts ledger`;

/** 给执行者的单：字段按 T87 OrderWire，交出去之前过一遍 parseOrderWire（台账里的脏值宁可报错，不发半张单） */
export function orderWireFor(db: Database, o: CurrentOrder): { ok: true; order: OrderWire } | { ok: false; error: string } {
  const t = o.task;
  const head = t.headSHA && isFullSha(t.headSHA) ? t.headSHA : null;
  const wire = {
    v: 1, orderId: o.orderId, taskId: t.id, specRev: t.specRev, dagVersion: dagVersionOf(db, t), node: o.intent?.node ?? o.step, step: o.step, round: t.round,
    head, repo: null, pr: null,
    inputs: [`规格与验收：${CLI} show ${t.id}`, ...(t.spec ? [`规格卡：${t.spec}`] : []), ...(t.branch ? [`分支：${t.branch}`] : [])],
    outputs: ["分支上的提交，已推到 origin（完整 head SHA）", "证据报告路径"],
    acceptance: ["规格里的验收线逐条自查"],
    writeBack: `用 deliver 工具回写：orderId ${o.orderId}，head = 本卡分支在 origin 上的完整 SHA（bridge 会核对）。CLI 仍可用：${CLI} deliver ${t.id} --from ${o.stage} --head <完整 SHA> --evidence <报告路径>`,
    findings: [], fallback: null,
  };
  const parsed = parseOrderWire(wire);
  return parsed.ok ? { ok: true, order: parsed.value } : { ok: false, error: `台账里这张单的字段不合 OrderWire：${parsed.error}` };
}
