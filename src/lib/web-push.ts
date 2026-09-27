/**
 * Web Push 的服务端身份（VAPID 密钥对）与发送（web-push 包），中继网关（src/relay/push.ts）与 bridge 直发
 * （bridge/push/sender.ts）共用。密钥必须持久化：换钥匙 = 既有订阅全部作废（推送服务按公钥哈希校验）。
 * subject 必须是合法 https URL 或 mailto——Apple 的推送服务严格校验，假域名直接 403 BadJwtToken；FCM 不挑。
 */
import webpush from "web-push";
import type { Agent } from "node:https";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { WebPushSubscription } from "./relay-protocol.js";

export interface VapidKeys { publicKey: string; privateKey: string }
export interface VapidIdentity extends VapidKeys { subject: string }

function isVapidKeys(v: unknown): v is VapidKeys {
  const o = v as Partial<VapidKeys> | null;
  return !!o && typeof o === "object" && typeof o.publicKey === "string" && o.publicKey.length > 0 && typeof o.privateKey === "string" && o.privateKey.length > 0;
}

/** 文件里的密钥；不存在返回 null，存在但不是密钥对就抛（别静默换钥匙） */
export function readVapidKeys(path: string): VapidKeys | null {
  if (!existsSync(path)) return null;
  const v: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isVapidKeys(v)) throw new Error(`${path} 不是 VAPID 密钥对（需要 publicKey / privateKey）`);
  return { publicKey: v.publicKey, privateKey: v.privateKey };
}

/** 读文件；没有就生成并以 0600 写入（目录自动建） */
export function loadOrCreateVapidKeys(path: string): VapidKeys {
  const hit = readVapidKeys(path);
  if (hit) return hit;
  const keys = webpush.generateVAPIDKeys();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}

/** 发一条：resolve 推送服务的 HTTP 状态（2xx 成功，404 / 410 订阅已失效）；网络层失败才 reject */
export type WebPushSend = (sub: WebPushSubscription, payload: string, opts: { ttl: number }) => Promise<number>;

export interface WebPushSenderOptions {
  /** 测试专用：打本地自签名 TLS 服务器的 agent（rejectUnauthorized:false）；生产不传 */
  agent?: Agent;
  timeoutMs?: number;
}

export function webPushSender(vapid: VapidIdentity, opts: WebPushSenderOptions = {}): WebPushSend {
  const vapidDetails = { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey };
  return async (sub, payload, { ttl }) => {
    try {
      const r = await webpush.sendNotification(sub, payload, { TTL: ttl, vapidDetails, timeout: opts.timeoutMs ?? 10_000, ...(opts.agent ? { agent: opts.agent } : {}) });
      return r.statusCode;
    } catch (e) {
      const status = (e as { statusCode?: unknown }).statusCode;
      if (typeof status === "number") return status; // web-push 把非 2xx 当异常抛，状态码在 statusCode 上
      throw e;
    }
  };
}

/** 推送服务的状态 → 结论：2xx 成功；404 / 410 订阅没了（删记录）；其余是暂时性失败 */
export function webPushOutcome(status: number): { ok: boolean; gone: boolean } {
  return { ok: status >= 200 && status < 300, gone: status === 404 || status === 410 };
}
