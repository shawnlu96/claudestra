/** Pure status/serve parsing and HTTPS planning; runtime queries stay in tailscale.ts. */

export interface TailscaleStatus {
  /** Running / NeedsLogin / Stopped / NoState / Starting … 原样保留 */
  backendState: string;
  running: boolean;
  /** Self.DNSName 去掉末尾的点，形如 my-mac.tail0000.ts.net；MagicDNS 关闭时为空 */
  dnsName: string;
  hostName: string;
  ipv4: string[];
  ipv6: string[];
  magicDNS: boolean;
  /** CertDomains 非空 = tailnet 管理后台开了 HTTPS 证书功能 */
  httpsEnabled: boolean;
  certDomains: string[];
  /** NeedsLogin 时 tailscaled 给的登录链接（可能为空） */
  authUrl: string;
  version: string;
}

type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function parseTailscaleStatus(json: unknown): TailscaleStatus | null {
  if (!isObj(json)) return null;
  const self = isObj(json.Self) ? json.Self : {};
  const tailnet = isObj(json.CurrentTailnet) ? json.CurrentTailnet : {};
  const ips = strArr(json.TailscaleIPs).length ? strArr(json.TailscaleIPs) : strArr(self.TailscaleIPs);
  const backendState = typeof json.BackendState === "string" ? json.BackendState : "";
  const certDomains = strArr(json.CertDomains);
  return {
    backendState,
    running: backendState === "Running",
    dnsName: typeof self.DNSName === "string" ? self.DNSName.replace(/\.$/, "") : "",
    hostName: typeof self.HostName === "string" ? self.HostName : "",
    ipv4: ips.filter((ip) => ip.includes(".")),
    ipv6: ips.filter((ip) => ip.includes(":")),
    magicDNS: tailnet.MagicDNSEnabled === true,
    httpsEnabled: certDomains.length > 0,
    certDomains,
    authUrl: typeof json.AuthURL === "string" ? json.AuthURL : "",
    version: typeof json.Version === "string" ? json.Version : "",
  };
}

/** `tailscale serve status --json` 里的一条 HTTP 处理器 */
export interface ServeHandler {
  host: string;
  port: number;
  path: string;
  /** 反代目标，如 http://127.0.0.1:3333；静态文件/文本处理器为空 */
  proxy: string;
}

export interface ServeState {
  /** serve 占用的 TCP 端口（含 HTTPS 与 TCP 转发） */
  ports: number[];
  handlers: ServeHandler[];
}

/**
 * 解析 ServeConfig：`{TCP:{"443":{HTTPS:true}}, Web:{"host:443":{Handlers:{"/":{Proxy}}}}}`。
 * 没配置时 CLI 输出 `{}`。
 */
export function parseServeStatus(json: unknown): ServeState {
  const out: ServeState = { ports: [], handlers: [] };
  if (!isObj(json)) return out;
  if (isObj(json.TCP)) {
    for (const k of Object.keys(json.TCP)) {
      const n = Number(k);
      if (Number.isInteger(n) && n > 0) out.ports.push(n);
    }
  }
  if (isObj(json.Web)) {
    for (const [hostPort, cfg] of Object.entries(json.Web)) {
      const m = /^(.*):(\d+)$/.exec(hostPort);
      if (!m || !isObj(cfg) || !isObj(cfg.Handlers)) continue;
      for (const [path, h] of Object.entries(cfg.Handlers)) {
        out.handlers.push({
          host: m[1],
          port: Number(m[2]),
          path,
          proxy: isObj(h) && typeof h.Proxy === "string" ? h.Proxy : "",
        });
      }
    }
  }
  out.ports.sort((a, b) => a - b);
  return out;
}

/** 反代目标是不是本机的 web 端口（serve 接受 `3333` / `localhost:3333` / `http://127.0.0.1:3333` 多种写法） */
export function proxyTargetsPort(proxy: string, port: number): boolean {
  const m = /^(?:https?(?:\+insecure)?:\/\/)?(?:(127\.0\.0\.1|localhost|\[::1\]):)?(\d+)\/?$/.exec(proxy.trim());
  return !!m && Number(m[2]) === port;
}

/** serve 里已经把某个端口的根路径转发到本机 web 的那条处理器 */
export function findServeForPort(serve: ServeState, webPort: number): ServeHandler | null {
  return serve.handlers.find((h) => h.path === "/" && proxyTargetsPort(h.proxy, webPort)) ?? null;
}

export function httpsUrl(dnsName: string, port: number): string {
  return port === 443 ? `https://${dnsName}` : `https://${dnsName}:${port}`;
}

/** 给用户照抄/给变更函数用的 serve 参数。只加一个处理器；永远不 reset，不碰 funnel。 */
export function serveArgs(httpsPort: number, webPort: number): string[] {
  return ["serve", "--bg", `--https=${httpsPort}`, `http://127.0.0.1:${webPort}`];
}

// ============================================================
// HTTPS 入口决策（纯函数）
// ============================================================

export type HttpsPlan =
  | { kind: "not-installed" }
  | { kind: "need-login"; backendState: string; authUrl: string }
  | { kind: "no-magicdns" }
  | { kind: "reuse"; url: string; source: "serve" | "external" }
  | { kind: "need-https-enable"; dnsName: string }
  | { kind: "serve"; port: 443 | 8443; url: string; args: string[] }
  | { kind: "fallback-manual"; reason: string };

export interface PlanInput {
  cliFound: boolean;
  status: TailscaleStatus | null;
  serve: ServeState;
  webPort: number;
  /** 本机有非 serve 进程在监听 443（例如 Caddy）—— serve 再占会遮蔽它的 tailnet 流量 */
  port443Busy: boolean;
  port8443Busy?: boolean;
  /** 已探测通、且确认通到我们 web 的 HTTPS 入口 */
  workingEntry?: { url: string; source: "serve" | "external" } | null;
}

/**
 * 顺序即优先级：没装 → 没登录 → 已有能用的入口就复用（零改动）→ 没 MagicDNS / 没开 HTTPS
 * 只引导 → 443 空闲用 443 → 否则 8443 → 都不行回落手工方案。
 */
export function planHttps(i: PlanInput): HttpsPlan {
  if (!i.cliFound || !i.status) return { kind: "not-installed" };
  if (!i.status.running) return { kind: "need-login", backendState: i.status.backendState, authUrl: i.status.authUrl };
  if (i.workingEntry) return { kind: "reuse", url: i.workingEntry.url, source: i.workingEntry.source };
  if (!i.status.dnsName) return { kind: "no-magicdns" };
  const existing = findServeForPort(i.serve, i.webPort);
  if (existing) {
    // serve 已经配好，只是这次没探测通（web 还没起来等）—— 仍然复用，不再加一条
    return { kind: "reuse", url: httpsUrl(i.status.dnsName, existing.port), source: "serve" };
  }
  if (!i.status.httpsEnabled) return { kind: "need-https-enable", dnsName: i.status.dnsName };
  const servePorts = new Set(i.serve.ports);
  if (!i.port443Busy && !servePorts.has(443)) {
    return { kind: "serve", port: 443, url: httpsUrl(i.status.dnsName, 443), args: serveArgs(443, i.webPort) };
  }
  if (!i.port8443Busy && !servePorts.has(8443)) {
    return { kind: "serve", port: 8443, url: httpsUrl(i.status.dnsName, 8443), args: serveArgs(8443, i.webPort) };
  }
  return { kind: "fallback-manual", reason: "443 与 8443 都已被占用" };
}

