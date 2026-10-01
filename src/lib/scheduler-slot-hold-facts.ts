/** Read-only slot projection, kept below ledger writers so stage transitions can release slots without import cycles. */
import type { Database } from "bun:sqlite";
import { getWorkflow } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { listEvents, listTasks } from "./ledger-store.js";
import { returnedFix, shouldHoldWriteSlot, type WriteSlotOwner } from "./scheduler-slot-hold.js";

export function localWriteOwner(db: Database, task: LedgerTask): boolean {
  if (!shouldHoldWriteSlot({ stage: task.stage, writeLease: null, orders: [] })) return false;
  const hasOrders = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lend_orders'").get();
  const hasLeases = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lend_write_leases'").get();
  const writeLease = hasLeases ? db.query("SELECT state FROM lend_write_leases WHERE taskId = ?").get(task.id) as WriteSlotOwner["writeLease"] : null;
  const orders = hasOrders ? db.query("SELECT step, status FROM lend_orders WHERE taskId = ?").all(task.id) as WriteSlotOwner["orders"] : [];
  return shouldHoldWriteSlot({ stage: task.stage, writeLease, orders });
}

/** Filter stale pre-upgrade slot rows too, while retaining every file/task/reviewer lease unchanged. */
export function writeSlotFacts(db: Database, project: string) {
  const resources = db.query("SELECT resource, taskId FROM scheduler_resources WHERE project = ?").all(project) as { resource: string; taskId: string }[];
  const tasks = listTasks(db, project);
  const local = new Set(tasks.filter((t) => localWriteOwner(db, t)).map((t) => t.id));
  const stale = resources.filter((r) => r.resource.startsWith("slot:") && !local.has(r.taskId));
  const held = resources.filter((r) => !stale.includes(r));
  const slots = held.filter((r) => r.resource.startsWith("slot:"));
  const writers = new Set(slots.map((r) => r.taskId));
  // start_node creates the author before build dispatch takes a persisted slot. Project that author now,
  // including the claim-to-create window, so admission and dispatch see the same reserved capacity.
  const implicit = tasks.filter((t) => local.has(t.id) && t.agent && ["spec", "restate"].includes(t.stage) &&
    !(typeof t.extra.placement === "string" && t.extra.placement.startsWith("peer:"))).map((t) => t.id);
  const claims = db.query(`SELECT json_extract(e.data, '$.taskId') AS taskId FROM events e WHERE e.project = ?
    AND json_extract(e.data, '$.op') = 'autostart_claim' AND json_extract(e.data, '$.peer') IS NULL
    AND NOT EXISTS (SELECT 1 FROM events s WHERE s.dedupKey = 'autostart-settle:' || e.seq)
    AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = json_extract(e.data, '$.taskId'))`).all(project) as { taskId: string }[];
  const used = new Set(slots.map((r) => r.resource));
  for (const taskId of [...implicit, ...claims.map((c) => c.taskId)]) {
    if (writers.has(taskId)) continue;
    let index = 0;
    while (used.has(`slot:${project}:${index}`)) index++;
    const row = { resource: `slot:${project}:${index}`, taskId };
    used.add(row.resource); writers.add(taskId); slots.push(row); held.push(row);
  }
  const waitingFix = tasks.some((t) => local.has(t.id) && !writers.has(t.id) && t.stage === "fix" && getWorkflow(db, t.id)?.mode === "auto" &&
    !(typeof t.extra.placement === "string" && t.extra.placement.startsWith("peer:")) &&
    returnedFix(t, listEvents(db, { project, target: t.id })));
  return { held, stale, slots, writers, workerCount: writers.size, waitingFix };
}
