/**
 * 看板「刷新」结果那一行（stats-panel.tsx）的纯逻辑：账号接口的 Claude 卡是实时读数时，/status 探测失败
 * 不再说「读取账号用量失败，显示的是上次读数或未知」。纯 .ts 才能被根目录测试直接测：tests/web-stats-panel-refresh-note.test.ts。
 */
import type { QuotaPanelData } from "./quota-view";

/** bridge POST /stats/refresh 的 refresh 字段；unknown = 打开面板时没有任何读数 */
export interface RefreshNote {
  outcome: "refreshed" | "backoff" | "failed" | "busy" | "unknown";
  nextAllowedAt: number | null;
  reason: string | null;
}

/** 账号接口的 Claude 卡此刻是实时读数：/status 探测只是备用读法，它失败不代表上面的数是旧的 */
export function claudeAccountLive(sub: QuotaPanelData | null): boolean {
  return sub?.entries.some((e) => e.id === "claude" && e.source.layer === "live") ?? false;
}

/** 刷新结果那一行的文案；null = 不出这一行 */
export function refreshNoteMessage(note: RefreshNote, claudeLive: boolean): { key: string; params?: Record<string, string> } | null {
  // busy = 别的请求正在读，结果很快就到；refreshed 卡片自己会显示新读数
  if (note.outcome === "refreshed" || note.outcome === "busy") return null;
  if (note.outcome === "unknown") return { key: "账号用量未知（没有状态栏缓存），可点右上角刷新读取一次" };
  const time = note.nextAllowedAt ? new Date(note.nextAllowedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
  if (claudeLive) return { key: "账号用量已是实时读数；备用读法（/status）这次没读到，{time} 前不再重试", params: { time } };
  return { key: "读取账号用量失败，显示的是上次读数或未知；{time} 前不再重试", params: { time } };
}
