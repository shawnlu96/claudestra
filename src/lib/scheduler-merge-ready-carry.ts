/**
 * A ready run whose PR head moved keeps its review only on the previous attempt's own update-branch: that attempt (scheduler identity)
 * went ready → updating at this reviewed head, ended unmerged (PM resolve cancelled / failed, or the PM-switch cancellation), shares
 * this round and spec revision, and nothing delivered or moved the card since. Read from the ledger inside carryReview's write
 * transaction (scheduler-merge.ts), never from the driver; the pure-main chain / hop limit stays autoCarryEvidence's.
 * tests/scheduler-merge-ready-carry*.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import type { SchedulerIntent } from "./ledger-scheduler.js";
import { LedgerError, listEvents } from "./ledger-store.js";
import type { MergeRun } from "./scheduler-merge.js";

export interface ReadyCarryFacts {
  task: Pick<LedgerTask, "id" | "round" | "specRev">;
  /** This card's events in seq order. */
  events: readonly LedgerEvent[];
  current: SchedulerIntent;
  reviewedHead: string;
  /** The newest merge intent of this card planned before `current`, with its merge run. */
  prior: { intent: SchedulerIntent; run: MergeRun | null } | null;
}

const own = (e: LedgerEvent, op: string, id: string) => e.kind === "scheduler" && e.data.op === op && e.data.intentId === id;
/** The round the card was in when the intent was planned: the merge stage it was planned inside. */
const roundOf = (events: readonly LedgerEvent[], intent: SchedulerIntent): unknown =>
  events.findLast((e) => e.seq <= intent.causalSeq && e.kind === "stage" && e.data.to === "merge")?.data.round;

/** null = the previous attempt's update-branch is proven; otherwise why the carry is refused. */
export function readyCarryRefusal(f: ReadyCarryFacts): string | null {
  const p = f.prior?.intent, run = f.prior?.run;
  if (!p || !run || p.action !== "merge" || p.taskId !== f.task.id) return "没有更早的合并意图";
  const events = f.events.filter((e) => e.data.imported !== true);
  const phases = events.filter((e) => own(e, "merge_phase", p.id));
  const ready = phases.find((e) => e.data.phase === "ready");
  if (!ready || ready.actor !== "scheduler" || ready.data.head !== f.reviewedHead || run.reviewedHead !== f.reviewedHead ||
    events.some((e) => own(e, "review_carry", p.id))) return "上一次尝试审查的 head 不是本次的审查 head";
  if (!phases.some((e) => e.actor === "scheduler" && e.data.from === "ready" && e.data.to === "updating")) {
    return "上一次尝试没有由调度器从 ready 发出 update-branch";
  }
  const end = events.findLast((e) => own(e, "merge_resolve", p.id) || (own(e, "merge_phase", p.id) && e.data.to === "resolved"));
  const resolved = !!end && (end.data.op === "merge_resolve"
    ? end.actor !== "scheduler" && end.data.manual === true && ["cancelled", "failed"].includes(String(end.data.outcome))
    : end.data.outcome === "cancelled" && end.dedupKey === `scheduler:${p.id}:merge:cancelled`);
  if (run.phase !== "resolved" || run.mergeSha || p.status !== "cancelled" || !resolved ||
    phases.some((e) => e.data.to === "merged" || e.data.to === "merging")) return "上一次尝试没有以未合并（cancelled / failed）结清";
  if (p.specRev !== f.current.specRev || p.specRev !== f.task.specRev || roundOf(events, p) !== f.task.round ||
    roundOf(events, f.current) !== f.task.round) return "上一次尝试的轮次或规格版本与本次不同";
  if (events.some((e) => e.seq > p.eventSeq && (e.kind === "deliver" || e.kind === "stage"))) return "上一次尝试之后卡上有交付或阶段变化";
  return null;
}

/** Inside the step's transaction: the previous attempt's intent id, or a conflict (nothing written). */
export function readyCarryPrior(db: Database, row: MergeRun, task: LedgerTask, getRun: (db: Database, id: string) => MergeRun | null): string {
  const current = db.query("SELECT * FROM scheduler_intents WHERE id = ?").get(row.intentId) as SchedulerIntent | null;
  const prior = current && db.query(`SELECT * FROM scheduler_intents WHERE taskId = ? AND action = 'merge' AND id != ? AND eventSeq < ?
    ORDER BY eventSeq DESC LIMIT 1`).get(task.id, current.id, current.eventSeq) as SchedulerIntent | null;
  const why = !current ? "找不到本次合并意图" : readyCarryRefusal({ task, current, reviewedHead: row.reviewedHead,
    events: listEvents(db, { project: task.project, target: task.id }), prior: prior ? { intent: prior, run: getRun(db, prior.id) } : null });
  if (why) throw new LedgerError("conflict", `跨尝试沿用不成立：${why}`);
  return (prior as SchedulerIntent).id;
}
