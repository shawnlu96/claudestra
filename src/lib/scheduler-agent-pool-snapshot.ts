/** File leases remain intact; unified capacity is independent of legacy numeric writing slots. */
import type { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import type { AgentLimits } from "./scheduler-agent-pool-config.js";
import { localAgentPool } from "./scheduler-agent-pool-ledger.js";

export function poolSnapshotSlots(db: Database, task: LedgerTask, totals: AgentLimits) {
  const held = db.query("SELECT resource, taskId FROM scheduler_resources WHERE project=?").all(task.project) as { resource: string; taskId: string }[];
  const pool = localAgentPool(db, task.project, totals, task.id);
  const used = new Set(held.map((r) => r.resource));
  let index = 0;
  while (used.has(`slot:${task.project}:agents:${index}`)) index++;
  return { held, workerCount: pool.running.claude + pool.running.codex, freeWorkerSlot: `slot:${task.project}:agents:${index}` };
}
