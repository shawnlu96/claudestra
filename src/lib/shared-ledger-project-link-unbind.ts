import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LockHandle } from "./file-lock.js";
import { writeTextAtomicSync } from "./state-file.js";
import { STATE_DIR } from "./paths.js";
import { newSharedLedgerBindingGeneration, publishSharedLedgerProjectUnbinding, readSharedLedgerBindings, SHARED_LEDGER_BINDING_GENERATION,
  type SharedLedgerBinding } from "./shared-ledger-gate-bindings.js";
import { resolveSharedLedgerCredential, type SharedLedgerLocalCredential } from "./shared-ledger-mode.js";
import { sameSharedLedgerProject, sharedLedgerBindingLocalId } from "./shared-ledger-project-link-target.js";
import { snapshotSharedLedgerState, withSharedLedgerStateLocks, type SharedLedgerStateSnapshot } from "./shared-ledger-project-link-save.js";

/** What the authenticated local owner approved on the exit card; version pins the binding lifecycle generation and both security files' exact bytes. */
export interface SharedLedgerProjectUnbindApproval {
  centerId: string; teamId: string; projectId: string; localProjectId: string; personId: string; instanceId: string; version: string;
}
export interface SharedLedgerProjectUnbindResult { binding: SharedLedgerBinding; revokedPermissions: number }

const OWNER = "owner:self";
const BINDINGS = "shared-ledger-bindings.json", CREDENTIALS = "shared-ledger-credentials.json", JOURNAL = "shared-ledger-project-unbind.json";
const GENERATION = SHARED_LEDGER_BINDING_GENERATION, JOURNALED = [BINDINGS, CREDENTIALS, GENERATION];
const FIELDS = ["centerId", "teamId", "projectId", "localProjectId", "personId", "instanceId", "version"] as const;
const ACTIONS = ["read", "plan", "import", "project"] as const;
const validId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const changed = () => new Error("shared binding changed; 绑定已变化，请重新检查");

type Journal = { files: { name: string; before: string | null; after: string | null; mode: number }[] };
type Located = { approval: SharedLedgerProjectUnbindApproval; binding: SharedLedgerBinding; credentials: string | null; revoked: number };

/** Content alone repeats after A->B->A rebinding; the never-reused generation does not. Unknown generation bytes refuse. */
function version(dir: string, bindings: SharedLedgerStateSnapshot, credentials: SharedLedgerStateSnapshot): string {
  const generation = snapshotSharedLedgerState(GENERATION, dir);
  if (generation.text !== null) {
    const parsed = (() => { try { return JSON.parse(generation.text!) as unknown; } catch { return null; } })();
    if (generation.mode !== 0o600 || !parsed || typeof parsed !== "object" || Object.keys(parsed).join() !== "generation"
      || !/^[0-9a-f-]{36}$/.test(String((parsed as { generation: unknown }).generation))) {
      throw new Error("invalid shared binding generation; nothing was changed");
    }
  }
  return "v2:" + createHash("sha256").update(JSON.stringify([generation.text, bindings.text, credentials.text])).digest("hex");
}

