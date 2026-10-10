/**
 * N6W: production composition of the shared project audit (N6 controller) with the real N2/N4 ports.
 * ask-entry.ts installs the hook synchronously before initJoinOffers(), so the first maintenance tick already
 * takes the new audit and the legacy rebind sweep never runs alongside it (shared-ledger-join-offer.ts setSharedProjectAuditHook).
 */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isPersonalProject } from "../lib/lend-policy.js";
import { closeAsk, listAsks, MASTER_PROJECT } from "../lib/ledger-asks.js";
import { STATE_DIR } from "../lib/paths.js";
import { writeProjects } from "../lib/projects.js";
import {
  readSharedLedgerBindings, replaceSharedLedgerBindings, SHARED_LEDGER_BINDING_GENERATION,
} from "../lib/shared-ledger-gate-bindings.js";
import { sharedLedgerJoinPinsMatch } from "../lib/shared-ledger-gate-proxy-join-pins.js";
import { resolveSharedLedgerCredential } from "../lib/shared-ledger-mode.js";
import {
  auditTargetKey, type AuditProjectRef, type AuditProjectSelection, type ProjectAuditMutationPorts, type ProjectAuditState,
} from "../lib/shared-ledger-project-audit.js";
import { withSharedLedgerProjectMutation } from "../lib/shared-ledger-project-link-save.js";
import { newSharedLedgerProject, readSharedLedgerProjects, sameSharedLedgerProject } from "../lib/shared-ledger-project-link-target.js";
import { readJsonStateSync } from "../lib/state-file.js";
import { askDb, askReadDb, publishAsk } from "./asks.js";
import { projectChoices } from "./local-api/shared-projects-choice.js";
import { joinOfferLiveDeps, setSharedProjectAuditHook } from "./shared-ledger-join-offer.js";
import { initSharedLedgerProjectAudit } from "./shared-ledger-project-audit-runtime.js";

export type SharedLedgerProjectAuditWiringPorts = ProjectAuditMutationPorts & { inform: (text: string) => Promise<void> };
const LEGACY_REBIND_CREATOR = "system:shared-ledger-rebind";
const LEGACY_RETIRED = "共享项目核对已接管改绑";
const INIT_FAILED = "共享项目核对启动失败，下一分钟重试。";

/** Public owner:self person read identities only; every one is confirmed by N2's resolver and no bearer leaves this function. */
function ownerReadProjects(dir: string): AuditProjectRef[] {
  const file = readJsonStateSync(join(dir, "shared-ledger-credentials.json"), v => Array.isArray((v as { credentials?: unknown } | null)?.credentials));
  if (file.status === "missing") return [];
  if (file.status !== "ok") throw new Error("invalid shared ledger credentials");
  const refs = new Map<string, AuditProjectRef>();
  for (const c of (file.data as { credentials: { localSubject?: unknown; kind?: unknown; centerId?: unknown; teamId?: unknown; projects?: unknown }[] }).credentials) {
    if (c?.localSubject !== "owner:self" || c.kind !== "person" || typeof c.centerId !== "string" || typeof c.teamId !== "string" || !Array.isArray(c.projects)) continue;
    for (const p of c.projects as { projectId?: unknown; actions?: unknown }[]) {
      if (typeof p?.projectId !== "string" || !Array.isArray(p.actions) || !p.actions.includes("read")) continue;
      const ref = { centerId: c.centerId, teamId: c.teamId, projectId: p.projectId, name: p.projectId };
      if (resolveSharedLedgerCredential("owner:self", "person", ref.centerId, ref.teamId, ref.projectId, "read", dir)) refs.set(auditTargetKey(ref), ref);
    }
  }
  return [...refs.values()];
}

/** N4's selection model; the target's own rows are ignored so duplicate bindings keep their original candidates. */
const n4ProjectChoices: AuditProjectSelection = (state, target) => {
  const n4 = projectChoices({ teamId: target.teamId, projectId: target.projectId, name: target.name },
    state.projects.filter(p => !p.personal), state.bindings.filter(b => !sameSharedLedgerProject(b, target)));
  return {
    choices: n4.choices.map(c => c.selection.mode === "existing"
      ? { button: `sl_audit_${c.value}`, kind: "existing" as const, localProjectId: c.selection.localProjectId, name: c.name }
      : { button: `sl_audit_${c.value}`, kind: "create" as const, name: target.name }),
    selected: `sl_audit_${n4.recommended}`,
  };
};

type BindingsSnapshot = { backups: Set<string>; bindings: string | null; generation: string | null };
const BINDINGS = "shared-ledger-bindings.json";
const readOrNull = (path: string): string | null => existsSync(path) ? readFileSync(path, "utf8") : null;
function bindingsSnapshot(dir: string): BindingsSnapshot {
  return { backups: new Set(readdirSync(dir).filter(f => f.startsWith(`${BINDINGS}.bak-`))),
    bindings: readOrNull(join(dir, BINDINGS)), generation: readOrNull(join(dir, SHARED_LEDGER_BINDING_GENERATION)) };
}
/**
 * N2 leaves a partial .bak-* behind when its backup write fails (ENOSPC/EIO). Cleanup allocates nothing (no lock dir/owner:
 * the disk may still be full). Candidates are listed first; each came from a writer that held the lock before the listing,
 * so once the lock is free all have released, and unchanged bindings + generation prove none published (residue only).
 */
