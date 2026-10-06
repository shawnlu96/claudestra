import { parseV2ProjectsResponse } from "../../lib/shared-ledger-contract-v2-projects.js";
import { bindHash, checkAsk } from "../../lib/ask-bind.js";
import { MASTER_PROJECT, ownerAnswered, type Ask } from "../../lib/ledger-asks.js";
import { projectChoices, selectedProject, sharedProjectCardDigest, type ProjectChoice } from "./shared-projects-choice.js";
import { requireProjectPerson, SharedProjectsError, type BootstrapPreflight, type CreatorOperation,
  type ProjectInviteApproval, type ProjectCreate, type ProjectPerson, type ProjectSelection, type SharedProjectsPorts } from "./shared-projects-ports.js";

const CREATOR = "system:shared-projects";
const APPROVE = "shared_project_confirm";
export interface ProjectAction {
  kind: "create" | "complete" | "bootstrap" | "invite";
  who: ProjectPerson;
  input?: ProjectCreate;
  operationId: string;
  selection?: ProjectSelection;
  choices?: ProjectChoice[];
  preflight?: BootstrapPreflight;
  expectedDigest?: string;
  completedLocalProjectId?: string;
  cardDigest?: string;
  invitation?: ProjectInviteApproval;
}
const samePerson = (a: ProjectPerson, b: ProjectPerson) =>
  a.centerId === b.centerId && a.teamId === b.teamId && a.personId === b.personId && a.instanceId === b.instanceId && JSON.stringify(a.sourceBinding) === JSON.stringify(b.sourceBinding);
const binding = (action: ProjectAction) => ({ action: "shared_project_action", params: action, approve: [APPROVE] });

export function openSharedProjectAction(d: SharedProjectsPorts, action: ProjectAction, title: string, context: string, select?: ReturnType<typeof projectChoices>) {
  context += `
参数摘要：${bindHash(binding(action), CREATOR)}`;
  context += `
中心 ${action.who.centerId}；团队 ${action.who.teamId}；本人 ${action.who.personId}；实例 ${action.who.instanceId}`;
  if (action.who.sourceBinding) context += `
原鉴权绑定：${action.who.sourceBinding.projectId} / ${action.who.sourceBinding.localProjectId ?? action.who.sourceBinding.projectId}`;
  if (action.completedLocalProjectId) context += `
已绑定本机项目：${action.completedLocalProjectId}`;
  const options: Ask["options"] = [...(select ? [select.row] : []), { type: "buttons", buttons: [
    { id: APPROVE, label: action.kind === "create" ? "建" : action.kind === "bootstrap" ? "确认团队 owner" : action.kind === "invite" ? "发送邀请" : "继续完成项目", style: "success" },
    { id: "shared_project_cancel", label: "取消", style: "secondary" },
  ] }];
  action = { ...action, cardDigest: sharedProjectCardDigest({ title, context, options }) };
  const bind = binding(action);
  return d.openAsk({ source: "system", createdBy: CREATOR, project: MASTER_PROJECT, kind: "authorize", title, context, options,
    allowText: false, blocking: true, expiresAt: action.preflight?.expiresAt ?? (action.invitation ? Math.min(...action.invitation.invitations.map(i => i.expiresAt)) : d.now() + 3600_000),
    bind: { ...bind, paramsHash: bindHash(bind, CREATOR) }, extra: { sharedProjectAction: true,
      ...(select ? { sharedProjectChoice: { selectId: select.row.type === "select" ? select.row.id : "", recommended: select.recommended } } : {}) },
  });
}

/** A PM may propose parameters only. Opening this card never calls the center's create endpoint. */
export async function proposeSharedProject(input: ProjectCreate, d: SharedProjectsPorts): Promise<Ask> {
  const who = await d.person();
  requireProjectPerson(who);
  return openSharedProjectAction(d, { kind: "create", who, input, operationId: input.operationId },
    `建议新建团队项目 ${input.name}`, `原创建参数：${input.name}（${input.id ?? "中心分配 ID"}）；操作 ${input.operationId}
`
      + `本机选择：${input.selection ? input.selection.mode === "create" ? "新建本机项目" : input.selection.localProjectId : "尚未选择，后续显式确认"}`);
}

function requireOperation(who: ProjectPerson, value: CreatorOperation, operationId: string): CreatorOperation {
  const parsed = parseV2ProjectsResponse("operation", 200, { ok: true, v: 2, ...value },
    { centerId: who.centerId, teamId: who.teamId, personId: who.personId, instanceId: who.instanceId, operationId });
  if (!parsed.ok || parsed.operation.state === "revoked") throw new SharedProjectsError(403, "operation_mismatch");
  return { project: parsed.project, operation: parsed.operation };
}

