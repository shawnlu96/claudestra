/**
 * Intent settlement and the scheduler's write permissions, apart from ledger-scheduler-write.ts so the pool step
 * (ledger-scheduler-pool.ts) can settle intents while workflow takeover in the write module closes pool orders first.
 */
import type { Database } from "bun:sqlite";
import { isManager, type WriteCtx } from "./ledger-checks.js";
import { getIntent, INTENT_STATUSES, type IntentStatus, type SchedulerIntent } from "./ledger-scheduler.js";
import { releaseFinishedCardLeases } from "./ledger-scheduler-lease.js";
import { getMeta, LedgerError } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";

export const textOneLine = (value: string, label: string, max: number): string => {
  const out = value.trim();
  if (!out || out.length > max || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(out)) throw new LedgerError("invalid", `${label}要是 1–${max} 字的单行文字`);
  return out;
};
export const actorMayConfigure = (db: Database, actor: string, project: string): boolean => {
  const meta = getMeta(db, project);
  return actor !== meta.team?.dispatcher && isManager(db, actor, { project, agent: null });
};
export const actorMaySchedule = (db: Database, actor: string, project: string): boolean =>
  actor === "scheduler" || actorMayConfigure(db, actor, project);

const NEXT: Record<IntentStatus, readonly IntentStatus[]> = {
  pending: ["submitted", "cancelled", "unknown"], submitted: ["done", "unknown", "cancelled"],
  done: [], unknown: ["done", "cancelled"], cancelled: [],
};

/** A timeout only marks unknown; resources stay claimed until reconciliation or explicit cancellation. */
export function settleIntent(db: Database, ctx: WriteCtx, input: { id: string; from: IntentStatus; to: IntentStatus; receipt?: string }): SchedulerIntent {
  return tx(db, () => {
    const intent = getIntent(db, input.id);
    if (!intent) throw new LedgerError("not_found", "没有这个调度意图");
    if (!actorMaySchedule(db, ctx.actor, intent.project)) throw new LedgerError("forbidden", "只有调度服务或项目 PM / master / owner 能结算调度意图");
    if (input.from === "unknown" && (ctx.actor === "scheduler" || !input.receipt?.trim())) {
      throw new LedgerError("forbidden", "结果不明的意图只有 PM 凭外部核对回执能结算");
    }
    if (!INTENT_STATUSES.includes(input.to) || !NEXT[input.from]?.includes(input.to) || intent.status !== input.from) {
      throw new LedgerError("conflict", `调度意图当前是 ${intent.status}，不能 ${input.from}→${input.to}`);
    }
    const now = ctx.now ?? Date.now();
    const receipt = input.receipt ? textOneLine(input.receipt, "回执", 600) : intent.receipt;
    db.prepare("UPDATE scheduler_intents SET status = ?, receipt = ?, attempts = attempts + ?, updatedAt = ? WHERE id = ?")
      .run(input.to, receipt, input.to === "submitted" ? 1 : 0, now, input.id);
    if (input.to === "done" || input.to === "cancelled") db.prepare("DELETE FROM scheduler_resources WHERE intentId = ? AND scope = 'intent'").run(input.id);
    releaseFinishedCardLeases(db, intent.taskId);
    insertEvent(db, { actor: ctx.actor, now, dedupKey: `scheduler:${input.id}:${input.to}` }, {
      project: intent.project, target: intent.taskId, kind: "scheduler", text: `调度意图 ${input.to}`,
      data: { op: "settle", id: input.id, from: input.from, to: input.to, receipt,
        ...(ctx.actor === "scheduler" ? {} : { manual: true }) },
    }, true);
    return getIntent(db, input.id) as SchedulerIntent;
  });
}
