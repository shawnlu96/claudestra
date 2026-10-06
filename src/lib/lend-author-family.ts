/**
 * FAMW: a lent write / fix order's family is who writes the card next. The provider's claim (claimLend, already inside its
 * BEGIN IMMEDIATE) reconciles workflow.authorFamily to the order's family in that same transaction, so the claim and the
 * family land together or not at all; the next review goes across from it through FAM1a's existing reviewer_swap epoch.
 * Only the order row's family counts (the peer's session family is still checked at result intake), never names or spec text.
 * Review orders, cancelled / late / stale claims and non-auto workflows change nothing; a scheduler-driven card whose workflow
 * row is gone refuses the claim (family unreadable), while a legacy manual card that never had one keeps claiming as before. tests/lend-author-family*.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { AUTHOR_FAMILIES, getWorkflow, type AuthorFamily, type TaskWorkflow } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, LedgerError, listEvents } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";

export const AUTHOR_FAMILY_OP = "lend_author_family";
const isFamily = (f: unknown): f is AuthorFamily => AUTHOR_FAMILIES.includes(f as AuthorFamily);

type ClaimedOrder = { orderId: string; taskId: string; project: string; peer: string; family: string; step: string; round: number; specRev: number;
  createdBy: string };

/** A card the scheduler ever drove (cut this order, or left scheduler events on the card): its missing workflow is an unreadable family. */
const schedulerDriven = (db: Database, o: ClaimedOrder): boolean => o.createdBy === "scheduler" ||
  listEvents(db, { project: o.project, target: o.taskId }).some((e) => e.kind === "scheduler" && e.actor === "scheduler");

/** Called once, right after the pooled → claimed UPDATE; any throw rolls the claim back with it (no half-written state). */
export function claimAuthorFamily(db: Database, ctx: WriteCtx, o: ClaimedOrder): void {
  if (o.step !== "write" && o.step !== "fix") return;
  if (!isFamily(o.family)) throw new LedgerError("conflict", `写单家族读不到（${String(o.family)}），不领这一单`);
  const workflow = getWorkflow(db, o.taskId);
  if (!workflow && schedulerDriven(db, o)) throw new LedgerError("conflict", "自动卡的流程记录读不到，作者家族没法对账，不领这一单");
  if (!workflow || workflow.mode !== "auto" || workflow.authorFamily === o.family) return;
  if (!isFamily(workflow.authorFamily)) throw new LedgerError("conflict", "卡的作者家族读不到，不领这一单");
  const key = `lend-author-family:${o.orderId}`;
  if (getEventByDedup(db, key)) throw new LedgerError("conflict", "这一单的作者家族已对过账，不重复改");
  const now = ctx.now ?? Date.now();
  const changed = db.query(`UPDATE task_workflows SET authorFamily = ?, rev = rev + 1, updatedAt = ?
    WHERE taskId = ? AND rev = ? AND authorFamily = ? AND mode = 'auto'`).run(o.family, now, o.taskId, workflow.rev, workflow.authorFamily).changes;
  if (changed !== 1) throw new LedgerError("conflict", "作者家族在领单途中被改过，先重读");
  appendEvent(db, { ...ctx, now, dedupKey: key }, { project: o.project, target: o.taskId, kind: "note",
    text: `出借：${o.peer} 的 ${o.family} 领了${o.step === "fix" ? "修复" : "开工"}单，作者家族由 ${workflow.authorFamily} 变成 ${o.family}`,
    data: { op: AUTHOR_FAMILY_OP, orderId: o.orderId, peer: o.peer, step: o.step, family: o.family, previousFamily: workflow.authorFamily,
      round: o.round, specRev: o.specRev, workflowRev: workflow.rev + 1 } });
}

/**
 * The author family a post-swap reviewer must differ from. The swap event is the FAM1a epoch: if the real author family no
 * longer matches what that epoch retired the old reviewer for, the epoch is stale and nothing is created (conservative).
 */
export function swapAuthorFamily(db: Database, task: LedgerTask, workflow: TaskWorkflow | null, swap: LedgerEvent): AuthorFamily {
  const wrote = remoteHeadFamily(db, task) ?? workflow?.authorFamily;
  if (!isFamily(wrote)) throw new LedgerError("conflict", "作者家族读不到，不建新审查会话");
  if (isFamily(swap.data.toFamily) && swap.data.toFamily !== wrote) {
    throw new LedgerError("conflict", `换人时作者家族是 ${swap.data.toFamily}，现在是 ${wrote}：旧 epoch 作废，先重算`);
  }
  return wrote;
}
