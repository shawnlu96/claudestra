import { test, expect, describe } from "bun:test";
import {
  pickTailscaleCli,
  parseTailscaleStatus,
  parseServeStatus,
  proxyTargetsPort,
  findServeForPort,
  planHttps,
  certVerdict,
  parseLsofListen,
  isWildcardBind,
  sameWebVersion,
  looksLikeClaudestra,
  serveArgs,
  httpsUrl,
  shellQuote,
  workingHttpsEntry,
  validateCertCandidate,
  type PlanInput,
  type RemoteAccessReport,
} from "../src/lib/tailscale";

// 夹具一律用占位值 —— 真实主机名/tailnet/IP 不进公开仓库
const APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const STATUS_RUNNING = {
  Version: "1.98.8",
  BackendState: "Running",
  AuthURL: "",
  TailscaleIPs: ["100.64.0.1", "fd7a:115c:a1e0::1"],
  Self: { HostName: "my-mac", DNSName: "my-mac.tail0000.ts.net.", TailscaleIPs: ["100.64.0.1"] },
  CurrentTailnet: { Name: "someone@example.com", MagicDNSSuffix: "tail0000.ts.net", MagicDNSEnabled: true },
  CertDomains: ["my-mac.tail0000.ts.net"],
};

describe("pickTailscaleCli", () => {
  test("PATH 里有就用 PATH 的", () => {
    const has = new Set(["/opt/homebrew/bin/tailscale", APP]);
    expect(pickTailscaleCli({ PATH: "/usr/bin:/opt/homebrew/bin" }, (p) => has.has(p))).toBe("/opt/homebrew/bin/tailscale");
  });

  test("launchd 的短 PATH 下仍能找到 App 包内 CLI（此前 bridge 调裸 tailscale 必然失败）", () => {
    const has = new Set([APP]);
    expect(pickTailscaleCli({ PATH: "/usr/bin:/bin" }, (p) => has.has(p))).toBe(APP);
  });

  test("显式覆盖优先，旧的 TLS_PROXY_TS_CLI 也认", () => {
    const has = new Set(["/custom/ts", APP]);
    expect(pickTailscaleCli({ TAILSCALE_CLI: "/custom/ts" }, (p) => has.has(p))).toBe("/custom/ts");
    expect(pickTailscaleCli({ TLS_PROXY_TS_CLI: "/custom/ts" }, (p) => has.has(p))).toBe("/custom/ts");
  });

  test("覆盖指向不存在的文件时不盲信，继续往下找", () => {
    expect(pickTailscaleCli({ TAILSCALE_CLI: "/nope" }, (p) => p === APP)).toBe(APP);
  });

  test("哪里都没有 → null", () => {
    expect(pickTailscaleCli({ PATH: "/usr/bin" }, () => false)).toBeNull();
  });
});

describe("parseTailscaleStatus", () => {
  test("Running：DNSName 去掉末尾点，IPv4/IPv6 分开，CertDomains 非空 = HTTPS 已开", () => {
    const s = parseTailscaleStatus(STATUS_RUNNING)!;
    expect(s.running).toBe(true);
    expect(s.dnsName).toBe("my-mac.tail0000.ts.net");
    expect(s.ipv4).toEqual(["100.64.0.1"]);
    expect(s.ipv6).toEqual(["fd7a:115c:a1e0::1"]);
    expect(s.magicDNS).toBe(true);
    expect(s.httpsEnabled).toBe(true);
  });

  test("NeedsLogin 带登录链接；没开 HTTPS 时 CertDomains 缺省", () => {
    const s = parseTailscaleStatus({ BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/xyz", Self: {} })!;
    expect(s.running).toBe(false);
    expect(s.authUrl).toBe("https://login.tailscale.com/a/xyz");
    expect(s.httpsEnabled).toBe(false);
    expect(s.dnsName).toBe("");
  });

  test("非对象输入 → null", () => {
    expect(parseTailscaleStatus(null)).toBeNull();
    expect(parseTailscaleStatus("oops")).toBeNull();
    expect(parseTailscaleStatus([])).toBeNull();
  });
});

describe("parseServeStatus / findServeForPort", () => {
  test("空配置（CLI 输出 {}）", () => {
    expect(parseServeStatus({})).toEqual({ ports: [], handlers: [] });
  });

  test("TCP 端口与 Web 处理器都解析出来", () => {
    const s = parseServeStatus({
      TCP: { "8443": { HTTPS: true }, "443": { HTTPS: true } },
      Web: {
        "my-mac.tail0000.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8080" } } },
        "my-mac.tail0000.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3333" }, "/static": { Path: "/tmp" } } },
      },
    });
    expect(s.ports).toEqual([443, 8443]);
    expect(s.handlers).toHaveLength(3);
    expect(findServeForPort(s, 3333)).toMatchObject({ port: 8443, path: "/" });
    expect(findServeForPort(s, 9999)).toBeNull();
  });

  test("proxyTargetsPort 认 serve 的几种写法，不认别的主机", () => {
    expect(proxyTargetsPort("http://127.0.0.1:3333", 3333)).toBe(true);
    expect(proxyTargetsPort("http://localhost:3333/", 3333)).toBe(true);
    expect(proxyTargetsPort("3333", 3333)).toBe(true);
    expect(proxyTargetsPort("https+insecure://localhost:3333", 3333)).toBe(true);
    expect(proxyTargetsPort("http://127.0.0.1:33333", 3333)).toBe(false);
    expect(proxyTargetsPort("http://10.0.0.5:3333", 3333)).toBe(false);
  });
});

