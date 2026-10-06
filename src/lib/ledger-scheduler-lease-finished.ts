/** Finished cards can retain a dispatch after a pooled round was taken back and completed locally. */
import { Database } from "bun:sqlite";
import type { SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getTask } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { clearFinishedLeaseNotice, queueFinishedLeaseNotice } from "./ledger-scheduler-lease-notice.js";
import { REGISTRY_PATH } from "./registry.js";
import { withLedgerWriter } from "./ledger-scheduler-lease-sync.js";
import { finishedWriters, finishedWorkerKey, finishedWorkerIdle } from "./ledger-scheduler-lease-worker.js";
import type { RegistryAgent } from "./registry.js";

type Options = { registryPath?: string; idleProof?: string; assertActive?: () => void };
const pending = new Map<string, Promise<void>>();
const hasTable = (db: Database, table: string): boolean =>
  !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);

/** Capture the whole card, intent and lease rows so a concurrent transition or settlement invalidates the probe. */
function stateKey(db: Database, taskId: string): string | null {
  const resources = db.query("SELECT * FROM scheduler_resources WHERE taskId = ? ORDER BY resource").all(taskId);
  if (!resources.length) return null;
  return JSON.stringify([getTask(db, taskId),
    db.query("SELECT * FROM scheduler_intents WHERE taskId = ? ORDER BY id").all(taskId), resources,
    db.query("SELECT * FROM scheduler_sessions WHERE taskId = ? ORDER BY sessionId").all(taskId)]);
}

function probeAfterCommit(db: Database, task: LedgerTask, workers: RegistryAgent[], opts: Options): void {
  const key = stateKey(db, task.id), filename = db.filename;
  const job = `${filename}:${task.id}`;
  if (!key || pending.has(job)) return;
  const token = crypto.randomUUID(), probeKey = `finished-card-lease-probe:${task.id}`;
  db.prepare("INSERT OR REPLACE INTO scheduler_meta (key, value) VALUES (?, ?)").run(probeKey, token);
  const work = Promise.resolve().then(() => reconcileWorkers(filename, db, task, workers, opts, { key, probeKey, token }));
  pending.set(job, work);
  void work.catch((error) => console.error("[scheduler-lease] 结清探测失败，保留文件锁", error)).finally(() => pending.delete(job));
}

async function reconcileWorkers(filename: string, writer: Database, task: LedgerTask, workers: RegistryAgent[], opts: Options,
  proof: { key: string; probeKey: string; token: string }): Promise<void> {
  const memory = !filename || filename === ":memory:";
  const db = memory ? writer : new Database(filename, { readwrite: true, create: false });
  const currentProbe = () => (db.query("SELECT value FROM scheduler_meta WHERE key = ?").get(proof.probeKey) as { value: string } | null)?.value === proof.token;
  try {
    if (!currentProbe() || stateKey(db, task.id) !== proof.key) return; // A rolled-back enclosing transaction must never launch a probe.
    const idle = await Promise.all(workers.map(finishedWorkerIdle));
    tx(db, () => {
      opts.assertActive?.();
      if (!currentProbe() || stateKey(db, task.id) !== proof.key) return;
      const intents = db.query("SELECT * FROM scheduler_intents WHERE taskId = ?").all(task.id) as SchedulerIntent[];
      const current = finishedWriters(db, task, intents.filter((i) => i.action === "dispatch" && ["write", "fix"].includes(i.node) &&
        ["pending", "submitted", "unknown"].includes(i.status)), opts.registryPath ?? REGISTRY_PATH);
      if (current.reason || finishedWorkerKey(current.workers) !== finishedWorkerKey(workers)) return;
      if (idle.some((value) => !value)) {
        queueFinishedLeaseNotice(db, task, `本机 worker ${workers.filter((_, i) => !idle[i]).map((w) => w.name).join("、")} 在忙或忙闲未知`, undefined, opts.assertActive);
        return;
      }
      settleFinishedWriteIntents(db, task, { ...opts, idleProof: finishedWorkerKey(workers) });
      if (!db.query("SELECT 1 FROM scheduler_intents WHERE taskId = ? AND status IN ('pending','submitted','unknown')").get(task.id)) {
        db.query("DELETE FROM scheduler_resources WHERE taskId = ? AND scope = 'card'").run(task.id);
      }
    });
  } finally {
    try {
      opts.assertActive?.();
      db.prepare("DELETE FROM scheduler_meta WHERE key = ? AND value = ?").run(proof.probeKey, proof.token);
    } finally { if (!memory) db.close(); }
  }
}

