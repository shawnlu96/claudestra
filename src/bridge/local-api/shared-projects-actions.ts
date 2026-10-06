import { bindHash, checkAsk } from "../../lib/ask-bind.js";
import { MASTER_PROJECT, ownerAnswered, type Ask } from "../../lib/ledger-asks.js";
import { projectChoices, selectedProject, type ProjectChoice } from "./shared-projects-choice.js";
import { requireProjectPerson, SharedProjectsError, type BootstrapPreflight, type CreatorOperation,
  type ProjectCreate, type ProjectPerson, type ProjectSelection, type SharedProjectsPorts } from "./shared-projects-ports.js";

const CREATOR = "system:shared-projects";
const APPROVE = "shared_project_confirm";
interface ProjectAction {
  kind: "create" | "complete" | "bootstrap";
  who: ProjectPerson;
  input?: ProjectCreate;
  operationId: string;
  selection?: ProjectSelection;
  choices?: ProjectChoice[];
  preflight?: BootstrapPreflight;
}
const samePerson = (a: ProjectPerson, b: ProjectPerson) =>
  a.centerId === b.centerId && a.teamId === b.teamId && a.personId === b.personId && a.instanceId === b.instanceId;
const binding = (action: ProjectAction) => ({ action: "shared_project_action", params: action, approve: [APPROVE] });

function openAction(d: SharedProjectsPorts, action: ProjectAction, title: string, context: string, select?: ReturnType<typeof projectChoices>) {
  const bind = binding(action);
  return d.openAsk({ source: "system", createdBy: CREATOR, project: MASTER_PROJECT, kind: "authorize", title, context,
    allowText: false, blocking: true, expiresAt: action.preflight?.expiresAt ?? d.now() + 3600_000,
    bind: { ...bind, paramsHash: bindHash(bind, CREATOR) }, extra: { sharedProjectAction: true,
      ...(select ? { sharedProjectChoice: { selectId: select.row.type === "select" ? select.row.id : "", recommended: select.recommended } } : {}) },
    options: [...(select ? [select.row] : []), { type: "buttons", buttons: [
      { id: APPROVE, label: action.kind === "create" ? "建" : action.kind === "bootstrap" ? "确认团队 owner" : "继续完成项目", style: "success" },
      { id: "shared_project_cancel", label: "取消", style: "secondary" },
    ] }],
  });
}

/** A PM may propose parameters only. Opening this card never calls the center's create endpoint. */
export async function proposeSharedProject(input: ProjectCreate, d: SharedProjectsPorts): Promise<Ask> {
  const who = await d.person();
  requireProjectPerson(who);
  return openAction(d, { kind: "create", who, input, operationId: input.operationId },
    `建议新建团队项目 ${input.name}`, `中心 ${who.centerId}；团队 ${who.teamId}；本人 ${who.personId}；实例 ${who.instanceId}`);
}

function requireOperation(who: ProjectPerson, operation: CreatorOperation, operationId: string) {
  if (operation.operationId !== operationId || operation.project.centerId !== who.centerId || operation.project.teamId !== who.teamId) {
    throw new SharedProjectsError(403, "operation_mismatch");
  }
}

async function recoveryCard(d: SharedProjectsPorts, who: ProjectPerson, operationId: string, selection?: ProjectSelection) {
  const ask = openAction(d, { kind: "complete", who, operationId, ...(selection ? { selection } : {}) },
    "继续完成项目", "中心操作结果或本机完成状态待确认；点击后查询同一操作并继续，不重复建项目。");
  return { ok: true, available: false, operationId, askId: ask.id };
}

/** The only success path reads the saved B credential, then binds, then reads B through the gate proxy. */
export async function completeSharedProject(who: ProjectPerson, operationId: string, selection: ProjectSelection | undefined,
  d: SharedProjectsPorts, created?: CreatorOperation): Promise<Record<string, unknown>> {
  try {
    const operation = created ?? await d.operation(who, operationId);
    requireOperation(who, operation, operationId);
    if (!await d.credentialSaved(who, operation.project)) await d.saveCreatorCredential(who, operation);
    if (!await d.credentialSaved(who, operation.project)) throw new SharedProjectsError(503, "credential_not_saved");
    if (!selection) {
      const select = projectChoices(operation.project, await d.eligible(), d.bindings());
      const ask = openAction(d, { kind: "complete", who, operationId, choices: select.choices }, "选择本机项目", "本人凭据已保存；选择本机项目后继续完成。", select);
      return { ok: true, available: false, operationId, askId: ask.id };
    }
    const bound = d.bindings().filter(b => b.centerId === who.centerId && b.teamId === who.teamId && b.projectId === operation.project.projectId);
    if (bound.length > 1) throw new SharedProjectsError(409, "binding_conflict");
    const existing = bound[0] && (bound[0].localProjectId ?? bound[0].projectId);
    if (existing && selection.mode === "existing" && selection.localProjectId !== existing) throw new SharedProjectsError(409, "binding_conflict");
    const localProjectId = existing ?? await d.bind(who, operation.project, selection);
    if (!await d.gateRead(who, operation.project, localProjectId)) throw new SharedProjectsError(503, "gate_read_failed");
    return { ok: true, available: true, operationId, projectId: operation.project.projectId, localProjectId };
  } catch {
    // Center, credential and filesystem exceptions can contain bearer/code material; only the recovery card is public.
    return recoveryCard(d, who, operationId, selection);
  }
}

