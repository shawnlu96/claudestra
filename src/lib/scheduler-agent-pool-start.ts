/** Admission reads the same family pool as dispatch, including pending session creation. */
import type { Database } from "bun:sqlite";
import type { RemotePolicy } from "./scheduler-config.js";
import type { BorrowEntry } from "./lend-config.js";
import { poolLocalFacts } from "./scheduler-agent-pool-context.js";
import { reserveFinishing, reservedStartPlacement } from "./scheduler-agent-pool-reserve.js";
import type { PlacementFacts } from "./scheduler-placement.js";
import { peerFacts } from "./scheduler-placement-plan.js";
import { borrowPeers } from "./scheduler-pool-facts.js";
import { cardRepo } from "./card-repo.js";

/** repo：开卡前还没卡，按要开的节点的仓库估（私仓节点 = 它的 repo: 前缀，i28-SECPOOL2）；不给 = 公共仓 */
export function poolStartFacts(db: Database, project: string, remote: RemotePolicy, borrow: readonly BorrowEntry[], now: number,
  repo?: string | null): PlacementFacts {
  return { remote, local: poolLocalFacts(db, project, remote)!, peers: borrowPeers(db, project, borrow, now, true).map(peerFacts),
    repo: repo ?? cardRepo(null, remote), pin: null, tried: [], lastPeer: null, writeLeasePeer: null, locksFree: true };
}

export function poolStartGate(db: Database, project: string, remote: RemotePolicy, borrow: readonly BorrowEntry[], now: number,
  destination?: { name: string; repo: string } | null, repo?: string | null): string | null {
  const facts = poolStartFacts(db, project, remote, borrow, now, repo);
  const reserved = reserveFinishing(db, project, facts);
  const target = (f: PlacementFacts): PlacementFacts => ({ ...f, repo: destination?.repo ?? f.repo,
    pin: destination ? `peer:${destination.name}` : null, ...(destination === null ? { peers: [] } : {}) });
  const placed = reservedStartPlacement(target(facts), target(reserved));
  if (placed.kind === "wait") return placed.reason;
  return null;
}
