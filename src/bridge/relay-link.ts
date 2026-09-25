/**
 * 中继链路（bridge 侧）：.env 配了 RELAY_URL + RELAY_ORG_TOKEN 就在启动时连上中继（lib/relay-client.ts），
 * 之后 peers.json 里 baseUrl 为 `relay://<对方指纹>` 的 peer 走中继，`http(s)://` 的照旧直连。
 *
 * 为什么做成 fetch 的替身而不是另起一套调用：http-peer.ts 的 POST / thread 轮询和 peer-presence.ts 的探测
 * 都已经围绕 fetch + Response 写好（状态码分支、超时分类），peerFetch 把中继响应包回标准 Response，
 * 那两处各只改一行调用；中继错误映射成同名异常（超时类 name=TimeoutError），http-peer 现有的结局分类照用。
 *
 * 入站不在这里：客户端库收到帧后验签、打到 bridge/peer-ingress.ts 的回环端口，bridge 看到的是普通 peer 请求。
 * 端口没配（没做过 HTTPS 步骤的机器）就先 ensurePeerIngressPort 写进 .env 再让入口开起来，否则对方只会拿到
 * local_unreachable。
 */
import { hostname } from "node:os";
import { connect, RelayError, type RelayClient } from "../lib/relay-client.js";
import { instanceKeySync } from "../lib/instance-key.js";
import { ensurePeerIngressPort } from "../lib/peer-ingress-config.js";
import { configuredPeerIngressPort, DEFAULT_BRIDGE_PORT } from "../lib/bridge-url.js";
import { bridgeHttpBase, bridgePortOf } from "../lib/bridge-port.js";
import { repoEnvVar } from "../lib/env-file.js";
import { syncPeerIngress } from "./peer-ingress.js";

let client: RelayClient | null = null;

/** 两项都有才启用；只配一项按没配处理并提醒，别让 bridge 半吊子地连上去 */
export function relayConfig(get: (k: string) => string | undefined = repoEnvVar): { url: string; orgToken: string } | null {
  const url = (get("RELAY_URL") || "").trim();
  const orgToken = (get("RELAY_ORG_TOKEN") || "").trim();
  if (!url && !orgToken) return null;
  if (!url || !orgToken) {
    console.error("⚠️ 中继：RELAY_URL 与 RELAY_ORG_TOKEN 要一起配，现在只有一项，不连中继");
    return null;
  }
  return { url, orgToken };
}

/** bridge 启动时调一次。没配中继立刻返回；连接失败由客户端库自己退避重连，这里不抛 */
export async function startRelayLink(): Promise<void> {
  const cfg = relayConfig();
  if (!cfg || client) return;
  const key = instanceKeySync();
  if (!key) {
    console.error("⚠️ 中继：本机没有实例密钥（instance-key.pem 读写失败），不连中继");
    return;
  }
  let port = configuredPeerIngressPort({ PEER_INGRESS_PORT: repoEnvVar("PEER_INGRESS_PORT") });
  if (!port) {
    // 没做过 HTTPS 步骤的机器还没有 peer 入口端口：现在挑一个写进 .env，再让入口立刻开起来
    port = await ensurePeerIngressPort(bridgePortOf(bridgeHttpBase()) ?? DEFAULT_BRIDGE_PORT);
    if (port) await syncPeerIngress();
    else console.error("⚠️ 中继：附近端口全被占，peer 入口开不出来——对方经中继调我会得到 local_unreachable");
  }
  client = connect({
    relayUrl: cfg.url,
    orgToken: cfg.orgToken,
    key,
    name: hostname(),
    localIngress: port ? `http://127.0.0.1:${port}` : undefined,
    log: (level, msg) => (level === "info" ? console.log : console.error)(`🛰 中继: ${msg}`),
  });
}

/** 单测注入假客户端；生产不调 */
export function setRelayClientForTest(c: RelayClient | null): void {
  client = c;
}

export interface PeerFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/** 超时类的中继错误按 TimeoutError 抛：http-peer 的结局分类靠 name 认「可能已送达，别重发」 */
const TIMEOUT_CODES = new Set(["timeout", "local_timeout", "peer_disconnected", "connection_lost"]);
/** 这些状态码的 Response 不许带 body，硬塞会抛 */
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

function relayFetchError(e: unknown): Error {
  if (!(e instanceof RelayError)) return e instanceof Error ? e : new Error(String(e));
  const err = new Error(`relay ${e.code}: ${e.message}`);
  if (TIMEOUT_CODES.has(e.code)) err.name = "TimeoutError";
  return err;
}

/**
 * fetch 的替身：`relay://<指纹>/api/v1/...` 经中继，其余原样交给 fetchImpl。
 * 路径取 URL 的 pathname + search——与 instance-key.ts 的 signedFor 同一口径，对方按同一串验签。
 */
export async function peerFetch(
  url: string,
  init: PeerFetchInit,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<Response> {
  if (!url.startsWith("relay://")) return (opts.fetchImpl ?? fetch)(url, init);
  const u = new URL(url);
  if (!client) throw new Error(`relay 未启用：本机 .env 没配 RELAY_URL / RELAY_ORG_TOKEN，调不了 ${u.hostname}`);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v;
  const req = { method: (init.method ?? "GET").toUpperCase(), path: u.pathname + u.search, headers, body: new TextEncoder().encode(init.body ?? "") };
  let r;
  try {
    r = await client.request(u.hostname, req, { timeoutMs: opts.timeoutMs });
  } catch (e) {
    throw relayFetchError(e);
  }
  return new Response(NULL_BODY_STATUS.has(r.status) ? null : r.body, { status: r.status, headers: r.headers });
}
