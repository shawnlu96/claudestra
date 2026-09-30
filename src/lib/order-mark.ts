/**
 * 领单留痕与未领单报警：两条都是按意图去重的 scheduler 事件，写一次，重复调用原样回放（duplicate=true）。
 * - order_taken：执行者 / 审查员 take_order / take_review 领到调度器的单时，bridge 以调用方身份写（身份门已过，lib/order-tool-route.ts）。
 *   只认这条意图的收件人、且会话是台账当前绑定的那个——换了会话、别的 agent 都记不上，所以记录不会串卡串会话。
 * - unclaimed：唤醒发出 N 分钟没人领，调度服务先落这条事件（报警文本定死在这里），再通知 PM；通知送到后才落 unclaimed_sent。
 *   有 sent 就不再发：重启、重复 tick 都只报一次；通知没送到（bridge 不在、发完前崩了）下一个 tick 照同一文本重发，至少送到一次。
 * 调度器对账时把 order_taken 当成「单已送到」的证据（lib/scheduler-dispatch.ts）。tests/order-mark.test.ts。
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { getIntent, type SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerEvent } from "./ledger-stages.js";
import { getEventByDedup, LedgerError } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import type { OrderToolHandler, OrderToolResult, VerifiedCall } from "./order-tool-route.js";
import { getSchedulerSession } from "./scheduler-sessions.js";

/** 唤醒发出后等多久没人领就报警（规格默认 10 分钟） */
export const UNCLAIMED_ALARM_MS = 10 * 60_000;

export const takenKey = (intentId: string): string => `scheduler:${intentId}:taken`;
export const unclaimedKey = (intentId: string): string => `scheduler:${intentId}:unclaimed`;
export const unclaimedSentKey = (intentId: string): string => `scheduler:${intentId}:unclaimed_sent`;

/** 收件人领过这条意图的单：事件 seq，没有就 null */
export function orderTakenSeq(db: Database, intentId: string): number | null {
  return getEventByDedup(db, takenKey(intentId))?.seq ?? null;
}

type Marked = { event: LedgerEvent; duplicate: boolean };

/** 只有派出去的执行 / 审查意图能被领、能报警；没派出（pending）或已作废的单不算 */
function sentIntent(db: Database, intentId: string): SchedulerIntent {
  const intent = getIntent(db, intentId);
  if (!intent) throw new LedgerError("not_found", `没有调度意图 ${intentId}`);
  if (intent.action !== "dispatch" && intent.action !== "review") throw new LedgerError("invalid", `意图 ${intent.action} 不是派单`);
  if (!["submitted", "done", "unknown"].includes(intent.status)) throw new LedgerError("conflict", `单 ${intentId} 是 ${intent.status}，没派出或已作废`);
  return intent;
}

export function markOrderTaken(db: Database, ctx: WriteCtx, input: { intentId: string; sessionId: string }): Marked {
  return tx(db, () => {
    const prior = getEventByDedup(db, takenKey(input.intentId));
    if (prior) return { event: prior, duplicate: true };
    const intent = sentIntent(db, input.intentId);
    if (intent.recipient !== ctx.actor) throw new LedgerError("forbidden", `单 ${intent.id} 不是派给 ${ctx.actor} 的`);
    const bound = getSchedulerSession(db, intent.taskId, intent.action === "review" ? "reviewer" : "author");
    if (!bound || bound.state !== "active" || bound.agent !== ctx.actor || bound.sessionId !== input.sessionId) {
      throw new LedgerError("forbidden", "调用方会话不是台账为这张卡绑定的会话");
    }
    const event = insertEvent(db, { ...ctx, dedupKey: takenKey(intent.id) }, {
      project: intent.project, target: intent.taskId, kind: "scheduler", text: `${ctx.actor} 领单`,
      data: { op: "order_taken", id: intent.id, sessionId: input.sessionId },
    }, true);
    return { event, duplicate: false };
  });
}