async function dropUnfinishedBackups(dir: string, seen: BindingsSnapshot): Promise<void> {
  try {
    const candidates = [...bindingsSnapshot(dir).backups].filter(f => !seen.backups.has(f));
    if (!candidates.length) return;
    for (const deadline = Date.now() + 2_000; existsSync(join(dir, `${BINDINGS}.lock`));) {
      if (Date.now() >= deadline) return;
      await new Promise(r => setTimeout(r, 25));
    }
    const now = bindingsSnapshot(dir);
    if (now.bindings === seen.bindings && now.generation === seen.generation) for (const f of candidates) rmSync(join(dir, f), { force: true });
  } catch { /* Best effort: the original N2 error is what the caller reports. */ }
}

/** Real ports over one state directory: N2 reader/writer, N4 choices, N2 project mutation lock and the join-offer inform card. */
export function sharedLedgerProjectAuditPorts(dir = STATE_DIR): SharedLedgerProjectAuditWiringPorts {
  return {
    read: async (): Promise<ProjectAuditState> => {
      const bindings = readSharedLedgerBindings(dir), credentials = ownerReadProjects(dir);
      if (!bindings.length && !credentials.length) return { bindings: [], credentials: [], projects: [] };
      const projects = readSharedLedgerProjects(dir).projects.map(p => ({ id: p.id, name: p.name, personal: isPersonalProject(p) }));
      return { bindings, credentials, projects };
    },
    projectChoices: n4ProjectChoices,
    replaceSharedLedgerBindings: async input => {
      let seen = null as BindingsSnapshot | null;
      try {
        await replaceSharedLedgerBindings(input, dir, current => {
          const { centerId, teamId, projectId, localProjectId } = input.next;
          const credential = resolveSharedLedgerCredential("owner:self", "person", centerId, teamId, projectId, "read", dir);
          if (!credential) throw new Error("本机 owner 缺少该共享项目的读取凭据");
          if (!localProjectId || !sharedLedgerJoinPinsMatch(credential, localProjectId, projectId, dir,
            current.filter(b => !sameSharedLedgerProject(b, input.next)))) throw new Error("所选项目或中心与已有 pins 不符");
          seen = bindingsSnapshot(dir); // Under N2's lock, just before its backup write.
        });
      } catch (e) { if (seen) await dropUnfinishedBackups(dir, seen); throw e; }
    },
    createLocalProject: target => withSharedLedgerProjectMutation(async () => {
      const data = readSharedLedgerProjects(dir);
      const project = newSharedLedgerProject({ teamId: target.teamId, projectId: target.projectId, name: target.name }, dir);
      data.projects.push(project);
      await writeProjects(data, join(dir, "projects.json"));
      return project.id;
    }, dir),
    inform: text => joinOfferLiveDeps.inform(text),
  };
}

/** Legacy open rebind cards are cancelled once; answered-but-unsettled ones are left unexecuted (the hook disables their handler). */
function retireLegacyRebindCards(): void {
  const db = askReadDb();
  const open = db ? listAsks(db, { project: MASTER_PROJECT, source: "system", states: ["open"] }).filter(a => a.createdBy === LEGACY_REBIND_CREATOR) : [];
  for (const a of open) {
    const closed = closeAsk(askDb(), a.id, "cancelled", LEGACY_RETIRED);
    if (closed) publishAsk(closed);
  }
}

/** Lazy controller: the first call initializes (that is the tick's one scan); a failed init is dropped and retried on the next tick. */
export function sharedLedgerProjectAuditHook(ports: SharedLedgerProjectAuditWiringPorts = sharedLedgerProjectAuditPorts()) {
  let runtime: Promise<{ afterJoin: () => Promise<void>; stop: () => void }> | null = null;
  const hook = async (): Promise<void> => {
    if (runtime) return (await runtime).afterJoin();
    const starting = runtime = (async () => { retireLegacyRebindCards(); return initSharedLedgerProjectAudit(ports); })();
    try { await starting; }
    catch {
      if (runtime === starting) runtime = null;
      console.error(INIT_FAILED); // Fixed text: reader/writer errors may carry paths.
    }
  };
  const stop = (): void => { void runtime?.then(r => r.stop(), () => {}); runtime = null; };
  return Object.assign(hook, { stop });
}

/** Synchronous: only installs the hook; no state, ledger or network I/O happens until the first maintenance tick. */
export function installSharedLedgerProjectAudit(ports?: SharedLedgerProjectAuditWiringPorts): void {
  setSharedProjectAuditHook(sharedLedgerProjectAuditHook(ports));
}