/** Uses card-wide writer facts: a takeover's newer order/worker protects every older residual write intent too. */
export function settleFinishedWriteIntents(db: Database, snapshot: LedgerTask, opts: Options = {}): void {
  tx(db, () => {
    opts.assertActive?.();
    const task = getTask(db, snapshot.id);
    if (!task || !["live", "verified", "done", "cancelled"].includes(task.stage)) return;
    const intents = db.query(`SELECT * FROM scheduler_intents WHERE taskId = ? AND action = 'dispatch'
      AND node IN ('write','fix') AND status IN ('pending','submitted','unknown') ORDER BY eventSeq, id`).all(task.id) as SchedulerIntent[];
    if (!intents.length) { clearFinishedLeaseNotice(db, task.id); return; }
    const order = hasTable(db, "lend_orders") ? db.query(`SELECT orderId, status FROM lend_orders
      WHERE taskId = ? AND step IN ('write','fix') AND status IN ('pooled','claimed','unknown') LIMIT 1`)
      .get(task.id) as { orderId: string; status: string } | null : null;
    if (order) { queueFinishedLeaseNotice(db, task, `出借写单 ${order.orderId} 仍是 ${order.status}`, undefined, opts.assertActive); return; }
    const local = finishedWriters(db, task, intents, opts.registryPath ?? REGISTRY_PATH);
    if (local.reason) { queueFinishedLeaseNotice(db, task, local.reason, undefined, opts.assertActive); return; }
    if (local.workers.length && opts.idleProof !== finishedWorkerKey(local.workers)) {
      probeAfterCommit(db, task, local.workers, opts);
      return;
    }
    clearFinishedLeaseNotice(db, task.id);
    const now = Date.now();
    const receipt = `自动结清：卡已 ${task.stage}，同卡无 pooled/claimed/unknown 出借写单，也无本机在途 worker；取消残留写意图`;
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

/** Retry busy/unknown workers on service ticks, including manual cards, before retirement checks open intents. */
export async function reconcileFinishedCardLeases(db: Database, projects: readonly string[], assertActive: () => void): Promise<void> {
  if (!projects.length) return;
  const tasks = db.query(`SELECT DISTINCT t.id FROM tasks t JOIN scheduler_intents i ON i.taskId = t.id
    WHERE t.project IN (${projects.map(() => "?").join(",")}) AND t.stage IN ('live','verified','done','cancelled')
    AND i.action = 'dispatch' AND i.node IN ('write','fix') AND i.status IN ('pending','submitted','unknown') ORDER BY t.id`)
    .all(...projects) as { id: string }[];
  const probes: Promise<void>[] = [];
  for (const row of tasks) {
    assertActive();
    tx(db, () => {
      settleFinishedWriteIntents(db, getTask(db, row.id)!, { assertActive });
      const probe = pending.get(`${db.filename}:${row.id}`);
      if (probe) probes.push(probe);
      else if (!db.query("SELECT 1 FROM scheduler_intents WHERE taskId = ? AND status IN ('pending','submitted','unknown')").get(row.id)) {
        db.query("DELETE FROM scheduler_resources WHERE taskId = ? AND scope = 'card'").run(row.id);
      }
    });
  }
  await Promise.all(probes);
  assertActive();
  releaseStrandedCardLocks(db, projects, assertActive);
}

/**
 * A finished card with no open intent still holding card locks: a move to live that skipped the release (the pre-LCK-1 merge
 * handoff) left them until verify. Same rule as releaseFinishedCardLeases, swept each tick so such cards free up on their own.
 */
function releaseStrandedCardLocks(db: Database, projects: readonly string[], assertActive: () => void): void {
  const stranded = `SELECT DISTINCT r.taskId FROM scheduler_resources r JOIN tasks t ON t.id = r.taskId WHERE r.scope = 'card'
    AND t.project IN (${projects.map(() => "?").join(",")}) AND t.stage IN ('live','verified','done','cancelled')
    AND NOT EXISTS (SELECT 1 FROM scheduler_intents i WHERE i.taskId = t.id AND i.status IN ('pending','submitted','unknown'))`;
  if (!db.query(stranded).all(...projects).length) return; // the pass reads query_only: write only when there is something to free
  withLedgerWriter(db, (writer) => tx(writer, () => {
    assertActive();
    writer.query(`DELETE FROM scheduler_resources WHERE scope = 'card' AND taskId IN (${stranded})`).run(...projects);
  }));
}

/** Reconciliation cancels only proven idle/absent writers. Retirement must not force its remaining writes closed. */
export function hasUnsettledFinishedWrites(db: Database, taskId: string): boolean {
  return !!db.query(`SELECT 1 FROM scheduler_intents WHERE taskId = ? AND action = 'dispatch'
    AND node IN ('write','fix') AND status IN ('pending','submitted','unknown') LIMIT 1`).get(taskId);
}
