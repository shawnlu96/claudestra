import { poolStartGate } from "./scheduler-agent-pool-start.js";
/** Autostart's capacity read: local writers plus currently usable peer capacity, bounded by total in-flight auto cards. */
import type { Database } from "bun:sqlite";
import { readLendSync, type BorrowEntry } from "./lend-config.js";
import { readSchedulerConfig, type RemotePolicy } from "./scheduler-config.js";
import { peerFacts } from "./scheduler-placement-plan.js";
import { borrowPeers } from "./scheduler-pool-facts.js";
import { cardRepo } from "./card-repo.js";
import { peerRefusal } from "./scheduler-placement.js";
import { newLocalWriteRoom, newCardCapacity } from "./scheduler-slot-hold.js";
import { writeSlotFacts } from "./scheduler-slot-hold-facts.js";

export interface SlotPool { remote: RemotePolicy | null; borrow: readonly BorrowEntry[] }

/** Re-read configuration at the claim gate so revoked borrowing cannot admit new work using cached capacity. */
function configuredPool(project: string): SlotPool {
  return { remote: readSchedulerConfig().projects[project]?.remote ?? null, borrow: readLendSync().file.borrow };
}

export function autostartCapacity(db: Database, project: string, maxWorkers: number, pool = configuredPool(project), now = Date.now()): string | null {
  if (pool.remote?.agents) return poolStartGate(db, project, pool.remote, pool.borrow, now);
  const slots = writeSlotFacts(db, project);
  const inFlight = (db.query(`SELECT COUNT(*) AS n FROM task_workflows AS w JOIN tasks AS t ON t.id = w.taskId
    WHERE w.project = ? AND w.mode = 'auto' AND (t.stage IN ('spec','restate','build','review','fix','merge')
    OR (t.stage = 'blocked' AND t.stageBefore IN ('spec','restate','build','review','fix','merge')))`)
    .get(project) as { n: number }).n;
  return newCardCapacity({ writers: slots.workerCount, maxWorkers, waitingFix: slots.waitingFix, inFlight, placement: {
    remote: pool.remote, repo: cardRepo(null, pool.remote), peers: borrowPeers(db, project, pool.borrow, now).map(peerFacts),
    local: { running: slots.workerCount, room: slots.workerCount < maxWorkers }, pin: null, tried: [], lastPeer: null, writeLeasePeer: null, locksFree: true,
  } });
}

/** The claim transaction checks the selected destination again; a peer vacancy never authorizes a local start. */
export function autostartPlacementGate(db: Database, project: string, maxWorkers: number,
  peer: { name: string; repo: string } | null | undefined, pool = configuredPool(project), now = Date.now()): string | null {
  if (pool.remote?.agents) return poolStartGate(db, project, pool.remote, pool.borrow, now, peer ?? null);
  const slots = writeSlotFacts(db, project);
  if (!peer) return pool.remote?.localPriority !== "off" && newLocalWriteRoom(slots.workerCount, maxWorkers, slots.waitingFix)
    ? null : "本机不写代码或写槽已满，不能在本机开卡";
  const peers = borrowPeers(db, project, pool.borrow, now).map(peerFacts);
  return peerRefusal({ remote: pool.remote, peers, repo: peer.repo, local: { running: slots.workerCount, room: false },
    pin: null, tried: [], lastPeer: null, writeLeasePeer: null, locksFree: true }, peers.find((p) => p.peer === peer.name), "write", "claude");
}
