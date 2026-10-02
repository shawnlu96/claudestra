/**
 * Automatic fix reassignment (i28-RA1), the planner's half, pure. A fix only goes back to the write-lease holder (i28-R6); when
 * that holder cannot take it, the card used to wait until PM ran workflow-set manual → lend-reclaim → stage fix→…→build →
 * lend-offer --base by hand. Now, when all three hold, the fix is placed on another peer instead:
 * - the card has waited on the holder longer than scheduler.json remote.fixReassignMin (default 20) since it entered fix;
 * - another peer has a free slot of the card's writing family (same family as the head's writer, so the review family,
 *   its opposite, does not change: cross-family review holds) and passes every other hard constraint of a fix;
 * - the holder has nothing running on this card (no live dispatch intent, no stray pool order).
 * At most one automatic reassignment per card per hour: the second time it is needed, the card goes to PM (escalate).
 * The relay itself (end the lease, record the event, a fix order on the new peer's own lend/ branch from the PR's current head,
 * PR base = main) is lend-fix-reassign-start.ts; closing the old PR is lend-fix-reassign-pr.ts. tests/lend-fix-reassign.test.ts.
 */
import type { AuthorFamily } from "./ledger-scheduler.js";
import type { PlannerSnapshot } from "./scheduler-plan.js";
import { peerFamily } from "./scheduler-family-pick.js";
import { peerRefusal, type PeerFacts, type PlacementFacts } from "./scheduler-placement.js";
import { FIX_RELAY_OP, FIX_RELAY_WINDOW_MS } from "./lend-fix-reassign-event.js";
import { FIX_REASSIGN_DEFAULT_MIN } from "./lend-fix-reassign-config.js";

export type RelayAway = { peer: string; reason: string } | { escalate: string } | null;

const LIVE = ["pending", "submitted", "unknown"];

/** The peer the fix would be reassigned to now, or null (no other peer can take it in the card's family). */
export function relayCandidate(facts: PlacementFacts, lease: string, family: AuthorFamily): PeerFacts | null {
  const ok = facts.peers.filter((p) => p.peer !== lease && !facts.tried.includes(p.peer) && !!p.v2 &&
    !peerRefusal({ ...facts, writeLeasePeer: p.peer }, p, "fix", family) && peerFamily(p, "fix", family, facts.remote?.writeFamilies) === family);
  return ok.map((p, order) => ({ p, order })).sort((a, b) => a.p.open - b.p.open || a.order - b.order)[0]?.p ?? null;
}

/**
 * Called by remoteWork when the fix waits on the lease holder. null = keep waiting (under the threshold, the holder still runs
 * something here, or no other peer can take it); a peer = reassign there; escalate = second reassignment within the hour.
 */
export function relayAway(s: PlannerSnapshot, since: number, facts: PlacementFacts, lease: string, waitReason: string): RelayAway {
  const now = s.pool?.now;
  if (!s.workflow || !s.pool || now === undefined || s.pool.remote.agents || s.task.stage !== "fix" || !s.task.headSHA || !s.task.pr) return null;
  const entered = s.events.find((e) => e.seq === since)?.ts;
  const min = s.pool.remote.fixReassignMin ?? FIX_REASSIGN_DEFAULT_MIN;
  if (entered === undefined || now - entered < min * 60_000) return null;
  if (s.strayPoolOrders?.length || s.intents.some((i) => i.action === "dispatch" && i.causalSeq >= since && LIVE.includes(i.status))) return null;
  const family = s.workflow.authorFamily;
  const pick = relayCandidate(facts, lease, family);
  if (!pick) return null;
  const waited = Math.floor((now - entered) / 60_000);
  const last = s.events.findLast((e) => e.kind === "scheduler" && e.data.op === FIX_RELAY_OP && now - e.ts < FIX_RELAY_WINDOW_MS);
  if (last) {
    return { escalate: `修复单等写租约方 ${lease} 已 ${waited} 分钟（${waitReason}），本卡一小时内已自动改派过一次（${String(last.data.from)} → ` +
      `${String(last.data.to)}），不再来回改派：PM 核对后 ledger lend-reclaim ${s.task.id} 或 lend-reoffer` };
  }
  return { peer: pick.peer, reason: `自动改派：写租约在 ${lease}，等了 ${waited} 分钟（阈值 ${min}）它仍不能接（${waitReason}）；` +
    `改派给 ${pick.peer} 的 ${family}，从 PR 当前 head 在它自己的出借分支上接力，新 PR 的 base 是 main` };
}
