/**
 * APNs 直连发送器（原生壳 native/ 的推送），零依赖：node:http2 + node:crypto 的 ES256 provider token。
 * 中继（RELAY_APNS_*，官方 p8 只在中继上）与 bridge 直发（APNS_*，自己的 p8）共用这一份；配置由调用方按前缀读 env
 * （apnsConfigFromEnv），这里不碰 process.env。http2 连接可注入（测试打本地 h2 服务器），生产永远只连 Apple。
 * 没配置 = 调用方拿到 null，不构造客户端；这里不做「静默 no-op」，免得推送悄悄丢了没人知道。
 */
import http2 from "node:http2";
import { createPrivateKey, sign as cryptoSign, type KeyObject } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type ApnsEnv = "sandbox" | "production";
export interface ApnsConfig { keyPath: string; keyId: string; teamId: string; topic: string; env: ApnsEnv }

const APNS_HOSTS: Record<ApnsEnv, string> = { sandbox: "https://api.sandbox.push.apple.com", production: "https://api.push.apple.com" };
const DEFAULT_APNS_TOPIC = "com.claudestra.app";
const KEY_FILE_RE = /^AuthKey_([A-Z0-9]+)\.p8$/;
/** provider token 20~60 分钟必须换一次（Apple 规定），50 分钟一换 */
const JWT_LIFETIME_S = 50 * 60;

/**
 * 按前缀读 env（`APNS_` 或 `RELAY_APNS_`）：KEY_PATH（没给就在 keyDir 里找 AuthKey_*.p8）、KEY_ID（默认从文件名解析）、
 * TEAM_ID（必填，不内置——部署给别人时是别人的团队）、TOPIC、ENV（默认 sandbox：开发签名的 App 只在 sandbox 收得到，
 * 而 production 打 sandbox 设备会回 BadDeviceToken → 调用方把好 token 当失效删掉）。缺 key 或 team 返回 null，why 说明原因。
 */
