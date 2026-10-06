/**
 * REBOR2 canonical write: one BEGIN IMMEDIATE re-checks task/head/spec/round/old terminal facts, every authority and the source
 * digest, then issues the successor only through offerLendCore (new order + new held projection) and appends the evidence.
 * Any failure rolls back all three; concurrent requests yield exactly one order. tests/lend-reborrow2-apply.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { getLendOrder, offerLendCore, type OfferInput, type LendOrder } from "./ledger-lend.js";
import { appendEvent } from "./ledger-write.js";
import { busyAsLedgerError, LedgerError } from "./ledger-store.js";
import { cliOfferFamily } from "./lend-cli-author-family.js";
import { LEND_FAMILIES } from "./lend-config.js";
import { assertReborrow2Authority, assertReborrow2Cas } from "./lend-reborrow2-facts.js";
import { assertReborrow2Context, type Reborrow2Context } from "./lend-reborrow2-context.js";
import { reborrow2EventDraft, reborrow2Key, replayReborrow2 } from "./lend-reborrow2-event.js";

function assertInput(recovery: Reborrow2Context, input: OfferInput): void {
  const f = recovery.facts, s = recovery.source;
  if (input.taskId !== f.task.id || input.peer !== f.target.peer || input.repo !== f.target.repo || input.family !== f.family ||
    input.pr !== (s.pr?.number ?? null) || input.write?.fp !== f.target.fp || input.write.base !== "main" || input.write.reborrow ||
    input.write.reborrow2 !== recovery || input.supersedes !== undefined) {
    throw new LedgerError("conflict", "终态接续输入与已核事实不符");
  }
}

export function applyReborrow2(db: Database, ctx: WriteCtx, recovery: Reborrow2Context, input: OfferInput, pinnedFp: string | null): LendOrder {
  return busyAsLedgerError("终态接续写租约", () => db.transaction(() => {
    const f = recovery.facts, s = recovery.source;
    assertInput(recovery, input);
    const replay = replayReborrow2(db, f, s, (id) => getLendOrder(db, id));
    assertReborrow2Authority(db, f, ctx.actor, input.borrow, pinnedFp, ctx.now ?? Date.now(), replay !== null);
    if (replay) return replay as LendOrder;
    assertReborrow2Cas(db, f);
    assertReborrow2Context(f.task, input.peer, recovery);
    // Same family keeps the existing CLI family gate; a change was proven by the formal workflow epoch in the facts.
    if (f.family === f.originalFamily) cliOfferFamily(db, f.task, input.family);
    else if (!(LEND_FAMILIES as readonly string[]).includes(input.family)) throw new LedgerError("invalid", "作者家族不认识");
    const order = offerLendCore(db, ctx, { ...input, supersedes: f.previous.orderId });
    appendEvent(db, { ...ctx, dedupKey: reborrow2Key(f.task.id, f.previous.orderId, f.previous.leaseGen) }, reborrow2EventDraft(f, s, order));
    const committed = getLendOrder(db, order.orderId)!;
    if (!committed.reborrow2Basis) throw new LedgerError("conflict", "终态接续审计 basis 未通过读侧核验");
    return committed;
  }).immediate());
}
