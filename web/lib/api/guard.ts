/** Chat Guard 管理面（bridge/local-api/guard.ts）：待放行清单 / 守门记录、放行 / 丢弃、阈值 */
import { api } from "./client";

export interface GuardItem {
  id: string;
  agent: string;
  from: string;
  trust: string;
  text: string;
  /** 进隔离区的时间 */
  at: string;
  hits: { id: string; verdict: string; score: number | null }[];
  sourceKind: string;
  /** 发送方 principal id（api:owner:self 等），历史视图据此判「是不是我发的」 */
  fromId?: string;
  /** 消息原时间（env.meta.ts） */
  ts?: string;
  status?: "pending" | "released" | "dropped";
  actedBy?: string | null;
  actedAt?: string | null;
}
/** all=false 只回 pending（待放行卡）；all=true 连 released / dropped 也回（历史视图里的守门记录） */
export function listGuard(agent?: string, all = false): Promise<GuardItem[]> {
  const qs = [agent ? `agent=${encodeURIComponent(agent)}` : "", all ? "status=all" : ""].filter(Boolean).join("&");
  return api<{ items?: GuardItem[] }>(`/guard/quarantine${qs ? `?${qs}` : ""}`, { timeoutMs: 8000 }).then((j) => j.items ?? []);
}
export function releaseGuard(id: string): Promise<void> {
  return api(`/guard/quarantine/${encodeURIComponent(id)}/release`, { method: "POST", json: {}, timeoutMs: 20_000 }).then(() => undefined);
}
export function dropGuard(id: string): Promise<void> {
  return api(`/guard/quarantine/${encodeURIComponent(id)}/drop`, { method: "POST", json: {}, timeoutMs: 8000 }).then(() => undefined);
}
export interface GuardSettings {
  mode: "off" | "on";
  blockAt: number;
  configured: boolean;
}
export function getGuardSettings(): Promise<GuardSettings> {
  return api<GuardSettings>("/guard/settings", { timeoutMs: 8000 });
}
export function putGuardSettings(patch: { mode?: "off" | "on"; blockAt?: number }): Promise<GuardSettings> {
  return api<GuardSettings>("/guard/settings", { method: "PUT", json: patch, timeoutMs: 8000 });
}
