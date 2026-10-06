import { join } from "node:path";
import { mkdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { acquireLock } from "./file-lock.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
import { assertSharedLedgerBindingAvailable, requireSharedLedgerProject, sameSharedLedgerProject } from "./shared-ledger-project-link.js";
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
/** Local owner approval or the authenticated CLI installs mappings; central grants and credentials are unchanged. */
export async function setSharedLedgerBinding(binding: SharedLedgerBinding, dir = STATE_DIR,
  preflight: (current: SharedLedgerBinding[]) => void = () => {}): Promise<void> {
  if (!validBindings([binding]) || !binding.localProjectId) throw new Error("invalid shared binding");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "shared-ledger-bindings.json"), lock = await acquireLock(`${path}.lock`);
  if (!lock) throw new Error("shared ledger binding lock unavailable");
  try {
    const bindings = readSharedLedgerBindings(dir);
    requireSharedLedgerProject(binding.localProjectId, dir);
    assertSharedLedgerBindingAvailable(binding, bindings);
    preflight(bindings);
    const current = bindings.filter(b => (b.localProjectId ?? b.projectId) !== binding.localProjectId
      && !(b.centerId === binding.centerId && b.teamId === binding.teamId && b.projectId === binding.projectId));
    writeJsonAtomicSync(path, [...current, binding], { mode: 0o600, commitIf: lock.held });
  } finally { lock.release(); }
}

/** Compare all rows for this center project under the same lock; only this operation may repair old mappings. */
export async function replaceSharedLedgerBindings(input: { expected: SharedLedgerBinding[]; next: SharedLedgerBinding },
  dir = STATE_DIR): Promise<{ backupPath: string | null }> {
  const { expected, next } = input;
  if (!validBindings(expected) || !validBindings([next]) || !next.localProjectId
    || expected.some(b => !sameSharedLedgerProject(b, next))) throw new Error("invalid shared binding replacement");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "shared-ledger-bindings.json"), lock = await acquireLock(`${path}.lock`);
  if (!lock) throw new Error("shared ledger binding lock unavailable");
  let backupPath: string | null = null;
  try {
    const bindings = readSharedLedgerBindings(dir);
    const related = bindings.filter(b => sameSharedLedgerProject(b, next));
    if (JSON.stringify(related) !== JSON.stringify(expected)) throw new Error("shared binding changed; reopen confirmation");
    requireSharedLedgerProject(next.localProjectId, dir);
    const other = bindings.filter(b => !sameSharedLedgerProject(b, next));
    assertSharedLedgerBindingAvailable(next, other);
    if (!lock.held()) throw new Error("shared ledger binding lock lost");
    const original = readJsonStateSync(path);
    if (original.status !== "missing") {
      backupPath = `${path}.bak-${Date.now()}-${crypto.randomUUID()}`;
      writeFileSync(backupPath, readFileSync(path), { mode: 0o600, flag: "wx" });
    }
    writeJsonAtomicSync(path, [...other, next], { mode: 0o600, commitIf: lock.held });
    if (JSON.stringify(readSharedLedgerBindings(dir)) !== JSON.stringify([...other, next])) throw new Error("shared binding readback failed");
    return { backupPath };
  } finally { lock.release(); }
}
