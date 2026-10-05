/**
 * Card worker registrations (lib/agent-lifecycle.ts): every path that creates a worker agent for a card writes one row here at
 * create time. A separate table rather than scheduler_sessions: those rows need an ensure_session intent, a family and a transport,
 * which PM-tool and start_node agents do not have; scheduler-bound sessions keep retiring through scheduler-retire.ts.
 * The table comes from the ledger migrations (agent-lifecycle-schema.ts); a reader on a ledger without it sees nothing registered.
 * Retirement marks rows retired and writes one ledger event per agent (the card's project; an unknown card's row is the record).
 * A retirement whose disk cleanup did not finish (dirty / held / symlinked checkout, a temp folder that could not go) keeps its row
 * active with `reason` = CLEANUP_PENDING + JSON of what is left: such a row is no longer an agent (the index skips it, a same-name
 * create does not close it) but a disk debt the lifecycle retries every pass (pendingCleanups) and doctor counts.
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

const CLEANUP_PENDING = "cleanup_pending:";
const NOT_PENDING = `(reason IS NULL OR reason NOT LIKE '${CLEANUP_PENDING}%')`;

/** No table (a ledger not yet migrated, opened read-only) = nothing registered. Rows that are only a pending cleanup are not agents. */
export function activeWorkers(db: Database): WorkerRegistration[] {
  if (!hasTable(db, "worker_agents")) return [];
  return db.query(`SELECT * FROM worker_agents WHERE state = 'active' AND ${NOT_PENDING} ORDER BY createdAt`).all() as WorkerRegistration[];
}

/** One checkout of a collected agent still on disk, and the Claude temp folder that may only go after it. */
export interface CleanupEntry { checkout: string; tmp: string | null }
export interface PendingCleanup { agent: string; sessionId: string; taskId: string | null; role: WorkerRole; createdAt: number; entries: CleanupEntry[] }

const isEntry = (v: unknown): v is CleanupEntry => !!v && typeof v === "object" && typeof (v as CleanupEntry).checkout === "string"
  && ((v as CleanupEntry).tmp === null || typeof (v as CleanupEntry).tmp === "string");

/** Collected agents whose disk cleanup is still owed. A marker that does not parse is reported with no entries (never guessed). */
export function pendingCleanups(db: Database): (PendingCleanup & { error?: string })[] {
  if (!hasTable(db, "worker_agents")) return [];
  const rows = db.query(`SELECT * FROM worker_agents WHERE state = 'active' AND reason LIKE '${CLEANUP_PENDING}%' ORDER BY createdAt`).all() as WorkerRegistration[];
  return rows.map((r) => {
    const base = { agent: r.agent, sessionId: r.sessionId, taskId: r.taskId, role: r.role, createdAt: r.createdAt };
    try {
      const entries = JSON.parse(r.reason!.slice(CLEANUP_PENDING.length)) as unknown;
      if (Array.isArray(entries) && entries.every(isEntry)) return { ...base, entries };
    } catch { /* reported below */ }
    return { ...base, entries: [], error: `待补清记录读不懂：${r.reason!.slice(0, 120)}` };
  });
}

type CardWorkerSource = "worker_agents" | "scheduler_sessions" | "tasks.agent";
/** sessionId: the session the record was made for (registration / binding); absent for tasks.agent, which names no session. */
interface CardWorkerLink { taskId: string | null; role: WorkerRole; source: CardWorkerSource; sessionId?: string }
/** The primary link (registration, then scheduler binding, then an unfinished card naming it as executor) plus every link. */
export interface CardWorker extends CardWorkerLink { links: CardWorkerLink[] }

const FINISHED: readonly string[] = ["verified", "done", "cancelled"];
const SOURCE_RANK: Record<CardWorkerSource, number> = { worker_agents: 0, scheduler_sessions: 1, "tasks.agent": 2 };

/** Pure half of cardWorkerIndex (tests feed rows directly). `executors` = cards' tasks.agent with the card's stage. */
export function buildCardWorkerIndex(rows: {
  registrations: readonly (Pick<WorkerRegistration, "agent" | "taskId" | "role"> & { sessionId?: string })[];
  bound: readonly { agent: string; taskId: string; role: "author" | "reviewer"; sessionId?: string }[];
  executors: readonly { agent: string; taskId: string; stage: string }[];
}): Map<string, CardWorker> {
  const all = new Map<string, (CardWorkerLink & { open: boolean })[]>();
  const add = (agent: string, l: CardWorkerLink, open = true) => {
    if (!agent) return;
    const xs = all.get(agent) ?? [];
    if (!xs.some((x) => x.taskId === l.taskId && x.source === l.source && x.sessionId === l.sessionId)) xs.push({ ...l, open });
    all.set(agent, xs);
  };
  const sid = (s: string | undefined) => (s ? { sessionId: s } : {});
  for (const r of rows.registrations) add(r.agent, { taskId: r.taskId, role: r.role, source: "worker_agents", ...sid(r.sessionId) });
  for (const b of rows.bound) add(b.agent, { taskId: b.taskId, role: b.role, source: "scheduler_sessions", ...sid(b.sessionId) });
  for (const e of rows.executors) add(e.agent, { taskId: e.taskId, role: "author", source: "tasks.agent" }, !FINISHED.includes(e.stage));
  const out = new Map<string, CardWorker>();
  for (const [agent, xs] of all) {
    const sorted = [...xs].sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || Number(b.open) - Number(a.open));
    const links = sorted.map(({ open: _open, ...l }) => l);
    out.set(agent, { ...links[0], links });
  }
  return out;
}

