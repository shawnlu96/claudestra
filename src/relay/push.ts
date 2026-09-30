/**
 * 推送网关（docs/relay/protocol.md §3.5、docs/design-hosted-frontend.md §7）：实例发 push 帧，中继用自己的 VAPID 私钥 /
 * APNs p8 投递，回 push-ack。持有完整订阅即视为有权推送（endpoint 只有订阅者与它交给的机器知道）。
 * 三道闸：每 fp 每分钟限次（限流窗口）、payload 上限（asPush）、endpoint 的 SSRF 规则（lib/push-endpoint.ts）。
 * 日志只记 fp、kind、状态、耗时——payload 是通知正文，永远不进日志。
 */
import { Agent } from "node:https";
import type { ClientHttp2Session } from "node:http2";
import { ApnsClient, apnsTokenDead, parseApnsMessage, type ApnsConfig } from "../lib/apns.js";
import { pushEndpointProblem } from "../lib/push-endpoint.js";
import { asPush, type PushAckFrame, type RelayPushCapabilities } from "../lib/relay-protocol.js";
import { webPushOutcome, webPushSender, type VapidIdentity, type WebPushSend } from "../lib/web-push.js";
import { KeyedWindows } from "./limiter.js";
import type { Logger } from "./types.js";

type Obj = Record<string, unknown>;

/** RelayOptions.push：入口（src/relay.ts）从 env 拼出来 */
export interface PushGatewayOptions {
  vapid?: VapidIdentity;
  apns?: ApnsConfig;
  /** 测试专用：允许 endpoint 指向回环 / 私网（本地假推送服务） */
  allowPrivateEndpoints?: boolean;
  /** 测试专用：接受假推送服务的自签名证书。生产不传——传了等于对推送服务不验证书 */
  insecureTls?: boolean;
  /** 沙箱 lab（scripts/sandbox-lab-relay.ts）：Web Push 只许投到这个 origin（假推送端点），别的 endpoint 一律 endpoint_forbidden */
  pinEndpointOrigin?: string;
  /** 沙箱 lab：APNs 连这里给的会话（假推送端点），不连 Apple。生产不传 */
  apnsConnect?: (host: string) => ClientHttp2Session;
}

/** 两个后端可注入（测试用假的；生产由 pushGatewayFor 从 options 构造） */
export interface PushGatewayDeps {
  vapidPublicKey?: string;
  webPush: WebPushSend | null;
  apns: Pick<ApnsClient, "send"> | null;
  perFpPerMinute: number;
  allowPrivateEndpoints?: boolean;
  pinEndpointOrigin?: string;
  log: Logger;
}

const ack = (id: string, ok: boolean, extra: Omit<PushAckFrame, "t" | "id" | "ok"> = {}): PushAckFrame => ({ t: "push-ack", id, ok, ...extra });

/**
 * Web Push 的 fp 由中继按「谁发的」钉死：浏览器的 SW 点通知时拿 payload.fp 拼 /m/<fp>/… 带凭据发已读回执，
 * 让机器自报 fp 就能冒充别的机器、甚至塞路径（"<B>/api/v1/restart-all?x="）打 B 的管理端点（codex 复核）。
 * payload 必须是 JSON 对象，否则拒（tests/relay-push.test.ts）。
 */
function bindSenderFp(payload: string, fp: string): string | null {
  let o: unknown;
  try {
    o = JSON.parse(payload);
  } catch {
    return null; // 不是 JSON：SW 会按默认值处理成「当前机器」，也可能被当成别的东西——直接拒更干净
  }
  return o && typeof o === "object" && !Array.isArray(o) ? JSON.stringify({ ...(o as Record<string, unknown>), fp }) : null;
}

export class PushGateway {
  private readonly windows: KeyedWindows;

  constructor(private readonly d: PushGatewayDeps) {
    this.windows = new KeyedWindows(d.perFpPerMinute);
  }

