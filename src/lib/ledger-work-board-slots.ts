/** Completion counts existing workers in total capacity; only new peer writing needs a fresh grant and free room. */
import type { Database } from 'bun:sqlite';
import type { BorrowEntry } from './lend-config.js';
import { getLendPeer, peerCapacity, unifiedPeerCapacity } from './ledger-lend-peers.js';
import type { RemotePolicy } from './scheduler-config.js';

export function workBoardSlots(db: Database, project: string, maxWorkers: number, borrow: readonly BorrowEntry[],
  remote: RemotePolicy | undefined, now: number): number {
  const hasOrders = !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lend_orders'").get();
  if (!hasOrders) return maxWorkers;
  // Claimed writers keep their existing slots even if new borrowing is switched off or its grant expires.
  const held = (db.query(`SELECT COUNT(*) AS n FROM lend_orders WHERE project=? AND status='claimed' AND step IN ('write','fix')
    AND EXISTS (SELECT 1 FROM task_workflows WHERE task_workflows.taskId=lend_orders.taskId)`)
    .get(project) as { n: number }).n;
  // The unified pool (remote.agents) places by unifiedPeerCapacity and ignores borrow roles/priority/maxOpen and grant roles
  // (scheduler-agent-pool.ts); legacy keeps all of those gates.
  const unified = !!remote?.agents;
  const free = remote && remote.mode !== 'off' && remote.roles.includes('write') ? borrow.reduce((sum, b) => {
    if (!b.projects.includes(project) || (!unified && (b.priority === 'off' || !b.roles.includes('write')))) return sum;
    const peer = getLendPeer(db, b.peer);
    if (!peer?.grant || (!unified && !peer.grant.roles.includes('write')) || (remote.repo && !peer.grant.repos.includes(remote.repo))) return sum;
    if (unified) {
      if (peer.proto < 2) return sum;
      const { slots } = unifiedPeerCapacity(db, b.peer, now);
      return sum + slots.codex + slots.claude;
    }
    const capacity = peerCapacity(db, b.peer, b.maxOpen, now);
    return sum + Math.min(Math.max(0, b.maxOpen - capacity.open), capacity.slots.codex + capacity.slots.claude);
  }, 0) : 0;
  return maxWorkers + held + free;
}
