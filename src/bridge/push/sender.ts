/**
 * 推送的出口（docs/design-hosted-frontend.md §7）。Web Push 按订阅的 VAPID 公钥选路：订阅只认订它时用的那把钥匙，
 * 用中继公钥订的走中继（push 帧），用本机公钥订的（托管前端之前的老浏览器）由 bridge 直发——两把钥匙签错一律 403。
 * 不知道钥匙的老订阅两条路依次试，401/403 才换下一条（没投出去，不会重复）。APNs 另行选路：中继有 p8 走中继，否则本机 p8。
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
  /** Web Push 投成功时用的那把 VAPID 公钥：调用方记回订阅，下次直接走这条路 */
  vapidKey?: string;
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
  /** 现在签得了的 VAPID 公钥（中继的在前）：登记订阅时浏览器报的钥匙只认这里面的 */
  webPushKeys(): string[];
  sendWebPush(sub: WebPushSubscription & { vapidKey?: string | null }, payload: string, ttl?: number): Promise<SendOutcome>;
  sendApns(token: string, msg: ApnsMessage): Promise<SendOutcome>;
}

export interface SenderDeps {
  relay: () => Pick<RelayClient, "info" | "push"> | null;
  direct: () => DirectBackends;
}

const fromAck = (a: PushAck): SendOutcome => ({ ok: a.ok, gone: a.gone === true, ...(a.status !== undefined ? { status: a.status } : {}), ...(a.error ? { error: a.error } : {}) });
const relayFailed = (e: unknown): SendOutcome => ({ ok: false, gone: false, error: e instanceof RelayError ? `relay_${e.code}` : (e as Error).message });
/** 推送服务拒了签名：多半是订阅用的不是这把钥匙（FCM 403、Mozilla 401），换另一把还有救 */
const keyRejected = (o: SendOutcome): boolean => o.status === 401 || o.status === 403;

interface WebPushRoute {
  key: string;
  send: (sub: WebPushSubscription, payload: string, ttl: number) => Promise<SendOutcome>;
}

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
  /** 现在可用的 Web Push 出口，中继在前（没记钥匙的订阅先试中继：托管前端之后订的都是中继公钥） */
  const webPushRoutes = (): WebPushRoute[] => {
    const out: WebPushRoute[] = [];
    const r = relayWebPush();
    if (r) {
      out.push({
        key: r.info().push!.vapidPublicKey!,
        send: (sub, payload, ttl) => r.push({ kind: "webpush", subscription: sub, payload, ttl }).then(fromAck, relayFailed),
      });
    }
    const b = d.direct();
    const send = b.webPush;
    if (send && b.vapidPublicKey && !out.some((o) => o.key === b.vapidPublicKey)) {
      out.push({
        key: b.vapidPublicKey,
        send: (sub, payload, ttl) =>
          send(sub, payload, { ttl }).then(
            (status): SendOutcome => ({ ...webPushOutcome(status), status }),
            (e: unknown): SendOutcome => ({ ok: false, gone: false, error: (e as Error).message }),
          ),
      });
    }
    return out;
  };
  return {
    webPushKeys: () => webPushRoutes().map((r) => r.key),
    config() {
      const mode = online() ? "relay" : "direct";
      const rw = relayWebPush();
      const key = rw ? rw.info().push!.vapidPublicKey! : d.direct().vapidPublicKey;
      return { mode, webPush: key ? { vapidPublicKey: key } : null, apns: relayApns() !== null || d.direct().apns !== null };
    },
    async sendWebPush(sub, payload, ttl = 3600) {
      const routes = webPushRoutes();
      if (!routes.length) return { ok: false, gone: false, error: "webpush_unavailable" };
      const own = sub.vapidKey ? routes.filter((r) => r.key === sub.vapidKey) : [];
      const target = { endpoint: sub.endpoint, keys: sub.keys }; // 只把订阅本身交出去，别把本地字段带进 push 帧
      let last: SendOutcome = { ok: false, gone: false, error: "webpush_unavailable" };
      for (const r of [...own, ...routes.filter((x) => !own.includes(x))]) {
        last = await r.send(target, payload, ttl);
        if (last.ok) return { ...last, vapidKey: r.key };
        if (!keyRejected(last)) return last;
      }
      return last;
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
