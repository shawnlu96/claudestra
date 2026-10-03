/**
 * PJ1 read-only sharing ("镜像中"): a feature committed to the center but not activated (center authorityMode=source)
 * gets its local planning back while the home machine projects card progress to the center.
 * - The mirroring flag lives in the mode file (`mirror: true` on {source, sharedPlanning}); restarts keep it.
 * - Push watermarks / last error live in shared-ledger-mirrors.json; the watermark only moves on a confirmed push.
 * - `off` stops pushing first (disable + wait for an in-flight push), then closes the local planning gate again.
 * activate stays with scripts/shared-ledger-import.ts and its owner approval; it rewrites the mode without `mirror`.
 */
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquireLock } from "./file-lock.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
import { STATE_DIR } from "./paths.js";
import { getFeature } from "./ledger-feature.js";
import { LedgerError } from "./ledger-store.js";
import { instanceKeySync, type InstanceKey } from "./instance-key.js";
import { readSharedLedgerMode, resolveSharedLedgerCredential, writeSharedLedgerMode, type SharedLedgerLocalCredential } from "./shared-ledger-mode.js";
import { parseSharedLedgerImport } from "./shared-ledger-contract-transfer.js";
import type { SharedLedgerImport } from "./shared-ledger-contract.js";
import type { MirrorEntry, MirrorTaskMeta } from "./shared-ledger-projector.js";

interface MirrorFile { features: Record<string, MirrorEntry> }
const validId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id);
const mirrorPath = (dir: string) => join(dir, "shared-ledger-mirrors.json");
/** Held for the duration of one feature push; `off` waits on it so no push lands after the gate closes. */
export const mirrorPushLockPath = (dir: string) => join(dir, "shared-ledger-mirrors.push.lock");
/** The lock scripts/shared-ledger-import.ts holds for commit / activate / revoke: mode writes here take it too. */
export const migrationLockPath = (dir: string) => join(dir, "shared-ledger-migrations", "migration.lock");
const ACTIVATED = "这个 feature 已经 activate，规划权在中心，不能进镜像";

function mirrorFile(value: unknown): value is MirrorFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const features = (value as MirrorFile).features;
  return !!features && typeof features === "object" && !Array.isArray(features) && Object.entries(features).every(([id, e]) => validId(id)
    && !!e && typeof e === "object" && typeof e.enabled === "boolean" && typeof e.snapshot === "boolean"
    && [e.batchId, e.centerId, e.teamId, e.projectId, e.centerFeatureId, e.sourceInstanceId, e.localProject].every((s) => typeof s === "string" && !!s)
    && [e.watermark, e.failures, e.nextAttemptAt].every((n) => Number.isSafeInteger(n) && n >= 0)
    && !!e.fingerprints && typeof e.fingerprints === "object" && !!e.taskMeta && typeof e.taskMeta === "object");
}
export function readSharedLedgerMirrors(dir = STATE_DIR): Record<string, MirrorEntry> {
  const state = readJsonStateSync(mirrorPath(dir), mirrorFile);
  if (state.status === "corrupt") throw new Error("shared ledger mirror state invalid");
  return state.status === "missing" ? {} : (state.data as MirrorFile).features;
}
/** Read-modify-write under the state lock; `mutate` sees the current file, not a caller's stale copy. */
export async function updateSharedLedgerMirrors(dir: string, mutate: (features: Record<string, MirrorEntry>) => void): Promise<void> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = mirrorPath(dir), lock = await acquireLock(`${path}.lock`);
  if (!lock) throw new Error("shared ledger mirror state lock unavailable");
  try {
    const state: MirrorFile = { features: readSharedLedgerMirrors(dir) };
    mutate(state.features);
    if (!mirrorFile(state)) throw new Error("shared ledger mirror state invalid");
    writeJsonAtomicSync(path, state, { mode: 0o600, commitIf: lock.held });
  } finally { lock.release(); }
}

interface JournalRecord { phase: string; featureIds: string[]; payload?: SharedLedgerImport; target?: string;
  receipt?: { status: string; receipt?: { mappings: { kind: string; sourceInstanceId: string; sourceId: string; id: string }[] } } }
