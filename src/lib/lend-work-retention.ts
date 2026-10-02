/** Stopped workers keep their checkout for 24 hours; only order-derived paths may be reclaimed. */
import type { Database } from "bun:sqlite";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { LEND_ROOT, orderDir, orderDirName, removeOrderDir } from "./lend-clone.js";
import { removeClaudeOrderConfig } from "./lend-claude-worker-routing.js";
import { getMeta, LEND_JOURNAL_PATH, openLendJournal, setMeta, type LendRow } from "./lend-journal.js";
import type { LoopDeps, TickResult } from "./lend-loop.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";

export const STOPPED_RETENTION_MS = 24 * 60 * 60_000;
const BATCH_SIZE = 5;
const keyOf = (id: string) => `workRetention:${id}`;
type Stopped = Pick<LendRow, "orderId" | "updatedAt">;
interface Retention { stoppedAt: number; cleaned?: boolean }

function retention(db: Database, row: Stopped): Retention {
  const raw = getMeta(db, keyOf(row.orderId));
  // Old journals have no transition timestamp: their last update is a conservative lower bound on retention age.
  return raw ? JSON.parse(raw) as Retention : { stoppedAt: row.updatedAt };
}

const stoppedRows = (db: Database): Stopped[] => db.query("SELECT orderId, updatedAt FROM lend_orders WHERE state = 'stopped'").all() as Stopped[];
const present = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false }) !== undefined;
const hasCheckout = (id: string, root: string): boolean => present(orderDir(id, root)) || present(orderDir(id, root, "push"));

/** removeOrderDir validates the leaf; also reject symlinked roots/areas before letting it resolve them. */
function checkPaths(id: string, root: string): void {
  if (!present(root)) return;
  if (lstatSync(root).isSymbolicLink()) throw new Error("出借根目录不能是软链");
  const realRoot = realpathSync(root);
  for (const area of ["work", "push"] as const) {
    const parent = join(root, area);
    if (!present(parent)) continue;
    if (lstatSync(parent).isSymbolicLink() || relative(realRoot, realpathSync(parent)) !== area) throw new Error(`拒绝删除：${area} 越出出借根目录`);
    const dir = orderDir(id, root, area);
    if (!present(dir)) continue;
    if (lstatSync(dir).isSymbolicLink() || relative(realRoot, realpathSync(dir)) !== join(area, orderDirName(id))) {
      throw new Error(`拒绝删除：${id} 的 ${area} 不是订单目录`);
    }
  }
}

interface SweepOptions {
  root?: string;
  now?: number;
  /** Production checks scheduler ownership before each destructive operation; failure must escape, not become a retry. */
  active?: () => void;
  log: (message: string) => void;
  removeConfig?: typeof removeClaudeOrderConfig;
}

/** One invocation per lend pass, even when there are no live orders or grants. Failed attempts count toward the cap. */
export function sweepStoppedWork(db: Database, o: SweepOptions): number {
  const root = o.root ?? LEND_ROOT;
  const now = o.now ?? Date.now();
  const rows = stoppedRows(db).map((row) => ({ row, kept: retention(db, row) })).sort((a, b) => a.kept.stoppedAt - b.kept.stoppedAt);
  let attempted = 0;
  for (const { row, kept } of rows) {
    o.active?.();
    // Snapshot before this pass retries settlement; late receipts/notices must not keep extending retention.
    if (getMeta(db, keyOf(row.orderId)) === null) setMeta(db, keyOf(row.orderId), JSON.stringify(kept));
    if (!Number.isFinite(kept.stoppedAt) || now - kept.stoppedAt < STOPPED_RETENTION_MS) continue;
    if (attempted >= BATCH_SIZE) break;
    let counted = false;
    try {
      if (kept.cleaned && !hasCheckout(row.orderId, root)) continue;
      attempted++;
      counted = true;
      // Record the original time before deleting, so partial failures and later settlement cannot reset the clock.
      setMeta(db, keyOf(row.orderId), JSON.stringify({ stoppedAt: kept.stoppedAt }));
      checkPaths(row.orderId, root);
      o.active?.();
      removeOrderDir(row.orderId, root);
      o.active?.();
      removeOrderDir(row.orderId, root, "push");
      o.active?.();
      (o.removeConfig ?? removeClaudeOrderConfig)(db, row.orderId);
      setMeta(db, keyOf(row.orderId), JSON.stringify({ stoppedAt: kept.stoppedAt, cleaned: true }));
    } catch (e) {
      if (e instanceof SchedulerStopped) throw e;
      if (!counted) attempted++;
      o.log(`清理 stopped 单 ${row.orderId} 失败，下轮再试：${(e as Error).message}`);
    }
  }
  return attempted;
}

/** Production entry and tests share the same once-per-pass cleanup, including an idle/disabled lender. */
export async function lendTickWithRetention(d: LoopDeps, active: () => void, root = LEND_ROOT): Promise<TickResult> {
  sweepStoppedWork(d.db, { root, now: d.now(), active, log: d.log });
  return (await import("./lend-loop.js")).lendTick(d);
}

export interface StoppedWorkSummary { count: number; oldestStoppedAt: number | null }

/** Count orders with either checkout still on disk, not historical stopped journal rows. */
export function stoppedWorkSummary(db: Database, root = LEND_ROOT): StoppedWorkSummary {
  const rows = stoppedRows(db).filter((r) => hasCheckout(r.orderId, root));
  const times = rows.map((r) => retention(db, r).stoppedAt).filter(Number.isFinite);
  return { count: rows.length, oldestStoppedAt: times.length ? Math.min(...times) : null };
}

export function readStoppedWorkSummary(path = LEND_JOURNAL_PATH): StoppedWorkSummary {
  if (!existsSync(path)) return { count: 0, oldestStoppedAt: null };
  const db = openLendJournal(path);
  try { return stoppedWorkSummary(db, dirname(path)); } finally { db.close(); }
}

export function stoppedWorkText(s: StoppedWorkSummary): string {
  return `stopped 工作副本 ${s.count} 个，最早停止时间：${s.oldestStoppedAt === null ? "无" : new Date(s.oldestStoppedAt).toISOString()}`;
}
