/**
 * 团队正文的浏览器读口（team-project-TEAMVIS7）：本机 bridge 的只读代理 src/bridge/local-api/team-body.ts 把中心
 * team-body 读口原样转回来（契约 src/lib/shared-ledger-contract-team-body.ts，bridge 严格解析后才回）。
 * 失败归成四种：not_member（403，调用方清缓存）/ gate_refused（主场明确拒发这张卡的正文：不用旧缓存）/
 * unsupported（中心没开能力位、或项目没开正文）/ unavailable（离线、限流、其他）。
 */
import { api, ApiError } from "./client";
import type { MachineRef } from "../machines";
import { sharedLedgerProjectHeaders } from "./shared-ledger";

export type TeamBodyKind = "event" | "review" | "spec" | "session-page";
/**
 * kind / ts / stageTo：中心以后给 event 记录补的白名单元数据（另一个节点做），现行契约不带；有就用，没有不编。
 */
export interface TeamBodyRecordWire {
  featureId: string; taskId: string; kind: TeamBodyKind; sourceKey: string; text: string;
  scrubVersion: number; maskedSegments: number; digest: string;
  meta?: { kind?: unknown; ts?: unknown; stageTo?: unknown };
}
export interface TeamBodyReadWire {
  schemaVersion: 1; teamId: string; projectId: string; featureId: string; taskId: string;
  records: TeamBodyRecordWire[]; syncedAt: number | null; homeOnline: boolean;
}
export type TeamBodyFailure = "not_member" | "gate_refused" | "unsupported" | "unavailable";

export interface TeamBodyTransport {
  read(featureId: string, taskId: string, signal: AbortSignal): Promise<TeamBodyReadWire>;
}
/** 路径里带 id，不带查询串（bridge 代理一律 400 查询串） */
export function teamBodyTransport(machine?: MachineRef, project?: string): TeamBodyTransport {
  const headers = sharedLedgerProjectHeaders(project);
  return {
    read: (featureId, taskId, signal) =>
      api(`/shared-ledger/team-body/features/${encodeURIComponent(featureId)}/tasks/${encodeURIComponent(taskId)}`, { signal, headers }, machine),
  };
}

/** 读失败 → 界面状态。403 带 gate_refused 是明确拒绝（不是离线），其余 403 按非成员；404 / 409 = 中心没开 */
export function teamBodyFailure(e: unknown): TeamBodyFailure {
  if (!(e instanceof ApiError)) return "unavailable";
  if (e.status === 403) return e.body.code === "gate_refused" ? "gate_refused" : "not_member";
  if (e.status === 404 || e.status === 409) return "unsupported";
  return "unavailable";
}