async function recoveryCard(d: SharedProjectsPorts, who: ProjectPerson, operationId: string, selection?: ProjectSelection,
  input?: ProjectCreate, expectedDigest?: string, completedLocalProjectId?: string) {
  const ask = openSharedProjectAction(d, { kind: "complete", who, operationId, input, expectedDigest, completedLocalProjectId, ...(selection ? { selection } : {}) },
    "继续完成项目", `操作 ${operationId}；本人 ${who.personId}；实例 ${who.instanceId}
`
      + `原创建参数：${input ? `${input.name}（${input.id ?? "中心分配 ID"}）` : "沿用中心原操作"}
`
      + `本机选择：${selection ? selection.mode === "create" ? "新建本机项目" : selection.localProjectId : "尚未选择，后续显式确认"}
`
      + "查询同一操作并继续，不重复建项目。");
  return { ok: true, available: false, operationId, askId: ask.id };
}


/** A missing operation means the original request may not have arrived; the center deduplicates the same approved input/id. */
async function recoverOperation(who: ProjectPerson, operationId: string, input: ProjectCreate | undefined,
  expectedDigest: string | undefined, d: SharedProjectsPorts): Promise<CreatorOperation> {
  try { return await d.operation(who, operationId); }
  catch (error) {
    if (!(error instanceof SharedProjectsError) || error.status !== 404 || !input || input.operationId !== operationId
      || expectedDigest !== undefined) throw error;
    return d.create(who, input);
  }
}

/** Selection precedes N2 atomic enrollment; success requires persisted credential readback and an actual B gate read. */
async function completeSharedProject(who: ProjectPerson, operationId: string, selection: ProjectSelection | undefined,
  d: SharedProjectsPorts, created?: CreatorOperation, input?: ProjectCreate, expectedDigest?: string, completedLocalProjectId?: string): Promise<Record<string, unknown>> {
  try {
    const operation = requireOperation(who, created ?? await recoverOperation(who, operationId, input, expectedDigest, d), operationId);
    if ((input && (operation.project.name !== input.name || (input.id !== undefined && operation.project.projectId !== input.id)))
      || (expectedDigest !== undefined && operation.operation.paramsDigest !== expectedDigest)) throw new SharedProjectsError(403, "operation_params_changed");
    expectedDigest = operation.operation.paramsDigest;
    if (!selection) {
      const select = projectChoices(operation.project, await d.eligible(), d.bindings());
      const ask = openSharedProjectAction(d, { kind: "complete", who, operationId, input, expectedDigest, choices: select.choices },
        "选择本机项目", `${operation.project.name}（${operation.project.projectId}）；操作 ${operationId}\n选择本机项目并批准后保存凭据、绑定和验证。`, select);
      return { ok: true, available: false, operationId, askId: ask.id };
    }
    const bound = d.bindings().filter(b => b.centerId === who.centerId && b.teamId === who.teamId && b.projectId === operation.project.projectId);
    if (bound.length > 1) throw new SharedProjectsError(409, "binding_conflict");
    const existing = bound[0] && (bound[0].localProjectId ?? bound[0].projectId);
    if (completedLocalProjectId && existing !== completedLocalProjectId) throw new SharedProjectsError(409, "binding_changed");
    if (existing && selection.mode === "existing" && selection.localProjectId !== existing) throw new SharedProjectsError(409, "binding_conflict");
    const localProjectId = existing && await d.credentialSaved(who, operation.project) ? existing
      : await d.enrollCreator(who, operation, existing ? { mode: "existing", localProjectId: existing } : selection);
    completedLocalProjectId = localProjectId;
    if (!await d.credentialSaved(who, operation.project)) throw new SharedProjectsError(503, "credential_not_saved");
    if (!await d.gateRead(who, operation.project, localProjectId)) throw new SharedProjectsError(503, "gate_read_failed");
    return { ok: true, available: true, operationId, projectId: operation.project.projectId, localProjectId };
  } catch {
    // Center, credential and filesystem exceptions can contain bearer/code material; only the recovery card is public.
    return recoveryCard(d, who, operationId, selection, input, expectedDigest, completedLocalProjectId);
  }
}

export async function createSharedProject(input: ProjectCreate, d: SharedProjectsPorts): Promise<Record<string, unknown>> {
  const who = await d.person();
  requireProjectPerson(who);
  try {
    const operation = await d.create(who, input);
    return completeSharedProject(who, input.operationId, input.selection, d, operation, input);
  } catch (error) {
    if (error instanceof SharedProjectsError && error.status < 500) throw error;
    // A lost response may already have committed: recover by the original operationId rather than creating again.
    return recoveryCard(d, who, input.operationId, input.selection, input);
  }
}

