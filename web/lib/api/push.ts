/**
 * 推送（§7、§13.3）：订阅交给当前机器保存；中继模式用中继的 VAPID 公钥（/app-config.json），直托管用 bridge 自签的。
 * 已读回执 / 已读表 / APNs 设备登记同样按机器。
 */
import { loadAppConfig } from "@/lib/app-config";
import { apiAgentName } from "@/lib/chat/agents";
import { api } from "./client";

export interface PushConfig {
  webPush: { vapidPublicKey: string } | null;
  apns: boolean;
  mode: "direct" | "relay";
}

/** 订阅要用的 VAPID 公钥：中继模式来自 app-config，直托管问 bridge；都没有 → null（此环境不能推） */
export async function vapidPublicKey(): Promise<string | null> {
  const cfg = await loadAppConfig();
  if (cfg.mode === "relay") return cfg.vapidPublicKey ?? null;
  if (cfg.vapidPublicKey) return cfg.vapidPublicKey;
  const c = await api<Partial<PushConfig>>("/push/config", { timeoutMs: 8000 });
  return c.webPush?.vapidPublicKey ?? null;
}

export function pushSubscribe(subscription: PushSubscriptionJSON, userAgent: string): Promise<void> {
  return api("/push/subscriptions", { method: "POST", json: { subscription, userAgent }, timeoutMs: 10_000 }).then(() => undefined);
}
export function pushUnsubscribe(endpoint: string): Promise<void> {
  return api("/push/subscriptions", { method: "DELETE", json: { endpoint }, timeoutMs: 10_000 }).then(() => undefined);
}

/**
 * 打开会话 / 看着时收到回复 = 已读：服务端归零未读 + 联动清别处通知；Discord 侧的完成 @ 由 notify-read 单独删
 * （bridge 的 read 端点不做这件事）——失败无所谓，消息可能早被人工清理或根本没有 Discord 通知。
 */
export async function markRead(agent: string): Promise<void> {
  const name = encodeURIComponent(apiAgentName(agent));
  await api(`/agents/${name}/read`, { method: "POST", json: {}, timeoutMs: 8000 });
  void api(`/agents/${name}/notify-read`, { method: "POST", json: {}, timeoutMs: 8000 }).catch(() => {});
}

/** 各 agent 的已读时刻（打开 App 时本机补清通知用） */
export function reads(): Promise<Record<string, number>> {
  return api<{ reads?: Record<string, string | number> }>("/reads", { timeoutMs: 8000 }).then((j) => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(j.reads ?? {})) {
      const n = typeof v === "number" ? v : Date.parse(v);
      if (Number.isFinite(n)) out[k] = n;
    }
    return out;
  });
}

export function apnsRegister(token: string, device: string): Promise<void> {
  return api("/push/apns", { method: "POST", json: { token, device }, timeoutMs: 10_000 }).then(() => undefined);
}
