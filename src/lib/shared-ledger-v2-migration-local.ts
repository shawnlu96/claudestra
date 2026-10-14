/** X13 local side of the execution migration: drill-root guard, group member ports (本机 / peer A / peer B), in-flight
 * inventory, backup, dispatch pause and report files. Every path this module writes is checked under the caller's drill root by
 * its real landing place (symlinks included); the production state directory is refused outright.
 * Reads each member's ledger read-only; scheduler_sessions and process locks are inventoried, never migrated.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { STATE_DIR, stateDirIn } from "./paths.js";
import { acquireMaintenance } from "./scheduler-maintenance.js";
import { LedgerReader } from "./ledger-read.js";
import { writeJsonAtomicSync } from "./state-file.js";
import { gateFeatureIds, type GateTask } from "./shared-ledger-v2-write-gate-state.js";
import { readSharedLedgerMode, writeSharedLedgerModes, type SharedLedgerMode } from "./shared-ledger-mode.js";

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
/** Where a write to `p` actually lands: the real path of `p`, or of its nearest existing ancestor plus the missing tail.
 * A dangling symlink on the way has no knowable landing place and is refused. */
function landing(p: string): string {
  const tail: string[] = [];
  for (let cur = p; ; cur = dirname(cur)) {
    try { return join(realpathSync(cur), ...tail.reverse()); } catch {
      let exists = false;
      try { lstatSync(cur); exists = true; } catch { /* missing: go up */ }
      if (exists) refuse("path_escape", p, "路径上有悬空符号链接");
      if (dirname(cur) === cur) return p;
      tail.push(basename(cur));
    }
  }
}
/** The production state directories: the default home path, the configured STATE_DIR and an explicit env override. */
export function productionDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  return [stateDirIn(homedir()), STATE_DIR, env.CLAUDESTRA_STATE_DIR].filter((p): p is string => !!p).map(real);
}
/** Drill roots live strictly inside the OS temp directory and never overlap a production state directory (either way round). */
export function assertDrillRoot(root: string, production = productionDirs(), temp = real(tmpdir())): string {
  const abs = real(root);
  if (production.some(p => within(abs, p) || within(p, abs))) refuse("production_root", abs, "演练根目录与生产状态目录重叠");
  if (!within(abs, temp) || abs === temp) refuse("not_isolated", abs, "演练只在临时目录内的隔离 fixture 里跑");
  return abs;
}
/** Every read/write path goes through here: lexically and by its real landing place (symlinked dirs / files followed), the path
 * must stay inside the drill root and outside every production state directory. An escape is a bug, never a fallback. */
export function underRoot(root: string, ...parts: string[]): string {
  const p = resolve(root, ...parts), at = landing(p);
  if (!within(p, root) || !within(at, real(root))) refuse("path_escape", p, `写路径实际落在演练根目录外（${at}）`);
  if (productionDirs().some(d => within(at, d))) refuse("production_root", p, "写路径实际落在生产状态目录");
  return p;
}
export const batchDir = (root: string, batchId: string): string => underRoot(root, "shared-ledger-v2-migration", batchId);
export function writeRootJson(root: string, path: string, data: unknown): string {
  const p = underRoot(root, path);
  mkdirSync(underRoot(root, dirname(p)), { recursive: true, mode: 0o700 });
  writeJsonAtomicSync(underRoot(root, path), data, { mode: 0o600 });
  return p;
}

interface LocalTask { id: string; featureIds: string[]; stage: string; reviewed: boolean }
interface LocalOrder { orderId: string; taskId: string; status: string; leaseGen: number; head: string; peer: string }
/** In flight = an active / retiring worker session, a pooled / claimed / unknown lend order, a pending / submitted / unknown intent. */
interface InflightItem { kind: "worker" | "lend" | "intent"; id: string; taskId: string; status: string }
export interface LocalInventory { tasks: LocalTask[]; orders: LocalOrder[]; inflight: InflightItem[] }

const hasTable = (db: Database, name: string): boolean =>
  !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
/** Cards of the group are found by both persisted associations (featureId column and extra.sharedFeatureId), like the X7 gate;
 * `relatedTaskIds` adds rows a peer keeps for the home's cards (lend orders, workers, intents) without owning the card.
 * `reviewed` is the source's own review fact: a delivered / done review step, independent of any manifest. */
