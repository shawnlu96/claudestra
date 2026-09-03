import http2 from "node:http2";
import { createPrivateKey, sign as cryptoSign, type KeyObject } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * v2.22+ APNs 直连发送器(原生壳 native/ 的推送;owner 2026-09-03 给了 Auth Key)。
 * 零依赖:Node http2 + crypto ES256 JWT(provider token 认证)。
 *
 * 配置(env 可覆盖):
 *   APNS_KEY_PATH  .p8 路径,默认取 ~/.claude-orchestrator/apns/AuthKey_*.p8 第一个
 *   APNS_KEY_ID    Key ID,默认从文件名 AuthKey_<ID>.p8 解析
 *   APNS_TEAM_ID   开发者团队 ID(默认 G3TUSL5X84)
 *   APNS_TOPIC     bundle id(默认 com.claudestra.app)
 *   APNS_ENV       sandbox | production(默认 sandbox——开发签名的 App 只在 sandbox 收得到)
 * 没有 key 文件 = 未配置,所有调用静默 no-op(一次告警)。
 */
interface ApnsConfig { keyPath: string; keyId: string; teamId: string; topic: string; host: string }

let cfgCache: ApnsConfig | null | undefined;
function config(): ApnsConfig | null {
  if (cfgCache !== undefined) return cfgCache;
  const dir = join(process.env.CLAUDESTRA_DATA_ROOT || join(homedir(), ".claude-orchestrator"), "apns");
  let keyPath = process.env.APNS_KEY_PATH || "";
  if (!keyPath && existsSync(dir)) {
    const f = readdirSync(dir).find((n) => /^AuthKey_[A-Z0-9]+\.p8$/.test(n));
    if (f) keyPath = join(dir, f);
  }
  if (!keyPath || !existsSync(keyPath)) {
    console.warn("[apns] 未配置(找不到 AuthKey_*.p8),原生推送不启用");
    cfgCache = null;
    return null;
  }
  const keyId = process.env.APNS_KEY_ID || (keyPath.match(/AuthKey_([A-Z0-9]+)\.p8$/)?.[1] ?? "");
  const env = (process.env.APNS_ENV || "sandbox").toLowerCase();
  cfgCache = {
    keyPath,
    keyId,
    teamId: process.env.APNS_TEAM_ID || "G3TUSL5X84",
    topic: process.env.APNS_TOPIC || "com.claudestra.app",
    host: env === "production" ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com",
  };
  return cfgCache;
}

export function apnsConfigured(): boolean {
  return config() !== null;
}

// ── provider token(JWT ES256),APNs 要求 20~60 分钟换一次 ──
let keyObj: KeyObject | null = null;
let jwtCache: { token: string; iat: number } | null = null;
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
function providerToken(force = false): string {
  const c = config()!;
  const now = Math.floor(Date.now() / 1000);
  if (!force && jwtCache && now - jwtCache.iat < 50 * 60) return jwtCache.token;
  if (!keyObj) keyObj = createPrivateKey(readFileSync(c.keyPath));
  const head = b64url(JSON.stringify({ alg: "ES256", kid: c.keyId }));
  const claims = b64url(JSON.stringify({ iss: c.teamId, iat: now }));
  const sig = cryptoSign("sha256", Buffer.from(`${head}.${claims}`), { key: keyObj, dsaEncoding: "ieee-p1363" });
  jwtCache = { token: `${head}.${claims}.${b64url(sig)}`, iat: now };
  return jwtCache.token;
}

// ── http2 会话复用(断了下次重连)──
let session: http2.ClientHttp2Session | null = null;
function getSession(): http2.ClientHttp2Session {
  const c = config()!;
  if (session && !session.closed && !session.destroyed) return session;
  session = http2.connect(c.host);
  session.on("error", () => { session = null; });
  session.on("close", () => { session = null; });
  session.setTimeout(60_000, () => { session?.close(); });
  return session;
}

export interface ApnsMessage {
  title: string;
  body: string;
  /** 自定义字段:点通知直达 + 已读对账 */
  agent: string;
  url: string;
  ts: number;
  tag: string;
  /** 同 id 的通知在通知中心合并(可选) */
  collapseId?: string;
}

export interface ApnsResult { ok: boolean; status: number; reason?: string }

/** 发一条 alert push。BadDeviceToken / Unregistered(410)由调用方据 reason 清 token。 */
export async function apnsSend(deviceToken: string, msg: ApnsMessage, retry = true): Promise<ApnsResult> {
  const c = config();
  if (!c) return { ok: false, status: 0, reason: "NotConfigured" };
  const body = JSON.stringify({
    aps: { alert: { title: msg.title, body: msg.body }, sound: "default", "thread-id": msg.agent },
    agent: msg.agent, url: msg.url, ts: msg.ts, tag: msg.tag,
  });
  return new Promise<ApnsResult>((resolve) => {
    let s: http2.ClientHttp2Session;
    try { s = getSession(); } catch (e) { return resolve({ ok: false, status: 0, reason: (e as Error).message }); }
    const headers: Record<string, string> = {
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      authorization: `bearer ${providerToken()}`,
      "apns-topic": c.topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(Math.floor(Date.now() / 1000) + 3600),
      "content-type": "application/json",
    };
    if (msg.collapseId) headers["apns-collapse-id"] = msg.collapseId.slice(0, 64);
    const req = s.request(headers);
    let status = 0; let data = "";
    const timer = setTimeout(() => { req.close(); resolve({ ok: false, status: 0, reason: "Timeout" }); }, 15_000);
    req.on("response", (h) => { status = Number(h[":status"] || 0); });
    req.on("data", (chunk) => { data += chunk; });
    req.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, status: 0, reason: e.message }); });
    req.on("end", () => {
      clearTimeout(timer);
      let reason: string | undefined;
      try { reason = data ? (JSON.parse(data) as { reason?: string }).reason : undefined; } catch { /* ignore */ }
      if (status === 403 && retry && (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken")) {
        providerToken(true);
        void apnsSend(deviceToken, msg, false).then(resolve);
        return;
      }
      resolve({ ok: status === 200, status, reason });
    });
    req.end(body);
  });
}

/** 该 reason 表示 token 永久失效,应从库里删掉。 */
export function apnsTokenDead(r: ApnsResult): boolean {
  return r.status === 410 || r.reason === "BadDeviceToken" || r.reason === "Unregistered" || r.reason === "DeviceTokenNotForTopic";
}
