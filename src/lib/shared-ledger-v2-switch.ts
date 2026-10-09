import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { acquireLock } from "./file-lock.js";
import { STATE_DIR } from "./paths.js";
import { validAutoShareId } from "./shared-ledger-auto-share-state.js";
import { readJsonStateSync, reportCorrupt, StateCorruptError, writeJsonAtomicSync } from "./state-file.js";
import type { StateValidator } from "./state-file.js";

export type Stage2Switch = "off" | "observe" | "on";
/** Times are Unix milliseconds. S2F enforces owner identity; askId is recorded without resolving the ask here. */
export interface Stage2Release {
  kind: "drill" | "release";
  askId: string;
  grantedAt: number;
  expiresAt?: number;
}
interface ProjectFile<T> { projects: Record<string, T> }

const MAX_DRILL_MS = 7 * 24 * 60 * 60 * 1000;
const GRANT_CLOCK_SKEW_MS = 60_000;
const RELEASE_FIELDS = new Set(["kind", "askId", "grantedAt", "expiresAt"]);
const switchPath = (dir: string) => join(dir, "shared-ledger-v2-switch.json");
const releasePath = (dir: string) => join(dir, "shared-ledger-v2-release.json");
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isMode = (v: unknown): v is Stage2Switch => v === "off" || v === "observe" || v === "on";
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function validRelease(project: string, value: unknown): value is Stage2Release {
  if (!isObject(value) || !Object.keys(value).every((key) => RELEASE_FIELDS.has(key)) || (value.kind !== "drill" && value.kind !== "release")
    || typeof value.askId !== "string" || !value.askId.trim() || !isTime(value.grantedAt)) return false;
  if (value.expiresAt !== undefined && (!isTime(value.expiresAt) || value.expiresAt <= value.grantedAt)) return false;
  return value.kind === "release" || (project.startsWith("s2-drill-") && isTime(value.expiresAt)
    && value.expiresAt - value.grantedAt <= MAX_DRILL_MS);
}

function validFile<T>(value: unknown, valid: (project: string, entry: unknown) => entry is T): value is ProjectFile<T> {
  return isObject(value) && isObject(value.projects)
    && Object.entries(value.projects).every(([project, entry]) => validAutoShareId(project) && valid(project, entry));
}
const switchFile = (value: unknown): value is ProjectFile<Stage2Switch> => validFile(value, (_project, entry): entry is Stage2Switch => isMode(entry));
const releaseFile = (value: unknown): value is ProjectFile<Stage2Release> => validFile(value, validRelease);

/** Readers fail closed without caching an earlier on; writers preserve corrupt files for repair. */
function readProjects<T>(path: string, validate: StateValidator, strict = false): Record<string, T> {
  const state = readJsonStateSync(path, validate);
  if (state.status === "corrupt") {
    if (strict) throw new StateCorruptError(path, state.error);
    reportCorrupt(path, state.error, "shared-ledger-v2-switch");
  }
  return state.status === "ok" ? (state.data as ProjectFile<T>).projects : {};
}
const ownEntry = <T>(projects: Record<string, T>, project: string): T | undefined => Object.hasOwn(projects, project) ? projects[project] : undefined;
/** A grant dated in the future is not yet valid, so it reads as observe rather than waiting to turn on. */
const effective = (entry: Stage2Release | undefined, now: number): boolean =>
  !!entry && Number.isFinite(now) && entry.grantedAt <= now && (entry.expiresAt === undefined || now < entry.expiresAt);

/** Returns the recorded authorization, including expired entries, so callers can display its audit fields. */
export function readStage2Release(localProjectId: string, dir = STATE_DIR): Stage2Release | null {
  return ownEntry(readProjects<Stage2Release>(releasePath(dir), releaseFile), localProjectId) ?? null;
}

export function readStage2Switch(localProjectId: string, dir = STATE_DIR, now = Date.now()): Stage2Switch {
  const mode = ownEntry(readProjects<Stage2Switch>(switchPath(dir), switchFile), localProjectId) ?? "off";
  if (mode !== "on") return mode;
  return effective(readStage2Release(localProjectId, dir) ?? undefined, now) ? "on" : "observe";
}

/** Fixed lock order serializes both writers, including the on check against concurrent revocation. */
async function withLocks(dir: string, write: (held: () => boolean) => void): Promise<void> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sw = await acquireLock(`${switchPath(dir)}.lock`);
  if (!sw) throw new Error("stage2 switch lock unavailable");
  try {
    const release = await acquireLock(`${releasePath(dir)}.lock`);
    if (!release) throw new Error("stage2 release lock unavailable");
    try { write(() => sw.held() && release.held()); }
    finally { release.release(); }
  } finally { sw.release(); }
}

export async function writeStage2Switch(localProjectId: string, mode: Stage2Switch, dir = STATE_DIR): Promise<void> {
  if (!validAutoShareId(localProjectId) || !isMode(mode)) throw new Error("invalid stage2 project or switch mode");
  await withLocks(dir, (held) => {
    const projects = readProjects<Stage2Switch>(switchPath(dir), switchFile, true);
    if (mode === "on" && !effective(ownEntry(readProjects<Stage2Release>(releasePath(dir), releaseFile, true), localProjectId), Date.now())) {
      throw new Error("stage2 on requires a valid release entry");
    }
    projects[localProjectId] = mode;
    writeJsonAtomicSync(switchPath(dir), { projects }, { mode: 0o600, commitIf: held });
  });
}

/** Copies only the recorded fields, so caller extras never reach disk and later caller mutation is ignored. */
function pickRelease(entry: unknown): unknown {
  if (!isObject(entry)) return entry;
  const { kind, askId, grantedAt, expiresAt } = entry;
  return { kind, askId, grantedAt, ...(expiresAt !== undefined ? { expiresAt } : {}) };
}

export interface Stage2ReleaseWriteOptions { now?: number; clockSkewMs?: number }

/** Passing null revokes immediately; it never rewrites the switch file. Future grants are refused so they cannot turn on later. */
export async function writeStage2Release(localProjectId: string, entry: Stage2Release | null, dir = STATE_DIR,
  { now = Date.now(), clockSkewMs = GRANT_CLOCK_SKEW_MS }: Stage2ReleaseWriteOptions = {}): Promise<void> {
  if (!validAutoShareId(localProjectId)) throw new Error("invalid stage2 project");
  const picked = entry === null ? null : pickRelease(entry);
  if (picked !== null && (!validRelease(localProjectId, picked) || !Number.isFinite(now)
    || !(picked.grantedAt <= now + clockSkewMs))) throw new Error("invalid stage2 release entry");
  const recorded = picked as Stage2Release | null;
  await withLocks(dir, (held) => {
    const projects = readProjects<Stage2Release>(releasePath(dir), releaseFile, true);
    if (recorded === null) delete projects[localProjectId];
    else projects[localProjectId] = recorded;
    writeJsonAtomicSync(releasePath(dir), { projects }, { mode: 0o600, commitIf: held });
  });
}
