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
import { existsSync, readFileSync, rmSync } from "node:fs";
import { ensurePeerIngressPort, resolveWebPort, saveEnvText, writeEnvKeys } from "../lib/peer-ingress-config.js";
import { acquireLock } from "../lib/file-lock.js";
import { statePath } from "../lib/paths.js";
import { REPO_ROOT } from "../lib/repo-root.js";
import { DEFAULT_RELAY_URL, normalizeRelayUrl } from "../lib/setup-remote-access.js";
import { configuredPeerIngressPort, DEFAULT_BRIDGE_PORT } from "../lib/bridge-url.js";
import { bridgeHttpBase, bridgePortOf } from "../lib/bridge-port.js";
import { repoEnvVar } from "../lib/env-file.js";
import { sandboxDisabled, sandboxDisabledOutsideLab, sandboxRelayUrlProblem } from "../lib/sandbox.js";
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

export type RelayStart = { ok: true } | { ok: false; error: string };

/**
 * bridge 启动时调一次，网页一键接入时（enableRelay）再调。连上 / 已在连 = ok；连中继失败由客户端库自己退避重连，
 * 那是「离线在重连」，不算失败。失败 = 这台机器根本连不了：没配地址、沙箱、没有实例密钥、客户端建不起来
 */
export async function startRelayLink(deps: { handleApi?: ApiHandler } = {}): Promise<RelayStart> {
  startDeps = deps;
  const relayUrl = repoEnvVar("RELAY_URL").trim();
  if (client) return { ok: true };
  if (!relayUrl) return { ok: false, error: "没配 RELAY_URL" };
  // 沙箱不连中继；lab 模式只连 lab 自己在回环上起的中继（lib/sandbox-lab.ts），身份是沙箱状态目录里的实例密钥
  const off = sandboxDisabledOutsideLab("中继") ?? sandboxRelayUrlProblem(relayUrl);
  if (off) return { ok: false, error: off };
  const key = instanceKeySync();
  if (!key) {
    console.error("⚠️ 中继：本机没有实例密钥（instance-key.pem 读写失败），不连中继");
    return { ok: false, error: "本机没有实例密钥（instance-key.pem 读写失败）" };
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
  if (ingressPort === webPort) console.error(`⚠️ 中继：peer 入口端口和网页端口都是 ${webPort}，子域名隧道一律拒绝（local_unreachable）——改 .env 的 PEER_INGRESS_PORT 或 WEB_PORT`);
  try {
    client = connectClient(relayUrl, key, ingressPort, webPort, deps);
  } catch (e) {
    console.error(`⚠️ 中继：客户端建不起来：${(e as Error).message}`);
    return { ok: false, error: `中继客户端建不起来：${(e as Error).message}` };
  }
  if (!contactsTimer) contactsTimer = setInterval(() => void refreshRelayContacts(), CONTACTS_EVERY_MS);
  return { ok: true };
}

/** 撤掉 startRelayLink 建的客户端和联系人定时器（一键接入失败回滚用） */
function stopRelayLink(): void {
  client?.close();
  client = null;
  if (contactsTimer) clearInterval(contactsTimer);
  contactsTimer = null;
}

function connectClient(relayUrl: string, key: NonNullable<ReturnType<typeof instanceKeySync>>, ingressPort: number | null, webPort: number,
  deps: { handleApi?: ApiHandler }): RelayClient {
  const webBase = `http://127.0.0.1:${webPort}`;
  const log = (level: "info" | "warn" | "error", msg: string) => (level === "info" ? console.log : console.error)(`🛰 中继: ${msg}`);
  return connect({
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
}

export type EnableRelayResult =
  | { ok: true; relayUrl: string; state: string | null }
  | { ok: false; status: 400 | 409 | 500; error: string };

export interface EnableRelayDeps {
  envPath: string;
  /** 机器级的一把锁：同时点两下 / 两个页面同时点，后到的直接 409，不排队重做一遍 */
  lockPath: string;
  sandbox: () => string | null;
  /** 锁里重读：进程环境 + .env 文件，锁外读的不作数 */
  current: () => string;
  start: () => Promise<RelayStart>;
  /** start 失败、.env 已恢复之后：关掉可能建出的客户端，按恢复后的 .env 收回 start 顺手开的 peer 入口 */
  undo: () => Promise<void>;
  /** 接上以后的连接状态（离线在重连也算接入成功，前端单列显示） */
  state: () => string | null;
}

const liveEnableDeps = (): EnableRelayDeps => ({
  envPath: `${REPO_ROOT}/.env`,
  lockPath: statePath("env-write.lock"),
  sandbox: () => sandboxDisabled("中继"),
  current: () => repoEnvVar("RELAY_URL").trim(),
  start: () => startRelayLink(startDeps),
  undo: async () => {
    stopRelayLink();
    await syncPeerIngress();
  },
  state: () => client?.info().state ?? null,
});

/**
 * Peer 面板「一键接入中继」：.env 写 RELAY_URL（不给地址 = 官方中继）后当场连上，不用重启 bridge。
 * 已经配了的不动（换地址改 .env 或重跑 setup）；沙箱不写仓库 .env、也不拿生产身份连中继。RELAY_NAME 不写：没写就按主机名取。
 * 连不了（没实例密钥等，见 startRelayLink）就把 .env 恢复成写之前的原样、撤掉副作用，不留半套配置
 */
export async function enableRelay(requested: string | undefined, d: EnableRelayDeps = liveEnableDeps()): Promise<EnableRelayResult> {
  const off = d.sandbox();
  if (off) return { ok: false, status: 409, error: off };
  const relayUrl = normalizeRelayUrl(requested ?? DEFAULT_RELAY_URL);
  if (!relayUrl) return { ok: false, status: 400, error: "中继地址不对：写 wss://<主机> 或主机名（不能带空白和 $）" };
  const lock = await acquireLock(d.lockPath, 0);
  if (!lock) return { ok: false, status: 409, error: "另一次接入正在进行，稍后刷新看结果" };
  try {
    if (d.current()) return { ok: false, status: 409, error: "已经配了 RELAY_URL：要换地址改 .env 或重跑 bun run setup" };
    const snapshot = existsSync(d.envPath) ? readFileSync(d.envPath, "utf8") : null;
    await writeEnvKeys({ RELAY_URL: relayUrl }, d.envPath);
    const r = await d.start().catch((e: unknown): RelayStart => ({ ok: false, error: (e as Error).message }));
    if (r.ok) return { ok: true, relayUrl, state: d.state() };
    if (snapshot === null) rmSync(d.envPath, { force: true });
    else saveEnvText(d.envPath, snapshot);
    await d.undo();
    return { ok: false, status: 500, error: `接不上中继，.env 已恢复原样：${r.error}` };
  } finally {
    lock.release();
  }
}

/**
 * POST /relay/setup 的请求体：空 body / {} = 官方中继，{relayUrl: "<地址>"} = 指定地址；
 * 坏 JSON、别的字段、relayUrl 不是非空字符串一律 400——拼错字段名（{url}）悄悄退回官方中继比报错更糟
 */
export function parseRelaySetup(text: string): { ok: true; relayUrl?: string } | { ok: false; error: string } {
  if (!text.trim()) return { ok: true };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, error: "请求体不是 JSON" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "请求体要是对象" };
  const extra = Object.keys(body).filter((k) => k !== "relayUrl");
  if (extra.length) return { ok: false, error: `不认识的字段：${extra.join(", ")}` };
  const v = (body as { relayUrl?: unknown }).relayUrl;
  if (v === undefined) return { ok: true };
  if (typeof v !== "string" || !v.trim()) return { ok: false, error: "relayUrl 要是非空字符串" };
  return { ok: true, relayUrl: v };
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
/** e2eOnly：目标此刻不是 E2E peer（刚被禁用、地址变了）就抛错不发——出借推送用，事前检查和这里之间 peers.json 可能变 */
type PeerFetchOpts = { fetchImpl?: typeof fetch; timeoutMs?: number; e2eOnly?: boolean };

/**
 * 所有 peer 调用的唯一出口：目标是 required peer → 走 E2E（走不了就抛错，绝不退回明文）；否则明文照旧。
 * 调用方的 signal / 超时一并带进会话里的每一次外层请求。
 */
export async function peerFetch(url: string, init: PeerFetchInit, opts: PeerFetchOpts = {}): Promise<Response> {
  const viaE2e = await e2eOutbound.fetch(url, init, (u, outer) => rawPeerFetch(u, { ...outer, ...(init.signal ? { signal: init.signal } : {}) }, opts));
  if (!viaE2e && opts.e2eOnly) throw new Error("目标不是端到端加密的 peer（可能刚被禁用或地址变了），不发明文");
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
