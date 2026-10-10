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

/** vapidKey = 订阅时用的公钥：机器按它选投递路径（中继的走中继，本机的直发） */
export function pushSubscribe(subscription: { endpoint?: string; expirationTime?: number | null; keys?: Record<string, string> }, userAgent: string, vapidKey: string): Promise<void> {
  return api("/push/subscriptions", { method: "POST", json: { subscription, userAgent, vapidKey }, timeoutMs: 10_000 }).then(() => undefined);
}
export function pushUnsubscribe(endpoint: string): Promise<void> {
  return api("/push/subscriptions", { method: "DELETE", json: { endpoint }, timeoutMs: 10_000 }).then(() => undefined);
}

let readsHeld = false;
const heldReads = new Set<string>();
/**
 * 协作视图盖在会话上面时暂停已读回执：底下的会话没人在看，不能替用户清掉未读和别处的通知（features/collab/collab-nav.ts）。
 * 暂停期间被拦下的会话记着；恢复时交还给调用方，由它判断用户回到的是不是那个会话、要不要补发。
 */
export function holdReads(on: boolean): string[] {
  readsHeld = on;
  if (on) return [];
  const out = [...heldReads];
  heldReads.clear();
  return out;
}

/**
 * 打开会话 / 看着时收到回复 = 已读：服务端归零未读 + 联动清别处通知；Discord 侧的完成 @ 由 notify-read 单独删
 * （bridge 的 read 端点不做这件事）——失败无所谓，消息可能早被人工清理或根本没有 Discord 通知。
 */
export async function markRead(agent: string): Promise<void> {
  if (readsHeld) {
    heldReads.add(agent);
    return;
  }
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

/** 未读是 owner 的全局计数；404 / 403 的降级由 unread-counts 管。 */
export async function fetchUnread(signal?: AbortSignal, timeoutMs = 5000): Promise<Record<string, number>> {
  const r = await api<{ counts: Record<string, number> }>("/unread", { signal, timeoutMs });
  return r.counts;
}

export function readAll(): Promise<{ ok: boolean; cleared: number }> {
  return api("/agents/read-all", { method: "POST", json: {}, timeoutMs: 8000 });
}