export async function createSharedProject(input: ProjectCreate, d: SharedProjectsPorts): Promise<Record<string, unknown>> {
  const who = await d.person();
  requireProjectPerson(who);
  try {
    const operation = await d.create(who, input);
    return completeSharedProject(who, input.operationId, input.selection, d, operation);
  } catch (error) {
    if (error instanceof SharedProjectsError && error.status < 500) throw error;
    // A lost response may already have committed: recover by the original operationId rather than creating again.
    return recoveryCard(d, who, input.operationId, input.selection);
  }
}

/** A local owner is not automatically a deployment owner; execution stays behind the explicitly approved executor port. */
export async function bootstrapSharedProject(operationId: string, d: SharedProjectsPorts): Promise<Ask> {
  if (!await d.deploymentAuthorized()) throw new SharedProjectsError(403, "deployment_authorization_required");
  const who = await d.person();
  requireProjectPerson(who);
  const p = await d.preflight(who, operationId);
  requirePreflight(who, operationId, p, d.now());
  return openAction(d, { kind: "bootstrap", who, operationId, preflight: p }, "确认团队 owner",
    `中心 ${p.centerId}；团队 ${p.teamId}；本人 ${p.personId}；实例 ${p.instanceId}\n实例公钥摘要 ${p.instanceKeyDigest}\n预检摘要 ${p.summaryDigest}`);
}
function requirePreflight(who: ProjectPerson, operationId: string, p: BootstrapPreflight, now: number) {
  if (!samePerson(who, { ...who, ...p }) || p.operationId !== operationId || p.expiresAt <= now || p.ownerCount !== 0 || !p.memberActive
    || !/^[a-f0-9]{64}$/.test(p.instanceKeyDigest) || !/^[a-f0-9]{64}$/.test(p.summaryDigest)) {
    throw new SharedProjectsError(403, "bootstrap_preflight_rejected");
  }
}
const running = new Set<string>();
/** Ask parameters, owner identity and expiry are rechecked even when the caller bypasses the HTTP UI. */
export async function answerSharedProject(a: Ask, d: SharedProjectsPorts): Promise<Record<string, unknown> | null> {
  if (a.createdBy !== CREATOR || a.extra.sharedProjectAction !== true || a.state !== "answered") return null;
  const action = a.bind?.params as ProjectAction | undefined;
  if (!action || !a.bind || bindHash(a.bind, CREATOR) !== a.bind.paramsHash || !ownerAnswered(a.answer)
    || !checkAsk({ ...a, fromAgent: CREATOR }, bindHash(binding(action), CREATOR), CREATOR, d.now()).ok) {
    throw new SharedProjectsError(403, "ask_check_failed");
  }
  if (running.has(a.id)) throw new SharedProjectsError(409, "operation_in_progress");
  running.add(a.id);
  try {
    const who = await d.person();
    requireProjectPerson(who);
    if (!samePerson(who, action.who)) throw new SharedProjectsError(403, "person_changed");
    if (action.kind === "bootstrap") {
      if (!await d.deploymentAuthorized() || !action.preflight) throw new SharedProjectsError(403, "deployment_authorization_required");
      requirePreflight(who, action.operationId, action.preflight, d.now());
      await d.confirmOwner(who, action.preflight);
      return { ok: true };
    }
    if (action.kind === "create" && action.input) return createSharedProject(action.input, d);
    if (action.kind !== "complete") throw new SharedProjectsError(400, "invalid_action");
    const selection = action.choices ? selectedProject(a.answer?.choices ?? [], action.choices) : action.selection;
    if (action.choices && !selection) throw new SharedProjectsError(400, "local_project_required");
    return completeSharedProject(who, action.operationId, selection ?? undefined, d);
  } finally { running.delete(a.id); }
}
