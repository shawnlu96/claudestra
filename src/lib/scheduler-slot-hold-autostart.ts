/** Autostart's capacity read: local writers plus currently usable peer capacity, bounded by total in-flight auto cards. */
import type { Database } from "bun:sqlite";
import { readLendSync, type BorrowEntry } from "./lend-config.js";
import { readSchedulerConfig, type RemotePolicy } from "./scheduler-config.js";
import { peerFacts } from "./scheduler-placement-plan.js";
import { borrowPeers } from "./scheduler-pool-facts.js";
import { newCardCapacity } from "./scheduler-slot-hold.js";
import { writeSlotFacts } from "./scheduler-slot-hold-facts.js";

export interface SlotPool { remote: RemotePolicy | null; borrow: readonly BorrowEntry[] }

/** Re-read configuration at the claim gate so revoked borrowing cannot admit new work using cached capacity. */
function configuredPool(project: string): SlotPool {
  return { remote: readSchedulerConfig().projects[project]?.remote ?? null, borrow: readLendSync().file.borrow };
}

export function autostartCapacity(db: Database, project: string, maxWorkers: number, pool = configuredPool(project), now = Date.now()): string | null {
  const slots = writeSlotFacts(db, project);
  const inFlight = (db.query(`SELECT COUNT(*) AS n FROM task_workflows AS w JOIN tasks AS t ON t.id = w.taskId
    WHERE w.project = ? AND w.mode = 'auto' AND (t.stage IN ('spec','restate','build','review','fix','merge')
    OR (t.stage = 'blocked' AND t.stageBefore IN ('spec','restate','build','review','fix','merge')))`)
    .get(project) as { n: number }).n;
  return newCardCapacity({ writers: slots.workerCount, maxWorkers, waitingFix: slots.waitingFix, inFlight, placement: {
    remote: pool.remote, repo: pool.remote?.repo ?? null, peers: borrowPeers(db, project, pool.borrow, now).map(peerFacts),
    local: { running: slots.workerCount, room: slots.workerCount < maxWorkers }, pin: null, tried: [], lastPeer: null, writeLeasePeer: null, locksFree: true,
  } });
}
