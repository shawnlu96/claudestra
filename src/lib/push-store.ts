/**
 * 推送订阅的存取（web-state.sqlite 的 push_subscriptions / apns_devices 两张表，lib/web-state.ts 建表）。
 * 纯函数 over Database：bridge/push/* 传生产库，测试传 ":memory:"。列名与 BFF 时代一致，迁移脚本按列复制。
 * keys 列存 JSON 字符串 {p256dh, auth}——订阅对象里就这两把，别的字段（expirationTime）不存。
 */
import type { Database } from "bun:sqlite";
import type { WebPushSubscription } from "./relay-protocol.js";

export interface PushSubscriptionRow extends WebPushSubscription {
  /** 订阅时的 User-Agent；iOS 判定靠它（空 = 老订阅，按 iOS 保守对待） */
  ua: string;
  /** 订阅用的 VAPID 公钥；null = 不知道（换钥匙前的老订阅），投递时两把都试、成功的那把记回来 */
  vapidKey: string | null;
}

/** iOS 对「push 到达不展示」有惩罚：dismiss 型静默 push 不能发给它们（iOS 靠打开 App 时按 push_read 补清） */
const IOS_UA_RE = /iPhone|iPad|iPod/i;
export const dismissSafe = (s: PushSubscriptionRow): boolean => !!s.ua && !IOS_UA_RE.test(s.ua);

/** keys 列 → 两把密钥；不是 JSON 或缺键的行是坏数据，返回 null 让调用方跳过（别让一行坏数据挡住其它订阅的推送） */
function parseKeys(raw: string): WebPushSubscription["keys"] | null {
  try {
    const k = JSON.parse(raw) as { p256dh?: unknown; auth?: unknown } | null;
    return k && typeof k.p256dh === "string" && typeof k.auth === "string" ? { p256dh: k.p256dh, auth: k.auth } : null;
  } catch {
    return null; // 坏 JSON 与缺键同样处理
  }
}

export function listPushSubscriptions(db: Database): PushSubscriptionRow[] {
  const rows = db.prepare("SELECT endpoint, keys, ua, vapid_key FROM push_subscriptions").all() as { endpoint: string; keys: string; ua: string; vapid_key: string | null }[];
  const out: PushSubscriptionRow[] = [];
  for (const r of rows) {
    const keys = parseKeys(r.keys);
    if (keys) out.push({ endpoint: r.endpoint, keys, ua: r.ua, vapidKey: r.vapid_key });
  }
  return out;
}

/** endpoint 主键 upsert：同一浏览器重新订阅会换密钥（也可能换了 VAPID 公钥），UA 也顺手刷新 */
export function savePushSubscription(db: Database, sub: WebPushSubscription, ua: string, vapidKey: string | null = null, now: Date = new Date()): void {
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, keys, ua, created_at, vapid_key) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET keys = excluded.keys, ua = excluded.ua, vapid_key = excluded.vapid_key`,
  ).run(sub.endpoint, JSON.stringify({ p256dh: sub.keys.p256dh, auth: sub.keys.auth }), ua.slice(0, 300), now.toISOString(), vapidKey);
}

/** 投递成功后记下实际对上的那把公钥（老订阅 / 登记时记错的，下次直接走对的路） */
export function setPushSubscriptionKey(db: Database, endpoint: string, vapidKey: string): void {
  db.prepare("UPDATE push_subscriptions SET vapid_key = ? WHERE endpoint = ?").run(vapidKey, endpoint);
}

export function deletePushSubscription(db: Database, endpoint: string): boolean {
  return db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint).changes > 0;
}

export function listApnsDevices(db: Database): string[] {
  return (db.prepare("SELECT token FROM apns_devices").all() as { token: string }[]).map((r) => r.token);
}

/** App 每次启动都会重新登记（APNs token 会变）：upsert 刷新 last_seen */
export function saveApnsDevice(db: Database, token: string, device: string, now: Date = new Date()): void {
  const iso = now.toISOString();
  db.prepare(
    `INSERT INTO apns_devices (token, device, created_at, last_seen) VALUES (?, ?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET device = excluded.device, last_seen = excluded.last_seen`,
  ).run(token.toLowerCase(), device.slice(0, 80), iso, iso);
}

export function deleteApnsDevice(db: Database, token: string): boolean {
  return db.prepare("DELETE FROM apns_devices WHERE token = ?").run(token.toLowerCase()).changes > 0;
}
