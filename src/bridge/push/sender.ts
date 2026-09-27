/**
 * 推送的出口（docs/design-hosted-frontend.md §7）：中继连着且中继有对应凭据 → 发 push 帧让中继投递（网关模式，浏览器用的是
 * 中继的 VAPID 公钥）；否则直发（bridge 自己的 VAPID 密钥 / 自己的 APNs p8）。Web Push 与 APNs 各自选路：中继只做了
 * Web Push 没做 APNs 时，APNs 仍可走本机 p8。老中继（welcome 不带 push）一律直发。
 * 两个后端都是注入的：relay 是 bridge/relay-link.ts 的 relayClient()，direct 由 init.ts 从磁盘 / env 懒加载。
 */
import { apnsTokenDead, type ApnsClient, type ApnsMessage } from "../../lib/apns.js";
import { RelayError, type PushAck, type RelayClient } from "../../lib/relay-client.js";
import type { WebPushSubscription } from "../../lib/relay-protocol.js";
import { webPushOutcome, type WebPushSend } from "../../lib/web-push.js";

export interface SendOutcome {
  ok: boolean;
  /** 订阅 / 设备已失效：调用方删记录 */
  gone: boolean;
  status?: number;
  error?: string;
}

/** GET /api/v1/push/config 的形状（契约 §13.3） */
interface PushConfig {
  webPush: { vapidPublicKey: string } | null;
  apns: boolean;
  mode: "direct" | "relay";
}

export interface DirectBackends {
  vapidPublicKey: string | null;
  webPush: WebPushSend | null;
  apns: Pick<ApnsClient, "send"> | null;
}

export interface PushSender {
  config(): PushConfig;
  sendWebPush(sub: WebPushSubscription, payload: string, ttl?: number): Promise<SendOutcome>;
  sendApns(token: string, msg: ApnsMessage): Promise<SendOutcome>;
}

export interface SenderDeps {
  relay: () => Pick<RelayClient, "info" | "push"> | null;
  direct: () => DirectBackends;
}

const fromAck = (a: PushAck): SendOutcome => ({ ok: a.ok, gone: a.gone === true, ...(a.status !== undefined ? { status: a.status } : {}), ...(a.error ? { error: a.error } : {}) });
const relayFailed = (e: unknown): SendOutcome => ({ ok: false, gone: false, error: e instanceof RelayError ? `relay_${e.code}` : (e as Error).message });

export function createPushSender(d: SenderDeps): PushSender {
  const online = () => {
    const c = d.relay();
    return c && c.info().connected ? c : null;
  };
  const relayWebPush = () => {
    const c = online();
    return c && c.info().push?.vapidPublicKey ? c : null;
  };
  const relayApns = () => {
    const c = online();
    return c && c.info().push?.apns ? c : null;
  };
  return {
    config() {
      const mode = online() ? "relay" : "direct";
      const rw = relayWebPush();
      const key = rw ? rw.info().push!.vapidPublicKey! : d.direct().vapidPublicKey;
      return { mode, webPush: key ? { vapidPublicKey: key } : null, apns: relayApns() !== null || d.direct().apns !== null };
    },
    async sendWebPush(sub, payload, ttl = 3600) {
      const r = relayWebPush();
      if (r) {
        try {
          return fromAck(await r.push({ kind: "webpush", subscription: sub, payload, ttl }));
        } catch (e) {
          return relayFailed(e);
        }
      }
      const b = d.direct();
      if (!b.webPush) return { ok: false, gone: false, error: "webpush_unavailable" };
      try {
        const status = await b.webPush(sub, payload, { ttl });
        return { ...webPushOutcome(status), status };
      } catch (e) {
        return { ok: false, gone: false, error: (e as Error).message };
      }
    },
    async sendApns(token, msg) {
      const r = relayApns();
      if (r) {
        try {
          return fromAck(await r.push({ kind: "apns", token, payload: JSON.stringify(msg), ...(msg.badge !== undefined ? { badge: msg.badge } : {}) }));
        } catch (e) {
          return relayFailed(e);
        }
      }
      const b = d.direct();
      if (!b.apns) return { ok: false, gone: false, error: "apns_unavailable" };
      const res = await b.apns.send(token, msg);
      return { ok: res.ok, gone: apnsTokenDead(res), status: res.status, ...(res.reason ? { error: res.reason } : {}) };
    },
  };
}
