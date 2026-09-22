/**
 * Tailscale 集成的唯一入口：CLI 定位、状态解析、HTTPS 入口决策、入口探测。
 *
 * 为什么单独一个模块：
 *   - CLI 定位此前写了三套（manager / tls-proxy / setup 的提示），而且 setup 打印的是裸
 *     `tailscale` —— macOS App 版（Standalone / App Store）的 CLI 在 App 包里，不在 PATH；
 *     launchd 的 PATH 更短，bridge 里调裸命令必然找不到。
 *   - 地址/主机名一律以 `tailscale status --json` 为准，运行时读，绝不写死：这个仓库要给
 *     别人用（owner 硬约束）。测试夹具只用 my-mac.tail0000.ts.net / 100.64.0.1 这类占位值。
 *
 * 结构：纯函数（解析 / 决策，单测覆盖）→ 只读查询（bridge、doctor、setup 都能调）→
 * 变更（只有 setup 在用户明确同意后调用；bridge 与网页永远不改机器配置）。
 * funnel（公网暴露）不在这里出现，也不会作为任何默认。
 */

import { existsSync } from "fs";
import { connect as tlsConnect } from "tls";

// ============================================================
// CLI 定位
// ============================================================

/** PATH 之外的已知安装位置。App 包内路径排第一：macOS 上最常见、又最不会进 PATH。 */
export const TAILSCALE_CLI_FALLBACKS = [
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/usr/bin/tailscale",
];

/**
 * 纯函数版定位：显式覆盖 → PATH → 已知位置。`exists` 注入便于单测。
 * 覆盖用环境变量 TAILSCALE_CLI（沿用 tls-proxy 的 TLS_PROXY_TS_CLI 也认）。
 */
export function pickTailscaleCli(
  env: Record<string, string | undefined>,
  exists: (p: string) => boolean,
): string | null {
  for (const o of [env.TAILSCALE_CLI, env.TLS_PROXY_TS_CLI]) {
    if (o && exists(o)) return o;
  }
  for (const dir of (env.PATH || "").split(":")) {
    if (!dir) continue;
    const p = `${dir.replace(/\/+$/, "")}/tailscale`;
    if (exists(p)) return p;
  }
  for (const p of TAILSCALE_CLI_FALLBACKS) if (exists(p)) return p;
  return null;
}

export function resolveTailscaleCli(): string | null {
  return pickTailscaleCli(process.env, existsSync);
}

// ============================================================
// 状态解析（纯函数）
// ============================================================

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
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
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

/** 打印命令时给 CLI 路径加引号（App 包路径本身没空格，但用户覆盖的路径可能有） */
export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
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

/** 证书剩余天数的三档：≥21 ok，7–21 warn，<7 或已过期 fail（ts.net 证书 90 天有效） */
export function certVerdict(daysLeft: number): "ok" | "warn" | "fail" {
  if (daysLeft >= 21) return "ok";
  if (daysLeft >= 7) return "warn";
  return "fail";
}

/**
 * 新签出的证书能不能替换旧的（续签脚本用）：SAN 必须含本机 ts.net 名、有效期要够、私钥配对。
 * 任何一项不过都保留旧证书 —— 换上一张坏证书比临期更糟（入口立刻全断）。
 */
export function validateCertCandidate(c: {
  host: string;
  subjectAltName: string;
  validTo: string;
  keyMatches: boolean;
  now?: number;
  minDays?: number;
}): { ok: true; daysLeft: number } | { ok: false; reason: string } {
  const sans = c.subjectAltName.split(",").map((x) => x.trim().replace(/^DNS:/, "").toLowerCase());
  if (!sans.includes(c.host.toLowerCase())) return { ok: false, reason: `证书 SAN 不含 ${c.host}` };
  const to = Date.parse(c.validTo);
  if (!Number.isFinite(to)) return { ok: false, reason: "读不出有效期" };
  const daysLeft = (to - (c.now ?? Date.now())) / 86_400_000;
  if (daysLeft < (c.minDays ?? 30)) return { ok: false, reason: `新证书只剩 ${Math.floor(daysLeft)} 天` };
  if (!c.keyMatches) return { ok: false, reason: "私钥与证书不配对" };
  return { ok: true, daysLeft };
}

/** `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fcn` 的输出 → [{command, addr}] */
export function parseLsofListen(out: string): { command: string; addr: string }[] {
  const res: { command: string; addr: string }[] = [];
  let cmd = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) cmd = "";
    else if (line.startsWith("c")) cmd = line.slice(1);
    else if (line.startsWith("n")) res.push({ command: cmd, addr: line.slice(1) });
  }
  return res;
}

/** 监听地址是不是通配（*:3333 / 0.0.0.0:3333 / [::]:3333）—— 即局域网/tailnet 都能直连明文 */
export function isWildcardBind(addr: string): boolean {
  return /^(\*|0\.0\.0\.0|\[::\]|::):\d+$/.test(addr);
}

