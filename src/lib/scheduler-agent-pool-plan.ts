/** Unified planning hooks, including local-only security reviews and existing session reuse. */
import type { PlannerSnapshot } from "./scheduler-plan.js";
import type { AgentPoolLoad } from "./scheduler-agent-pool.js";
import type { PlaceRole, PlacementFacts, Placement } from "./scheduler-placement.js";
import { placeAgentPool } from "./scheduler-agent-pool.js";
import { peerFacts } from "./scheduler-agent-pool-peer.js";
import { placementHistory, placeWithRetries } from "./scheduler-placement-tried.js";
import { keepsReviewer } from "./scheduler-review-swap.js";
import type { Away } from "./scheduler-placement-plan.js";

function agentPoolFacts(s: PlannerSnapshot, since: number, role: PlaceRole, locksFree: boolean): PlacementFacts & { retries: ReturnType<typeof placementHistory>["retries"] } {
  const p = s.pool!;
  const pool = (p as typeof p & { localPool?: AgentPoolLoad }).localPool;
  return { remote: p.remote, peers: p.peers.map(peerFacts), repo: p.repo,
    local: { running: p.localWriters ?? s.workerCount, room: true, pool, ...(role !== "review" && s.author?.source === "local" ? { family: s.author.family } : {}) },
    pin: typeof s.task.extra.placement === "string" ? s.task.extra.placement : null,
    lastPeer: p.lastPeer, writeLeasePeer: p.writeLeasePeer ?? null, locksFree, ...placementHistory(s, since) };
}

export function agentPoolReview(s: PlannerSnapshot, since: number): Exclude<Away, { escalate: string }> {
  if (!s.workflow) return null;
  const family = s.workflow.authorFamily === "claude" ? "codex" : "claude";
  const facts = agentPoolFacts(s, since, "review", true);
  // Security stays local; a local session's continuity remains a hard rule, not a load preference.
  const localOnly = s.workflow.template === "security" || (keepsReviewer(s) && s.reviewer?.source === "local");
  const placed = localOnly ? placeAgentPool({ ...facts, peers: [] }, "review", family) : placeWithRetries(facts, "review", family);
  if (placed.kind === "wait") return { wait: placed.reason };
  return placed.kind === "peer" ? { peer: placed.peer, reason: `挂池：跨模型审查给 ${placed.peer} 的 ${family} worker（${placed.reason}）` } : null;
}

export function agentPoolWork(s: PlannerSnapshot, since: number, role: Exclude<PlaceRole, "review">, locksFree: boolean): Away {
  if (!s.workflow) return null;
  const facts = agentPoolFacts(s, since, role, locksFree);
  if (facts.pin === "local" && facts.writeLeasePeer) facts.pin = `peer:${facts.writeLeasePeer}`;
  if (s.task.stage === "spec") {
    const local = placeAgentPool({ ...facts, peers: [], pin: null }, "fix", s.author?.family ?? s.workflow.authorFamily);
    return local.kind === "wait" ? { wait: local.reason, code: "placement" } : null;
  }
  if (!["build", "fix"].includes(s.task.stage)) return null;
  if (!facts.writeLeasePeer && !facts.pin?.startsWith("peer:") && facts.pin === "local") {
    const local = placeAgentPool({ ...facts, peers: [], pin: null }, "fix", s.author?.family ?? s.workflow.authorFamily);
    return local.kind === "wait" ? { wait: local.reason, code: "placement" } : null;
  }
  const placed: Placement = placeWithRetries(facts, role, s.workflow.authorFamily);
  return placed.kind === "peer" ? { peer: placed.peer, reason: `挂池：${role} 给 ${placed.peer} 的 ${placed.family} worker（${placed.reason}）` }
    : placed.kind === "wait" ? { wait: placed.reason, code: "placement" } : null;
}
