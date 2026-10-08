/** N7B 本机提案通路：已绑定团队项目的「新建 feature」不写本机台账，改成 N7K FeatureProposal 交中心（N7C）等 owner 批准。
 * plan_feature 先问 proposeBoundFeature：未绑定 / 个人项目回 null 走原路径；project / center / team 只由本机绑定定。
 * MCP 用 owner:self 的 service 凭据，网页用 person；本机只写 0600 待同步记录，中心不可达 = 待同步、结果未确认。
 * 本地 API（给 N7W）：ROOT 的 POST 提交 / GET 列记录，ROOT/operations/{opId} 按 operationId 查，ROOT/decisions 转发 owner 审批，
 * ROOT/projects/{localProjectId} 读中心该项目的提案列表（owner 审批卡用，带 proposalRev）。
 */
import { randomUUID } from "node:crypto";
import type { Principal } from "../../lib/principals.js";
import { STATE_DIR } from "../../lib/paths.js";
import { isPersonalProject } from "../../lib/lend-policy.js";
import { parseToolNodes, type NodeInput } from "../../lib/dag-tools-plan.js";
import { refuse, type OrderToolResult, type VerifiedCall } from "../../lib/order-tool-route.js";
import { readBoundedRequestBody, RequestBodyError } from "../../lib/request-body.js";
import { readSharedLedgerBindings, type SharedLedgerBinding } from "../../lib/shared-ledger-gate-bindings.js";
import { SHARED_LEDGER_PROJECT_HEADER } from "../../lib/shared-ledger-gate-proxy.js";
import { readSharedLedgerProjects } from "../../lib/shared-ledger-project-link.js";
import { sharedLedgerBindingLocalId } from "../../lib/shared-ledger-project-link-target.js";
import { instanceIdSync } from "../../lib/instance-id.js";
import { FEATURE_PROPOSAL_SCHEMA_VERSION, parseFeatureProposal } from "../../lib/shared-ledger-contract-v2-feature-proposals.js";
import { FeatureProposalRejected, FeatureProposalUnsupported } from "../../lib/shared-ledger-feature-proposals.js";
import {
  forwardDecision, listCenterProposals, PROPOSAL_DEFAULT_TTL_MS, readPendingProposals, resumeProposals, stageProposal, syncProposal,
  type PendingProposal, type ProposalDraft, type ProposalRuntime, type ProposalVia,
} from "../../lib/shared-ledger-feature-proposals-store.js";
import { SharedLedgerUnavailable } from "../../lib/shared-ledger-client-transport.js";
import { reconcileCenterClaims } from "../../lib/shared-ledger-center-start.js";
import { apiJson } from "../api-respond.js";
import { sharedProjectOwnerPrincipal } from "./shared-projects-auth.js";

/** 回给调用方的固定文本：不回显中心原文、凭据或输入 */
export const PROPOSAL_TEXT = Object.freeze({
  pending_approval: "已提交，待项目 owner 批准",
  approved: "已批准，等中心发布",
  published: "中心已发布（本机执行由 N7X 接）",
  rejected: "提案被拒绝：未建本机 feature / 卡，未派单",
  expired: "提案已过期：未建本机 feature / 卡，未派单",
  conflict: "提案冲突（409）：未建本机 feature / 卡，未派单；改内容后重新提交",
  drift: "提案与中心当前版本漂移，中心仍待审：本机继续按 operationId 查，不自动重交、不重放审批",
  pending_sync: "待同步，结果未确认：中心暂不可达，已留待同步记录，恢复后先查后交",
  unsupported: "中心提案协议版本不受支持（schemaVersion），未提交成功",
  no_credential: "本机没有该团队项目可用的凭据（owner:self、plan 权限、实例一致），未提交",
  forbidden: "中心拒绝了本机凭据，未提交",
  invalid: "提案内容不符合团队项目契约（节点 / 字段 / 大小），未提交",
  bindings: "团队项目绑定或本机项目文件不可读：未写本机台账，也未提交提案",
});

let runtime: ProposalRuntime | null = null;
const live = (): ProposalRuntime => ({ stateDir: STATE_DIR, now: Date.now, newOperationId: () => `op-${randomUUID()}`, ttlMs: PROPOSAL_DEFAULT_TTL_MS });
/** 测试注入（临时 state 目录、假时钟、fake center 的 fetch）；undefined 回到 live */
export function configureFeatureProposals(rt: Partial<ProposalRuntime> | undefined): void {
  runtime = rt ? { ...live(), ...rt } : null;
}
const rt = (): ProposalRuntime => runtime ?? live();

