/**
 * N8A auto-share switch + last-pass results, one file per state dir: shared-ledger-auto-share.json.
 * `mode` / `exclude` are written only by `ledger shared-auto` (PM / owner); every other field only by the pass.
 * Both go through updateAutoShareState (lock + re-read), so neither side overwrites the other's fields.
 * A missing file or project means off.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { acquireLock } from "./file-lock.js";
import { STATE_DIR } from "./paths.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";

export type AutoShareMode = "off" | "observe" | "on";
/** will_share 会共享 / deferred 暂缓 / refused 拒收 / shared 已共享 / excluded 排除 / in_batch 本机批次进行中 */
export type AutoShareStatus = "will_share" | "deferred" | "refused" | "shared" | "excluded" | "in_batch";
/** `solo`: its last multi-feature batch failed (prepare or body size), so it is batched alone from now on. */
export interface AutoShareFeature { status: AutoShareStatus; reason?: string; rev?: number; version?: number; at: number; rules?: number; solo?: boolean }
/** The one batch this project may have open: prepared → committed (staged) → every feature mirrored. */
export interface AutoSharePending { batchId: string; digest: string; featureIds: string[]; unknown: number; at: number }
/** Audit of auto-approved batches (owner 10-08 decision): the digest committed under the batch's own manifestDigest. */
interface AutoShareBatch { batchId: string; digest: string; featureIds: string[]; at: number; outcome: string }
export interface AutoShareProject {
  mode: AutoShareMode; exclude: string[];
  features?: Record<string, AutoShareFeature>;
  pending?: AutoSharePending | null;
  halted?: { batchId: string; at: number } | null;
  batches?: AutoShareBatch[];
  lastRunAt?: number; lastError?: string | null;
}
interface AutoShareFile { projects: Record<string, AutoShareProject> }

export const validAutoShareId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id);
const autoSharePath = (dir: string) => join(dir, "shared-ledger-auto-share.json");
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function autoShareFile(value: unknown): value is AutoShareFile {
  if (!isObject(value) || !isObject(value.projects)) return false;
  return Object.entries(value.projects).every(([id, p]) => validAutoShareId(id) && isObject(p)
    && ["off", "observe", "on"].includes(p.mode as string) && Array.isArray(p.exclude) && p.exclude.every(validAutoShareId)
    && (p.features === undefined || isObject(p.features)) && (p.pending == null || isObject(p.pending))
    && (p.halted == null || isObject(p.halted)) && (p.batches === undefined || Array.isArray(p.batches)));
}

export function readAutoShareState(dir = STATE_DIR): Record<string, AutoShareProject> {
  const state = readJsonStateSync(autoSharePath(dir), autoShareFile);
  if (state.status === "corrupt") throw new Error("shared ledger auto-share state invalid");
  return state.status === "missing" ? {} : (state.data as AutoShareFile).projects;
}
export const autoShareProject = (dir: string, localProjectId: string): AutoShareProject =>
  readAutoShareState(dir)[localProjectId] ?? { mode: "off", exclude: [] };

/** Read-modify-write under the state lock; `mutate` sees the current file, not a caller's stale copy. */
export async function updateAutoShareState(dir: string, mutate: (projects: Record<string, AutoShareProject>) => void): Promise<void> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = autoSharePath(dir), lock = await acquireLock(`${path}.lock`);
  if (!lock) throw new Error("shared ledger auto-share state lock unavailable");
  try {
    const state: AutoShareFile = { projects: readAutoShareState(dir) };
    mutate(state.projects);
    if (!autoShareFile(state)) throw new Error("shared ledger auto-share state invalid");
    writeJsonAtomicSync(path, state, { mode: 0o600, commitIf: lock.held });
  } finally { lock.release(); }
}
/** The pass's writes: only the named project's result fields; a concurrent `shared-auto` change to mode / exclude survives. */
export async function updateAutoShareProject(dir: string, localProjectId: string, mutate: (project: AutoShareProject) => void): Promise<void> {
  await updateAutoShareState(dir, (projects) => {
    const cur = projects[localProjectId];
    if (!cur) return; // Switched off (file entry removed) while the pass ran: nothing of ours to record.
    mutate(cur);
  });
}
