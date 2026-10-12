/**
 * S2F7: the attempt number of a planned intent key `t68:s<since>:r<round>:<node>:a<attempt>`.
 * An intent of the same node counts when it was planned at or after `since` (home causalSeq), or when its id carries this
 * round's key prefix — a projected central intent keeps the center's causalSeq, which is not comparable to the home `since`.
 */
import type { SchedulerIntent } from "./ledger-scheduler.js";

export const intentKeyPrefix = (since: number, round: number, node: string): string => `t68:s${since}:r${round}:${node}:a`;

export function intentAttempt(intents: readonly Pick<SchedulerIntent, "id" | "node" | "causalSeq">[], node: string, since: number, round: number): number {
  const prefix = intentKeyPrefix(since, round, node);
  return intents.filter((i) => i.node === node && (i.causalSeq >= since || i.id.startsWith(prefix))).length;
}
