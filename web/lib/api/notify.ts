/**
 * 外部通知渠道（bridge/local-api/notify.ts）：ntfy / Bark / Webhook。GET 拿到的密钥只有尾四位（<字段>Hint / <字段>Set），
 * PUT 时密钥字段不传 = 沿用，空串 = 清除；只有全权设备能读写。
 */
import { api } from "./client";

export type NotifyKind = "ntfy" | "bark" | "webhook";
export type NotifyType = "ask" | "security" | "system" | "talk";
export const NOTIFY_TYPES: NotifyType[] = ["ask", "security", "system", "talk"];

/** GET 回来的一条（密钥换成提示） */
export interface NotifyChannelView {
  id: string;
  kind: NotifyKind;
  name: string;
  /** 停用 / 推哪些 / 只在离开时推 / 不带正文（bridge lib/notify-channels.ts 的同名字段） */
  enabled: boolean; types: NotifyType[]; onlyWhenAway: boolean; hideContent: boolean;
  /** ntfy / Bark 的服务器，ntfy 的 topic */
  server?: string; topic?: string;
  /** 密钥：是否已配 + 尾四位（webhook 地址是「主机/…尾四位」） */
  tokenSet?: boolean; tokenHint?: string;
  deviceKeySet?: boolean; deviceKeyHint?: string;
  urlSet?: boolean; urlHint?: string;
  secretSet?: boolean; secretHint?: string;
}
/** PUT / 测试用的一条：密钥字段只在改过时带 */
export type NotifyChannelWire = Pick<NotifyChannelView, "kind" | "name" | "enabled" | "types" | "onlyWhenAway" | "hideContent" | "server" | "topic"> & {
  id?: string;
  token?: string;
  deviceKey?: string;
  url?: string;
  secret?: string;
};
export interface NotifyResult {
  at: number;
  type: NotifyType | "test";
  ok: boolean;
  status?: number;
  error?: string;
}
export interface NotifyConfig {
  channels: NotifyChannelView[];
  /** 点开通知打开的地址（设置里填的）；空 = 用 linkBase */
  openUrl: string;
  /** 自动探测的打开地址（中继首页）；null = 没有，通知不带链接 */
  linkBase: string | null;
  recent: Record<string, NotifyResult[]>;
}

export function getNotify(): Promise<NotifyConfig> {
  return api<NotifyConfig>("/notify", { timeoutMs: 8000 });
}
export function putNotify(channels: NotifyChannelWire[], openUrl: string): Promise<NotifyConfig> {
  return api<NotifyConfig>("/notify", { method: "PUT", json: { channels, openUrl }, timeoutMs: 8000 });
}
/** 测已保存的（id）或草稿（channel）；结果也会出现在 GET 的 recent 里 */
export function testNotify(arg: { id: string } | { channel: NotifyChannelWire }): Promise<NotifyResult> {
  return api<{ result: NotifyResult }>("/notify/test", { method: "POST", json: arg, timeoutMs: 30_000 }).then((j) => j.result);
}

/** 视图 → 回传形状：不带任何密钥字段（bridge 沿用旧值） */
export function toWire(v: NotifyChannelView): NotifyChannelWire {
  const { id, kind, name, enabled, types, onlyWhenAway, hideContent, server, topic } = v;
  return { id, kind, name, enabled, types, onlyWhenAway, hideContent, ...(server ? { server } : {}), ...(topic ? { topic } : {}) };
}