interface CommittedImport {
  batchId: string; payload: SharedLedgerImport; centerId: string; teamId: string; instanceId: string; centerFeatureId: string;
}
/** Local migration journal (scripts/shared-ledger-import.ts): `verified` = committed and staged, `active` = planning handed over. */
function findCommittedImport(featureId: string, dir = STATE_DIR): CommittedImport | { refused: string } {
  const root = join(dir, "shared-ledger-migrations");
  const names = existsSync(root) ? readdirSync(root).filter((n) => n.endsWith(".json")).sort() : [];
  let found: CommittedImport | null = null;
  for (const name of names) {
    let record: JournalRecord;
    try { record = JSON.parse(readFileSync(join(root, name), "utf8")) as JournalRecord; }
    catch { return { refused: "迁移 journal 无法读取，先核对本机 journal" }; }
    if (!Array.isArray(record?.featureIds) || !record.featureIds.includes(featureId)) continue;
    if (record.phase === "active" || record.receipt?.status === "active") return { refused: ACTIVATED };
    if (record.phase !== "verified" || record.receipt?.status !== "staged" || !record.payload || !record.target) continue;
    const payload = parseSharedLedgerImport(record.payload);
    const target = JSON.parse(record.target) as { centerId?: unknown; teamId?: unknown; instanceId?: unknown };
    const mapping = record.receipt.receipt?.mappings.find((m) => m.kind === "feature" && m.sourceId === featureId
      && m.sourceInstanceId === payload.manifest.sourceInstanceId);
    if (typeof target.centerId !== "string" || typeof target.teamId !== "string" || target.instanceId !== payload.manifest.sourceInstanceId
      || !mapping || !validId(mapping.id)) return { refused: "迁移 journal 与中心回执对不上，先核对本机 journal" };
    found = { batchId: name.slice(0, -".json".length), payload, centerId: target.centerId, teamId: target.teamId,
      instanceId: payload.manifest.sourceInstanceId, centerFeatureId: mapping.id };
  }
  return found ?? { refused: "这个 feature 还没有 commit 到中心（没有已 commit、未 activate 的导入批次）" };
}

/** JN1: projections are pushed with the local service enrollment (`--role service`) that carries `project`. */
export const resolveMirrorCredential = (e: Pick<MirrorEntry, "centerId" | "teamId" | "projectId">, dir = STATE_DIR): SharedLedgerLocalCredential | null =>
  resolveSharedLedgerCredential("owner:self", "service", e.centerId, e.teamId, e.projectId, "project", dir);

export interface MirrorControlOptions { stateDir?: string; key?: () => InstanceKey | null }

