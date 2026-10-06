import { createHash } from "node:crypto";
import type { SharedLedgerBinding } from "./shared-ledger-gate-bindings.js";
import type { SharedLedgerProjectChoice } from "./shared-ledger-local-project.js";

export interface AuditProjectRef { centerId: string; teamId: string; projectId: string; name: string }
interface AuditLocalProject { id: string; name: string; personal: boolean }
/** Only public project identities with an owner:self person read credential enter this port; never pass bearer objects. */
export interface ProjectAuditState {
  bindings: SharedLedgerBinding[];
  credentials: AuditProjectRef[];
  projects: AuditLocalProject[];
}
type ProjectAuditStatus = "normal" | "dangling" | "duplicate" | "personal" | "unbound" | "credential-missing";
export type AuditProjectChoice = (SharedLedgerProjectChoice & { kind: "existing" })
  | { button: string; kind: "create"; name: string };
export type AuditProjectSelection = (state: ProjectAuditState, target: AuditProjectRef) => { choices: AuditProjectChoice[]; selected: string };
export interface ProjectAudit {
  target: AuditProjectRef;
  status: ProjectAuditStatus;
  expected: SharedLedgerBinding[];
  version: string;
  choices: AuditProjectChoice[];
  selected: string;
}
export const auditTargetKey = (p: Pick<AuditProjectRef, "centerId" | "teamId" | "projectId">): string =>
  JSON.stringify([p.centerId, p.teamId, p.projectId]);
export const auditRows = (rows: SharedLedgerBinding[], target: AuditProjectRef): SharedLedgerBinding[] =>
  rows.filter(b => auditTargetKey(b) === auditTargetKey(target));
/** Preserve every row and its property order: N2 must compare the exact approved rows under its lock. */
export const auditVersion = (rows: SharedLedgerBinding[]): string => createHash("sha256").update(JSON.stringify(rows)).digest("hex");

function statusOf(expected: SharedLedgerBinding[], state: ProjectAuditState, readable: boolean): ProjectAuditStatus {
  if (!expected.length) return "unbound";
  if (expected.length > 1) return "duplicate";
  const local = state.projects.find(p => p.id === (expected[0]!.localProjectId ?? expected[0]!.projectId));
  if (!local) return "dangling";
  if (local.personal) return "personal";
  return readable ? "normal" : "credential-missing";
}

/** Name matching only recommends a choice; it never creates a binding or inspects repositories/directories. */
function choicesFor(state: ProjectAuditState, target: AuditProjectRef): { choices: AuditProjectChoice[]; selected: string } {
  const eligible = state.projects.filter(p => !p.personal && !state.bindings.some(b =>
    (b.localProjectId ?? b.projectId) === p.id && auditTargetKey(b) !== auditTargetKey(target)));
  const names = new Set([target.projectId.toLowerCase(), target.name.toLowerCase()]);
  const matches = eligible.filter(p => names.has(p.id.toLowerCase()) || names.has(p.name.toLowerCase()));
  const choices: AuditProjectChoice[] = [
    { button: "sl_audit_create", kind: "create", name: target.name },
    ...eligible.map((p, i) => ({ button: `sl_audit_${i}`, kind: "existing" as const, localProjectId: p.id, name: p.name })),
  ];
  const selected = matches.length === 1 ? choices.find(c => c.kind === "existing" && c.localProjectId === matches[0]!.id)!.button : choices[0]!.button;
  return { choices, selected };
}

/** Read-only five-state migration audit, with a separate fail-closed state for missing owner credentials. */
export function auditSharedLedgerProjects(state: ProjectAuditState, select: AuditProjectSelection = choicesFor): ProjectAudit[] {
  const targets = new Map<string, AuditProjectRef>();
  for (const b of state.bindings) targets.set(auditTargetKey(b), { centerId: b.centerId, teamId: b.teamId, projectId: b.projectId, name: b.projectId });
  for (const c of state.credentials) targets.set(auditTargetKey(c), c);
  return [...targets.values()].map(target => {
    const expected = structuredClone(auditRows(state.bindings, target));
    const readable = state.credentials.some(c => auditTargetKey(c) === auditTargetKey(target));
    const status = statusOf(expected, state, readable);
    const selection = readable ? select(state, target) : { choices: [], selected: "" };
    return { target: { ...target }, status, expected, version: auditVersion(expected), ...selection };
  });
}

interface ReplaceAuditBindingsInput { expected: SharedLedgerBinding[]; next: SharedLedgerBinding }
export interface ProjectAuditMutationPorts {
  read: () => Promise<ProjectAuditState>;
  /** N4 supplies its shared create/existing selection model; the default is the isolated frozen-design fixture. */
  projectChoices?: AuditProjectSelection;
  /** N2 replaceSharedLedgerBindings only: backup 0600 + CAS + validation + replace under the bindings lock. */
  replaceSharedLedgerBindings: (input: ReplaceAuditBindingsInput) => Promise<void>;
  /** N2 project creation adapter; it must only append a non-personal local project with empty dirs. */
  createLocalProject: (target: AuditProjectRef) => Promise<string>;
}

/** Preflight precedes project creation; N2 repeats CAS/target checks under lock to close the write race. */
export async function applyProjectAuditChoice(audit: ProjectAudit, choice: AuditProjectChoice, ports: ProjectAuditMutationPorts): Promise<SharedLedgerBinding> {
  const current = await ports.read();
  if (auditVersion(auditRows(current.bindings, audit.target)) !== audit.version) throw new Error("audit_stale");
  if (!current.credentials.some(c => auditTargetKey(c) === auditTargetKey(audit.target))) throw new Error("audit_credential_missing");
  const approved = audit.choices.find(c => c.button === choice.button);
  if (!approved || JSON.stringify(approved) !== JSON.stringify(choice)) throw new Error("audit_choice_changed");
  if (choice.kind === "existing" && !choicesFor(current, audit.target).choices.some(c => c.kind === "existing" && c.localProjectId === choice.localProjectId)) {
    throw new Error("audit_target_changed");
  }
  const localProjectId = choice.kind === "existing" ? choice.localProjectId : await ports.createLocalProject(audit.target);
  const { centerId, teamId, projectId } = audit.target;
  const next = { centerId, teamId, projectId, localProjectId };
  await ports.replaceSharedLedgerBindings({ expected: structuredClone(audit.expected), next });
  const after = await ports.read(), rows = auditRows(after.bindings, audit.target);
  if (rows.length !== 1 || rows[0]!.localProjectId !== localProjectId
    || !after.projects.some(p => p.id === localProjectId && !p.personal)) throw new Error("audit_readback_failed");
  return next;
}
