/** Stopped workers keep their checkout for 24 hours; only order-derived paths may be reclaimed. */
import type { Database } from "bun:sqlite";
import { existsSync, lstatSync } from "node:fs";
import { dirname } from "node:path";
import { LEND_ROOT, orderDir, removeOrderDir } from "./lend-clone.js";
import { removeClaudeOrderConfig } from "./lend-claude-worker-routing.js";
import {
  assertOrderPaths as checkPaths, preservedBackups, preserveOrderWork, verifyPreserved, type PreserveIdentity, type PreserveProof, type PreserveRecord,
} from "./lend-disk-preserve.js";
import { getMeta, getOrder, LEND_JOURNAL_PATH, openLendJournal, setMeta, type LendRow, type LendState } from "./lend-journal.js";
import type { LoopDeps, TickResult } from "./lend-loop.js";
import { workerName } from "./lend-worker-name.js";
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

interface SweepOptions {
  root?: string;
  now?: number;
  /** Production checks scheduler ownership before each destructive operation; failure must escape, not become a retry. */
  active?: () => void;
  log: (message: string) => void;
  removeConfig?: typeof removeClaudeOrderConfig;
  /** The batch this pass already reaped; recomputing it here could pick an order whose processes were never reaped. */
  batch?: Candidate[];
  /**
   * Enforced preserve-first policy: an owned order whose result is pending/unknown is held until its backup verifies. Absent = age
   * alone decides (what lendTickWithRetention runs). A held order keeps its batch slot: five of them stall the sweep until backed up.
   */
  proof?: Pick<ReclaimPolicy, "mode" | "ownedSince">;
}

type Candidate = { row: Stopped; kept: Retention };
const ordered = (db: Database): Candidate[] =>
  stoppedRows(db).map((row) => ({ row, kept: retention(db, row) })).sort((a, b) => a.kept.stoppedAt - b.kept.stoppedAt);

/** This pass's deletion batch, oldest first; the tick reaps exactly this batch and hands it to the sweep. */
function dueBatch(rows: Candidate[], now: number, root: string): Candidate[] {
  const gone = (id: string) => { try { return !hasCheckout(id, root); } catch { return false; } }; // 读不了算还在：交给 sweep 去试并记日志
  return rows.filter(({ row, kept }) => Number.isFinite(kept.stoppedAt) && now - kept.stoppedAt >= STOPPED_RETENTION_MS && !(kept.cleaned && gone(row.orderId)))
    .slice(0, BATCH_SIZE);
}

/** One invocation per lend pass, even when there are no live orders or grants. Failed attempts count toward the cap. */
export function sweepStoppedWork(db: Database, o: SweepOptions): number {
  const root = o.root ?? LEND_ROOT;
  const rows = ordered(db);
  for (const { row, kept } of rows) {
    o.active?.();
    // Snapshot before this pass retries settlement; late receipts/notices must not keep extending retention.
    if (getMeta(db, keyOf(row.orderId)) === null) setMeta(db, keyOf(row.orderId), JSON.stringify(kept));
  }
  const batch = o.batch ?? dueBatch(rows, o.now ?? Date.now(), root);
  for (const { row, kept } of batch) {
    try {
      o.active?.();
      // Record the original time before deleting, so partial failures and later settlement cannot reset the clock.
      setMeta(db, keyOf(row.orderId), JSON.stringify({ stoppedAt: kept.stoppedAt }));
      checkPaths(row.orderId, root);
      const held = o.proof ? stoppedHold(db, row.orderId, root, o.proof) : null;
      if (held) { o.log(`stopped 单 ${row.orderId} 到期但不清：${held}`); continue; }
      o.active?.();
      removeOrderDir(row.orderId, root);
      o.active?.();
      removeOrderDir(row.orderId, root, "push");
      o.active?.();
      (o.removeConfig ?? removeClaudeOrderConfig)(db, row.orderId);
      setMeta(db, keyOf(row.orderId), JSON.stringify({ stoppedAt: kept.stoppedAt, cleaned: true }));
    } catch (e) {
      if (e instanceof SchedulerStopped) throw e;
      o.log(`清理 stopped 单 ${row.orderId} 失败，下轮再试：${(e as Error).message}`);
    }
  }
  return batch.length;
}