/** A local owner is not automatically a deployment owner; execution stays behind the explicitly approved executor port. */
export async function bootstrapSharedProject(operationId: string, d: SharedProjectsPorts): Promise<Ask> {
  if (!await d.deploymentAuthorized()) throw new SharedProjectsError(403, "deployment_authorization_required");
  const who = await d.person();
  requireProjectPerson(who);
  const p = await d.preflight(who, operationId);
  requirePreflight(who, operationId, p, d.now());
  return openSharedProjectAction(d, { kind: "bootstrap", who, operationId, preflight: p }, "确认团队 owner",
    `中心 ${p.centerId}；团队 ${p.teamId}；本人 ${p.personId}；实例 ${p.instanceId}\n实例公钥摘要 ${p.instanceKeyDigest}\n预检摘要 ${p.summaryDigest}`);
}
function requirePreflight(who: ProjectPerson, operationId: string, p: BootstrapPreflight, now: number) {
  if (!samePerson(who, { ...who, ...p }) || p.operationId !== operationId || p.expiresAt <= now || p.ownerCount !== 0 || !p.memberActive
    || !/^[a-f0-9]{64}$/.test(p.instanceKeyDigest) || !/^[a-f0-9]{64}$/.test(p.summaryDigest)) {
    throw new SharedProjectsError(403, "bootstrap_preflight_rejected");
  }
}
/** HTTP recovery uses the original stored approval; the request cannot replace its local selection. */
export async function continueSharedProject(operationId: string, askId: string, d: SharedProjectsPorts) {
  const ask = d.getAsk(askId);
  if (!ask || ask.state !== "answered" || ask.createdBy !== CREATOR || (ask.bind?.params as ProjectAction | undefined)?.operationId !== operationId) {
    throw new SharedProjectsError(403, "ask_check_failed");
  }
  return answerSharedProject(ask, d);
}
/** Ask parameters, owner identity and expiry are rechecked even when the caller bypasses the HTTP UI. */
export async function answerSharedProject(a: Ask, d: SharedProjectsPorts): Promise<Record<string, unknown> | null> {
  if (a.createdBy !== CREATOR || a.extra.sharedProjectAction !== true || a.state !== "answered") return null;
  const stored = d.getAsk(a.id);
  if (!stored || stored.state !== "answered" || stored.createdBy !== CREATOR
    || !stored.bind || !a.bind || stored.bind.paramsHash !== a.bind.paramsHash
    || bindHash(stored.bind, CREATOR) !== bindHash(a.bind, CREATOR)) throw new SharedProjectsError(403, "ask_check_failed");
  a = structuredClone(stored);
  const action = a.bind?.params as ProjectAction | undefined;
  if (!action || action.cardDigest !== sharedProjectCardDigest(a) || !a.bind || bindHash(a.bind, CREATOR) !== a.bind.paramsHash || !ownerAnswered(a.answer)
    || !checkAsk({ ...a, fromAgent: CREATOR }, bindHash(binding(action), CREATOR), CREATOR, d.now()).ok) {
    throw new SharedProjectsError(403, "ask_check_failed");
  }
  if (!await d.authorizeAnswer(a)) throw new SharedProjectsError(403, "approver_required");
  const who = await d.person();
  requireProjectPerson(who);
  if (!samePerson(who, action.who)) throw new SharedProjectsError(403, "person_changed");
  if (action.kind === "invite") return { ok: true, offers: await d.sendInvite(who, a) };
  if (action.kind === "bootstrap") {
    if (!await d.deploymentAuthorized() || !action.preflight) throw new SharedProjectsError(403, "deployment_authorization_required");
    requirePreflight(who, action.operationId, action.preflight, d.now());
    const current = await d.preflight(who, action.operationId);
    requirePreflight(who, action.operationId, current, d.now());
    if (current.summaryDigest !== action.preflight.summaryDigest || current.instanceKeyDigest !== action.preflight.instanceKeyDigest) {
      throw new SharedProjectsError(403, "bootstrap_preflight_changed");
    }
    if (!d.claimAsk(a)) throw new SharedProjectsError(409, "ask_already_executed");
    await d.confirmOwner(who, action.preflight);
    return { ok: true };
  }
  if (action.kind === "create" && action.input) {
    if (!d.claimAsk(a)) throw new SharedProjectsError(409, "ask_already_executed");
    return createSharedProject(action.input, d);
  }
  if (action.kind !== "complete") throw new SharedProjectsError(400, "invalid_action");
  const selection = action.choices ? selectedProject(a.answer?.choices ?? [], action.choices) : action.selection;
  if (action.choices && !selection) throw new SharedProjectsError(400, "local_project_required");
  if (!d.claimAsk(a)) throw new SharedProjectsError(409, "ask_already_executed");
  return completeSharedProject(who, action.operationId, selection ?? undefined, d, undefined, action.input, action.expectedDigest, action.completedLocalProjectId);
}