function readLocalInventory(ledgerPath: string, featureIds: readonly string[], relatedTaskIds: readonly string[] = []): LocalInventory {
  if (!existsSync(ledgerPath)) return { tasks: [], orders: [], inflight: [] };
  const db = new Database(ledgerPath, { readonly: true });
  try {
    const group = new Set(featureIds);
    const reviewed = new Set(hasTable(db, "task_steps") ? (db.query(
      "SELECT DISTINCT taskId FROM task_steps WHERE step IN ('review','final_review') AND state IN ('delivered','done')").all() as
      { taskId: string }[]).map(r => r.taskId) : []);
    const tasks = hasTable(db, "tasks") ? (db.query("SELECT * FROM tasks").all() as GateTask[])
      .map(t => ({ id: t.id, featureIds: gateFeatureIds(t), stage: String(t.stage), reviewed: reviewed.has(t.id) }))
      .filter(t => t.featureIds.some(f => group.has(f))) : [];
    const ids = new Set([...tasks.map(t => t.id), ...relatedTaskIds]), mine = <T extends { taskId: string }>(rows: T[]) => rows.filter(r => ids.has(r.taskId));
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
interface MigrationBackup { files: { name: string; path: string; sha256: string }[] }
/** Consistent copy of a member's ledger (VACUUM INTO, WAL included) plus its mode file, with digests recorded in the report. */
function backupLocal(root: string, out: string, memberDir: string, ledgerPath: string): MigrationBackup {
  const dir = underRoot(root, out);
  if (existsSync(dir)) refuse("backup_exists", out, "同批次备份已存在，不覆盖");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files: MigrationBackup["files"] = [];
  if (existsSync(ledgerPath)) {
    const to = underRoot(dir, "ledger.sqlite"), db = new Database(ledgerPath);
    try { db.run("VACUUM INTO ?", [to]); } finally { db.close(); }
    files.push({ name: "ledger.sqlite", path: to, sha256: sha256File(to) });
  }
  const modes = underRoot(root, memberDir, "shared-ledger-modes.json");
  if (existsSync(modes)) {
    const to = underRoot(dir, "shared-ledger-modes.json");
    writeJsonAtomicSync(to, JSON.parse(readFileSync(modes, "utf8")), { mode: 0o600 });
    files.push({ name: "shared-ledger-modes.json", path: to, sha256: sha256File(to) });
  }
  return { files };
}

/** Pauses new dispatch through the scheduler maintenance lease (as `update` does), without touching scheduler logic.
 * A busy merge queue or a pass that does not yield in time refuses the migration; the caller releases the handle. */
async function pauseDispatch(root: string, memberDir: string, ledgerPath: string, waitMs = 0): Promise<{ release(): void }> {
  const reader = new LedgerReader(ledgerPath);
  try {
    const lock = await acquireMaintenance("update", { path: underRoot(root, memberDir, "scheduler-maintenance.lock"),
      request: underRoot(root, memberDir, "scheduler-maintenance.request"), marker: underRoot(root, memberDir, "update-inflight.json"), reader, waitMs });
    return lock ?? refuse("dispatch_not_paused", "scheduler", "调度维护锁拿不到（调度在跑或合并队列在途）");
  } finally { reader.close(); }
}

/** A group member as the migration sees it. The drill's members are isolated state dirs under the drill root; every step is
 * confirmed by reading the member's persisted state back, never by the write call's return alone. */
export interface MigrationMemberSpec { label: string; instanceId: string; versionVerified: boolean; dir: string }
export interface MemberPort {
  label: string; instanceId: string; versionVerified: boolean;
  pause(waitMs?: number): Promise<{ release(): void }>;
  backup(out: string): MigrationBackup;
  inventory(featureIds: readonly string[], relatedTaskIds?: readonly string[]): LocalInventory;
  modes(featureIds: readonly string[]): Record<string, SharedLedgerMode>;
  writeModes(modes: Record<string, SharedLedgerMode>): Promise<void>;
  /** Durable whole-scheduler hold (the maintenance marker the scheduler lease refuses under) for a member whose mode is unwritable. */
  hold(why: object): string;
}
export function fileMember(root: string, m: MigrationMemberSpec): MemberPort {
  const dir = relative(root, underRoot(root, m.dir)) || ".", at = () => underRoot(root, dir);
  const ledger = () => underRoot(root, dir, "ledger.sqlite");
  return {
    label: m.label, instanceId: m.instanceId, versionVerified: m.versionVerified,
    pause: waitMs => pauseDispatch(root, dir, ledger(), waitMs),
    backup: out => backupLocal(root, out, dir, ledger()),
    inventory: (featureIds, related) => readLocalInventory(ledger(), featureIds, related),
    modes: featureIds => {
      underRoot(root, dir, "shared-ledger-modes.json");
      return Object.fromEntries(featureIds.map(f => [f, readSharedLedgerMode(f, at())]));
    },
    writeModes: async modes => {
      underRoot(root, dir, "shared-ledger-modes.json"); underRoot(root, dir, "shared-ledger-modes.json.lock");
      await writeSharedLedgerModes(modes, at(), ledger());
    },
    hold: why => writeRootJson(root, join(dir, "update-inflight.json"), { ...why, holder: "x13-migration" }),
  };
}
