/**
 * N7X1 replica bookkeeping (shared-center-replicas.json, 0600): per center feature the local id, center version / rev,
 * baseDigest, last sync and last error; features refused for local limits (with a fixed reason); per center project
 * scope the last sync and error. Status only: the gates read the mode file and claims, never this file.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { acquireLock } from "./file-lock.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
import { STATE_DIR } from "./paths.js";

export interface ReplicaScope { centerId: string; teamId: string; projectId: string }
interface ReplicaEntry extends ReplicaScope {
  centerFeatureId: string; localFeatureId: string; localProject: string;
  version: number; rev: number; baseDigest: string; syncedAt: number; lastError: string | null; lastErrorAt: number | null;
  /** N7X4: node keys the center binds while this instance has no card and no claim for them; missing in older files = none. */
  boundElsewhere?: string[];
}
interface ReplicaRefusal extends ReplicaScope { reason: string; at: number }
interface ScopeStatus { syncedAt: number | null; lastError: string | null; lastErrorAt: number | null }
export interface ReplicaFile {
  replicas: Record<string, ReplicaEntry>; refused: Record<string, ReplicaRefusal>; scopes: Record<string, ScopeStatus>;
}

const centerReplicasPath = (dir = STATE_DIR) => join(dir, "shared-center-replicas.json");
export const scopeKey = (s: ReplicaScope) => `${s.centerId}/${s.teamId}/${s.projectId}`;
const str = (v: unknown) => typeof v === "string" && v.length > 0;
const nat = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const optText = (v: unknown) => v === null || typeof v === "string";
const optNat = (v: unknown) => v === null || nat(v);
const dict = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function replicaFile(value: unknown): value is ReplicaFile {
  if (!dict(value) || !dict(value.replicas) || !dict(value.refused) || !dict(value.scopes)) return false;
  return Object.entries(value.replicas).every(([id, e]) => dict(e) && e.centerFeatureId === id
      && [e.centerId, e.teamId, e.projectId, e.localFeatureId, e.localProject].every(str) && [e.version, e.rev, e.syncedAt].every(nat)
      && typeof e.baseDigest === "string" && /^[0-9a-f]{64}$/.test(e.baseDigest) && optText(e.lastError) && optNat(e.lastErrorAt)
      && (e.boundElsewhere === undefined || (Array.isArray(e.boundElsewhere) && e.boundElsewhere.every(str))))
    && Object.values(value.refused).every((r) => dict(r) && [r.centerId, r.teamId, r.projectId, r.reason].every(str) && nat(r.at))
    && Object.values(value.scopes).every((s) => dict(s) && optNat(s.syncedAt) && optText(s.lastError) && optNat(s.lastErrorAt));
}

const EMPTY = (): ReplicaFile => ({ replicas: {}, refused: {}, scopes: {} });
export function readCenterReplicas(dir = STATE_DIR): ReplicaFile {
  const state = readJsonStateSync(centerReplicasPath(dir), replicaFile);
  if (state.status === "corrupt") throw new Error("shared center replica state invalid");
  return state.status === "missing" ? EMPTY() : state.data as ReplicaFile;
}
export async function updateCenterReplicas(dir: string, mutate: (state: ReplicaFile) => void): Promise<void> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = centerReplicasPath(dir), lock = await acquireLock(`${path}.lock`);
  if (!lock) throw new Error("shared center replica state lock unavailable");
  try {
    const state = readCenterReplicas(dir);
    mutate(state);
    if (!replicaFile(state)) throw new Error("shared center replica state invalid");
    writeJsonAtomicSync(path, state, { mode: 0o600, commitIf: lock.held });
  } finally { lock.release(); }
}

/**
 * Cross-process lock for one local replica id: the whole sync of that id (identity re-check → mirror → mode → ledger →
 * state) runs under it, so two center features whose uuids share the first 10 hex cannot both pass the collision check.
 * Fails closed: returns null when the lock is unavailable and `run` never starts.
 */
export async function withCenterReplicaLock<T>(dir: string, localFeatureId: string, run: () => Promise<T>): Promise<T | null> {
  const locks = join(dir, "shared-center-replica-locks");
  mkdirSync(locks, { recursive: true, mode: 0o700 });
  const lock = await acquireLock(join(locks, `${localFeatureId}.lock`));
  if (!lock) return null;
  try { return await run(); } finally { lock.release(); }
}
