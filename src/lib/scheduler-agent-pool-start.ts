/** Admission reads the same family pool as dispatch, including pending session creation. */
import type { Database } from "bun:sqlite";
import type { RemotePolicy } from "./scheduler-config.js";
import type { BorrowEntry } from "./lend-config.js";
import { poolLocalFacts } from "./scheduler-agent-pool-context.js";
import { placeAgentPool } from "./scheduler-agent-pool.js";
import { peerFacts } from "./scheduler-placement-plan.js";
import { borrowPeers } from "./scheduler-pool-facts.js";

export function poolStartGate(db: Database, project: string, remote: RemotePolicy, borrow: readonly BorrowEntry[], now: number,
  destination?: { name: string; repo: string } | null): string | null {
  const local = poolLocalFacts(db, project, remote)!;
  const finishing = db.query(`SELECT 1 FROM tasks t JOIN task_workflows w ON w.taskId=t.id
    WHERE t.project=? AND w.mode='auto' AND t.stage IN ('review','fix') AND NOT EXISTS
    (SELECT 1 FROM scheduler_intents i WHERE i.taskId=t.id AND i.action IN ('review','dispatch')
    AND i.head IS t.headSHA AND i.status IN ('submitted','done')) LIMIT 1`).get(project);
  if (finishing) return "空位优先留给审查 / 复验 / 修复";
  const placed = placeAgentPool({ remote, local, peers: borrowPeers(db, project, borrow, now, true).map(peerFacts), repo: destination?.repo ?? remote.repo ?? null,
    pin: destination ? `peer:${destination.name}` : null, tried: [], lastPeer: null, writeLeasePeer: null, locksFree: true }, "write", "claude");
  if (placed.kind === "wait") return placed.reason;
  if (destination === null && placed.kind !== "local") {
    const mine = placeAgentPool({ remote, local, peers: [], repo: null, pin: null, tried: [], lastPeer: null, writeLeasePeer: null, locksFree: true }, "write", "claude");
    return mine.kind === "local" ? null : mine.reason;
  }
  return null;
}
