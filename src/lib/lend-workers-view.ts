/**
 * Remote workers as A sees them (i28-W6, docs remote-pool-v2-plan §2.7): one row per order A has out that a peer holds a worker
 * for, shaped like a local row so the team view and fleet can list it read-only. Only claimed / unknown orders with a worker
 * appear; the state comes from the last batched beat (lib/ledger-lend-peers.ts beatLend), never from what the peer claims now.
 * An old ledger without the lend tables or the beat column yields nothing. tests/lend-workers-view.test.ts.
 */
import type { Database } from "bun:sqlite";
import { teamIdentity } from "./team-activity.js";

/** Same shape lend-drive.ts workerName gives ("agent-lend-" + 10 hex), with or without the agent- prefix. */
const LEND_WORKER_RE = /^(?:agent-)?lend-[0-9a-f]{10}$/;
export const isLendWorkerName = (name: string): boolean => LEND_WORKER_RE.test(name);

/** Four beat periods (15 s each): a worker whose last beat is older than this shows as silent, not running. */
export const BEAT_LIVE_MS = 60_000;

/** running = fresh beat under the current lease; silent = stale or wrong generation; no_beat = claimed but never beat; unknown = stopped for PM */
export type LendWorkerState = "running" | "silent" | "no_beat" | "unknown";

export interface LendWorkerRow {
  /** `<worker without agent->@<peer>`: what the team view shows and what send_to_agent addresses */
  name: string;
  /** team-graph id, `peer:<peer>/<worker>` (teamIdentity) */
  id: string;
  peer: string;
  worker: string;
  orderId: string;
  taskId: string;
  project: string;
  step: string;
  role: "审查员" | "执行者";
  family: string;
  phase: string | null;
  beatAt: number | null;
  lastActivityAt: number | null;
  /** already masked by beatLend (sanitizeForeign) */
  excerpt: string | null;
  state: LendWorkerState;
}

interface Beat { gen?: unknown; phase?: unknown; lastActivityAt?: unknown; excerpt?: unknown; at?: unknown }

const hasBeatColumn = (db: Database): boolean => {
  const t = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lend_orders'").get();
  return !!t && (db.query("PRAGMA table_info(lend_orders)").all() as { name: string }[]).some((c) => c.name === "beat");
};

function parseBeat(raw: unknown): Beat | null {
  if (typeof raw !== "string") return null;
  try {
    const b = JSON.parse(raw) as unknown;
    return b && typeof b === "object" ? b as Beat : null;
  } catch (e) {
    // beatLend writes this column itself; a row that does not parse counts as never beat (shown as no_beat), never as running
    console.warn(`[lend-workers] beat 列解析不了：${(e as Error).message}`);
    return null;
  }
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function lendWorkerState(status: string, leaseGen: number, beat: Beat | null, now: number): LendWorkerState {
  if (status === "unknown") return "unknown";
  const at = num(beat?.at);
  if (!beat || at === null) return "no_beat";
  if (beat.gen !== leaseGen) return "silent";
  return now - at <= BEAT_LIVE_MS ? "running" : "silent";
}

interface OrderRow { orderId: string; taskId: string; project: string; peer: string; family: string; step: string; worker: string; leaseGen: number; status: string; beat: string | null }

export function lendWorkerRows(db: Database, now: number, project?: string): LendWorkerRow[] {
  if (!hasBeatColumn(db)) return [];
  const where = project === undefined ? "" : " AND project = ?";
  const rows = db.query(`SELECT orderId, taskId, project, peer, family, step, worker, leaseGen, status, beat FROM lend_orders
    WHERE status IN ('claimed', 'unknown') AND worker IS NOT NULL AND worker != ''${where} ORDER BY createdAt, orderId`)
    .all(...(project === undefined ? [] : [project])) as OrderRow[];
  return rows.map((r) => {
    const beat = parseBeat(r.beat);
    const worker = r.worker.replace(/^agent-/, "");
    const name = `${worker}@${r.peer}`;
    return {
      name, id: teamIdentity(name, new Set()) as string, peer: r.peer, worker, orderId: r.orderId, taskId: r.taskId, project: r.project, step: r.step,
      role: r.step === "review" ? "审查员" : "执行者", family: r.family,
      phase: typeof beat?.phase === "string" ? beat.phase : null, beatAt: num(beat?.at), lastActivityAt: num(beat?.lastActivityAt),
      excerpt: typeof beat?.excerpt === "string" ? beat.excerpt : null, state: lendWorkerState(r.status, r.leaseGen, beat, now),
    };
  });
}