describe("planHttps", () => {
  const status = parseTailscaleStatus(STATUS_RUNNING)!;
  const base: PlanInput = { cliFound: true, status, serve: { ports: [], handlers: [] }, webPort: 3333, port443Busy: false };

  test("没装 / 没登录", () => {
    expect(planHttps({ ...base, cliFound: false, status: null }).kind).toBe("not-installed");
    const nl = planHttps({ ...base, status: { ...status, running: false, backendState: "NeedsLogin", authUrl: "u" } });
    expect(nl).toEqual({ kind: "need-login", backendState: "NeedsLogin", authUrl: "u" });
  });

  test("已有能用的入口 → 复用，零改动（外部反代也算）", () => {
    const p = planHttps({ ...base, port443Busy: true, workingEntry: { url: "https://my-mac.tail0000.ts.net", source: "external" } });
    expect(p).toEqual({ kind: "reuse", url: "https://my-mac.tail0000.ts.net", source: "external" });
  });

  test("serve 已指向 web 但这次没探测通 → 仍复用，不再加一条", () => {
    const serve = parseServeStatus({ TCP: { "8443": { HTTPS: true } }, Web: { "x:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3333" } } } } });
    expect(planHttps({ ...base, serve })).toEqual({ kind: "reuse", url: "https://my-mac.tail0000.ts.net:8443", source: "serve" });
  });

  test("tailnet 没开 HTTPS → 只引导，不配 serve", () => {
    expect(planHttps({ ...base, status: { ...status, httpsEnabled: false } }).kind).toBe("need-https-enable");
  });

  test("没有 MagicDNS 名 → 拿不到证书，单独提示", () => {
    expect(planHttps({ ...base, status: { ...status, dnsName: "" } }).kind).toBe("no-magicdns");
  });

  test("443 空闲 → serve 443", () => {
    const p = planHttps(base);
    expect(p).toEqual({ kind: "serve", port: 443, url: "https://my-mac.tail0000.ts.net", args: serveArgs(443, 3333) });
  });

  test("443 被别的进程占（如 Caddy）→ 8443，不遮蔽它", () => {
    const p = planHttps({ ...base, port443Busy: true });
    expect(p).toMatchObject({ kind: "serve", port: 8443, url: "https://my-mac.tail0000.ts.net:8443" });
  });

  test("443 被 serve 的其它处理器占 → 8443", () => {
    const serve = parseServeStatus({ TCP: { "443": { HTTPS: true } }, Web: { "x:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8080" } } } } });
    expect(planHttps({ ...base, serve })).toMatchObject({ kind: "serve", port: 8443 });
  });

  test("443 与 8443 都占 → 回落手工方案", () => {
    expect(planHttps({ ...base, port443Busy: true, port8443Busy: true }).kind).toBe("fallback-manual");
  });

  test("serve 参数只加一个处理器，绝不 reset / funnel", () => {
    const a = serveArgs(443, 3333);
    expect(a).toEqual(["serve", "--bg", "--https=443", "http://127.0.0.1:3333"]);
    expect(a.join(" ")).not.toMatch(/reset|funnel/);
  });
});

