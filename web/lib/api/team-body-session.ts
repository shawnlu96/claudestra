/**
 * 团队会话页的浏览器取页口（team-project-TEAMVIS8）：本机 bridge 的代理 src/bridge/local-api/team-body-session.ts 把
 * 「要一页」登记到中心、再按 requestId 读主场回传的页。只有这两个请求：不发消息、不改卡的状态。
 * 失败归成：not_member（403，调用方清缓存）/ gate_refused（主场明确拒发）/ not_open（主场没开正文）/ expired（请求过期）/
 * home_offline（主场不在线）/ unsupported（中心没开取页口）/ unavailable（离线、限流、其他）。
 */
import { api, ApiError } from "./client";
import type { MachineRef } from "../machines";
import { sharedLedgerProjectHeaders } from "./shared-ledger";
import type { TeamBodyRecordWire } from "./shared-ledger-team-body";

export interface TeamSessionTicket { requestId: string; expiresAt: number }
export type TeamSessionResult =
  | { kind: "page"; records: TeamBodyRecordWire[]; nextCursor: string | null }
  | { kind: "refused"; code: "gate_refused" | "not_open" };
/** pending = 主场还没回传（result 为 null） */
export interface TeamSessionPoll {
  requestId: string; status: "pending" | "ready"; expiresAt: number; homeOnline: boolean; result: TeamSessionResult | null;
}
export type TeamSessionFailure = "not_member" | "gate_refused" | "not_open" | "expired" | "home_offline" | "unsupported" | "unavailable";

export interface TeamSessionTransport {
  /** cursor null = 最新一页；否则上一页给的 nextCursor（原样带回，不解读） */
  request(featureId: string, taskId: string, cursor: string | null, signal: AbortSignal): Promise<TeamSessionTicket>;
  poll(featureId: string, taskId: string, requestId: string, signal: AbortSignal): Promise<TeamSessionPoll>;
}

/** 路径里带 id，不带查询串（bridge 代理一律 400 查询串） */
export function teamSessionTransport(machine?: MachineRef, project?: string): TeamSessionTransport {
  const headers = sharedLedgerProjectHeaders(project);
  const root = (featureId: string, taskId: string) =>
    `/shared-ledger/team-body/features/${encodeURIComponent(featureId)}/tasks/${encodeURIComponent(taskId)}/session-pages`;
  return {
    request: (featureId, taskId, cursor, signal) => api(root(featureId, taskId), { method: "POST", json: { cursor }, signal, headers }, machine),
    poll: (featureId, taskId, requestId, signal) => api(`${root(featureId, taskId)}/${encodeURIComponent(requestId)}`, { signal, headers }, machine),
  };
}

/** 请求失败 → 界面状态。403 带 gate_refused 是主场明确拒发，其余 403 按非成员；503 只有带 home_offline 才算主场离线 */
export function teamSessionFailure(e: unknown): TeamSessionFailure {
  if (!(e instanceof ApiError)) return "unavailable";
  if (e.status === 403) return e.body.code === "gate_refused" ? "gate_refused" : "not_member";
  if (e.status === 409) return "not_open";
  if (e.status === 410) return "expired";
  if (e.status === 404) return "unsupported";
  if (e.status === 503 && e.body.code === "home_offline") return "home_offline";
  return "unavailable";
}
