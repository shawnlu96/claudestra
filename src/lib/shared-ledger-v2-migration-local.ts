/** X13 local side of the execution migration: drill-root guard, in-flight inventory, backup, dispatch pause and report files.
 * Every path this module writes is resolved under the caller's drill root; the production state directory is refused outright.
 * Reads the local ledger read-only; scheduler_sessions and process locks are inventoried, never migrated.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { STATE_DIR } from "./paths.js";
import { acquireMaintenance } from "./scheduler-maintenance.js";
import { LedgerReader } from "./ledger-read.js";
import { writeJsonAtomicSync } from "./state-file.js";
import { gateFeatureIds, type GateTask } from "./shared-ledger-v2-write-gate-state.js";

/** One itemized reason; `item` names the row (worker / order / intent / task id) so the list is actionable. */
export interface MigrationFinding { code: string; item: string; detail: string }
export class MigrationRefused extends Error {
  constructor(readonly findings: MigrationFinding[]) {
    super(`迁移被拒：${findings.map(f => `${f.code}:${f.item}`).join(", ")}`);
  }
}
const refuse = (code: string, item: string, detail: string): never => { throw new MigrationRefused([{ code, item, detail }]); };

const real = (p: string): string => { try { return realpathSync(p); } catch { return resolve(p); } };
const within = (child: string, parent: string): boolean => {
  const r = relative(parent, child);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};
/** The production state directories: the default home path, the configured STATE_DIR and an explicit env override. */
export function productionDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  return [join(homedir(), ".claude-orchestrator"), STATE_DIR, env.CLAUDESTRA_STATE_DIR].filter((p): p is string => !!p).map(real);
}
/** Drill roots live strictly inside the OS temp directory and never overlap a production state directory (either way round). */
export function assertDrillRoot(root: string, production = productionDirs(), temp = real(tmpdir())): string {
  const abs = real(root);
  if (production.some(p => within(abs, p) || within(p, abs))) refuse("production_root", abs, "演练根目录与生产状态目录重叠");
  if (!within(abs, temp) || abs === temp) refuse("not_isolated", abs, "演练只在临时目录内的隔离 fixture 里跑");
  return abs;
}
/** Every write goes through here: a path escaping the drill root is a bug, never a fallback. */
export function underRoot(root: string, ...parts: string[]): string {
  const p = resolve(root, ...parts);
  if (!within(p, root)) refuse("path_escape", p, "写路径不在演练根目录内");
  return p;
}
export const batchDir = (root: string, batchId: string): string => underRoot(root, "shared-ledger-v2-migration", batchId);
export function writeRootJson(root: string, path: string, data: unknown): string {
  const p = underRoot(root, path);
  mkdirSync(resolve(p, ".."), { recursive: true, mode: 0o700 });
  writeJsonAtomicSync(p, data, { mode: 0o600 });
  return p;
}

interface LocalTask { id: string; featureIds: string[]; stage: string }
interface LocalOrder { orderId: string; taskId: string; status: string; leaseGen: number; head: string; peer: string }
/** In flight = an active / retiring worker session, a pooled / claimed / unknown lend order, a pending / submitted / unknown intent. */
interface InflightItem { kind: "worker" | "lend" | "intent"; id: string; taskId: string; status: string }
export interface LocalInventory { tasks: LocalTask[]; orders: LocalOrder[]; inflight: InflightItem[] }

const hasTable = (db: Database, name: string): boolean =>
  !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
