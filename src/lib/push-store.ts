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
  /** owner = 收全部推送（聊天、提醒、待你处理）；guest = 只收指派给自己的「待你处理」（T11b） */
  audience: PushAudience;
  /** 订阅时的 principal 与设备凭据 id（老订阅没有）：guest 的推送按它认人、凭据撤了就不再推 */
  principal: string | null;
  credential: string | null;
}

type PushAudience = "owner" | "guest";
export interface PushSubscriber {
  audience: PushAudience;
  principal: string;
  credential?: string;
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

/** keys 列只存两把密钥（别的字段不存） */
const keysJson = (k: WebPushSubscription["keys"]) => JSON.stringify({ p256dh: k.p256dh, auth: k.auth });

export function listPushSubscriptions(db: Database): PushSubscriptionRow[] {
  type R = { endpoint: string; keys: string; ua: string; vapid_key: string | null; audience: string; principal: string | null; credential: string | null };
  const rows = db.prepare("SELECT endpoint, keys, ua, vapid_key, audience, principal, credential FROM push_subscriptions").all() as R[];
  const out: PushSubscriptionRow[] = [];
  for (const r of rows) {
    const keys = parseKeys(r.keys);
    const audience: PushAudience = r.audience === "guest" ? "guest" : "owner";
    if (keys) out.push({ endpoint: r.endpoint, keys, ua: r.ua, vapidKey: r.vapid_key, audience, principal: r.principal, credential: r.credential });
  }
  return out;
}

/**
 * endpoint 主键 upsert：同一浏览器重新订阅会换密钥（也可能换了 VAPID 公钥），UA 与订阅者也顺手刷新（不给 = owner，老调用方）。
 * guest 的登记盖不掉已有的 owner 订阅（否则拿到 owner 的 endpoint 就能把 owner 的推送改成只收 ask）
 */
export function savePushSubscription(db: Database, sub: WebPushSubscription, ua: string, vapidKey: string | null = null, now: Date = new Date(), who?: PushSubscriber): void {
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, keys, ua, created_at, vapid_key, audience, principal, credential) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET keys = excluded.keys, ua = excluded.ua, vapid_key = excluded.vapid_key,
       audience = excluded.audience, principal = excluded.principal, credential = excluded.credential
     WHERE excluded.audience = 'owner' OR push_subscriptions.audience = 'guest'`,
  ).run(sub.endpoint, keysJson(sub.keys), ua.slice(0, 300), now.toISOString(), vapidKey, who?.audience ?? "owner", who?.principal ?? null, who?.credential ?? null);
}

/**
 * 投递成功后记下实际对上的那把公钥（老订阅 / 登记时记错的，下次直接走对的路）。
 * 带上投递时的密钥做条件（按字段比，不比 JSON 原文——BFF 时代迁来的行格式不一定相同）：
 * 发送途中这个 endpoint 被重新订阅（换了密钥和公钥）时，旧结果不能盖掉新登记
 */
export function setPushSubscriptionKey(db: Database, sub: WebPushSubscription, vapidKey: string): void {
  db.prepare(
    "UPDATE push_subscriptions SET vapid_key = ? WHERE endpoint = ? AND json_extract(keys, '$.p256dh') = ? AND json_extract(keys, '$.auth') = ?",
  ).run(vapidKey, sub.endpoint, sub.keys.p256dh, sub.keys.auth);
}

/** principal 给了就只删它自己的（guest 退订不能顺手删掉 owner 的订阅） */
export function deletePushSubscription(db: Database, endpoint: string, principal?: string): boolean {
  if (principal !== undefined) return db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND principal = ?").run(endpoint, principal).changes > 0;
  return db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint).changes > 0;
}

/** APNs 设备（owner 的 App）；principal / credential 是登记时的凭据（老行没有，按 owner:self 算，App 下次启动重新登记时补上） */
export interface ApnsDeviceRow {
  token: string;
  principal: string | null;
  credential: string | null;
}

/**
 * 没记登记凭据的老行（T11b 之前登记的）超过 7 天没重新登记就清掉：不知道是谁登记的，留着按 owner:self 全权推，撤了凭据的设备又登记不回来。
 * 壳每次启动、已授权时都会重新登记，正常在用的手机一周内早补上了 principal
 */
export const LEGACY_APNS_MAX_AGE_MS = 7 * 24 * 3600_000;
export function pruneLegacyApnsDevices(db: Database, now: Date = new Date()): number {
  return db.prepare("DELETE FROM apns_devices WHERE principal IS NULL AND last_seen < ?").run(new Date(now.getTime() - LEGACY_APNS_MAX_AGE_MS).toISOString()).changes;
}

export function listApnsDevices(db: Database): ApnsDeviceRow[] {
  return db.prepare("SELECT token, principal, credential FROM apns_devices").all() as ApnsDeviceRow[];
}

/** App 每次启动都会重新登记（APNs token 会变）：upsert 刷新 last_seen 与登记凭据（换了配对就换成新凭据） */
export function saveApnsDevice(db: Database, token: string, device: string, now: Date = new Date(), who?: PushSubscriber): void {
  const iso = now.toISOString();
  db.prepare(
    `INSERT INTO apns_devices (token, device, created_at, last_seen, principal, credential) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET device = excluded.device, last_seen = excluded.last_seen, principal = excluded.principal, credential = excluded.credential`,
  ).run(token.toLowerCase(), device.slice(0, 80), iso, iso, who?.principal ?? null, who?.credential ?? null);
}

export function deleteApnsDevice(db: Database, token: string): boolean {
  return db.prepare("DELETE FROM apns_devices WHERE token = ?").run(token.toLowerCase()).changes > 0;
}
