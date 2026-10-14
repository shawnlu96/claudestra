/** Read-only slot projection, kept below ledger writers so stage transitions can release slots without import cycles. */
import type { Database } from "bun:sqlite";
import { AUTOSTART_DEDUP_PREFIX, dedupRangeEnd } from "./ledger-autostart-grant.js";
import { getWorkflow } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { listEvents, listTasks } from "./ledger-store.js";
import { returnedFix, shouldHoldWriteSlot, type WriteSlotOwner } from "./scheduler-slot-hold.js";

/** localWriteOwner 每张卡一次：走 lend_orders_task 索引（lend_orders_live 只覆盖在途状态，按 taskId 等值查用不上） */
export const LEND_ORDERS_SQL = "SELECT step, status FROM lend_orders WHERE taskId = ?";

/**
 * writeSlotFacts 的未结 claim 读：dedupKey 前缀区间走 events 的 dedupKey 唯一索引，`+e.project` 让规划器别选 events_project_target
 * （几乎全表同一个项目）。claim 只由 claimNode 以 claimDedup 写入，前缀不变量在 ledger-autostart-grant.ts。
 * ORDER BY 保住旧计划（events_project_target 的 (target, seq)）给出的行序：claim 按这个顺序分 slot 号。
 */
export const CLAIMS_SQL = `SELECT json_extract(e.data, '$.taskId') AS taskId FROM events e WHERE +e.project = ?
    AND e.dedupKey >= '${AUTOSTART_DEDUP_PREFIX}' AND e.dedupKey < '${dedupRangeEnd(AUTOSTART_DEDUP_PREFIX)}'
    AND json_extract(e.data, '$.op') = 'autostart_claim' AND json_extract(e.data, '$.peer') IS NULL
    AND NOT EXISTS (SELECT 1 FROM events s WHERE s.dedupKey = 'autostart-settle:' || e.seq)
    AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = json_extract(e.data, '$.taskId'))
    ORDER BY e.target, e.seq`;

export function localWriteOwner(db: Database, task: LedgerTask): boolean {
  if (!shouldHoldWriteSlot({ stage: task.stage, writeLease: null, orders: [] })) return false;
  const hasOrders = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lend_orders'").get();
  const hasLeases = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lend_write_leases'").get();
  const writeLease = hasLeases ? db.query("SELECT state FROM lend_write_leases WHERE taskId = ?").get(task.id) as WriteSlotOwner["writeLease"] : null;
  const orders = hasOrders ? db.query(LEND_ORDERS_SQL).all(task.id) as WriteSlotOwner["orders"] : [];
  return shouldHoldWriteSlot({ stage: task.stage, writeLease, orders });
}

/** Filter stale pre-upgrade slot rows too, while retaining every file/task/reviewer lease unchanged. */
export function writeSlotFacts(db: Database, project: string, snapshotTasks?: LedgerTask[]) {
  const resources = db.query("SELECT resource, taskId FROM scheduler_resources WHERE project = ?").all(project) as { resource: string; taskId: string }[];
  const tasks = snapshotTasks ?? listTasks(db, project), local = new Set(tasks.filter((t) => localWriteOwner(db, t)).map((t) => t.id));
  const stale = resources.filter((r) => r.resource.startsWith("slot:") && !local.has(r.taskId));
  const held = resources.filter((r) => !stale.includes(r));
  const slots = held.filter((r) => r.resource.startsWith("slot:"));
  const writers = new Set(slots.map((r) => r.taskId));
  // start_node creates the author before build dispatch takes a persisted slot. Project that author now,
  // including the claim-to-create window, so admission and dispatch see the same reserved capacity.
  const implicit = tasks.filter((t) => local.has(t.id) && t.agent && ["spec", "restate"].includes(t.stage) &&
    !(typeof t.extra.placement === "string" && t.extra.placement.startsWith("peer:"))).map((t) => t.id);
  const claims = db.query(CLAIMS_SQL).all(project) as { taskId: string }[];
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
