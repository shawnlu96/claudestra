/** Finished cards can retain a dispatch after a pooled round was taken back and completed locally. */
import type { Database } from "bun:sqlite";
import type { SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getTask } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { queueFinishedLeaseNotice } from "./ledger-scheduler-lease-notice.js";
import { workBoardWorkerAlive } from "./ledger-work-board-registry.js";
import { bareCanonicalName, normalizeRegistryAgents, REGISTRY_PATH } from "./registry.js";
import { readJsonStateSync } from "./state-file.js";

const hasTable = (db: Database, table: string): boolean =>
  !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);

function localWriter(db: Database, task: LedgerTask, intents: readonly SchedulerIntent[], registryPath: string): string | null {
  // An unretired local author remains a writer claim, including the create/retire windows before registry changes.
  const session = hasTable(db, "scheduler_sessions") ? db.query(`SELECT agent FROM scheduler_sessions
    WHERE taskId = ? AND role = 'author' AND transport != 'peer' AND state IN ('active','retiring') LIMIT 1`)
    .get(task.id) as { agent: string } | null : null;
  if (session) return `本机 author ${session.agent} 尚未退役`;
  const names = [task.agent, ...intents.map((i) => i.recipient)].filter((n): n is string => !!n && !n.startsWith("peer:"));
  if (!names.length) return null;
  const state = readJsonStateSync(registryPath, (value) => {
    const agents = (value as { agents?: unknown } | null)?.agents;
    return !!agents && typeof agents === "object" && !Array.isArray(agents) &&
      Object.values(agents).every((a) => !!a && typeof a === "object");
  });
  if (state.status === "corrupt") return `本机 worker 状态无法核实：${state.error}`;
  if (state.status === "missing") return null;
  const wanted = new Set(names.map(bareCanonicalName));
  const worker = normalizeRegistryAgents(state.data).find((a) => wanted.has(bareCanonicalName(a.name)) && workBoardWorkerAlive(a));
  return worker ? `本机 worker ${worker.name} 仍是 ${worker.status}` : null;
}

/** Uses card-wide writer facts: a takeover's newer order/worker protects every older residual write intent too. */
export function settleFinishedWriteIntents(db: Database, snapshot: LedgerTask, opts: { registryPath?: string } = {}): void {
  tx(db, () => {
    const task = getTask(db, snapshot.id);
    if (!task || !["live", "verified", "done", "cancelled"].includes(task.stage)) return;
    const intents = db.query(`SELECT * FROM scheduler_intents WHERE taskId = ? AND action = 'dispatch'
      AND node IN ('write','fix') AND status IN ('pending','submitted','unknown') ORDER BY eventSeq, id`).all(task.id) as SchedulerIntent[];
    if (!intents.length) return;
    const order = hasTable(db, "lend_orders") ? db.query(`SELECT orderId, status FROM lend_orders
      WHERE taskId = ? AND step IN ('write','fix') AND status IN ('pooled','claimed','running') LIMIT 1`)
      .get(task.id) as { orderId: string; status: string } | null : null;
    const held = order ? `出借写单 ${order.orderId} 仍是 ${order.status}` : localWriter(db, task, intents, opts.registryPath ?? REGISTRY_PATH);
    if (held) { queueFinishedLeaseNotice(db, task, held); return; }
    const now = Date.now();
    const receipt = `自动结清：卡已 ${task.stage}，同卡无 pooled/claimed/running 出借写单，也无本机在途 worker；取消残留写意图`;
    for (const intent of intents) {
      db.prepare("UPDATE scheduler_intents SET status = 'cancelled', receipt = ?, updatedAt = ? WHERE id = ? AND status = ?")
        .run(receipt, now, intent.id, intent.status);
      db.prepare("DELETE FROM scheduler_resources WHERE intentId = ? AND scope = 'intent'").run(intent.id);
      // This terminal-card reconciliation also resolves unknown; the general scheduler-settle permission stays unchanged.
      insertEvent(db, { actor: "scheduler", now, dedupKey: `scheduler:${intent.id}:cancelled` }, {
        project: task.project, target: task.id, kind: "scheduler", text: "调度意图 cancelled",
        data: { op: "settle", id: intent.id, from: intent.status, to: "cancelled", receipt, finishedCard: true },
      }, true);
    }
  });
}