/** 本地 /api/version 与入口返回的是否同一个 web（比 version + webCommit，兼容旧版没有 webCommit） */
export function sameWebVersion(a: unknown, b: unknown): boolean {
  if (!isObj(a) || !isObj(b)) return false;
  if (typeof a.version !== "string" || a.version !== b.version) return false;
  return (a.webCommit ?? a.commit) === (b.webCommit ?? b.commit);
}

/** 看起来是不是 Claudestra 的 web（本地 web 没起来时的弱判据） */
export function looksLikeClaudestra(v: unknown): boolean {
  return isObj(v) && typeof v.version === "string" && typeof v.commit === "string";
}

// ============================================================
// 只读查询（I/O）
// ============================================================

async function runCli(cli: string, args: string[], timeoutMs = 5000): Promise<{ code: number; out: string; err: string }> {
  try {
    const proc = Bun.spawn([cli, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    clearTimeout(timer);
    return { code, out, err };
  } catch (e) {
    return { code: -1, out: "", err: (e as Error).message };
  }
}

/** 原始 status JSON（manager 的 tailnet 扫描要 Peer 列表，所以单独暴露） */
export async function readTailscaleStatusRaw(cli = resolveTailscaleCli()): Promise<unknown | null> {
  if (!cli) return null;
  const r = await runCli(cli, ["status", "--json"]);
  // 没登录时 status 可能非零退出但仍输出 JSON —— 以能否解析为准
  try { return r.out.trim().startsWith("{") ? JSON.parse(r.out) : null; } catch { return null; }
}

export async function readTailscaleStatus(cli = resolveTailscaleCli()): Promise<TailscaleStatus | null> {
  return parseTailscaleStatus(await readTailscaleStatusRaw(cli));
}

export async function readServeStatus(cli = resolveTailscaleCli()): Promise<ServeState> {
  if (!cli) return { ports: [], handlers: [] };
  const r = await runCli(cli, ["serve", "status", "--json"]);
  try { return parseServeStatus(JSON.parse(r.out || "{}")); } catch { return { ports: [], handlers: [] }; }
}

/** 谁在监听这个端口；lsof 不可用返回 null（调用方按「未知」处理，不当成空闲） */
export async function listListeners(port: number): Promise<{ command: string; addr: string }[] | null> {
  try {
    const proc = Bun.spawn(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fcn"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return parseLsofListen(out);
  } catch {
    return null;
  }
}

/** 非 tailscale 进程在监听该端口（serve 的监听在 tailscaled / 网络扩展里，不算「被别人占」） */
export async function portBusyByOthers(port: number): Promise<boolean> {
  const ls = await listListeners(port);
  if (ls === null) return true; // 看不清就保守：别去抢
  return ls.some((l) => !/tailscale/i.test(l.command));
}

export async function fetchJson(url: string, timeoutMs = 4000): Promise<unknown | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/** TLS 握手取证书剩余天数；不校验链（过期证书也要能报天数），authorized 单独给出 */
export function certDaysLeft(host: string, port: number, timeoutMs = 4000): Promise<{ daysLeft: number; authorized: boolean } | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: { daysLeft: number; authorized: boolean } | null) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(v);
    };
    const sock = tlsConnect({ host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = sock.getPeerCertificate();
      const to = cert?.valid_to ? Date.parse(cert.valid_to) : NaN;
      finish(Number.isFinite(to) ? { daysLeft: (to - Date.now()) / 86_400_000, authorized: sock.authorized } : null);
    });
    sock.on("error", () => finish(null));
    sock.on("timeout", () => finish(null));
  });
}

export interface EntryProbe {
  url: string;
  secure: boolean;
  source: "serve" | "external" | "tailnet-ip";
  reachable: boolean;
  /** 返回的 /api/version 与本机 web 一致（本机 web 不在时退化为「像 Claudestra」） */
  matchesLocal: boolean;
  certDaysLeft?: number;
  certValid?: boolean;
}

export async function probeEntry(
  url: string,
  source: EntryProbe["source"],
  local: unknown | null,
): Promise<EntryProbe> {
  const secure = url.startsWith("https://");
  const v = await fetchJson(`${url}/api/version`);
  const probe: EntryProbe = {
    url, secure, source,
    reachable: v !== null,
    matchesLocal: local ? sameWebVersion(local, v) : looksLikeClaudestra(v),
  };
  if (secure) {
    const u = new URL(url);
    const c = await certDaysLeft(u.hostname, Number(u.port || 443));
    if (c) { probe.certDaysLeft = Math.round(c.daysLeft * 10) / 10; probe.certValid = c.authorized; }
  }
  return probe;
}

export interface RemoteAccessReport {
  tailscale: {
    installed: boolean;
    cli: string | null;
    backendState: string;
    running: boolean;
    dnsName: string;
    ipv4: string[];
    magicDNS: boolean;
    httpsEnabled: boolean;
  };
  webPort: number;
  /** web 的监听地址（lsof），通配 = 明文入口对 LAN/tailnet 开着 */
  webBind: string[];
  servePorts: number[];
  entries: EntryProbe[];
  /** 其它进程在监听 443（serve 若也占 443 会与之冲突） */
  others443: string[];
}

