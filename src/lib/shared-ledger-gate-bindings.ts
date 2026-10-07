import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { acquireLock, lockOwnedBy, type LockHandle } from "./file-lock.js";
import { readJsonStateSync, writeJsonAtomicSync, writeTextAtomicSync } from "./state-file.js";
import { STATE_DIR } from "./paths.js";
import { requireSharedLedgerLinkTarget, sameSharedLedgerProject, sharedLedgerBindingLocalId } from "./shared-ledger-project-link-target.js";

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
function requireBinding(binding: SharedLedgerBinding, dir: string): void {
  if (!validBindings([binding]) || !binding.localProjectId) throw new Error("invalid shared binding");
  requireSharedLedgerLinkTarget(binding.localProjectId, dir);
}

function requireSharedLedgerBindingAddition(binding: SharedLedgerBinding, bindings: SharedLedgerBinding[], dir = STATE_DIR): void {
  requireBinding(binding, dir);
  const conflicts = bindings.filter(b => sameSharedLedgerProject(b, binding) || sharedLedgerBindingLocalId(b) === binding.localProjectId);
  if (conflicts.length === 1 && sameSharedLedgerProject(conflicts[0]!, binding)
    && sharedLedgerBindingLocalId(conflicts[0]!) === binding.localProjectId) return;
  if (conflicts.length) {
    throw new Error("shared project or local project already bound; nothing was saved");
  }
}

/** Both mutations use the same lock, atomic writer and read-back. Ordinary addition cannot rebind. */
async function updateBindings(dir: string, update: (current: SharedLedgerBinding[]) => SharedLedgerBinding[], backup: boolean): Promise<{ backupPath: string | null }> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "shared-ledger-bindings.json"), lock = await acquireLock(`${path}.lock`);
  if (!lock) throw new Error("shared ledger binding lock unavailable");
  try {
    const bindings = readSharedLedgerBindings(dir);
    const next = update(bindings);
    if (JSON.stringify(next) === JSON.stringify(bindings)) return { backupPath: null };
    let backupPath: string | null = null;
    if (backup && existsSync(path)) {
      if (!lock.held()) throw new Error("shared ledger binding lock unavailable");
      backupPath = `${path}.bak-${Date.now()}-${randomUUID()}`;
      writeFileSync(backupPath, readFileSync(path), { flag: "wx", mode: 0o600 });
    }
    publishBindings(next, dir, lock.held);
    return { backupPath };
  } finally { lock.release(); }
}

/** Local owner approval or the authenticated CLI installs mappings; credentials are unchanged. */
export async function setSharedLedgerBinding(binding: SharedLedgerBinding, dir = STATE_DIR,
  preflight: (current: SharedLedgerBinding[]) => void = () => {}): Promise<void> {
  await updateBindings(dir, current => {
    requireSharedLedgerBindingAddition(binding, current, dir);
    preflight(current);
    if (current.some(b => sameSharedLedgerProject(b, binding))) return current;
    return [...current, binding];
  }, false);
}

/** Owner-authorized convergence only: expected is every old row for this center/team/project. */
export async function replaceSharedLedgerBindings(input: { expected: SharedLedgerBinding[]; next: SharedLedgerBinding }, dir = STATE_DIR,
  preflight: (current: SharedLedgerBinding[]) => void = () => {}): Promise<{ backupPath: string | null }> {
  return updateBindings(dir, current => {
    if (!validBindings(input.expected) || input.expected.some(b => !sameSharedLedgerProject(b, input.next))) throw new Error("invalid expected bindings");
    const related = current.filter(b => sameSharedLedgerProject(b, input.next));
    if (JSON.stringify(related) !== JSON.stringify(input.expected)) throw new Error("shared binding changed; 绑定已变化，请重新检查");
    const remaining = current.filter(b => !sameSharedLedgerProject(b, input.next));
    preflight(current);
    requireSharedLedgerBindingAddition(input.next, remaining, dir);
    return [...remaining, input.next];
  }, true);
}

/** All binding publication and read-back stay in the binding file's sole writer. */
function publishBindings(next: SharedLedgerBinding[], dir: string, held: () => boolean): void {
  writeJsonAtomicSync(join(dir, "shared-ledger-bindings.json"), next, { mode: 0o600, commitIf: held });
  if (JSON.stringify(readSharedLedgerBindings(dir)) !== JSON.stringify(next)) throw new Error("shared binding did not read back");
}

/** Enrollment has already staged canonical writers while owning this file's lock. A failed publication restores its snapshot. */
export async function publishSharedLedgerProjectBinding<T>(binding: SharedLedgerBinding, stageDir: string, dir: string,
  lock: LockHandle, action: () => Promise<T>): Promise<T> {
  const path = join(dir, "shared-ledger-bindings.json");
  const held = () => lock.held() && lockOwnedBy(`${path}.lock`, lock.token);
  if (!held()) throw new Error("shared ledger binding lock unavailable");
  const original = existsSync(path) ? readFileSync(path, "utf8") : null;
  const current = readSharedLedgerBindings(dir), staged = readSharedLedgerBindings(stageDir);
  requireSharedLedgerBindingAddition(binding, current, stageDir);
  const next = current.some(b => sameSharedLedgerProject(b, binding)) ? current : [...current, binding];
  if (JSON.stringify(staged) !== JSON.stringify(next)) throw new Error("staged binding changed; nothing was saved");
  return publishWithRollback(current, next, original, dir, held, action);
}

async function publishWithRollback<T>(current: SharedLedgerBinding[], next: SharedLedgerBinding[], original: string | null,
  dir: string, held: () => boolean, action: () => Promise<T>): Promise<T> {
  const path = join(dir, "shared-ledger-bindings.json");
  let changed = false;
  try {
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      changed = true;
      publishBindings(next, dir, held);
    }
    return await action();
  } catch (error) {
    if (changed) {
      if (!held()) throw new Error("shared ledger binding rollback lock lost");
      if (original === null) { if (existsSync(path)) unlinkSync(path); }
      else writeTextAtomicSync(path, original, { mode: 0o600, commitIf: held });
    }
    throw error;
  }
}

/** Exit removes exactly the approved row through the same writer; a failed later step restores the original bytes. */
export async function publishSharedLedgerProjectUnbinding<T>(binding: SharedLedgerBinding, dir: string,
  lock: LockHandle, action: () => Promise<T>): Promise<T> {
  const path = join(dir, "shared-ledger-bindings.json");
  const held = () => lock.held() && lockOwnedBy(`${path}.lock`, lock.token);
  if (!held()) throw new Error("shared ledger binding lock unavailable");
  const original = existsSync(path) ? readFileSync(path, "utf8") : null;
  const current = readSharedLedgerBindings(dir), related = current.filter(b => sameSharedLedgerProject(b, binding));
  if (related.length !== 1 || related[0]!.localProjectId !== binding.localProjectId) throw new Error("shared binding changed; 绑定已变化，请重新检查");
  return publishWithRollback(current, current.filter(b => b !== related[0]), original, dir, held, action);
}
