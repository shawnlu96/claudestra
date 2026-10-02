import {
  array, fail, id, integer, nullable, object, parseReceipt, text, timestamp, v2ObjectDigest,
  assertTransactionContext, type Infer, type V2Receipt, type V2TransactionContext,
} from "../../lib/shared-ledger-contract-v2.js";

/** What a source (home, worker or peer) says happened. It is an observation attachment only: its seq never orders
 * central events, and `claimedCommand` is opaque text that is never parsed as or dispatched to a V2 command.
 */
const parseSourceObservation = object({
  instanceId: id, seq: integer, origin: nullable(id), originSeq: nullable(integer),
  observedAt: timestamp, claimedCommand: text(200), summary: text(4000), artifactIds: array(id, 100),
});
type SourceObservation = Infer<typeof parseSourceObservation>;
interface AttachedObservation { serverSeq: number; observation: SourceObservation }

/** Attach observations to an already committed central receipt (same caller transaction). The receipt's serverSeq is
 * the only order; a source key seen before is idempotent if identical and a dedup_mismatch otherwise.
 */
export function attachSourceObservations(ctx: V2TransactionContext, receipt: V2Receipt, observations: readonly unknown[]): AttachedObservation[] {
  assertTransactionContext(ctx);
  const r = parseReceipt(receipt);
  if (r.teamId !== ctx.scope.teamId || r.projectId !== ctx.scope.projectId) fail("forbidden");
  const seq = ctx.all("xt.event.seq", { requestId: r.requestId })[0] as { seq: number } | undefined;
  if (!seq || seq.seq !== r.serverSeq) fail("not_found");
  return observations.map(input => {
    const observation = parseSourceObservation(input), data = JSON.stringify(observation);
    const key = { sourceInstanceId: observation.instanceId, sourceSeq: observation.seq };
    const old = ctx.all("xw.source.get", key)[0] as { serverSeq: number; data: string } | undefined;
    if (old) {
      if (v2ObjectDigest(JSON.parse(old.data)) !== v2ObjectDigest(observation)) fail("dedup_mismatch");
      return { serverSeq: old.serverSeq, observation };
    }
    ctx.run("xw.source.insert", { ...key, serverSeq: r.serverSeq, data });
    return { serverSeq: r.serverSeq, observation };
  });
}
export function readSourceObservations(ctx: V2TransactionContext): AttachedObservation[] {
  assertTransactionContext(ctx);
  return (ctx.all("xw.source.list") as Array<{ serverSeq: number; data: string }>)
    .map(row => ({ serverSeq: row.serverSeq, observation: parseSourceObservation(JSON.parse(row.data)) }));
}