/** 只认本机绑定：一个本机项目绑一个团队项目；个人项目不走提案 */
export function boundTeamProject(localProjectId: string, dir: string): SharedLedgerBinding | null {
  const hits = readSharedLedgerBindings(dir).filter(b => sharedLedgerBindingLocalId(b) === localProjectId);
  if (!hits.length) return null;
  if (hits.length > 1) throw new Error("ambiguous binding");
  const local = readSharedLedgerProjects(dir).projects.find(p => p.id === localProjectId);
  return local && isPersonalProject(local) ? null : hits[0]!;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
interface DraftInput { title: string; description?: unknown; ownerWords?: unknown; homeInstanceId?: unknown; nodes: NodeInput[] }
function draftOf(r: ProposalRuntime, b: SharedLedgerBinding, input: DraftInput): ProposalDraft | null {
  const home = input.homeInstanceId === undefined ? (r.instanceId ?? (() => instanceIdSync(r.stateDir)))() : input.homeInstanceId;
  if (typeof home !== "string" || !ID.test(home)) return null;
  if (input.description !== undefined && typeof input.description !== "string") return null;
  if (input.ownerWords !== undefined && input.ownerWords !== null && typeof input.ownerWords !== "string") return null;
  const draft: ProposalDraft = {
    schemaVersion: FEATURE_PROPOSAL_SCHEMA_VERSION, centerId: b.centerId, teamId: b.teamId, projectId: b.projectId, kind: "new",
    title: input.title, description: (input.description as string | undefined) ?? "",
    ownerWords: typeof input.ownerWords === "string" && input.ownerWords ? input.ownerWords : null,
    nodes: input.nodes.map(n => ({ key: n.key, oneLine: n.oneLine, deps: [...n.deps], fileGlobs: [...(n.fileGlobs ?? [])], estimate: n.estimate ?? "" })),
    homeInstanceId: home,
  };
  const now = r.now();
  try { parseFeatureProposal({ ...draft, operationId: "op-check", expiresAt: now + Math.min(r.ttlMs, 7 * 24 * 3_600_000) }, now); }
  catch { return null; }
  return draft;
}

type Outcome = { status: number; body: OrderToolResult };
/** 记录 → 结果；终态照报。非终态先报最近一次同步的问题（unsupported / 凭据 / 不可达），之前拿到的 pending_approval /
 * approved 只作 cachedState 附带，不能盖住本次错误；没有问题时只有 pending_approval / approved 是 ok */
export function proposalOutcome(r: PendingProposal): Outcome {
  const base = { operationId: r.operationId, state: r.state, proposalId: r.proposalId };
  if (r.state === "published") return { status: 200, body: { ok: true, ...base, centerFeatureId: r.featureId, version: r.version, message: PROPOSAL_TEXT.published } };
  if (r.state === "rejected" || r.state === "expired" || r.state === "conflict") return { status: 409, body: refuse(`proposal_${r.state}`, PROPOSAL_TEXT[r.state]) };
  const cached = r.state === "unsynced" ? {} : { cachedState: r.state, proposalId: r.proposalId };
  if (r.issue === "unsupported") return { status: 502, body: { ...refuse("unsupported", PROPOSAL_TEXT.unsupported), ...cached } };
  if (r.issue === "no_credential") return { status: 403, body: { ...refuse("forbidden", PROPOSAL_TEXT.no_credential), ...cached } };
  if (r.issue === "forbidden") return { status: 403, body: { ...refuse("forbidden", PROPOSAL_TEXT.forbidden), ...cached } };
  if (r.issue === "drift") return { status: 202, body: { ...refuse("proposal_drift", PROPOSAL_TEXT.drift), ...cached } };
  if (r.issue === null && r.state !== "unsynced") return { status: 200, body: { ok: true, ...base, message: PROPOSAL_TEXT[r.state] } };
  return { status: 202, body: { ...refuse("pending_sync", `${PROPOSAL_TEXT.pending_sync}（operationId ${r.operationId}）`), ...cached } };
}

async function submit(r: ProposalRuntime, b: SharedLedgerBinding, draft: ProposalDraft, via: ProposalVia): Promise<Outcome> {
  const record = await stageProposal(r, draft, sharedLedgerBindingLocalId(b), via);
  return proposalOutcome(await syncProposal(r, record.operationId));
}

/** plan_feature（新建）入口：未绑定 / 个人项目回 null 让原路径照旧；已绑定则只提案，不碰本机台账 */
export async function proposeBoundFeature(_call: VerifiedCall, localProjectId: string, title: string, nodes: NodeInput[],
  args: Record<string, unknown>): Promise<OrderToolResult | null> {
  const r = rt();
  let binding: SharedLedgerBinding | null;
  try { binding = boundTeamProject(localProjectId, r.stateDir); }
  catch { return refuse("shared_ledger", PROPOSAL_TEXT.bindings); }
  if (!binding) return null;
  const draft = draftOf(r, binding, { title, description: args.description, ownerWords: args.ownerWords, homeInstanceId: args.homeInstanceId, nodes });
  if (!draft) return refuse("invalid", PROPOSAL_TEXT.invalid);
  try { return (await submit(r, binding, draft, "service")).body; }
  catch { return refuse("pending_sync", PROPOSAL_TEXT.pending_sync); } // 本机记录写失败等：固定文本，不当成功
}

let resumeTimer: ReturnType<typeof setInterval> | null = null;
/** bridge 启动时（api-routes.ts initApiRoutes）调一次：立刻按 operationId 续一遍待同步记录，此后每 5 分钟；重复调用不另起 */
export function startFeatureProposalResume(): Promise<void> | null {
  if (resumeTimer) return null;
  const run = () => Promise.all([resumeProposals(rt()), reconcileCenterClaims()]).then(() => {}, () => console.warn("feature proposal resume failed"));
  resumeTimer = setInterval(run, 5 * 60_000);
  resumeTimer.unref?.();
  return run();
}
/** 测试收尾用 */
export function stopFeatureProposalResume(): void {
  if (resumeTimer) clearInterval(resumeTimer);
  resumeTimer = null;
}

const ROOT = "/api/v1/shared-feature-proposals";
class ApiError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
function body(v: unknown, allowed: string[]): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !allowed.includes(k))) throw new ApiError(400, "invalid_body");
  return v as Record<string, unknown>;
}
/** 只在本机绑定里选：body.localProjectId 或头里的中心 projectId；多个候选不猜 */
function selectBinding(req: Request, b: Record<string, unknown>, dir: string): SharedLedgerBinding {
  const local = b.localProjectId, wanted = req.headers.get(SHARED_LEDGER_PROJECT_HEADER);
  if (local !== undefined && (typeof local !== "string" || !ID.test(local))) throw new ApiError(400, "invalid_project");
  let hits: SharedLedgerBinding[];
  try { hits = readSharedLedgerBindings(dir); } catch { throw new ApiError(503, "bindings_unavailable"); }
  hits = hits.filter(x => (local === undefined || sharedLedgerBindingLocalId(x) === local) && (wanted === null || x.projectId === wanted));
  if (hits.length !== 1) throw new ApiError(hits.length ? 409 : 404, hits.length ? "project_ambiguous" : "project_not_bound");
  return hits[0]!;
}
function view(r: PendingProposal) {
  return { operationId: r.operationId, localProjectId: r.localProjectId, projectId: r.proposal.projectId, title: r.proposal.title,
    kind: r.proposal.kind, state: r.state, issue: r.issue, proposalDigest: r.proposalDigest, proposalId: r.proposalId,
    featureId: r.featureId, version: r.version, expiresAt: r.expiresAt, createdAt: r.createdAt, updatedAt: r.updatedAt };
}
const respond = (o: Outcome, r: PendingProposal) => apiJson(o.status, { ...o.body, operation: view(r) });
/** 中心列表 → owner 审批卡：只给审批要用的字段；不回他人 personId / instanceId、policy.setBy、bearer 或中心原文 */
function centerView(list: Awaited<ReturnType<typeof listCenterProposals>>) {
  const { approvers, rev, updatedAt } = list.policy;
  return { policy: { approvers, rev, updatedAt }, proposals: list.proposals.map(p => ({
    proposalId: p.proposalId, proposalRev: p.proposalRev, proposalDigest: p.operation.proposalDigest, state: p.operation.state,
    drift: p.operation.state === "conflict", title: p.proposal.title, description: p.proposal.description, nodes: p.proposal.nodes,
    version: p.operation.version, expiresAt: p.proposal.expiresAt,
    proposer: { type: p.proposer.type, ...(p.proposer.type === "person" && p.proposer.personId === list.selfPersonId ? { code: "self" } : {}) },
  })) };
}

