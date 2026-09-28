/** Chat Guard 管理面（bridge/local-api/guard.ts）：待放行清单、放行 / 丢弃、开关与阈值 */
import { api } from "./client";

export interface GuardItem {
  id: string;
  agent: string;
  from: string;
  trust: string;
  text: string;
  at: string;
  hits: { id: string; verdict: string; score: number | null }[];
  sourceKind: string;
}
export function listGuard(agent?: string): Promise<GuardItem[]> {
  return api<{ items?: GuardItem[] }>(`/guard/quarantine${agent ? `?agent=${encodeURIComponent(agent)}` : ""}`, { timeoutMs: 8000 }).then(
    (j) => j.items ?? [],
  );
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
