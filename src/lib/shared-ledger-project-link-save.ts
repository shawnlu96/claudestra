import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLock, type LockHandle } from "./file-lock.js";
import { writeTextAtomicSync } from "./state-file.js";
import { writeProjects } from "./projects.js";
import { readSharedLedgerBindings, setSharedLedgerBinding, publishSharedLedgerProjectBinding, type SharedLedgerBinding } from "./shared-ledger-gate-bindings.js";
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

/** Stage through canonical writers; publish security files transactionally, then create through writeProjects last. */
async function saveLocked(credential: SharedLedgerLocalCredential, binding: SharedLedgerBinding, display: SharedLedgerProjectDisplay | undefined,
  dir: string, locks: LockHandle[]): Promise<{ localProjectId: string; identities: number }> {
  const snapshots: Snapshot[] = FILES.map(name => {
    const path = join(dir, name);
    const bytes = existsSync(path) ? readFileSync(path) : null;
    const text = bytes?.toString("utf8") ?? null;
    if (bytes && !Buffer.from(text!).equals(bytes)) throw new Error("invalid local UTF-8 state; nothing was saved");
    return { name, text, mode: existsSync(path) ? statSync(path).mode & 0o777 : 0o600 };
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
    const held = () => locks.every(lock => lock.held());
    return await publishSharedLedgerProjectBinding({ ...binding, localProjectId }, stage, dir, locks[0]!, async () => {
      const original = snapshots.find(s => s.name === "shared-ledger-credentials.json")!;
      let published = false;
      try {
        writeTextAtomicSync(join(dir, original.name), readFileSync(join(stage, original.name), "utf8"), { mode: 0o600, commitIf: held });
        published = true;
        if (!resolveSharedLedgerCredential(credential.localSubject, credential.kind, binding.centerId, binding.teamId, binding.projectId, "read", dir)) {
          throw new Error("local identity did not read back");
        }
        if (!held()) throw new Error("shared ledger state lock lost");
        // Project creation commits last through the existing writer. No fallible step follows a successful rename.
        if (created) await writeProjects(readSharedLedgerProjects(stage), join(dir, "projects.json"));
        return { localProjectId, identities };
      } catch (error) {
        if (published) {
          if (!held()) throw new Error("shared ledger credential rollback lock lost");
          if (original.text === null) rmSync(join(dir, original.name));
          else writeTextAtomicSync(join(dir, original.name), original.text, { mode: original.mode, commitIf: held });
        }
        throw error;
      }
    });
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
    return await saveLocked(credential, binding, display, dir, locks);
  } finally { for (const lock of locks.reverse()) lock.release(); }
}