/** Read-only: every check happens again under both locks; unknown or ambiguous state never produces a card. */
function locate(localProjectId: string, dir: string): Located {
  if (existsSync(join(dir, JOURNAL))) throw new Error("shared ledger unbind pending reconciliation; nothing was changed");
  const bindingsFile = snapshotSharedLedgerState(BINDINGS, dir), credentialsFile = snapshotSharedLedgerState(CREDENTIALS, dir);
  const rows = readSharedLedgerBindings(dir), local = rows.filter(b => sharedLedgerBindingLocalId(b) === localProjectId);
  if (local.length !== 1) throw new Error("local project is not bound to one shared project; nothing was changed");
  const binding = local[0]!;
  if (rows.filter(b => sameSharedLedgerProject(b, binding)).length !== 1) throw new Error("shared project has ambiguous bindings; nothing was changed");
  // Validates the whole credential file and its 0600 mode before any byte is interpreted below.
  if (!ACTIONS.some(a => resolveSharedLedgerCredential(OWNER, "person", binding.centerId, binding.teamId, binding.projectId, a, dir))) {
    throw new Error("本机 owner 没有该共享项目的 person 权限；nothing was changed");
  }
  const state = JSON.parse(credentialsFile.text!) as { credentials: SharedLedgerLocalCredential[] };
  const mine = (c: SharedLedgerLocalCredential) => c.localSubject === OWNER && c.kind === "person"
    && c.centerId === binding.centerId && c.teamId === binding.teamId && c.projects.some(p => p.projectId === binding.projectId);
  const people = new Set(state.credentials.filter(mine).map(c => JSON.stringify([c.personId, c.instanceId])));
  if (people.size !== 1) throw new Error("本机 person 身份不唯一；nothing was changed");
  const [personId, instanceId] = JSON.parse([...people][0]!) as [string, string];
  let revoked = 0;
  state.credentials = state.credentials.map(c => {
    if (!mine(c)) return c;
    revoked++;
    return { ...c, projects: c.projects.filter(p => p.projectId !== binding.projectId) };
  }).filter(c => c.projects.length > 0);
  return { binding, revoked, credentials: JSON.stringify(state, null, 2), approval: { centerId: binding.centerId, teamId: binding.teamId,
    projectId: binding.projectId, localProjectId, personId, instanceId, version: version(dir, bindingsFile, credentialsFile) } };
}

/** The exit card N4 shows to the authenticated local owner. Reads only; approval goes to unbindSharedLedgerProject unchanged. */
export function sharedLedgerProjectUnbindCard(localProjectId: string, dir = STATE_DIR): SharedLedgerProjectUnbindApproval {
  if (!validId(localProjectId)) throw new Error("invalid local project");
  return locate(localProjectId, dir).approval;
}

function readJournal(dir: string): Journal | null {
  const path = join(dir, JOURNAL);
  if (!existsSync(path)) return null;
  const journal = (() => { try { return JSON.parse(snapshotSharedLedgerState(JOURNAL, dir).text!) as Journal; } catch { return null; } })();
  const valid = journal && Array.isArray(journal.files) && journal.files.length === JOURNALED.length && journal.files.every((f, i) => f.name === JOURNALED[i]
    && [f.before, f.after].every(t => t === null || typeof t === "string") && (f.mode === 0o600));
  if (!valid) throw new Error("shared ledger unbind journal invalid; owner review required");
  return journal;
}

/** Restart reconciliation: an interrupted exit returns to its exact pre-exit bytes, or refuses if anything else moved since. */
function recoverLocked(dir: string, held: () => boolean): "clean" | "restored" {
  const journal = readJournal(dir);
  if (!journal) return "clean";
  const current = journal.files.map(f => snapshotSharedLedgerState(f.name, dir).text);
  if (journal.files.some((f, i) => current[i] !== f.before && current[i] !== f.after)) {
    throw new Error("shared ledger unbind recovery conflict; owner review required");
  }
  for (const [i, f] of journal.files.entries()) {
    if (current[i] === f.before) continue;
    if (!held()) throw new Error("shared ledger state lock lost");
    if (f.before === null) unlinkSync(join(dir, f.name));
    else writeTextAtomicSync(join(dir, f.name), f.before, { mode: f.mode, commitIf: held });
  }
  if (journal.files.some(f => snapshotSharedLedgerState(f.name, dir).text !== f.before)) throw new Error("shared ledger state did not read back");
  unlinkSync(join(dir, JOURNAL));
  return "restored";
}

export async function recoverSharedLedgerProjectUnbind(dir = STATE_DIR): Promise<"clean" | "restored"> {
  return withSharedLedgerStateLocks(dir, async locks => recoverLocked(dir, () => locks.every(lock => lock.held())));
}

