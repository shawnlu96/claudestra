import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLock, type LockHandle } from "./file-lock.js";
import { writeTextAtomicSync } from "./state-file.js";
import { writeProjects } from "./projects.js";
import { readSharedLedgerBindings, setSharedLedgerBinding, type SharedLedgerBinding } from "./shared-ledger-gate-bindings.js";
import { resolveSharedLedgerCredential, writeSharedLedgerCredential, type SharedLedgerLocalCredential } from "./shared-ledger-mode.js";
import { sharedLedgerJoinPinsMatch } from "./shared-ledger-gate-proxy-join-pins.js";
import { newSharedLedgerProject, readSharedLedgerProjects, requireSharedLedgerProject, type SharedLedgerProjectDisplay } from "./shared-ledger-project-link.js";
import { STATE_DIR } from "./paths.js";

/** All local project mutations and enrollment use the binding lock, before any credential-file lock. */
export async function withSharedLedgerProjectMutation<T>(action: () => Promise<T>, dir = STATE_DIR): Promise<T> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = await acquireLock(join(dir, "shared-ledger-bindings.json.lock"));
  if (!lock) throw new Error("shared ledger binding lock unavailable");
  try { return await action(); } finally { lock.release(); }
}

type Snapshot = { name: string; text: string | null; mode: number };
const FILES = ["projects.json", "shared-ledger-bindings.json", "shared-ledger-credentials.json"];

/** Stage through the canonical writers, then publish credentials last. Ordinary failures restore exact original bytes. */
async function saveLocked(credential: SharedLedgerLocalCredential, binding: SharedLedgerBinding, display: SharedLedgerProjectDisplay | undefined,
  dir: string, held: () => boolean): Promise<{ localProjectId: string; identities: number }> {
  const snapshots: Snapshot[] = FILES.map(name => {
    const path = join(dir, name);
    return { name, text: existsSync(path) ? readFileSync(path, "utf8") : null,
      mode: existsSync(path) ? statSync(path).mode & 0o777 : 0o600 };
  });
  const stage = mkdtempSync(join(dir, ".shared-project-"));
  try {
    for (const s of snapshots) if (s.text !== null) writeFileSync(join(stage, s.name), s.text, { mode: s.mode });
    const created = display ? newSharedLedgerProject(display, dir) : undefined;
    const localProjectId = created?.id ?? binding.localProjectId!;
    if (created) {
      const data = readSharedLedgerProjects(dir);
      data.projects.push(created);
      await writeProjects(data, join(stage, "projects.json"));
    } else requireSharedLedgerProject(localProjectId, dir);
    if (!sharedLedgerJoinPinsMatch(credential, localProjectId, binding.projectId, dir)) throw new Error("center or project does not match pinned center");
    // Validate every existing credential (including permissions) before staging its replacement.
    resolveSharedLedgerCredential(credential.localSubject, credential.kind, binding.centerId, binding.teamId, binding.projectId, "read", dir);
    await setSharedLedgerBinding({ ...binding, localProjectId }, stage);
    await writeSharedLedgerCredential(credential, stage);
    const identities = readSharedLedgerBindings(stage).filter(b => resolveSharedLedgerCredential(credential.localSubject, credential.kind,
      b.centerId, b.teamId, b.projectId, "read", stage)).length;
    if (!resolveSharedLedgerCredential(credential.localSubject, credential.kind, binding.centerId, binding.teamId, binding.projectId, "read", stage)) {
      throw new Error("local identity did not read back");
    }
    const changed: Snapshot[] = [];
    try {
      for (const s of snapshots) {
        if (s.name === "projects.json" && !created) continue;
        writeTextAtomicSync(join(dir, s.name), readFileSync(join(stage, s.name), "utf8"), { mode: 0o600, commitIf: held });
        changed.push(s);
      }
    } catch (error) {
      for (const s of changed.reverse()) {
        if (s.text === null) rmSync(join(dir, s.name));
        else writeTextAtomicSync(join(dir, s.name), s.text, { mode: s.mode });
      }
      throw error;
    }
    return { localProjectId, identities };
  } finally {
    try { rmSync(stage, { recursive: true, force: true }); }
    catch { console.error("shared project staging cleanup failed"); } // A committed enrollment must not report failure because cleanup failed.
  }
}

export async function saveSharedLedgerProjectJoin(credential: SharedLedgerLocalCredential, binding: SharedLedgerBinding,
  display: SharedLedgerProjectDisplay | undefined, dir = STATE_DIR): Promise<{ localProjectId: string; identities: number }> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const locks: LockHandle[] = [];
  try {
    for (const file of ["shared-ledger-bindings.json", "shared-ledger-credentials.json"]) {
      const lock = await acquireLock(join(dir, `${file}.lock`));
      if (!lock) throw new Error("shared ledger state lock unavailable");
      locks.push(lock);
    }
    return await saveLocked(credential, binding, display, dir, () => locks.every(lock => lock.held()));
  } finally { for (const lock of locks.reverse()) lock.release(); }
}