/** Cards of the group are found by both persisted associations (featureId column and extra.sharedFeatureId), like the X7 gate. */
export function readLocalInventory(ledgerPath: string, featureIds: readonly string[]): LocalInventory {
  if (!existsSync(ledgerPath)) return { tasks: [], orders: [], inflight: [] };
  const db = new Database(ledgerPath, { readonly: true });
  try {
    const group = new Set(featureIds);
    const tasks = hasTable(db, "tasks") ? (db.query("SELECT * FROM tasks").all() as GateTask[])
      .map(t => ({ id: t.id, featureIds: gateFeatureIds(t), stage: String(t.stage) }))
      .filter(t => t.featureIds.some(f => group.has(f))) : [];
    const ids = new Set(tasks.map(t => t.id)), mine = <T extends { taskId: string }>(rows: T[]) => rows.filter(r => ids.has(r.taskId));
    const orders = hasTable(db, "lend_orders") ? mine(db.query(
      "SELECT orderId, taskId, status, leaseGen, head, peer FROM lend_orders ORDER BY orderId").all() as LocalOrder[]) : [];
    const workers = hasTable(db, "scheduler_sessions") ? mine(db.query(
      "SELECT taskId, role, sessionId, state FROM scheduler_sessions WHERE state IN ('active','retiring') ORDER BY taskId, role").all() as
      { taskId: string; role: string; sessionId: string; state: string }[]) : [];
    const intents = hasTable(db, "scheduler_intents") ? mine(db.query(
      "SELECT id, taskId, status FROM scheduler_intents WHERE status IN ('pending','submitted','unknown') ORDER BY id").all() as
      { id: string; taskId: string; status: string }[]) : [];
    const inflight: InflightItem[] = [
      ...workers.map(w => ({ kind: "worker" as const, id: `${w.taskId}/${w.role}`, taskId: w.taskId, status: w.state })),
      ...orders.filter(o => ["pooled", "claimed", "unknown"].includes(o.status))
        .map(o => ({ kind: "lend" as const, id: o.orderId, taskId: o.taskId, status: o.status })),
      ...intents.map(i => ({ kind: "intent" as const, id: i.id, taskId: i.taskId, status: i.status })),
    ];
    return { tasks, orders, inflight };
  } finally { db.close(); }
}

export const sha256File = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
export interface MigrationBackup { files: { name: string; path: string; sha256: string }[] }
/** Consistent copy of the ledger (VACUUM INTO, WAL included) plus the mode file, with digests recorded in the report. */
export function backupLocal(root: string, batchId: string, ledgerPath: string): MigrationBackup {
  const dir = underRoot(batchDir(root, batchId), "backup");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files: MigrationBackup["files"] = [];
  if (existsSync(ledgerPath)) {
    const out = underRoot(dir, "ledger.sqlite");
    if (existsSync(out)) refuse("backup_exists", batchId, "同批次备份已存在，不覆盖");
    const db = new Database(ledgerPath);
    try { db.run("VACUUM INTO ?", [out]); } finally { db.close(); }
    files.push({ name: "ledger.sqlite", path: out, sha256: sha256File(out) });
  }
  const modes = underRoot(root, "shared-ledger-modes.json");
  if (existsSync(modes)) {
    const out = underRoot(dir, "shared-ledger-modes.json");
    writeJsonAtomicSync(out, JSON.parse(readFileSync(modes, "utf8")), { mode: 0o600 });
    files.push({ name: "shared-ledger-modes.json", path: out, sha256: sha256File(out) });
  }
  return { files };
}

/** Pauses new dispatch through the scheduler maintenance lease (as `update` does), without touching scheduler logic.
 * A busy merge queue or a pass that does not yield in time refuses the migration; the caller releases the handle. */
export async function pauseDispatch(root: string, ledgerPath: string, waitMs = 0): Promise<{ release(): void }> {
  const reader = new LedgerReader(ledgerPath);
  try {
    const lock = await acquireMaintenance("update", { path: underRoot(root, "scheduler-maintenance.lock"),
      request: underRoot(root, "scheduler-maintenance.request"), marker: underRoot(root, "update-inflight.json"), reader, waitMs });
    return lock ?? refuse("dispatch_not_paused", "scheduler", "调度维护锁拿不到（调度在跑或合并队列在途）");
  } finally { reader.close(); }
}