/**
 * The one reader: agent → the card it works for, merged from worker_agents (active rows), scheduler_sessions (not retired) and
 * tasks.agent. An agent absent from the map has no ledger record and is the user's own agent. Read-only; missing tables read as empty.
 * Links carry the session they were recorded for: a reader acting on an agent must check its current session against them (the
 * name may have been reused after a manual remove).
 */
export function cardWorkerIndex(db: Database): Map<string, CardWorker> {
  const bound = hasTable(db, "scheduler_sessions")
    ? db.query("SELECT agent, taskId, role, sessionId FROM scheduler_sessions WHERE state != 'retired'").all() as
      { agent: string; taskId: string; role: "author" | "reviewer"; sessionId: string }[] : [];
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
    db.prepare(`UPDATE worker_agents SET state = 'retired', retiredAt = ?, reason = '同名 agent 重建' WHERE agent = ? AND state = 'active' AND ${NOT_PENDING}`).run(now, input.agent);
    db.prepare(`INSERT OR REPLACE INTO worker_agents (agent, sessionId, taskId, role, createdBy, createdAt, state) VALUES (?, ?, ?, ?, ?, ?, 'active')`)
      .run(input.agent, input.sessionId, task.id, input.role, input.createdBy, now);
    insertEvent(db, { actor: input.createdBy, now }, { project: task.project, target: task.id, kind: "scheduler", text: `登记 ${input.role} agent ${input.agent}`,
      data: { op: "worker_register", agent: input.agent, sessionId: input.sessionId, role: input.role, createdBy: input.createdBy } }, false);
    return db.query("SELECT * FROM worker_agents WHERE agent = ? AND createdAt = ?").get(input.agent, now) as WorkerRegistration;
  });
}

export interface RetireRecord {
  agent: string; sessionId: string | null; taskId: string | null; role: WorkerRole | "stock"; rule: string; reason: string;
  idleMs: number | null; bytesBefore: number | null; bytesAfter: number | null; steps: string[]; now: number;
  /** what is still on disk after this attempt; empty = cleanup finished */
  pending: CleanupEntry[];
  /** a retry of an earlier pending cleanup (the agent itself is already gone) */
  retry: boolean;
}

/**
 * Idempotent. Cleanup finished: the agent's row is closed (an agent with no row, stock, gets a retired row so the ledger keeps a
 * record even when its card is unknown). Cleanup not finished: the row stays active as a pending cleanup with what is left, so the
 * next pass retries it. The event goes to the card's project when the card is known.
 */
export function recordWorkerRetire(db: Database, actor: string, r: RetireRecord): void {
  tx(db, () => {
    const freed = r.bytesBefore !== null && r.bytesAfter !== null ? Math.max(0, r.bytesBefore - r.bytesAfter) : null;
    const done = r.pending.length === 0;
    const reason = done ? `${r.rule}: ${r.reason}`.slice(0, 300) : CLEANUP_PENDING + JSON.stringify(r.pending);
    const which = r.retry ? `reason LIKE '${CLEANUP_PENDING}%'` : NOT_PENDING;
    const hit = db.prepare(`UPDATE worker_agents SET state = ?, retiredAt = ?, reason = ? WHERE agent = ? AND state = 'active' AND ${which}`)
      .run(done ? "retired" : "active", done ? r.now : null, reason, r.agent);
    if (hit.changes === 0 && !r.retry) {
      db.prepare(`INSERT OR IGNORE INTO worker_agents (agent, sessionId, taskId, role, createdBy, createdAt, state, retiredAt, reason)
        VALUES (?, ?, ?, 'other', 'lifecycle-stock', ?, ?, ?, ?)`).run(r.agent, r.sessionId ?? "", r.taskId, r.now, done ? "retired" : "active", done ? r.now : null, reason);
    }
    const task = r.taskId ? getTask(db, r.taskId) : null;
    if (!task) return;
    insertEvent(db, { actor, now: r.now }, { project: task.project, target: task.id, kind: "scheduler",
      text: `${r.retry ? "补清" : "收"} ${r.role} agent ${r.agent}：${r.reason}${done ? "" : `；还剩 ${r.pending.length} 处没清，下轮再试`}`.slice(0, 400),
      data: { op: "worker_retire", agent: r.agent, sessionId: r.sessionId, role: r.role, rule: r.rule, reason: r.reason, idleMs: r.idleMs, retry: r.retry,
        bytesBefore: r.bytesBefore, bytesAfter: r.bytesAfter, bytesFreed: freed, steps: r.steps, pending: r.pending } }, false);
  });
}