async function route(req: Request, path: string, r: ProposalRuntime): Promise<Response> {
  const read = async () => JSON.parse(new TextDecoder().decode(await readBoundedRequestBody(req, 300_000))) as unknown;
  if (path === ROOT && req.method === "GET") return apiJson(200, { ok: true, operations: readPendingProposals(r.stateDir).map(view) });
  if (path === ROOT && req.method === "POST") {
    const b = body(await read(), ["localProjectId", "title", "description", "ownerWords", "nodes", "homeInstanceId"]);
    const binding = selectBinding(req, b, r.stateDir);
    const local = readSharedLedgerProjects(r.stateDir).projects.find(p => p.id === sharedLedgerBindingLocalId(binding));
    if (local && isPersonalProject(local)) throw new ApiError(409, "personal_project");
    const nodes = parseToolNodes(b.nodes);
    if (typeof b.title !== "string" || !b.title.trim() || !nodes.ok) throw new ApiError(400, "invalid_body");
    const draft = draftOf(r, binding, { title: b.title, description: b.description, ownerWords: b.ownerWords, homeInstanceId: b.homeInstanceId, nodes: nodes.value });
    if (!draft) throw new ApiError(400, "invalid_proposal");
    const record = await stageProposal(r, draft, sharedLedgerBindingLocalId(binding), "person");
    const synced = await syncProposal(r, record.operationId);
    return respond(proposalOutcome(synced), synced);
  }
  const op = /^\/api\/v1\/shared-feature-proposals\/operations\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/.exec(path);
  if (op && req.method === "GET") {
    if (!readPendingProposals(r.stateDir).some(x => x.operationId === op[1])) throw new ApiError(404, "operation_not_found");
    const synced = await syncProposal(r, op[1]!, { queryFirst: true });
    return respond(proposalOutcome(synced), synced);
  }
  if (path === `${ROOT}/decisions` && req.method === "POST") {
    const b = body(await read(), ["localProjectId", "proposalId", "decision", "proposalDigest", "proposalRev", "homeInstanceId", "reason"]);
    const binding = selectBinding(req, b, r.stateDir);
    if (typeof b.proposalId !== "string" || !ID.test(b.proposalId)) throw new ApiError(400, "invalid_body");
    const { localProjectId: _l, ...decision } = b;
    const { operation } = await forwardDecision(r, binding, b.proposalId, { schemaVersion: FEATURE_PROPOSAL_SCHEMA_VERSION, ...decision });
    return apiJson(200, { ok: true, state: operation.state, proposalId: operation.proposalId, featureId: operation.featureId, version: operation.version });
  }
  const project = /^\/api\/v1\/shared-feature-proposals\/projects\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/.exec(path);
  if (project && req.method === "GET") {
    const binding = selectBinding(req, { localProjectId: project[1] }, r.stateDir);
    const local = readSharedLedgerProjects(r.stateDir).projects.find(p => p.id === sharedLedgerBindingLocalId(binding));
    if (local && isPersonalProject(local)) throw new ApiError(409, "personal_project");
    return apiJson(200, { ok: true, ...centerView(await listCenterProposals(r, binding)) });
  }
  const known = path === ROOT || op || path === `${ROOT}/decisions` || project;
  return apiJson(known ? 405 : 404, { ok: false, code: known ? "method_not_allowed" : "not_found" });
}