/**
 * 汇总一次「手机访问」现状：只读，bridge / doctor / setup 共用。
 * 候选入口：serve 里指向 web 的处理器 → ts.net 的 443（可能是 Caddy 之类外部反代）→ tailnet IP 明文。
 */
export async function collectRemoteAccess(webPort: number): Promise<RemoteAccessReport> {
  const cli = resolveTailscaleCli();
  const [status, serve, webLs, ls443, local] = await Promise.all([
    readTailscaleStatus(cli),
    readServeStatus(cli),
    listListeners(webPort),
    listListeners(443),
    fetchJson(`http://127.0.0.1:${webPort}/api/version`, 2000),
  ]);
  const report: RemoteAccessReport = {
    tailscale: {
      installed: !!cli,
      cli,
      backendState: status?.backendState ?? "",
      running: !!status?.running,
      dnsName: status?.dnsName ?? "",
      ipv4: status?.ipv4 ?? [],
      magicDNS: !!status?.magicDNS,
      httpsEnabled: !!status?.httpsEnabled,
    },
    webPort,
    webBind: (webLs ?? []).map((l) => l.addr),
    servePorts: serve.ports,
    entries: [],
    others443: (ls443 ?? []).filter((l) => !/tailscale/i.test(l.command)).map((l) => l.command),
  };
  if (!status?.running) return report;

  const cands: { url: string; source: EntryProbe["source"] }[] = [];
  if (status.dnsName) {
    const h = findServeForPort(serve, webPort);
    if (h) cands.push({ url: httpsUrl(status.dnsName, h.port), source: "serve" });
    if (!h || h.port !== 443) cands.push({ url: httpsUrl(status.dnsName, 443), source: serve.ports.includes(443) ? "serve" : "external" });
  }
  if (status.ipv4[0]) cands.push({ url: `http://${status.ipv4[0]}:${webPort}`, source: "tailnet-ip" });

  const probes = await Promise.all(cands.map((c) => probeEntry(c.url, c.source, local)));
  // ts.net:443 连 TLS 都握不上 = 那里没有入口，不列（否则面板多一条噪音）；握得上就列，
  // 哪怕 HTTP 不通 —— 证书过期正是这种样子，doctor 要能报出来
  report.entries = probes.filter((p) => p.source !== "external" || p.reachable || p.certDaysLeft !== undefined);
  return report;
}

/** 已探测通、且确认是我们 web 的 HTTPS 入口（第一条） */
export function workingHttpsEntry(r: RemoteAccessReport): { url: string; source: "serve" | "external" } | null {
  const e = r.entries.find((x) => x.secure && x.reachable && x.matchesLocal && x.certValid !== false);
  return e && e.source !== "tailnet-ip" ? { url: e.url, source: e.source } : null;
}

/**
 * 给网页「手机访问」面板用的快照：现状 + 建议（纯只读）。60 秒缓存 —— 每次都探测要起
 * 几个子进程、做几次 TLS 握手，面板开关一次就是一轮，没必要。
 */
let snapCache: { at: number; port: number; data: RemoteAccessSnapshot } | null = null;

export interface RemoteAccessSnapshot extends RemoteAccessReport {
  plan: HttpsPlan;
  /** plan 为 serve 时给一条可复制的命令（CLI 绝对路径）；网页只展示，不执行 */
  suggestedCommand: string | null;
  checkedAt: string;
}

export async function remoteAccessSnapshot(webPort: number, maxAgeMs = 60_000): Promise<RemoteAccessSnapshot> {
  if (snapCache && snapCache.port === webPort && Date.now() - snapCache.at < maxAgeMs) return snapCache.data;
  const r = await collectRemoteAccess(webPort);
  const cli = r.tailscale.cli;
  const [status, serve, busy8443] = await Promise.all([
    readTailscaleStatus(cli),
    readServeStatus(cli),
    portBusyByOthers(8443),
  ]);
  const plan = planHttps({
    cliFound: !!cli, status, serve, webPort,
    port443Busy: r.others443.length > 0, port8443Busy: busy8443,
    workingEntry: workingHttpsEntry(r),
  });
  const data: RemoteAccessSnapshot = {
    ...r,
    plan,
    suggestedCommand: plan.kind === "serve" && cli ? [shellQuote(cli), ...plan.args].join(" ") : null,
    checkedAt: new Date().toISOString(),
  };
  snapCache = { at: Date.now(), port: webPort, data };
  return data;
}

// ============================================================
// 变更（只在用户明确同意后由交互式 setup 调用）
// ============================================================

/**
 * 加一个 serve 处理器：https://<ts 名>:<port> → http://127.0.0.1:<webPort>。
 * 只加不删，不 reset（机器上可能已有别人的 serve 配置），不开 funnel。
 */
export async function applyServe(cli: string, httpsPort: number, webPort: number): Promise<{ ok: boolean; detail: string }> {
  const r = await runCli(cli, serveArgs(httpsPort, webPort), 20_000);
  return { ok: r.code === 0, detail: (r.err || r.out).trim().split("\n").slice(0, 3).join(" ") };
}