function requireApproval(value: SharedLedgerProjectUnbindApproval): void {
  const keys = value && typeof value === "object" ? Object.keys(value) : [];
  if (keys.length !== FIELDS.length || !FIELDS.every(k => keys.includes(k)) || !FIELDS.slice(0, -1).every(k => validId(value[k]))
    || !/^v2:[0-9a-f]{64}$/.test(String(value.version))) throw new Error("invalid unbind approval; nothing was changed");
}

function credentialsPermit(binding: SharedLedgerBinding, dir: string): boolean {
  return ACTIONS.some(a => resolveSharedLedgerCredential(OWNER, "person", binding.centerId, binding.teamId, binding.projectId, a, dir));
}

async function unbindLocked(approval: SharedLedgerProjectUnbindApproval, dir: string, locks: LockHandle[]): Promise<SharedLedgerProjectUnbindResult> {
  const held = () => locks.every(lock => lock.held());
  recoverLocked(dir, held);
  const before = JOURNALED.map(name => snapshotSharedLedgerState(name, dir));
  if (version(dir, before[0]!, before[1]!) !== approval.version) throw changed();
  const located = locate(approval.localProjectId, dir);
  if (FIELDS.some(k => located.approval[k] !== approval[k])) throw changed();
  const { binding } = located, rest = readSharedLedgerBindings(dir).filter(b => sharedLedgerBindingLocalId(b) !== approval.localProjectId);
  const stage = mkdtempSync(join(dir, ".shared-project-unbind-"));
  try {
    writeFileSync(join(stage, CREDENTIALS), located.credentials!, { mode: 0o600 });
    if (credentialsPermit(binding, stage)) throw new Error("local permission did not stage; nothing was changed");
    const generation = newSharedLedgerBindingGeneration(), after = [JSON.stringify(rest, null, 2), located.credentials, generation];
    const journal: Journal = { files: before.map((s, i) => ({ name: s.name, before: s.text, after: after[i]!, mode: 0o600 })) };
    writeTextAtomicSync(join(dir, JOURNAL), JSON.stringify(journal), { mode: 0o600, commitIf: held });
    try {
      return await publishSharedLedgerProjectUnbinding(binding, generation, dir, locks[0]!, async () => {
        let published = false;
        try {
          writeTextAtomicSync(join(dir, CREDENTIALS), located.credentials!, { mode: 0o600, commitIf: held });
          published = true;
          if (credentialsPermit(binding, dir) || JSON.stringify(readSharedLedgerBindings(dir)) !== JSON.stringify(rest)
            || snapshotSharedLedgerState(GENERATION, dir).text !== generation) {
            throw new Error("local exit did not read back");
          }
          unlinkSync(join(dir, JOURNAL));
          return { binding, revokedPermissions: located.revoked };
        } catch (error) {
          if (published) {
            if (!held()) throw new Error("shared ledger credential rollback lock lost");
            writeTextAtomicSync(join(dir, CREDENTIALS), before[1]!.text!, { mode: before[1]!.mode, commitIf: held });
          }
          throw error;
        }
      });
    } catch (error) {
      // Both files are back at their snapshots here unless rollback itself failed; the journal then stays for restart reconciliation.
      try { recoverLocked(dir, held); } catch { console.error("shared ledger unbind left a journal for restart reconciliation"); }
      throw error;
    }
  } finally {
    try { rmSync(stage, { recursive: true, force: true }); }
    catch { console.error("shared project unbind staging cleanup failed"); } // A committed exit must not report failure because cleanup failed.
  }
}

/**
 * The only local exit: removes exactly the approved mapping and that person's local permission for this project.
 * Other bindings, members, service credentials, the local project, its directories and agents stay byte-identical.
 * Callers authenticate the local owner first; this API adds no second identity gate.
 */
export async function unbindSharedLedgerProject(approval: SharedLedgerProjectUnbindApproval, dir = STATE_DIR): Promise<SharedLedgerProjectUnbindResult> {
  requireApproval(approval);
  return withSharedLedgerStateLocks(dir, locks => unbindLocked({ ...approval }, dir, locks));
}
