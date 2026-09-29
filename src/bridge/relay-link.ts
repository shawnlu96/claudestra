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
import { connect, RelayError, type RelayClient } from "../lib/relay-client.js";
import { relayCallError } from "../lib/peer-auth-hints.js";
import type { RelayLinkInfo } from "../lib/relay-client-types.js";
import { instanceKeySync, signedHeaders } from "../lib/instance-key.js";
import { createE2eOutbound, defaultOutboundDeps } from "../lib/peer-e2e-outbound.js";
import { E2E_RESPONSE_WIRE_MAX } from "../lib/peer-e2e-wire.js";
import { ensurePeerIngressPort, resolveWebPort, writeEnvKeys } from "../lib/peer-ingress-config.js";
import { DEFAULT_RELAY_URL, normalizeRelayUrl } from "../lib/setup-remote-access.js";
import { configuredPeerIngressPort, DEFAULT_BRIDGE_PORT } from "../lib/bridge-url.js";
import { bridgeHttpBase, bridgePortOf } from "../lib/bridge-port.js";
import { repoEnvVar } from "../lib/env-file.js";
import { sandboxDisabled } from "../lib/sandbox.js";
import { readPeers } from "../lib/peers.js";
import { loadRelayPeerView, relayPeerRefusal } from "../lib/peer-trust.js";
import { FP_RE, slugify, type PeerRecord } from "../lib/relay-protocol.js";
import { NULL_BODY_STATUS, recordToHeaders } from "../lib/relay-stream.js";
import { syncPeerIngress } from "./peer-ingress.js";
import { makeInboundHandler } from "./relay-inbound.js";
import type { ApiHandler } from "./relay-dispatch.js";

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

/** 启动时的依赖留着：网页上一键接入中继时（enableRelay）当场连，用同一套 */
let startDeps: { handleApi?: ApiHandler } = {};

/** bridge 启动时调一次。没配 RELAY_URL 立刻返回；连接失败由客户端库自己退避重连，这里不抛 */
export async function startRelayLink(deps: { handleApi?: ApiHandler } = {}): Promise<void> {
  startDeps = deps;
  const relayUrl = repoEnvVar("RELAY_URL").trim();
  if (!relayUrl || client || sandboxDisabled("中继")) return; // 沙箱不用生产实例身份连中继（lib/sandbox.ts）
  const key = instanceKeySync();
  if (!key) {
    console.error("⚠️ 中继：本机没有实例密钥（instance-key.pem 读写失败），不连中继");
    return;
  }
  let port = configuredPeerIngressPort({ PEER_INGRESS_PORT: repoEnvVar("PEER_INGRESS_PORT") });
  if (!port) {
    // 没做过 HTTPS 步骤的机器还没有 peer 入口端口：现在挑一个写进 .env，再让入口立刻开起来
    port = await ensurePeerIngressPort(bridgePortOf(bridgeHttpBase()) ?? DEFAULT_BRIDGE_PORT, resolveWebPort());
    if (port) await syncPeerIngress();
    else console.error("⚠️ 中继：附近端口全被占，peer 入口开不出来——对方经中继调我会得到 local_unreachable");
  }
  const ingressPort = port;
  const webPort = resolveWebPort();
  const webBase = `http://127.0.0.1:${webPort}`;
  if (ingressPort === webPort) console.error(`⚠️ 中继：peer 入口端口和网页端口都是 ${webPort}，子域名隧道一律拒绝（local_unreachable）——改 .env 的 PEER_INGRESS_PORT 或 WEB_PORT`);
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
      handleApi: deps.handleApi,
      refusePeer: async (from, req) => relayPeerRefusal(from, req, await loadRelayPeerView()),
    }),
    onWelcome: (i) => {
      log("info", `这台机器的网页地址：https://${i.slug}.${i.base}（手机 / 浏览器不装任何东西就能打开）`);
      void refreshRelayContacts();
    },
    log,
  });
  if (!contactsTimer) contactsTimer = setInterval(() => void refreshRelayContacts(), CONTACTS_EVERY_MS);
}

export type EnableRelayResult = { ok: true; relayUrl: string } | { ok: false; status: 400 | 409; error: string };