export function markUnclaimed(db: Database, ctx: WriteCtx, input: { intentId: string; text: string }): Marked {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "未领单报警只由调度服务写");
  const text = input.text.replace(/\s+/g, " ").trim();
  if (!text || text.length > 600) throw new LedgerError("invalid", "报警说明要是 1–600 字");
  return tx(db, () => {
    const prior = getEventByDedup(db, unclaimedKey(input.intentId));
    if (prior) return { event: prior, duplicate: true };
    const intent = sentIntent(db, input.intentId);
    if (getEventByDedup(db, takenKey(intent.id))) throw new LedgerError("conflict", `单 ${intent.id} 已被领走，不报警`);
    const event = insertEvent(db, { ...ctx, dedupKey: unclaimedKey(intent.id) }, {
      project: intent.project, target: intent.taskId, kind: "scheduler", text, data: { op: "unclaimed", id: intent.id, recipient: intent.recipient },
    }, true);
    return { event, duplicate: false };
  });
}

/** 未领单报警已交给 PM：只由调度服务在 notifyPm 成功后写；要先有那条报警 */
export function markUnclaimedSent(db: Database, ctx: WriteCtx, input: { intentId: string }): Marked {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "报警送达只由调度服务写");
  return tx(db, () => {
    const prior = getEventByDedup(db, unclaimedSentKey(input.intentId));
    if (prior) return { event: prior, duplicate: true };
    const alarm = getEventByDedup(db, unclaimedKey(input.intentId));
    if (!alarm) throw new LedgerError("conflict", `单 ${input.intentId} 没有未领单报警`);
    const event = insertEvent(db, { ...ctx, dedupKey: unclaimedSentKey(input.intentId) }, {
      project: alarm.project, target: alarm.target, kind: "scheduler", text: "未领单报警已送达 PM", data: { op: "unclaimed_sent", id: input.intentId, alarmSeq: alarm.seq },
    }, true);
    return { event, duplicate: false };
  });
}

/** 注入：以调用方频道为身份跑 manager（bridge/order-tools.ts 的 ledgerRun） */
type MarkRun = (args: string[], channelId: string) => Promise<{ ok?: unknown; error?: unknown } | null | undefined>;

/**
 * 领到调度器的单后留痕：只处理台账里有的调度意图（PM 手动派的单没有意图，不记），已记过的跳过；会话只取身份。
 * 调用方是 routeOrderTool 身份门之后的 handler，所以未验证的调用永远到不了这里。写失败只记日志：领单本身不受影响，
 * 最坏是 PM 多收一次未领单报警。返回记上的单号（单测用）。
 */
export async function recordTaken(db: Database | null, call: VerifiedCall, orderIds: readonly string[], run: MarkRun,
  log: (msg: string) => void = console.warn): Promise<string[]> {
  if (!db || !call.sessionId || !call.channelId) return [];
  const marked: string[] = [];
  for (const id of orderIds) {
    if (!getIntent(db, id) || orderTakenSeq(db, id) !== null) continue;
    try {
      const r = await run(["ledger", "order-taken", id, `--session=${call.sessionId}`], call.channelId);
      if (r?.ok === true) marked.push(id);
      else log(`⚠ 领单留痕没记上（${id}）：${String(r?.error ?? "manager 无结果")}`);
    } catch (e) {
      log(`⚠ 领单留痕出错（${id}）：${(e as Error).message}`);
    }
  }
  return marked;
}

/** 给领单工具（take_order / take_review）套上留痕：先把单交出去，留痕在后台跑，不拖慢回包 */
export function markingTakes(handler: OrderToolHandler, orderIdsOf: (r: Extract<OrderToolResult, { ok: true }>) => string[],
  mark: (call: VerifiedCall, ids: string[]) => Promise<unknown>): OrderToolHandler {
  return async (call, args) => {
    const r = await handler(call, args);
    if (r.ok) void mark(call, orderIdsOf(r)).catch((e) => console.warn(`⚠ 领单留痕出错：${(e as Error).message}`));
    return r;
  };
}
