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

export function poolStartFacts(db: Database, project: string, remote: RemotePolicy, borrow: readonly BorrowEntry[], now: number): PlacementFacts {
  return { remote, local: poolLocalFacts(db, project, remote)!, peers: borrowPeers(db, project, borrow, now, true).map(peerFacts),
    repo: cardRepo(null, remote), pin: null, tried: [], lastPeer: null, writeLeasePeer: null, locksFree: true };
}

export function poolStartGate(db: Database, project: string, remote: RemotePolicy, borrow: readonly BorrowEntry[], now: number,
  destination?: { name: string; repo: string } | null): string | null {
  const facts = poolStartFacts(db, project, remote, borrow, now);
  const reserved = reserveFinishing(db, project, facts);
  const target = (f: PlacementFacts): PlacementFacts => ({ ...f, repo: destination?.repo ?? f.repo,
    pin: destination ? `peer:${destination.name}` : null, ...(destination === null ? { peers: [] } : {}) });
  const placed = reservedStartPlacement(target(facts), target(reserved));
  if (placed.kind === "wait") return placed.reason;
  return null;
}
