import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { acquireLock } from "./file-lock.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
import { STATE_DIR } from "./paths.js";
import type { SharedLedgerConnection } from "./shared-ledger-client.js";

type SharedLedgerAuthorityMode = "source" | "planning" | "execution";
export interface SharedLedgerMode { authorityMode: SharedLedgerAuthorityMode; sharedPlanning: boolean }
interface ModeFile { features: Record<string, SharedLedgerMode> }
export interface SharedLedgerLocalCredential extends SharedLedgerConnection {
  localSubject: string;
  kind: "person" | "service";
  projects: { projectId: string; actions: ("read" | "plan" | "import" | "project")[] }[];
}
interface CredentialFile { credentials: SharedLedgerLocalCredential[] }
function modeFile(value: unknown): value is ModeFile {
  if (!value || typeof value !== "object" || !("features" in value)) return false;
  const features = (value as ModeFile).features;
  return !!features && typeof features === "object" && !Array.isArray(features) && Object.values(features).every((m) =>
    m && ["source", "planning", "execution"].includes(m.authorityMode) && typeof m.sharedPlanning === "boolean");
}
function credentialFile(value: unknown): value is CredentialFile {
  if (!value || typeof value !== "object" || !Array.isArray((value as CredentialFile).credentials)) return false;
  return (value as CredentialFile).credentials.every((c) => c && ["person", "service"].includes(c.kind)
    && [c.localSubject, c.centerId, c.baseUrl, c.teamId, c.personId, c.instanceId, c.bearer].every((s) => typeof s === "string" && !!s)
    && Array.isArray(c.projects) && c.projects.every((p) => p.projectId !== "*" && typeof p.projectId === "string"
      && Array.isArray(p.actions) && p.actions.every((a) => ["read", "plan", "import", "project"].includes(a))));
}
/** Corrupt security state never becomes an empty file or a last-good authorization cache. */
function readState<T>(path: string, validate: (value: unknown) => value is T, fallback: T): T {
  const state = readJsonStateSync(path, validate);
  if (state.status === "corrupt") throw new Error("shared ledger local state invalid");
  return state.status === "missing" ? fallback : state.data as T;
}
async function updateState<T>(path: string, validate: (value: unknown) => value is T, fallback: T, mutate: (state: T) => void): Promise<void> {
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = await acquireLock(`${path}.lock`);
  if (!lock) throw new Error("shared ledger state lock unavailable");
  try {
    const state = readState(path, validate, fallback);
    mutate(state);
    if (!validate(state)) throw new Error("shared ledger state invalid");
    writeJsonAtomicSync(path, state, { mode: 0o600, commitIf: lock.held });
  } finally { lock.release(); }
}
export function readSharedLedgerMode(featureId: string, dir = STATE_DIR): SharedLedgerMode {
  const state = readState(join(dir, "shared-ledger-modes.json"), modeFile, { features: {} });
  return Object.hasOwn(state.features, featureId) ? { ...state.features[featureId] } : { authorityMode: "source", sharedPlanning: false };
}
export function localSharedLedgerPlanningAllowed(mode: SharedLedgerMode): boolean {
  return mode.authorityMode === "source" && !mode.sharedPlanning;
}
export async function writeSharedLedgerMode(featureId: string, mode: SharedLedgerMode, dir = STATE_DIR): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(featureId)) throw new Error("invalid feature id");
  await updateState(join(dir, "shared-ledger-modes.json"), modeFile, { features: {} }, (state) => {
    Object.defineProperty(state.features, featureId, { value: { ...mode }, enumerable: true, configurable: true, writable: true });
  });
}
export async function writeSharedLedgerCredential(credential: SharedLedgerLocalCredential, dir = STATE_DIR): Promise<void> {
  await updateState(join(dir, "shared-ledger-credentials.json"), credentialFile, { credentials: [] }, (state) => {
    const same = (c: SharedLedgerLocalCredential) => c.localSubject === credential.localSubject && c.kind === credential.kind
      && c.centerId === credential.centerId && c.teamId === credential.teamId;
    state.credentials = [...state.credentials.filter((c) => !same(c)), structuredClone(credential)];
  });
}
/** Subject/kind come from authenticated transport, never JSON body or caller-supplied actor/role. */
export function resolveSharedLedgerCredential(subject: string, kind: "person" | "service", centerId: string, teamId: string,
  projectId: string, action: SharedLedgerLocalCredential["projects"][number]["actions"][number], dir = STATE_DIR): SharedLedgerLocalCredential | null {
  const path = join(dir, "shared-ledger-credentials.json");
  const state = readState(path, credentialFile, { credentials: [] });
  if (state.credentials.length && (statSync(path).mode & 0o777) !== 0o600) throw new Error("shared ledger credentials require 0600");
  const credential = state.credentials.find((c) => c.localSubject === subject && c.kind === kind && c.centerId === centerId && c.teamId === teamId
    && c.projects.some((p) => p.projectId === projectId && p.actions.includes(action)));
  return credential ? structuredClone(credential) : null;
}
