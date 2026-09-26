/**
 * 中继链路（bridge 侧，docs/relay/protocol.md）：.env 配了 RELAY_URL 就在启动时连上中继（lib/relay-client.ts），
 * 之后三件事经它走：浏览器打 https://<slug>.<base> 的隧道流量 → 本机 Web；peers.json 里 baseUrl 为
 * `relay://<对方指纹>` 的 peer 互调；联系人在线状态。入站分流在 relay-inbound.ts，配对短码在 relay-pairing.ts，
 * 回环控制路由在 relay-routes.ts。这里只管连接的生命周期、联系人同步与 peerFetch（fetch 的替身）。
 *
 * peerFetch 做成 fetch 替身的原因：http-peer.ts / peer-presence.ts 都围绕 fetch + Response 写好，中继响应包回
 * 标准 Response 后那两处各改一行；中继错误映射成同名异常（超时类 name=TimeoutError），结局分类照用。
 */
import { hostname } from "node:os";
import { readFileSync } from "node:fs";
import { connect, RelayError, type RelayClient } from "../lib/relay-client.js";
import type { RelayLinkInfo } from "../lib/relay-client-types.js";
import { instanceKeySync } from "../lib/instance-key.js";
import { ensurePeerIngressPort } from "../lib/peer-ingress-config.js";
import { configuredPeerIngressPort, DEFAULT_BRIDGE_PORT } from "../lib/bridge-url.js";
import { bridgeHttpBase, bridgePortOf } from "../lib/bridge-port.js";
import { repoEnvVar } from "../lib/env-file.js";
import { REPO_ROOT } from "../lib/repo-root.js";
import { webPortFromStartScript } from "../lib/cli-install.js";
import { readPeers } from "../lib/peers.js";
import { FP_RE, slugify, type PeerRecord } from "../lib/relay-protocol.js";
import { NULL_BODY_STATUS, recordToHeaders } from "../lib/relay-stream.js";
import { syncPeerIngress } from "./peer-ingress.js";
import { makeInboundHandler } from "./relay-inbound.js";

let client: RelayClient | null = null;
let contactsTimer: ReturnType<typeof setInterval> | null = null;
const CONTACTS_EVERY_MS = 15_000;

export function relayClient(): RelayClient | null {
  return client;
}

/** 单测注入假客户端；生产不调 */
export function setRelayClientForTest(c: RelayClient | null): void {
  client = c;
}

export function relayInfo(): RelayLinkInfo {
  const relayUrl = repoEnvVar("RELAY_URL").trim() || null;
  const i = client?.info();
  return {
    enabled: !!relayUrl,
    connected: !!i?.connected,
    state: i?.state ?? null,
    fp: i?.fp ?? null,
    slug: i?.slug ?? null,
    base: i?.base ?? null,
    url: i?.slug && i.base ? `https://${i.slug}.${i.base}` : null,
    relayUrl,
    retryAt: i?.retryAt ?? null,
    lastError: i?.lastError ?? null,
  };
}

/** 中继报的联系人在线状态（只有双向联系人才有） */
export function relayPresence(fp: string | undefined): PeerRecord | null {
  if (!fp || !client) return null;
  return client.peers().find((p) => p.fp === fp) ?? null;
}

/** peers.json 里记了指纹的 peer 就是联系人；变了才会真的发帧（client 自己比对） */
export async function refreshRelayContacts(): Promise<void> {
  if (!client) return;
  const peers = (await readPeers()).httpPeers ?? [];
  client.setContacts(peers.filter((p) => !p.disabled && p.fp && FP_RE.test(p.fp)).map((p) => p.fp!));
}

/** Web 的端口：WEB_PORT 显式配置 > web/package.json 的 start 脚本 > 默认 */
function resolveWebPort(): number {
  const env = Number(repoEnvVar("WEB_PORT"));
  if (Number.isInteger(env) && env > 0) return env;
  try {
    const pkg = JSON.parse(readFileSync(`${REPO_ROOT}/web/package.json`, "utf8")) as { scripts?: { start?: string } };
    return webPortFromStartScript(pkg.scripts?.start);
  } catch {
    return webPortFromStartScript(undefined); // web 没装：用默认端口，隧道请求会得到 local_unreachable，日志里看得到
  }
}

/** bridge 启动时调一次。没配 RELAY_URL 立刻返回；连接失败由客户端库自己退避重连，这里不抛 */
export async function startRelayLink(): Promise<void> {
  const relayUrl = repoEnvVar("RELAY_URL").trim();
  if (!relayUrl || client) return;
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
  const ingressPort = port;
  const webBase = `http://127.0.0.1:${resolveWebPort()}`;
  const log = (level: "info" | "warn" | "error", msg: string) => (level === "info" ? console.log : console.error)(`🛰 中继: ${msg}`);
  client = connect({
    relayUrl,
    key,
    name: hostname(),
    slug: slugify(repoEnvVar("RELAY_NAME").trim() || hostname()),
    onInbound: makeInboundHandler({
      webBase,
      ingressBase: () => (ingressPort ? `http://127.0.0.1:${ingressPort}` : null),
      onRedeemed: () => void refreshRelayContacts(),
    }),
    onWelcome: (i) => {
      log("info", `这台机器的网页地址：https://${i.slug}.${i.base}（手机 / 浏览器不装任何东西就能打开）`);
      void refreshRelayContacts();
    },
    log,
  });
  if (!contactsTimer) contactsTimer = setInterval(() => void refreshRelayContacts(), CONTACTS_EVERY_MS);
}

export interface PeerFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/** 超时类的中继错误按 TimeoutError 抛：http-peer 的结局分类靠 name 认「可能已送达，别重发」 */
const TIMEOUT_CODES = new Set(["timeout", "local_timeout", "peer_disconnected", "connection_lost", "stream_idle"]);

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
  if (!client) throw new Error(`relay 未启用：本机 .env 没配 RELAY_URL，调不了 ${u.hostname}`);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v;
  const body = init.body ? new TextEncoder().encode(init.body) : null;
  let r;
  try {
    r = await client.request(u.hostname, { method: (init.method ?? "GET").toUpperCase(), path: u.pathname + u.search, headers, body }, { timeoutMs: opts.timeoutMs, signal: init.signal });
  } catch (e) {
    throw relayFetchError(e);
  }
  return new Response(NULL_BODY_STATUS.has(r.status) ? null : r.body, { status: r.status, headers: recordToHeaders(r.headers) });
}