describe("小工具", () => {
  test("certVerdict 边界：21 / 7", () => {
    expect(certVerdict(60)).toBe("ok");
    expect(certVerdict(21)).toBe("ok");
    expect(certVerdict(20.9)).toBe("warn");
    expect(certVerdict(7)).toBe("warn");
    expect(certVerdict(6.9)).toBe("fail");
    expect(certVerdict(-1)).toBe("fail");
  });

  test("parseLsofListen / isWildcardBind", () => {
    const out = "p123\ncnode\nn*:3333\np456\nccaddy\nn127.0.0.1:443\nn[::1]:443\n";
    expect(parseLsofListen(out)).toEqual([
      { command: "node", addr: "*:3333" },
      { command: "caddy", addr: "127.0.0.1:443" },
      { command: "caddy", addr: "[::1]:443" },
    ]);
    expect(isWildcardBind("*:3333")).toBe(true);
    expect(isWildcardBind("0.0.0.0:3333")).toBe(true);
    expect(isWildcardBind("[::]:3333")).toBe(true);
    expect(isWildcardBind("127.0.0.1:3333")).toBe(false);
  });

  test("sameWebVersion 比 version + webCommit；looksLikeClaudestra 是弱判据", () => {
    const a = { version: "2.20.1", commit: "aaa", webCommit: "w1" };
    expect(sameWebVersion(a, { version: "2.20.1", commit: "bbb", webCommit: "w1" })).toBe(true);
    expect(sameWebVersion(a, { version: "2.20.1", commit: "aaa", webCommit: "w2" })).toBe(false);
    expect(sameWebVersion(a, null)).toBe(false);
    expect(looksLikeClaudestra(a)).toBe(true);
    expect(looksLikeClaudestra({ ok: true })).toBe(false);
  });

  test("httpsUrl 443 不带端口；shellQuote 只在需要时加引号", () => {
    expect(httpsUrl("h.ts.net", 443)).toBe("https://h.ts.net");
    expect(httpsUrl("h.ts.net", 8443)).toBe("https://h.ts.net:8443");
    expect(shellQuote(APP)).toBe(APP);
    expect(shellQuote("/Apps/My Tail/ts")).toBe("'/Apps/My Tail/ts'");
  });

  test("workingHttpsEntry 只认 HTTPS + 通 + 是我们的 web + 证书有效", () => {
    const r = (entries: RemoteAccessReport["entries"]): RemoteAccessReport => ({
      tailscale: { installed: true, cli: APP, backendState: "Running", running: true, dnsName: "h", ipv4: [], magicDNS: true, httpsEnabled: true },
      webPort: 3333, webBind: [], servePorts: [], entries, others443: [],
    });
    const ok = { url: "https://h", secure: true, source: "external" as const, reachable: true, matchesLocal: true, certValid: true };
    expect(workingHttpsEntry(r([ok]))).toEqual({ url: "https://h", source: "external" });
    expect(workingHttpsEntry(r([{ ...ok, matchesLocal: false }]))).toBeNull();
    expect(workingHttpsEntry(r([{ ...ok, certValid: false }]))).toBeNull();
    expect(workingHttpsEntry(r([{ ...ok, url: "http://100.64.0.1:3333", secure: false, source: "tailnet-ip" }]))).toBeNull();
  });
});

describe("validateCertCandidate（续签脚本替换前的闸）", () => {
  const now = Date.parse("2026-10-01T00:00:00Z");
  const good = { host: "my-mac.tail0000.ts.net", subjectAltName: "DNS:my-mac.tail0000.ts.net", validTo: "Dec 30 00:00:00 2026 GMT", keyMatches: true, now };

  test("合格 → ok 并给出天数", () => {
    const r = validateCertCandidate(good);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Math.round(r.daysLeft)).toBe(90);
  });

  test("SAN 不对 / 有效期不够 / 私钥不配对 → 都拒绝（保留旧证书）", () => {
    expect(validateCertCandidate({ ...good, subjectAltName: "DNS:other.tail0000.ts.net" }).ok).toBe(false);
    expect(validateCertCandidate({ ...good, validTo: "Oct 10 00:00:00 2026 GMT" }).ok).toBe(false);
    expect(validateCertCandidate({ ...good, keyMatches: false }).ok).toBe(false);
    expect(validateCertCandidate({ ...good, validTo: "garbage" }).ok).toBe(false);
  });
});
