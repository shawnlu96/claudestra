import { join } from "node:path";
import { mkdirSync, statSync } from "node:fs";
import { acquireLock } from "./file-lock.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
import { STATE_DIR } from "./paths.js";

export interface SharedLedgerBinding { centerId: string; teamId: string; projectId: string; localProjectId?: string }
const validId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
function validBindings(value: unknown): value is SharedLedgerBinding[] {
  return Array.isArray(value) && value.every(b => b && typeof b === "object"
    && Object.keys(b).every(k => ["centerId", "teamId", "projectId", "localProjectId"].includes(k))
    && [b.centerId, b.teamId, b.projectId].every(validId) && (b.localProjectId === undefined || validId(b.localProjectId)));
}
export function readSharedLedgerBindings(dir = STATE_DIR): SharedLedgerBinding[] {
  const path = join(dir, "shared-ledger-bindings.json"), file = readJsonStateSync(path, validBindings);
  if (file.status === "missing") return [];
  if (file.status !== "ok" || (statSync(path).mode & 0o777) !== 0o600) throw new Error("invalid shared bindings");
  return file.data as SharedLedgerBinding[];
}
/** Only the authenticated local CLI installs mappings; this function does not install central grants or credentials. */
export async function setSharedLedgerBinding(binding: SharedLedgerBinding, dir = STATE_DIR): Promise<void> {
  if (!validBindings([binding]) || !binding.localProjectId) throw new Error("invalid shared binding");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "shared-ledger-bindings.json"), lock = await acquireLock(`${path}.lock`);
  if (!lock) throw new Error("shared ledger binding lock unavailable");
  try {
    const current = readSharedLedgerBindings(dir).filter(b => (b.localProjectId ?? b.projectId) !== binding.localProjectId);
    writeJsonAtomicSync(path, [...current, binding], { mode: 0o600, commitIf: lock.held });
  } finally { lock.release(); }
}
