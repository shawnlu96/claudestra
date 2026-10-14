/** Unified planning hooks, including local-only security reviews (security-pool.ts switch off) and existing session reuse. */
import type { PlannerSnapshot } from "./scheduler-plan.js";
import type { AgentPoolLoad } from "./scheduler-agent-pool.js";
import type { PlaceRole, PlacementFacts, Placement } from "./scheduler-placement.js";
import { placeAgentPool } from "./scheduler-agent-pool.js";
import { peerFacts } from "./scheduler-agent-pool-peer.js";
import { placementHistory, placeWithRetries } from "./scheduler-placement-tried.js";
import { keepsReviewer } from "./scheduler-review-swap.js";
import type { Away } from "./scheduler-placement-plan.js";
import { LOCAL_LEASE_WAIT, LOCAL_PLACEMENT, placementPin } from "./scheduler-local-pin.js";
import { securityReviewLocalOnly } from "./security-pool.js";
import { recoveryPolicy } from "./recovery-policy.js";
import { reviewLocalFacts } from "./scheduler-agent-pool-review-local.js";
import { writeLocalFacts } from "./scheduler-agent-pool-write-local.js";
import { privateRepoOf, privateReviewWait, privateWriteWait } from "./scheduler-foreign-repo.js";
import { poolRelayAway } from "./recovery-peer-lease.js";

/** PRIVPLACE1: the same facts with this machine taken out (no local room, no family slot, localPriority off): peers only. */
export function peersOnly<T extends PlacementFacts>(f: T): T {
  const pool = f.local.pool && { ...f.local.pool, totals: { claude: 0, codex: 0 } };
  return { ...f, local: { ...f.local, room: false, ...(pool ? { pool } : {}) },
    remote: f.remote && { ...f.remote, ...(f.remote.agents ? { agents: { claude: 0, codex: 0 } } : {}), localPriority: "off" } };
}

function agentPoolFacts(s: PlannerSnapshot, since: number, role: PlaceRole, locksFree: boolean): PlacementFacts & { retries: ReturnType<typeof placementHistory>["retries"] } {
  const p = s.pool!;
  const pool = (p as typeof p & { localPool?: AgentPoolLoad }).localPool;
  return { remote: p.remote, peers: p.peers.map(peerFacts), repo: p.repo,
    local: { running: p.localWriters ?? s.workerCount, room: true, pool, ...(role !== "review" && s.author?.source === "local" ? { family: s.author.family } : {}) },
    pin: placementPin(s.task.extra),
    lastPeer: p.lastPeer, writeLeasePeer: p.writeLeasePeer ?? null, locksFree, ...placementHistory(s, since) };
}

export function agentPoolReview(s: PlannerSnapshot, since: number): Exclude<Away, { escalate: string }> {
  if (!s.workflow) return null;
  const family = s.workflow.authorFamily === "claude" ? "codex" : "claude";
  const facts = reviewLocalFacts(agentPoolFacts(s, since, "review", true), { project: s.task.project, task: s.task.id, round: s.task.round }, recoveryPolicy);
  // A private card has no checkout here: peers only, and a bound local reviewer is not kept (PRIVPLACE1).
  const priv = privateRepoOf(s);
  if (priv) {
    const placed = placeWithRetries(peersOnly(facts), "review", family);
    if (placed.kind !== "peer") return { wait: `${privateReviewWait(priv)}（${placed.reason}）` };
    return { peer: placed.peer, reason: `挂池：跨模型审查给 ${placed.peer} 的 ${family} worker（${placed.reason}）` };
  }
  // Security stays local unless its pool switch is on; a local session's continuity remains a hard rule, not a load preference.
  const localOnly = securityReviewLocalOnly(s.workflow, s.securityPool) || (keepsReviewer(s) && s.reviewer?.source === "local");
  const placed = localOnly ? placeAgentPool({ ...facts, peers: [] }, "review", family) : placeWithRetries(facts, "review", family);
  if (placed.kind === "wait") return { wait: placed.reason };
  return placed.kind === "peer" ? { peer: placed.peer, reason: `挂池：跨模型审查给 ${placed.peer} 的 ${family} worker（${placed.reason}）` } : null;
}

export function agentPoolWork(s: PlannerSnapshot, since: number, role: Exclude<PlaceRole, "review">, locksFree: boolean): Away {
  if (!s.workflow) return null;
  const facts = writeLocalFacts(agentPoolFacts(s, since, role, locksFree), { project: s.task.project, task: s.task.id,
    window: `${s.task.stage}:r${s.task.round}` }, recoveryPolicy); // WRITELOCAL1: only an unpinned write reads it
  const pinnedHere = facts.pin === LOCAL_PLACEMENT;
  // Only an unbound named local author reaches ensure early. Ensure must prove fresh identity or keep every creation gate;
  // once bound, placement and dispatch retain their capacity, lease and file checks.
  if (s.task.agent && !s.author && !facts.writeLeasePeer && (pinnedHere || s.task.stage === "spec")) return null;
  if (s.task.stage === "spec") {
    const local = placeAgentPool({ ...facts, peers: [], pin: null }, "fix", s.author?.family ?? s.workflow.authorFamily);
    return local.kind === "wait" ? { wait: local.reason, code: "placement" } : null;
  }
  if (!["build", "fix"].includes(s.task.stage)) return null;
  if (pinnedHere) {
    // An explicit local card is never sent out, and a peer's write lease is not relaxed into a second local writer either.
    if (facts.writeLeasePeer) return { wait: LOCAL_LEASE_WAIT(facts.writeLeasePeer), code: "placement_pinned" };
    const local = placeAgentPool({ ...facts, peers: [] }, "fix", s.author?.family ?? s.workflow.authorFamily);
    return local.kind === "wait" ? { wait: local.reason, code: "placement" } : null;
  }
  const priv = privateRepoOf(s); // PRIVPLACE1: never a local author for a private card (its pin / spec cases are remoteWork's)
  const placed: Placement = placeWithRetries(priv ? peersOnly(facts) : facts, role, s.workflow.authorFamily);
  const lease = role === "fix" && !facts.pin && placed.kind === "wait" ? facts.writeLeasePeer : null; // PEERLEASE1: the pool relay (recovery-peer-lease.ts)
  const relay = lease ? poolRelayAway(s, since, priv ? peersOnly(facts) : facts, lease, priv ? `${privateWriteWait(priv)}（${placed.reason}）` : placed.reason) : null;
  if (relay) return relay;
  if (priv && placed.kind !== "peer") return { wait: `${privateWriteWait(priv)}（${placed.reason}）`, code: "placement" };
  return placed.kind === "peer" ? { peer: placed.peer, reason: `挂池：${role} 给 ${placed.peer} 的 ${placed.family} worker（${placed.reason}）` }
    : placed.kind === "wait" ? { wait: placed.reason, code: "placement" } : null;
}
