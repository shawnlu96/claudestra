import { api, ApiError, type ApiInit } from "./api/client";
import { sharedLedgerProjectHeaders } from "./api/shared-ledger";
import type { MachineRef } from "./machines";
import { sharedProjectsApi } from "./shared-projects-api";
import { ProjectFailure, type SharedProjectsPort } from "./shared-projects-model";

/** N7B / N7B2 本机提案接口（只收本机 owner 设备）。project / home / center / team 只由 bridge 的绑定定，网页从不发这几个键。 */
export interface ProposalNode { key: string; oneLine: string; deps: string[]; fileGlobs: string[]; estimate: string }
export interface ProposalInput { title: string; description: string; ownerWords?: string; nodes: ProposalNode[] }
export interface ProposalDecision {
  proposalId: string; decision: "approve" | "reject"; proposalDigest: string; proposalRev: number; reason: string;
}
/** HTTP 答复原样交给模型解析；非 HTTP 失败（断网、中止、超时）是 status 0 */
export interface Reply { status: number; body: Record<string, unknown> }
export interface ProposalAccess { status: number; role: "owner" | "member" | null; localProjectId: string | null }
export interface FeatureProposalsPort {
  submit(input: ProposalInput, signal: AbortSignal): Promise<Reply>;
  operations(signal: AbortSignal): Promise<Reply>;
  operation(operationId: string, signal: AbortSignal): Promise<Reply>;
  access(signal: AbortSignal): Promise<ProposalAccess>;
  review(localProjectId: string, signal: AbortSignal): Promise<Reply>;
  decide(localProjectId: string, decision: ProposalDecision, signal: AbortSignal): Promise<Reply>;
}
export type ProposalRequest = (path: string, init: ApiInit) => Promise<unknown>;

const ROOT = "/shared-feature-proposals";
const seg = encodeURIComponent;

/** `project` 是中心 projectId：既选 bridge 绑定（请求头），也用来在 N4 snapshot 里找本人的 projectRole 和本机项目 id */
export function featureProposalsApi(machine: MachineRef, project: string, transport?: ProposalRequest,
  projects: SharedProjectsPort = sharedProjectsApi(machine, project)): FeatureProposalsPort {
  const headers = sharedLedgerProjectHeaders(project);
  const send = transport ?? ((path: string, init: ApiInit) => api(path, init, machine));
  const request = async (path: string, init: ApiInit): Promise<Reply> => {
    try {
      const body = await send(path, { ...init, headers: { ...headers, ...init.headers } });
      // api() 对 2xx 一律 resolve：202 待同步要靠 body 区分，见 feature-proposals-model.ts submitStatus
      const b = body && typeof body === "object" ? body as Record<string, unknown> : {};
      return { status: b.ok === true ? 200 : 202, body: b };
    } catch (error) {
      return error instanceof ApiError ? { status: error.status, body: error.body } : { status: 0, body: {} };
    }
  };
  return {
    submit: (input, signal) => request(ROOT, { method: "POST", signal, json: {
      title: input.title, description: input.description, ...(input.ownerWords ? { ownerWords: input.ownerWords } : {}), nodes: input.nodes } }),
    operations: signal => request(ROOT, { signal }),
    operation: (id, signal) => request(`${ROOT}/operations/${seg(id)}`, { signal }),
    review: (local, signal) => request(`${ROOT}/projects/${seg(local)}`, { signal }),
    decide: (local, d, signal) => request(`${ROOT}/decisions`, { method: "POST", signal, json: { localProjectId: local, ...d } }),
    access: async signal => {
      try {
        const hits = (await projects.list(signal)).projects.filter(p => p.projectId === project);
        const p = hits.length === 1 ? hits[0]! : null;
        return { status: 200, role: p?.role ?? null, localProjectId: p?.local?.id ?? null };
      } catch (error) {
        return { status: error instanceof ProjectFailure ? error.status : 0, role: null, localProjectId: null };
      }
    },
  };
}
