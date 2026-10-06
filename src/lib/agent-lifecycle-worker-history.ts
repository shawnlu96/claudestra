import type { Database } from "bun:sqlite";

export interface WorkerMigrationEvidence {
  agent: string; sessionId: string | null; taskId: string | null;
  source: "worker_agents" | "scheduler_sessions" | "tasks.agent" | "lend_orders.worker" | "lend_journal";
  state: string; local: boolean; recordId?: string;
}

/** Historical evidence never enters the live index. A-side lend names belong to another instance, even if a local name matches. */
export function cardWorkerMigrationEvidence(db: Database, journalDb?: Database): {
  evidence: WorkerMigrationEvidence[]; missingSources: string[];
} {
  const evidence: WorkerMigrationEvidence[] = [], missingSources: string[] = [];
  const has = (connection: Database, table: string) => !!connection.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (has(db, "worker_agents")) {
    const rows = db.query(`SELECT agent, sessionId, taskId, state FROM worker_agents
      WHERE (reason IS NULL OR (reason != 'registering' AND reason NOT LIKE 'register_failed:%'))`).all() as
      { agent: string; sessionId: string | null; taskId: string | null; state: string }[];
    evidence.push(...rows.map((row) => ({ ...row, source: "worker_agents" as const, local: true })));
  } else missingSources.push("worker_agents");
  if (has(db, "scheduler_sessions")) {
    const rows = db.query("SELECT agent, sessionId, taskId, state FROM scheduler_sessions").all() as
      { agent: string; sessionId: string | null; taskId: string; state: string }[];
    evidence.push(...rows.map((row) => ({ ...row, source: "scheduler_sessions" as const, local: true })));
  } else missingSources.push("scheduler_sessions");
  if (has(db, "tasks")) {
    const rows = db.query("SELECT agent, id AS taskId, stage AS state FROM tasks WHERE agent IS NOT NULL AND agent != ''").all() as
      { agent: string; taskId: string; state: string }[];
    evidence.push(...rows.map((row) => ({ ...row, sessionId: null, source: "tasks.agent" as const, local: true })));
  } else missingSources.push("tasks.agent");
  if (has(db, "lend_orders")) {
    const rows = db.query("SELECT worker AS agent, taskId, status AS state, orderId AS recordId FROM lend_orders WHERE worker IS NOT NULL AND worker != ''").all() as
      { agent: string; taskId: string; state: string; recordId: string }[];
    evidence.push(...rows.map((row) => ({ ...row, sessionId: null, source: "lend_orders.worker" as const, local: false })));
  } else missingSources.push("lend_orders.worker");
  if (journalDb && has(journalDb, "lend_orders")) {
    const columns = journalDb.query("PRAGMA table_info(lend_orders)").all() as { name: string }[];
    if (!["agent", "sessionId", "state", "orderId"].every((name) => columns.some((c) => c.name === name))) missingSources.push("lend_journal:old_schema");
    else {
      const rows = journalDb.query("SELECT agent, sessionId, state, orderId AS recordId FROM lend_orders WHERE agent IS NOT NULL AND agent != ''").all() as
        { agent: string; sessionId: string | null; state: string; recordId: string }[];
      evidence.push(...rows.map((row) => ({ ...row, taskId: null, source: "lend_journal" as const, local: true })));
    }
  } else missingSources.push("lend_journal");
  return { evidence, missingSources };
}
