/** Atomic canonical write composition; source I/O is finished before this function is called. */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { getLendOrder, offerLendCore, type OfferInput, type LendOrder } from "./ledger-lend.js";
import { appendEvent } from "./ledger-write.js";
import { busyAsLedgerError, LedgerError } from "./ledger-store.js";
import { cliOfferFamily } from "./lend-cli-author-family.js";
import { assertReborrowAuthority, assertReborrowCas } from "./lend-reborrow-facts.js";
import { assertReborrowContext, type ReborrowContext } from "./lend-reborrow-context.js";
import { reborrowEventDraft, reborrowKey, replayReborrow } from "./lend-reborrow-event.js";

/** The next lease is issued only by offerLendCore. If the evidence append fails, its order and holder projection roll back too. */
export function applyReborrow(db: Database, ctx: WriteCtx, recovery: ReborrowContext, input: OfferInput, pinnedFp: string | null): LendOrder {
  return busyAsLedgerError("接回写租约", () => db.transaction(() => {
    const f = recovery.facts, s = recovery.source;
    if (input.taskId !== f.task.id || input.peer !== f.lease.peer || input.repo !== f.lease.repo || input.family !== f.family ||
      input.pr !== (s.pr?.number ?? null) || input.write?.fp !== f.lease.fp || input.write.base !== "main") {
      throw new LedgerError("conflict", "接续输入与已核恢复事实不符");
    }
    const replay = replayReborrow(db, f, s);
    assertReborrowAuthority(db, f, ctx.actor, input.borrow, pinnedFp, ctx.now ?? Date.now(), replay !== null);
    if (replay) return replay;
    assertReborrowCas(db, f);
    assertReborrowContext(f.task, input.peer, recovery);
    cliOfferFamily(db, f.task, input.family);
    const order = offerLendCore(db, ctx, { ...input, supersedes: f.previous.orderId, write: { ...input.write, reborrow: recovery } });
    appendEvent(db, { ...ctx, dedupKey: reborrowKey(f.task.id, f.reclaim.seq) }, reborrowEventDraft(f, s, order));
    const committed = getLendOrder(db, order.orderId)!;
    if (!committed.reborrowBasis) throw new LedgerError("conflict", "接续审计 basis 未通过读侧核验");
    return committed;
  }).immediate());
}
