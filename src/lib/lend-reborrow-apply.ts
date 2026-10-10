/** Atomic canonical write composition; source I/O is finished before this function is called. */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { getLendOrder, offerLendCore, type OfferInput, type LendOrder } from "./ledger-lend.js";
import { appendEvent } from "./ledger-write.js";
import { busyAsLedgerError, LedgerError } from "./ledger-store.js";
import { cliOfferFamily } from "./lend-cli-author-family.js";
import { assertReborrowAuthority, assertReborrowCas } from "./lend-reborrow-facts.js";
import { assertConvReborrowCas } from "./lend-reborrow-conv.js";
import { convOrderSpec } from "./lend-reborrow-conv-material.js";
import { assertReborrowContext, type ReborrowContext } from "./lend-reborrow-context.js";
import { reborrowEventDraft, reborrowKeyFor, replayReborrow } from "./lend-reborrow-event.js";

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
    (f.conv ? assertConvReborrowCas : assertReborrowCas)(db, f);
    assertReborrowContext(f.task, input.peer, recovery);
    // CONV: the target family is the formal other_family decision (already re-proven by the CAS); authority above re-checked
    // the current borrow/grant/protocol/capacity for that family. No general family-swap permission is derived from it.
    if (!f.conv) cliOfferFamily(db, f.task, input.family);
    else {
      cliOfferFamily(db, f.task, f.conv.from); // original-author proof is kept, never replaced by the target
      if (input.family !== f.conv.to || f.family !== f.conv.to) throw new LedgerError("conflict", "新单家族与 CONV 冻结目标家族不符");
    }
    // CONV: the frozen history rides the order spec through offerLendCore's complete outbound gate, as the proven bytes only.
    const spec = f.conv ? convOrderSpec(db, f.task, input.spec, f.conv.material) : input.spec;
    const order = offerLendCore(db, ctx, { ...input, spec, supersedes: f.previous.orderId, write: { ...input.write, reborrow: recovery } });
    appendEvent(db, { ...ctx, dedupKey: reborrowKeyFor(f) }, reborrowEventDraft(f, s, order));
    const committed = getLendOrder(db, order.orderId)!;
    if (!committed.reborrowBasis) throw new LedgerError("conflict", "接续审计 basis 未通过读侧核验");
    return committed;
  }).immediate());
}