export interface FeatureProposalRouteDeps { auth: (req: Request, url: URL) => Promise<Principal | Response> }
const liveAuth: FeatureProposalRouteDeps = {
  auth: async (req, url) => (await import("../api-auth.js")).authenticateApi(req, url, { rateLimit: true }),
};

/** api-routes.ts 在认证前挂这一行（同 shared-projects）：这里自己认证，只收本机 owner（owner:self，网页走 person 凭据） */
export async function handleSharedFeatureProposalsApi(req: Request, url: URL, d: FeatureProposalRouteDeps = liveAuth): Promise<Response | null> {
  if (url.pathname !== ROOT && !url.pathname.startsWith(`${ROOT}/`)) return null;
  const p = await d.auth(req, url);
  if (p instanceof Response) return p.status === 429 ? p : apiJson(403, { ok: false, code: "owner_required" });
  if (!sharedProjectOwnerPrincipal(p)) return apiJson(403, { ok: false, code: "owner_required" });
  try {
    if (url.search) throw new ApiError(400, "invalid_query");
    return await route(req, url.pathname, rt());
  } catch (e) {
    // 中心 / 传输 / 解析异常里可能带凭据或原文：只回固定 code
    if (e instanceof ApiError) return apiJson(e.status, { ok: false, code: e.code });
    if (e instanceof RequestBodyError) return apiJson(e.status, { ok: false, code: e.code });
    if (e instanceof SyntaxError) return apiJson(400, { ok: false, code: "invalid_json" });
    if (e instanceof FeatureProposalUnsupported) return apiJson(502, { ok: false, code: "unsupported", error: PROPOSAL_TEXT.unsupported });
    if (e instanceof FeatureProposalRejected) {
      return apiJson(e.status || 502, { ok: false, code: e.error?.code ?? "center_rejected", ...(e.error ? { error: e.error.reason } : {}) });
    }
    if (e instanceof SharedLedgerUnavailable) return apiJson(503, { ok: false, code: "center_unavailable", error: "中心不可达，结果未确认" });
    if ((e as { code?: unknown })?.code === "invalid_field" || (e as { code?: unknown })?.code === "payload_too_large") {
      return apiJson(400, { ok: false, code: "invalid_body" });
    }
    return apiJson(503, { ok: false, code: "proposal_request_failed" });
  }
}