/**
 * Peer 面板「一键接入中继」：.env 写 RELAY_URL（不给地址 = 官方中继）后当场连上，不用重启 bridge。
 * 已经配了的不动（换地址改 .env 或重跑 setup）；沙箱不写仓库 .env、也不拿生产身份连中继。RELAY_NAME 不写：没写就按主机名取
 */
export async function enableRelay(
  requested: unknown,
  d = { current: () => repoEnvVar("RELAY_URL").trim(), write: writeEnvKeys, start: () => startRelayLink(startDeps), sandbox: () => sandboxDisabled("中继") },
): Promise<EnableRelayResult> {
  const off = d.sandbox();
  if (off) return { ok: false, status: 409, error: off };
  if (d.current()) return { ok: false, status: 409, error: "已经配了 RELAY_URL：要换地址改 .env 或重跑 bun run setup" };
  const relayUrl = normalizeRelayUrl(typeof requested === "string" && requested.trim() ? requested : DEFAULT_RELAY_URL);
  if (!relayUrl) return { ok: false, status: 400, error: "中继地址不对：写 wss://<主机> 或主机名" };
  await d.write({ RELAY_URL: relayUrl });
  await d.start();
  return { ok: true, relayUrl };
}

export interface PeerFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
}

/**
 * 中继报的错（error 帧、ws 关闭原因）code 与说明都可能出自中继：给调用方的只有清洗过的 code 与本机的提示（lib/peer-auth-hints.ts），
 * 说明原文只进日志，并标明未经认证
 */
function relayFetchError(e: unknown): Error {
  if (!(e instanceof RelayError)) return e instanceof Error ? e : new Error(String(e));
  const err = relayCallError(e);
  console.warn(`⚠️ [relay] peer 调用失败 ${err.code}；未经认证的说明（只供排查）: ${JSON.stringify(String(e.message).slice(0, 200))}`);
  return err;
}

/** 发往 required peer 的一律包进 E2E 会话（lib/peer-e2e-outbound.ts）；外层签名在这里加，内层由调用方照旧签 */
const e2eOutbound = createE2eOutbound({ ...defaultOutboundDeps(), sign: (method, path, body) => signedHeaders(method, path, body) });
type PeerFetchOpts = { fetchImpl?: typeof fetch; timeoutMs?: number };

/**
 * 所有 peer 调用的唯一出口：目标是 required peer → 走 E2E（走不了就抛错，绝不退回明文）；否则明文照旧。
 * 调用方的 signal / 超时一并带进会话里的每一次外层请求。
 */
export async function peerFetch(url: string, init: PeerFetchInit, opts: PeerFetchOpts = {}): Promise<Response> {
  const viaE2e = await e2eOutbound.fetch(url, init, (u, outer) => rawPeerFetch(u, { ...outer, ...(init.signal ? { signal: init.signal } : {}) }, opts));
  return viaE2e ?? rawPeerFetch(url, init, opts);
}

/**
 * 传输层：`relay://<指纹>/api/v1/...` 经中继，其余原样交给 fetchImpl。
 * 路径取 URL 的 pathname + search——与 instance-key.ts 的 signedFor 同一口径，对方按同一串验签。
 */
async function rawPeerFetch(url: string, init: PeerFetchInit, opts: PeerFetchOpts): Promise<Response> {
  if (!url.startsWith("relay://")) return (opts.fetchImpl ?? fetch)(url, init as RequestInit);
  const u = new URL(url);
  if (!client) throw new Error(`relay 未启用：本机 .env 没配 RELAY_URL，调不了 ${u.hostname}`);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v;
  const body = !init.body ? null : typeof init.body === "string" ? new TextEncoder().encode(init.body) : init.body;
  let r;
  try {
    const limits = { timeoutMs: opts.timeoutMs, signal: init.signal, maxResponseBytes: E2E_RESPONSE_WIRE_MAX }; // 响应总量封顶：中继能灌无限的 data 帧
    r = await client.request(u.hostname, { method: (init.method ?? "GET").toUpperCase(), path: u.pathname + u.search, headers, body }, limits);
  } catch (e) {
    throw relayFetchError(e);
  }
  return new Response(NULL_BODY_STATUS.has(r.status) ? null : r.body, { status: r.status, headers: recordToHeaders(r.headers) });
}
