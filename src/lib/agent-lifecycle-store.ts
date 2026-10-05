/**
 * Card worker registrations (lib/agent-lifecycle.ts): every path that creates a worker agent for a card writes one row here at
 * create time. A separate table rather than scheduler_sessions: those rows need an ensure_session intent, a family and a transport,
 * which PM-tool and start_node agents do not have; scheduler-bound sessions keep retiring through scheduler-retire.ts.
 * The table comes from the ledger migrations (agent-lifecycle-schema.ts); a reader on a ledger without it sees nothing registered.
 * Retirement marks rows retired and writes one ledger event per agent (the card's project; an unknown card's row is the record).
 * `cardWorkerIndex` is the one reader of "which card does this agent work for": the lifecycle, the sidebar list (LIFE2) and the
 * collaboration view all import it instead of reading these tables themselves.
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

const hasTable = (db: Database, name: string): boolean => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

/** No table (a ledger not yet migrated, opened read-only) = nothing registered. */
export function activeWorkers(db: Database): WorkerRegistration[] {
  if (!hasTable(db, "worker_agents")) return [];
  return db.query("SELECT * FROM worker_agents WHERE state = 'active' ORDER BY createdAt").all() as WorkerRegistration[];
}

export type CardWorkerSource = "worker_agents" | "scheduler_sessions" | "tasks.agent";
export interface CardWorkerLink { taskId: string | null; role: WorkerRole; source: CardWorkerSource }
/** The primary link (registration, then scheduler binding, then an unfinished card naming it as executor) plus every link. */
export interface CardWorker extends CardWorkerLink { links: CardWorkerLink[] }

const FINISHED: readonly string[] = ["verified", "done", "cancelled"];
const SOURCE_RANK: Record<CardWorkerSource, number> = { worker_agents: 0, scheduler_sessions: 1, "tasks.agent": 2 };

/** Pure half of cardWorkerIndex (tests feed rows directly). `executors` = cards' tasks.agent with the card's stage. */
export function buildCardWorkerIndex(rows: {
  registrations: readonly Pick<WorkerRegistration, "agent" | "taskId" | "role">[];
  bound: readonly { agent: string; taskId: string; role: "author" | "reviewer" }[];
  executors: readonly { agent: string; taskId: string; stage: string }[];
}): Map<string, CardWorker> {
  const all = new Map<string, (CardWorkerLink & { open: boolean })[]>();
  const add = (agent: string, l: CardWorkerLink, open = true) => {
    if (!agent) return;
    const xs = all.get(agent) ?? [];
    if (!xs.some((x) => x.taskId === l.taskId && x.source === l.source)) xs.push({ ...l, open });
    all.set(agent, xs);
  };
  for (const r of rows.registrations) add(r.agent, { taskId: r.taskId, role: r.role, source: "worker_agents" });
  for (const b of rows.bound) add(b.agent, { taskId: b.taskId, role: b.role, source: "scheduler_sessions" });
  for (const e of rows.executors) add(e.agent, { taskId: e.taskId, role: "author", source: "tasks.agent" }, !FINISHED.includes(e.stage));
  const out = new Map<string, CardWorker>();
  for (const [agent, xs] of all) {
    const sorted = [...xs].sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || Number(b.open) - Number(a.open));
    const links = sorted.map(({ taskId, role, source }) => ({ taskId, role, source }));
    out.set(agent, { ...links[0], links });
  }
  return out;
}

/**
 * The one reader: agent → the card it works for, merged from worker_agents (active rows), scheduler_sessions (not retired) and
 * tasks.agent. An agent absent from the map has no ledger record and is the user's own agent. Read-only; missing tables read as empty.
 */
export function cardWorkerIndex(db: Database): Map<string, CardWorker> {
  const bound = hasTable(db, "scheduler_sessions")
    ? db.query("SELECT agent, taskId, role FROM scheduler_sessions WHERE state != 'retired'").all() as { agent: string; taskId: string; role: "author" | "reviewer" }[] : [];
  const executors = db.query("SELECT agent, id AS taskId, stage FROM tasks WHERE agent IS NOT NULL AND agent != ''").all() as { agent: string; taskId: string; stage: string }[];
  return buildCardWorkerIndex({ registrations: activeWorkers(db), bound, executors });
}

/** Refuses a card the ledger does not know: a typo'd id would register an agent nothing ever collects. */
export function checkCard(db: Database, taskId: string): string | null {
  return getTask(db, taskId) ? null : `台账里没有卡 ${taskId}（--card 要写台账卡号，如 --card T123）`;
}

export interface RegisterInput { agent: string; sessionId: string; taskId: string; role: WorkerRole; createdBy: string; now?: number }

/** A re-created name replaces its earlier active row: one agent name runs one session at a time. */
export function registerWorker(db: Database, input: RegisterInput): WorkerRegistration {
  if (!isWorkerRole(input.role)) throw new LedgerError("invalid", `--card-role 只能是 ${WORKER_ROLES.join(" / ")}`);
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
