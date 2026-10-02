/**
 * Automatic fix reassignment, the planner's half (pure). The fix goes to another peer when the write-lease holder has been unable
 * to take it for remote.fixReassignMin (default 20) of continuous holder-wait, another peer has a free slot of the card's writing
 * family (so the review family, its opposite, is unchanged), and the holder runs nothing on the card. The clock is the
 * fix_lease_wait stretch the tick records (lend-fix-reassign-tick.ts), so waits on file locks never count. A second relay
 * within the hour goes to PM. tests/lend-fix-reassign.test.ts.
 */
import type { AuthorFamily } from "./ledger-scheduler.js";
import type { PlannerSnapshot } from "./scheduler-plan.js";
import { peerFamily } from "./scheduler-family-pick.js";
import { peerRefusal, type PeerFacts, type PlacementFacts } from "./scheduler-placement.js";
import { FIX_LEASE_WAIT_CODE, FIX_RELAY_OP, FIX_RELAY_WINDOW_MS, leaseWaitOpen } from "./lend-fix-reassign-event.js";
import { FIX_REASSIGN_DEFAULT_MIN } from "./lend-fix-reassign-config.js";

export type RelayAway = { peer: string; reason: string } | { escalate: string } | { code: string; wait: string } | null;

const LIVE = ["pending", "submitted", "unknown"];

/** As if every peer had a free slot of the card's family: some other peer could take the fix once a slot frees up. */
const withRoom = (facts: PlacementFacts, family: AuthorFamily): PlacementFacts => ({ ...facts, peers: facts.peers.map((p) => p.v2
  ? { ...p, v2: { ...p.v2, slots: { ...p.v2.slots, [family]: Math.max(1, p.v2.slots[family] ?? 0) } } } : p) });

/** The peer the fix would be reassigned to now, or null (no other peer can take it in the card's family). */
export function relayCandidate(facts: PlacementFacts, lease: string, family: AuthorFamily): PeerFacts | null {
  const ok = facts.peers.filter((p) => p.peer !== lease && !facts.tried.includes(p.peer) && !!p.v2 &&
    !peerRefusal({ ...facts, writeLeasePeer: p.peer }, p, "fix", family) && peerFamily(p, "fix", family, facts.remote?.writeFamilies) === family);
  return ok.map((p, order) => ({ p, order })).sort((a, b) => a.p.open - b.p.open || a.order - b.order)[0]?.p ?? null;
}

/**
 * Called by remoteWork when the fix cannot go to the lease holder. null = not a holder wait (the caller's own wait / escalation
 * stands); the fix_lease_wait code = keep waiting with the clock running; a peer = reassign there; escalate = PM decides
 * (second relay within the hour).
 */
export function relayAway(s: PlannerSnapshot, since: number, facts: PlacementFacts, lease: string, waitReason: string): RelayAway {
  const now = s.pool?.now;
  if (!s.workflow || !s.pool || now === undefined || s.pool.remote.agents || s.task.stage !== "fix" || !s.task.headSHA || !s.task.pr) return null;
  const family = s.workflow.authorFamily, tried = facts.tried.includes(lease);
  // A file lock blocks every peer alike: only the holder's own refusal, or its finished attempt this round, is a holder wait.
  if (!tried && !peerRefusal({ ...facts, locksFree: true }, facts.peers.find((p) => p.peer === lease), "fix", family)) return null;
  const pick = relayCandidate(facts, lease, family);
  // A tried holder waits like a busy one while another peer could relay once its slot frees; with none at all PM decides.
  if (tried && !pick && !relayCandidate(withRoom(facts, family), lease, family)) return null;
  const hold = { code: FIX_LEASE_WAIT_CODE, wait: waitReason };
  const open = leaseWaitOpen(s.events, since);
  const min = s.pool.remote.fixReassignMin ?? FIX_REASSIGN_DEFAULT_MIN;
  if (!pick || !open || now - open.ts < min * 60_000) return hold;
  if (s.strayPoolOrders?.length || s.intents.some((i) => i.action === "dispatch" && i.causalSeq >= since && LIVE.includes(i.status))) return hold;
  const waited = Math.floor((now - open.ts) / 60_000);
  const last = s.events.findLast((e) => e.kind === "scheduler" && e.data.op === FIX_RELAY_OP && now - e.ts < FIX_RELAY_WINDOW_MS);
  if (last) {
    return { escalate: `修复单等写租约方 ${lease} 已 ${waited} 分钟（${waitReason}），本卡一小时内已自动改派过一次（${String(last.data.from)} → ` +
      `${String(last.data.to)}），不再来回改派：PM 核对后 ledger lend-reclaim ${s.task.id} 或 lend-reoffer` };
  }
  return { peer: pick.peer, reason: `自动改派：写租约在 ${lease}，它连续 ${waited} 分钟不能接（阈值 ${min}；${waitReason}）；` +
    `改派给 ${pick.peer} 的 ${family}，从 PR 当前 head 在它自己的出借分支上接力，新 PR 的 base 是 main` };
}