  /** welcome 帧里报给实例：有没有 Web Push（公钥）、有没有 APNs */
  capabilities(): RelayPushCapabilities {
    return { ...(this.d.vapidPublicKey ? { vapidPublicKey: this.d.vapidPublicKey } : {}), apns: this.d.apns !== null };
  }

  sweep(now: number): void {
    this.windows.sweep(now);
  }

  /** 一帧 → 一条 push-ack（连 id 都没有时返回 null，调用方回 frame_invalid 错误帧）。永不 reject */
  async handle(fp: string, raw: Obj): Promise<PushAckFrame | null> {
    const id = typeof raw.id === "string" ? raw.id : null;
    const f = asPush(raw);
    if (!f) return id ? ack(id, false, { error: "frame_invalid" }) : null;
    if (!this.windows.tryAcquire(fp)) return ack(f.id, false, { error: "rate_limited" });
    const t0 = Date.now();
    const result = f.kind === "webpush" ? await this.webPush(fp, f.subscription, f.payload, f.ttl) : await this.apns(f.token, f.payload, f.badge);
    this.d.log("info", `push ${fp} ${f.kind} → ${result.ok ? "ok" : result.error ?? "fail"}${result.status ? ` ${result.status}` : ""}${result.gone ? " gone" : ""} ${Date.now() - t0}ms`);
    return ack(f.id, result.ok, result);
  }

  private async webPush(fp: string, sub: { endpoint: string; keys: { p256dh: string; auth: string } }, raw: string, ttl?: number): Promise<Omit<PushAckFrame, "t" | "id">> {
    const payload = bindSenderFp(raw, fp);
    if (!payload) return { ok: false, error: "payload_invalid" };
    const pin = this.d.pinEndpointOrigin;
    const problem = pushEndpointProblem(sub.endpoint, { allowPrivate: this.d.allowPrivateEndpoints }) ??
      (pin && new URL(sub.endpoint).origin !== pin ? `不是钉死的 ${pin}` : null);
    if (problem) {
      this.d.log("warn", `push ${fp} webpush endpoint 被拒（${problem}）`);
      return { ok: false, error: "endpoint_forbidden" };
    }
    if (!this.d.webPush) return { ok: false, error: "webpush_unavailable" };
    try {
      const status = await this.d.webPush(sub, payload, { ttl: ttl ?? 3600 });
      const o = webPushOutcome(status);
      return { ok: o.ok, status, ...(o.gone ? { gone: true } : {}), ...(o.ok || o.gone ? {} : { error: "upstream_error" }) };
    } catch (e) {
      this.d.log("warn", `push ${fp} webpush 发送失败: ${(e as Error).message.slice(0, 120)}`);
      return { ok: false, error: "send_failed" };
    }
  }

  private async apns(token: string, payload: string, badge?: number): Promise<Omit<PushAckFrame, "t" | "id">> {
    if (!this.d.apns) return { ok: false, error: "apns_unavailable" };
    const msg = parseApnsMessage(payload, badge);
    if (!msg) return { ok: false, error: "payload_invalid" };
    const r = await this.d.apns.send(token, msg);
    return { ok: r.ok, status: r.status, ...(apnsTokenDead(r) ? { gone: true } : {}), ...(r.ok ? {} : { error: r.reason ?? "upstream_error" }) };
  }
}

/** 生产构造：options 里有 VAPID 就开 Web Push，有 APNs 配置就开 APNs */
export function pushGatewayFor(opts: PushGatewayOptions | undefined, perFpPerMinute: number, log: Logger): PushGateway {
  return new PushGateway({
    perFpPerMinute, log, allowPrivateEndpoints: opts?.allowPrivateEndpoints, pinEndpointOrigin: opts?.pinEndpointOrigin,
    vapidPublicKey: opts?.vapid?.publicKey,
    webPush: opts?.vapid ? webPushSender(opts.vapid, opts.insecureTls ? { agent: new Agent({ rejectUnauthorized: false }) } : {}) : null,
    apns: opts?.apns ? new ApnsClient(opts.apns, opts.apnsConnect ? { connect: opts.apnsConnect } : {}) : null,
  });
}