/** Runs `write` under the migration lock, so an activate cannot land between its re-check and the mode write. */
async function underMigrationLock<T>(dir: string, write: () => Promise<T>): Promise<T> {
  const path = migrationLockPath(dir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = await acquireLock(path);
  if (!lock) throw new LedgerError("busy", "迁移正在进行（migration.lock 被占用），未改本机模式；稍后重跑");
  try { return await write(); } finally { lock.release(); }
}

export async function sharedMirrorOn(db: Database, featureId: string, opts: MirrorControlOptions = {}) {
  const dir = opts.stateDir ?? STATE_DIR;
  if (!validId(featureId)) throw new LedgerError("invalid", "invalid feature id");
  const feature = getFeature(db, featureId);
  if (!feature) throw new LedgerError("not_found", `没有 feature ${featureId}`);
  const mode = readSharedLedgerMode(featureId, dir);
  if (mode.authorityMode !== "source") throw new LedgerError("forbidden", ACTIVATED);
  if (!mode.sharedPlanning) throw new LedgerError("forbidden", "这个 feature 还没有 commit 到中心（本机规划闸未关），不能进镜像");
  const committed = findCommittedImport(featureId, dir);
  if ("refused" in committed) throw new LedgerError("forbidden", committed.refused);
  const base = { centerId: committed.centerId, teamId: committed.teamId, projectId: committed.payload.manifest.projectId };
  const credential = resolveMirrorCredential(base, dir);
  if (!credential || credential.instanceId !== committed.instanceId) throw new LedgerError("forbidden", "本机没有可用的 service 凭据（需要 kind=service、带 project 权限、实例一致）");
  if (!(opts.key ?? (() => instanceKeySync(dir)))()) throw new LedgerError("forbidden", "本机实例密钥不可用，无法签名推送");
  const source = committed.payload.manifest.features.find((f) => f.sourceFeatureId === featureId)!;
  const taskMeta: Record<string, MirrorTaskMeta> = Object.fromEntries(source.projection.tasks.map((t) =>
    [t.sourceTaskId, { specSummary: t.specSummary, specDigest: t.specDigest, assigneeCode: t.assigneeCode }]));
  // State first, mode second: a crash between them leaves a disabled-by-mode entry the pusher ignores.
  await updateSharedLedgerMirrors(dir, (features) => {
    const prior = features[featureId];
    const same = prior?.batchId === committed.batchId && prior.centerFeatureId === committed.centerFeatureId;
    features[featureId] = { enabled: true, batchId: committed.batchId, ...base, centerFeatureId: committed.centerFeatureId,
      sourceInstanceId: committed.instanceId, localProject: feature.project,
      watermark: same ? prior.watermark : committed.payload.manifest.sourceSeq, snapshot: same ? prior.snapshot : false,
      fingerprints: same ? prior.fingerprints : {}, taskMeta,
      lastPushAt: same ? prior.lastPushAt : null, lastPushSeq: same ? prior.lastPushSeq : null,
      lastError: null, lastErrorAt: null, failures: 0, nextAttemptAt: 0 };
  });
  // The checks above ran before any wait: an activate may have finished since. Re-check and write under its lock.
  const refused = await underMigrationLock(dir, async () => {
    const now = readSharedLedgerMode(featureId, dir), again = findCommittedImport(featureId, dir);
    if (now.authorityMode !== "source" || "refused" in again) return "refused" in again ? again.refused : ACTIVATED;
    if (!now.sharedPlanning || again.batchId !== committed.batchId) return "迁移批次在开启镜像期间变了，未开启；核对后重跑";
    await writeSharedLedgerMode(featureId, { authorityMode: "source", sharedPlanning: true, mirror: true }, dir, db.filename);
    return null;
  });
  if (refused) {
    await updateSharedLedgerMirrors(dir, (features) => {
      const cur = features[featureId];
      if (cur?.batchId === committed.batchId) features[featureId] = { ...cur, enabled: false };
    });
    throw new LedgerError("forbidden", refused);
  }
  return sharedMirrorStatus(featureId, dir);
}

export async function sharedMirrorOff(db: Database, featureId: string, opts: Pick<MirrorControlOptions, "stateDir"> = {}) {
  const dir = opts.stateDir ?? STATE_DIR;
  if (!validId(featureId)) throw new LedgerError("invalid", "invalid feature id");
  if (!readSharedLedgerMode(featureId, dir).mirror && !readSharedLedgerMirrors(dir)[featureId]?.enabled) {
    throw new LedgerError("invalid", `feature ${featureId} 不在镜像中`);
  }
  await updateSharedLedgerMirrors(dir, (features) => { if (features[featureId]) features[featureId] = { ...features[featureId], enabled: false }; });
  const push = await acquireLock(mirrorPushLockPath(dir));
  if (!push) throw new LedgerError("busy", "推送仍在进行，已停推送但未关闭本机规划；稍后重跑 off");
  push.release();
  // An activate in between already rewrote the mode (or is about to): never downgrade it back to source.
  const activated = await underMigrationLock(dir, async () => {
    const mode = readSharedLedgerMode(featureId, dir), journal = findCommittedImport(featureId, dir);
    if (mode.authorityMode !== "source" || ("refused" in journal && journal.refused === ACTIVATED)) return true;
    if (mode.mirror) await writeSharedLedgerMode(featureId, { authorityMode: "source", sharedPlanning: true }, dir, db.filename);
    return false;
  });
  if (activated) throw new LedgerError("forbidden", "已停推送；这个 feature 已经 activate，规划权在中心，未改本机模式");
  return sharedMirrorStatus(featureId, dir);
}

export function sharedMirrorStatus(featureId: string, dir = STATE_DIR) {
  const mode = readSharedLedgerMode(featureId, dir), e = readSharedLedgerMirrors(dir)[featureId];
  const at = (t: number | null | undefined) => t ? new Date(t).toISOString() : null;
  return { ok: true, featureId, mirroring: mode.mirror === true && !!e?.enabled,
    mode: { authorityMode: mode.authorityMode, sharedPlanning: mode.sharedPlanning, mirror: mode.mirror === true },
    ...(e ? { centerFeatureId: e.centerFeatureId, batchId: e.batchId, watermark: e.watermark, lastPushSeq: e.lastPushSeq,
      lastPushAt: at(e.lastPushAt), lastError: e.lastError, lastErrorAt: at(e.lastErrorAt), failures: e.failures,
      nextAttemptAt: at(e.nextAttemptAt), snapshotPending: e.snapshot } : {}),
    freshness: "本机任一事件推进全局 seq 时推送;整机无事件时中心如实显示过期(PM 10-02 定 A)" };
}
