/**
 * Card worker registrations (lib/agent-lifecycle.ts): every path that creates a worker agent for a card writes one row here at
 * create time. A separate table rather than scheduler_sessions: those rows need an ensure_session intent, a family and a transport,
 * which PM-tool and start_node agents do not have; scheduler-bound sessions keep retiring through scheduler-retire.ts.
 * Retirement marks rows retired and writes one ledger event per agent (the card's project; an unknown card's row is the record).
 */
import type { Database } from "bun:sqlite";
import { getTask, LedgerError } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";

const WORKER_ROLES = ["author", "reviewer", "other"] as const;
export type WorkerRole = (typeof WORKER_ROLES)[number];
export const isWorkerRole = (v: unknown): v is WorkerRole => WORKER_ROLES.includes(v as WorkerRole);

export interface WorkerRegistration {
  agent: string;
  sessionId: string;
  taskId: string | null;
  role: WorkerRole;
  createdBy: string;
  createdAt: number;
  state: "active" | "retired";
  retiredAt: number | null;
  reason: string | null;
}

function ensureWorkerTable(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS worker_agents (
    agent TEXT NOT NULL, sessionId TEXT NOT NULL DEFAULT '', taskId TEXT, role TEXT NOT NULL CHECK (role IN ('author','reviewer','other')),
    createdBy TEXT NOT NULL, createdAt INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('active','retired')),
    retiredAt INTEGER, reason TEXT, PRIMARY KEY (agent, createdAt))`);
  db.run("CREATE INDEX IF NOT EXISTS worker_agents_state ON worker_agents(state, taskId)");
}

/** Read-only (the scheduler's connection cannot create tables): no table yet = nothing registered. */
export function activeWorkers(db: Database): WorkerRegistration[] {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'worker_agents'").get()) return [];
  return db.query("SELECT * FROM worker_agents WHERE state = 'active' ORDER BY createdAt").all() as WorkerRegistration[];
}

/** Refuses a card the ledger does not know: a typo'd id would register an agent nothing ever collects. */
export function checkCard(db: Database, taskId: string): string | null {
  return getTask(db, taskId) ? null : `台账里没有卡 ${taskId}（--card 要写台账卡号，如 --card T123）`;
}

export interface RegisterInput { agent: string; sessionId: string; taskId: string; role: WorkerRole; createdBy: string; now?: number }

/** A re-created name replaces its earlier active row: one agent name runs one session at a time. */
export function registerWorker(db: Database, input: RegisterInput): WorkerRegistration {
  if (!isWorkerRole(input.role)) throw new LedgerError("invalid", `--card-role 只能是 ${WORKER_ROLES.join(" / ")}`);
  ensureWorkerTable(db);
  return tx(db, () => {
    const task = getTask(db, input.taskId);
    if (!task) throw new LedgerError("not_found", checkCard(db, input.taskId) ?? "");
    const now = input.now ?? Date.now();
    db.prepare("UPDATE worker_agents SET state = 'retired', retiredAt = ?, reason = '同名 agent 重建' WHERE agent = ? AND state = 'active'").run(now, input.agent);
    db.prepare(`INSERT OR REPLACE INTO worker_agents (agent, sessionId, taskId, role, createdBy, createdAt, state) VALUES (?, ?, ?, ?, ?, ?, 'active')`)
      .run(input.agent, input.sessionId, task.id, input.role, input.createdBy, now);
    insertEvent(db, { actor: input.createdBy, now }, { project: task.project, target: task.id, kind: "scheduler", text: `登记 ${input.role} agent ${input.agent}`,
      data: { op: "worker_register", agent: input.agent, sessionId: input.sessionId, role: input.role, createdBy: input.createdBy } }, false);
    return db.query("SELECT * FROM worker_agents WHERE agent = ? AND createdAt = ?").get(input.agent, now) as WorkerRegistration;
  });
}

export interface RetireRecord {
  agent: string; taskId: string | null; role: WorkerRole | "stock"; rule: string; mode: "retire" | "park"; reason: string;
  idleMs: number | null; bytesBefore: number | null; bytesAfter: number | null; steps: string[]; now: number;
}

/**
 * Idempotent: a park keeps the row active (the agent may be resumed for the same card), a retire closes it; an agent with no
 * active row (stock) gets a retired row so the ledger keeps a record even when its card is unknown. The event goes to the card's
 * project when the card is known.
 */
export function recordWorkerRetire(db: Database, actor: string, r: RetireRecord): void {
  ensureWorkerTable(db);
  tx(db, () => {
    const freed = r.bytesBefore !== null && r.bytesAfter !== null ? Math.max(0, r.bytesBefore - r.bytesAfter) : null;
    const reason = `${r.rule}: ${r.reason}`.slice(0, 300);
    if (r.mode === "retire") {
      const hit = db.prepare("UPDATE worker_agents SET state = 'retired', retiredAt = ?, reason = ? WHERE agent = ? AND state = 'active'").run(r.now, reason, r.agent);
      if (hit.changes === 0) {
        db.prepare(`INSERT OR IGNORE INTO worker_agents (agent, sessionId, taskId, role, createdBy, createdAt, state, retiredAt, reason)
          VALUES (?, '', ?, 'other', 'lifecycle-stock', ?, 'retired', ?, ?)`).run(r.agent, r.taskId, r.now, r.now, reason);
      }
    }
    const task = r.taskId ? getTask(db, r.taskId) : null;
    if (!task) return;
    insertEvent(db, { actor, now: r.now }, { project: task.project, target: task.id, kind: "scheduler",
      text: `${r.mode === "retire" ? "收" : "停"} ${r.role} agent ${r.agent}：${r.reason}`.slice(0, 400),
      data: { op: "worker_retire", agent: r.agent, role: r.role, rule: r.rule, mode: r.mode, reason: r.reason, idleMs: r.idleMs,
        bytesBefore: r.bytesBefore, bytesAfter: r.bytesAfter, bytesFreed: freed, steps: r.steps } }, false);
  });
}