/** Production entry and tests share the same once-per-pass cleanup, including an idle/disabled lender. */
export async function lendTickWithRetention(d: LoopDeps, active: () => void, root = LEND_ROOT): Promise<TickResult> {
  // One clock read, one batch: re-reading after the reaps (TERM grace takes seconds) lets an order turn due and be deleted unreaped.
  const now = d.now();
  const batch = dueBatch(ordered(d.db), now, root);
  if (d.reapOrder) for (const { row } of batch) await d.reapOrder(row.orderId);
  await d.reapOrphans?.();
  sweepStoppedWork(d.db, { root, now, batch, active, log: d.log });
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

export type EndKind = "cancelled" | "stopped" | "done" | "released";
/** none = no worker ever ran; delivered = A's verified receipt covers it; pending = handed in, not acknowledged; unknown = ran, nothing handed in. */
export type ResultStatus = "none" | "delivered" | "pending" | "unknown";
const END_KIND: Partial<Record<LendState, EndKind>> = { cancelled: "cancelled", stopped: "stopped", acked: "done", released: "released" };

/** How the order ended and what is known about its output; null = not one of the four endings (live, or declined before any claim). */
export function endedResult(row: LendRow): { kind: EndKind; result: ResultStatus } | null {
  const kind = END_KIND[row.state];
  if (!kind) return null;
  // A cancel says nothing about output: only a row that never named a worker, session or hand-in is provably empty.
  if (row.agent === null && row.sessionId === null && row.startedAt === null && row.work === null && row.payload === null) return { kind, result: "none" };
  if (kind === "done" && row.receipt !== null && row.payload !== null) return { kind, result: "delivered" };
  return { kind, result: row.work !== null || row.payload !== null ? "pending" : "unknown" };
}

export type ReclaimMode = "observe" | "enforce";
export interface ReclaimPolicy {
  /** observe (default): report what would happen, write and delete nothing */
  mode?: ReclaimMode;
  /** Only orders created at or after this instant are owned by this path; older ones are listed, never touched. Default: none. */
  ownedSince?: number;
}

/** null = this order is an explicitly owned resource of the lend service; otherwise why it is only listed. */
function unowned(row: LendRow, root: string, since: number): string | null {
  if (!(row.createdAt >= since)) return "建单早于属主起点，历史单只列举";
  if (row.leaseGen === null) return "没有租约代数，认不出属主";
  if (row.agent !== null && row.agent !== workerName(row.orderId)) return `agent ${row.agent} 不是本单的出借 worker 名`;
  if (row.dir !== null && row.dir !== orderDir(row.orderId, root)) return "journal 记的 dir 不是本单订单目录";
  return null;
}

const identityOf = (row: LendRow): PreserveIdentity =>
  ({ orderId: row.orderId, state: row.state, leaseGen: row.leaseGen, agent: row.agent, sessionId: row.sessionId, createdAt: row.createdAt });
const reportOf = (row: LendRow) => ({ reason: row.reason, work: row.work, payloadSha: row.payloadSha, receipt: row.receipt, preview: row.preview });

/** Why a due stopped order may not be removed on age alone; null = removable. Any failure to verify holds it. */
function stoppedHold(db: Database, orderId: string, root: string, p: Pick<ReclaimPolicy, "mode" | "ownedSince">): string | null {
  const row = getOrder(db, orderId), ended = row && endedResult(row);
  if (!row || !ended) return "订单行不在或已不是终态";
  if (p.mode !== "enforce" || unowned(row, root, p.ownedSince ?? Infinity) || ended.result === "none" || ended.result === "delivered") return null;
  try { verifyPreserved(root, identityOf(row)); return null; } catch (e) { return `结果${ended.result === "pending" ? "待交" : "未知"}且没有可核的保全（${(e as Error).message}）`; }
}

export type ProcessFact = "exited" | "alive" | "unknown";
/** What the retire entry is asked to reclaim, and the evidence that it is safe. proof = null only for none / delivered results. */
export interface ReclaimTarget { orderId: string; leaseGen: number | null; agent: string | null; dirs: string[]; proof: PreserveProof | null }
export interface EndedReclaimDeps extends ReclaimPolicy {
  db: Database;
  root?: string;
  now: () => number;
  /** LIFE1 cardWorkerIndex(ledger): a worker name linked to a local card is that card's worker, not ours to reclaim */
  index: ReadonlyMap<string, unknown>;
  /** A process observation for this order's worker and checkout; observed twice (before and after the backup), both must say exited. */
  exited: (row: LendRow) => ProcessFact | Promise<ProcessFact>;
  /** The one retire entry (LIFE1). This module decides what and with which evidence; it never removes, archives or signals by itself. */
  retire: (target: ReclaimTarget) => void | Promise<void>;
  records?: (row: LendRow) => readonly PreserveRecord[];
  active?: () => void;
  log: (message: string) => void;
  preserve?: typeof preserveOrderWork;
}
export interface ReclaimVerdict {
  orderId: string;
  /** reclaimed = backed up as needed and handed to retire; preserved = backed up, left for the stopped retention; kept = protected; listed = not owned; observed = dry run */
  action: "reclaimed" | "preserved" | "kept" | "listed" | "observed";
  kind: EndKind | null;
  result: ResultStatus | null;
  why: string;
  proof?: PreserveProof;
}

const reclaimKey = (id: string) => `workPreserve:${id}`;
const reclaiming = new Set<string>();

/**
 * Preserve first, reclaim second, for one ended order. Every protection is a refusal: live or unreadable process facts, a card
 * link, a late claim or a changed generation, a failed / unverifiable backup all keep the checkout. Cancel is never read as
 * "no output" and age is never proof. A stopped order is only backed up here; its removal stays with the 24-hour sweep.
 */
export async function reclaimEndedWork(orderId: string, d: EndedReclaimDeps): Promise<ReclaimVerdict> {
  if (reclaiming.has(orderId)) return { orderId, action: "kept", kind: null, result: null, why: "同一张单的回收正在进行" };
  reclaiming.add(orderId);
  try { return await reclaimOnce(orderId, d); } finally { reclaiming.delete(orderId); }
}

async function reclaimOnce(orderId: string, d: EndedReclaimDeps): Promise<ReclaimVerdict> {
  const root = d.root ?? LEND_ROOT;
  const row = getOrder(d.db, orderId), ended = row && endedResult(row);
  const verdict = (action: ReclaimVerdict["action"], why: string, proof?: PreserveProof): ReclaimVerdict =>
    ({ orderId, action, kind: ended?.kind ?? null, result: ended?.result ?? null, why, ...(proof ? { proof } : {}) });
  if (!row || !ended) return verdict("kept", row ? `订单是 ${row.state}，不是 cancel / stopped / done / released` : "journal 里没有这张单");
  const foreign = unowned(row, root, d.ownedSince ?? Infinity);
  if (foreign) return verdict("listed", foreign);
  if (row.agent && d.index.has(row.agent)) return verdict("kept", `${row.agent} 关联本机卡，不是出借回收对象`);
  const needsProof = ended.result === "pending" || ended.result === "unknown";
  try {
    checkPaths(orderId, root);
    if (!hasCheckout(orderId, root)) {
      const done = getMeta(d.db, reclaimKey(orderId)) !== null ? preservedBackups(root, orderId)[0] : undefined;
      return done ? verdict("reclaimed", "已保全并回收过，保全仍可核", done) : verdict("kept", "工作副本已不在，没有可保全 / 回收的东西");
    }
    if (row.agent && (await d.exited(row)) !== "exited") return verdict("kept", "worker 进程还在或状态读不到");
    if ((d.mode ?? "observe") !== "enforce") return verdict("observed", needsProof ? "enforce 下会先保全再回收" : "enforce 下无需保全，直接回收");
    d.active?.();
    const proof = needsProof ? (d.preserve ?? preserveOrderWork)({ root, identity: identityOf(row), report: reportOf(row), records: d.records?.(row), now: d.now() }) : null;
    if (proof) setMeta(d.db, reclaimKey(orderId), JSON.stringify({ manifestSha256: proof.manifestSha256, dir: proof.dir, preservedAt: proof.at }));
    if (ended.kind === "stopped") return verdict("preserved", "已保全，清理留给 stopped 到期回收", proof ?? undefined);
    // Second observation, after the copy: a late claim, a new generation or a revived worker since the first one voids the proof.
    const fresh = getOrder(d.db, orderId);
    if (!fresh || JSON.stringify(identityOf(fresh)) !== JSON.stringify(identityOf(row))) return verdict("kept", "保全后订单换了状态 / 代数 / 会话，不回收");
    if (row.agent && (await d.exited(row)) !== "exited") return verdict("kept", "保全后 worker 进程又出现或状态读不到");
    if (proof) verifyPreserved(root, identityOf(row));
    d.active?.();
    await d.retire({ orderId, leaseGen: row.leaseGen, agent: row.agent, dirs: (["work", "push"] as const).map((a) => orderDir(orderId, root, a)), proof });
    if (!proof) setMeta(d.db, reclaimKey(orderId), JSON.stringify({ manifestSha256: null, reclaimedAt: d.now() }));
    return verdict("reclaimed", proof ? "已保全并交回收入口" : "无待保全产物，已交回收入口", proof ?? undefined);
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    d.log(`${orderId} 保全 / 回收没做成，工作副本保留：${(e as Error).message}`);
    return verdict("kept", `保全 / 回收失败：${(e as Error).message}`);
  }
}

/** Ended orders with a checkout still on disk that this path does not own: reported, never preserved-and-removed here. */
export function listUnownedEndedWork(db: Database, root = LEND_ROOT, since = Infinity): { orderId: string; kind: EndKind; result: ResultStatus; why: string }[] {
  const rows = db.query("SELECT orderId FROM lend_orders WHERE state IN ('cancelled','stopped','acked','released')").all() as { orderId: string }[];
  return rows.flatMap(({ orderId }) => {
    const row = getOrder(db, orderId)!, ended = endedResult(row)!, why = unowned(row, root, since);
    return why && hasCheckout(orderId, root) ? [{ orderId, ...ended, why }] : [];
  });
}