export function apnsConfigFromEnv(get: (name: string) => string | undefined, opts: { prefix: string; keyDir?: string }): { config: ApnsConfig | null; why?: string } {
  const v = (k: string) => (get(`${opts.prefix}${k}`) ?? "").trim();
  let keyPath = v("KEY_PATH");
  if (!keyPath && opts.keyDir && existsSync(opts.keyDir)) {
    const f = readdirSync(opts.keyDir).find((n) => KEY_FILE_RE.test(n));
    if (f) keyPath = join(opts.keyDir, f);
  }
  if (!keyPath || !existsSync(keyPath)) return { config: null, why: `找不到 AuthKey_*.p8（${opts.prefix}KEY_PATH${opts.keyDir ? ` 或 ${opts.keyDir}` : ""}）` };
  const keyId = v("KEY_ID") || (KEY_FILE_RE.exec(keyPath.split("/").pop() ?? "")?.[1] ?? "");
  if (!keyId) return { config: null, why: `${opts.prefix}KEY_ID 没设，文件名也不是 AuthKey_<ID>.p8` };
  const teamId = v("TEAM_ID");
  if (!teamId) return { config: null, why: `${opts.prefix}TEAM_ID（Apple 开发者团队 ID）没设` };
  const env: ApnsEnv = v("ENV").toLowerCase() === "production" ? "production" : "sandbox";
  return { config: { keyPath, keyId, teamId, topic: v("TOPIC") || DEFAULT_APNS_TOPIC, env } };
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** ES256 JWT：header {alg, kid}，claims {iss: teamId, iat}；签名 ieee-p1363（r‖s），不是 DER */
export function apnsJwt(key: KeyObject, keyId: string, teamId: string, iatS: number): string {
  const head = b64url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const claims = b64url(JSON.stringify({ iss: teamId, iat: iatS }));
  const sig = cryptoSign("sha256", Buffer.from(`${head}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `${head}.${claims}.${b64url(sig)}`;
}

export interface ApnsMessage {
  title: string;
  body: string;
  /** 自定义字段（顶层）：agent / url 给点通知直达，ts / tag 给跨端已读对账 */
  agent: string; url: string;
  ts: number; tag: string;
  /** 同 id 的通知在通知中心合并（可选） */
  collapseId?: string;
  /** App 图标角标数（未读总数）；省略则不动角标 */
  badge?: number;
  /** 仅同步角标、不弹通知（已读归零时用）：aps 只带 badge，无 alert / sound。Apple 规定带 badge 的推送 push-type 仍是 alert */
  silent?: boolean;
}

/** 请求正文：aps + 自定义顶层字段 */
export function apnsBody(msg: ApnsMessage): string {
  const aps: Record<string, unknown> = msg.silent
    ? { "thread-id": msg.agent }
    : { alert: { title: msg.title, body: msg.body }, sound: "default", "thread-id": msg.agent };
  if (typeof msg.badge === "number") aps.badge = Math.max(0, Math.floor(msg.badge));
  return JSON.stringify({ aps, agent: msg.agent, url: msg.url, ts: msg.ts, tag: msg.tag });
}

/**
 * 中继收到的 push 帧 payload（实例侧 JSON.stringify(ApnsMessage)）→ 消息；形状不对返回 null。
 * 帧级 badge 优先于 payload 里的（协议 §3.5：`badge?` 是给中继看的）。
 */
export function parseApnsMessage(payload: string, badge?: number): ApnsMessage | null {
  let v: unknown;
  try {
    v = JSON.parse(payload);
  } catch {
    return null; // 不是 JSON 就不是我们的通知格式
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const s = (x: unknown) => (typeof x === "string" ? x : null);
  const title = s(o.title), body = s(o.body), agent = s(o.agent), url = s(o.url), tag = s(o.tag);
  if (title === null || body === null || agent === null || url === null || tag === null || typeof o.ts !== "number") return null;
  const b = badge ?? (typeof o.badge === "number" ? o.badge : undefined);
  return {
    title, body, agent, url, ts: o.ts, tag,
    ...(typeof o.collapseId === "string" ? { collapseId: o.collapseId } : {}),
    ...(b !== undefined ? { badge: b } : {}), ...(o.silent === true ? { silent: true } : {}),
  };
}

export interface ApnsResult { ok: boolean; status: number; reason?: string }

/** 该 reason / 状态表示 token 永久失效，应从库里删掉 */
export function apnsTokenDead(r: ApnsResult): boolean {
  return r.status === 410 || r.reason === "BadDeviceToken" || r.reason === "Unregistered" || r.reason === "DeviceTokenNotForTopic";
}

export interface ApnsClientOptions {
  /** 测试注入：连本地 h2 服务器（带 rejectUnauthorized:false）；生产用 http2.connect */
  connect?: (host: string) => http2.ClientHttp2Session;
  now?: () => number;
  timeoutMs?: number;
  readKey?: (path: string) => Buffer;
}

export class ApnsClient {
  private key: KeyObject | null = null;
  private jwt: { token: string; iat: number } | null = null;
  private session: http2.ClientHttp2Session | null = null;
  private readonly connect: (host: string) => http2.ClientHttp2Session;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly readKey: (path: string) => Buffer;

  constructor(readonly cfg: ApnsConfig, opts: ApnsClientOptions = {}) {
    this.connect = opts.connect ?? ((host) => http2.connect(host));
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.readKey = opts.readKey ?? ((p) => readFileSync(p));
  }

  get host(): string {
    return APNS_HOSTS[this.cfg.env];
  }

  /** provider token，50 分钟内复用；force = Apple 说它过期 / 无效，立刻换 */
  providerToken(force = false): string {
    const nowS = Math.floor(this.now() / 1000);
    if (!force && this.jwt && nowS - this.jwt.iat < JWT_LIFETIME_S) return this.jwt.token;
    if (!this.key) this.key = createPrivateKey(this.readKey(this.cfg.keyPath));
    this.jwt = { token: apnsJwt(this.key, this.cfg.keyId, this.cfg.teamId, nowS), iat: nowS };
    return this.jwt.token;
  }

  /** http2 会话复用，断了下次重连 */
  private getSession(): http2.ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session;
    const s = this.connect(this.host);
    s.on("error", () => (this.session = null));
    s.on("close", () => (this.session = null));
    s.setTimeout(60_000, () => s.close());
    this.session = s;
    return s;
  }

  close(): void {
    this.session?.close();
    this.session = null;
  }

  headers(token: string, msg: ApnsMessage): Record<string, string> {
    const h: Record<string, string> = {
      ":method": "POST",
      ":path": `/3/device/${token}`,
      authorization: `bearer ${this.providerToken()}`,
      "apns-topic": this.cfg.topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(Math.floor(this.now() / 1000) + 3600),
      "content-type": "application/json",
    };
    if (msg.collapseId) h["apns-collapse-id"] = msg.collapseId.slice(0, 64);
    return h;
  }

  /** 发一条 alert push。BadDeviceToken / Unregistered（410）由调用方据 apnsTokenDead 清 token；provider token 被拒就换一把重发一次 */
  async send(token: string, msg: ApnsMessage, retry = true): Promise<ApnsResult> {
    const r = await this.once(token, msg);
    if (r.status === 403 && retry && (r.reason === "ExpiredProviderToken" || r.reason === "InvalidProviderToken")) {
      this.providerToken(true);
      return this.send(token, msg, false);
    }
    return r;
  }

  private once(token: string, msg: ApnsMessage): Promise<ApnsResult> {
    return new Promise<ApnsResult>((resolve) => {
      let s: http2.ClientHttp2Session;
      try {
        s = this.getSession();
      } catch (e) {
        return resolve({ ok: false, status: 0, reason: (e as Error).message });
      }
      const req = s.request(this.headers(token, msg));
      let status = 0;
      let data = "";
      const timer = setTimeout(() => {
        req.close();
        resolve({ ok: false, status: 0, reason: "Timeout" });
      }, this.timeoutMs);
      req.on("response", (h) => (status = Number(h[":status"] || 0)));
      req.on("data", (chunk) => (data += chunk));
      req.on("error", (e) => {
        clearTimeout(timer);
        resolve({ ok: false, status: 0, reason: e.message });
      });
      req.on("end", () => {
        clearTimeout(timer);
        let reason: string | undefined;
        try {
          reason = data ? (JSON.parse(data) as { reason?: string }).reason : undefined;
        } catch {
          reason = data.slice(0, 80); // Apple 的错误体一定是 JSON；不是 JSON 就把原文截一段当原因
        }
        resolve({ ok: status === 200, status, reason });
      });
      req.end(apnsBody(msg));
    });
  }
}
