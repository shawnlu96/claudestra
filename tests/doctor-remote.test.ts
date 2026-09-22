import { test, expect, describe } from "bun:test";
import { remoteAccessChecks } from "../src/lib/doctor-remote";
import type { RemoteAccessReport, EntryProbe } from "../src/lib/tailscale";

// 占位值夹具：真实主机名不进公开仓库
const HOST = "my-mac.tail0000.ts.net";
const report = (over: Partial<RemoteAccessReport> = {}, ts: Partial<RemoteAccessReport["tailscale"]> = {}): RemoteAccessReport => ({
  tailscale: { installed: true, cli: "/x/tailscale", backendState: "Running", running: true, dnsName: HOST, ipv4: ["100.64.0.1"], magicDNS: true, httpsEnabled: true, ...ts },
  webPort: 3333,
  webBind: ["127.0.0.1:3333"],
  servePorts: [],
  entries: [],
  others443: [],
  port443Busy: false,
  webUp: true,
  plan: { kind: "reuse", url: `https://${HOST}`, source: "external" },
  ...over,
});
const https = (over: Partial<EntryProbe> = {}): EntryProbe => ({
  url: `https://${HOST}`, secure: true, source: "external", reachable: true, matchesLocal: true, certDaysLeft: 60, certValid: true, ...over,
});
const by = (checks: ReturnType<typeof remoteAccessChecks>, name: string) => checks.filter((c) => c.name === name);

describe("remoteAccessChecks", () => {
  test("没装 / 没登录只给 warn，不继续往下查", () => {
    expect(remoteAccessChecks(report({}, { installed: false }))).toMatchObject([{ name: "Tailscale", status: "warn" }]);
    const nl = remoteAccessChecks(report({}, { running: false, backendState: "NeedsLogin" }));
    expect(nl).toHaveLength(1);
    expect(nl[0].detail).toContain("NeedsLogin");
  });

  test("健康：入口 ok + 证书 ok", () => {
    const c = remoteAccessChecks(report({ entries: [https()] }));
    expect(c.every((x) => x.status === "ok")).toBe(true);
    expect(by(c, "证书剩余")[0].detail).toContain("60");
  });

  test("90 天证书剩 19 天 → warn（<1/4 寿命），外部反代给续签脚本建议（这正是 2026-09 线上的样子）", () => {
    const c = by(remoteAccessChecks(report({ entries: [https({ certDaysLeft: 19, certLifetimeDays: 90 })] })), "证书剩余")[0];
    expect(c.status).toBe("warn");
    expect(c.fix).toContain("renew-ts-cert");
  });

  test("serve 模式的证书临期 → 建议看 tailscaled，而不是自己续", () => {
    const c = by(remoteAccessChecks(report({ entries: [https({ source: "serve", certDaysLeft: 5 })] })), "证书剩余")[0];
    expect(c.status).toBe("fail");
    expect(c.fix).toContain("tailscaled");
  });

  test("证书过期：HTTP 不通 → 入口 warn + 证书 fail", () => {
    const c = remoteAccessChecks(report({ entries: [https({ reachable: false, certDaysLeft: -2, certValid: false })] }));
    expect(by(c, "HTTPS 入口")[0].status).toBe("warn");
    expect(by(c, "证书剩余")[0]).toMatchObject({ status: "fail" });
    expect(by(c, "证书剩余")[0].detail).toContain("已过期");
  });

  test("入口通到别的服务 / HTTP 探测失败 → warn（可能只是一时超时或刚部署），不给 fail", () => {
    expect(by(remoteAccessChecks(report({ entries: [https({ matchesLocal: false })] })), "HTTPS 入口")[0].status).toBe("warn");
    expect(by(remoteAccessChecks(report({ entries: [https({ reachable: false, certDaysLeft: 60 })] })), "HTTPS 入口")[0].status).toBe("warn");
  });

  test("证书阈值按寿命比例：45 天证书剩 12 天 → ok，剩 10 天 → warn；任何证书 <7 天 → fail", () => {
    const v = (d: number, life: number) => by(remoteAccessChecks(report({ entries: [https({ certDaysLeft: d, certLifetimeDays: life })] })), "证书剩余")[0].status;
    expect(v(12, 45)).toBe("ok");
    expect(v(10, 45)).toBe("warn");
    expect(v(23, 90)).toBe("ok");
    expect(v(22, 90)).toBe("warn");
    expect(v(6, 45)).toBe("fail");
  });

  test("本机 web 不应答 → 单独一条 warn，并且排在最前", () => {
    const c = remoteAccessChecks(report({ webUp: false }));
    expect(c[0]).toMatchObject({ name: "web 服务", status: "warn" });
  });

  test("没有 HTTPS 入口 → warn；tailnet 没开 HTTPS 时建议先去后台开", () => {
    const a = by(remoteAccessChecks(report()), "HTTPS 入口")[0];
    expect(a.status).toBe("warn");
    const b = by(remoteAccessChecks(report({}, { httpsEnabled: false })), "HTTPS 入口")[0];
    expect(b.fix).toContain("HTTPS Certificates");
  });

  test("serve 占 443 且另有进程听 443 → 冲突 warn；lsof 看不见时（root 属主）也要报", () => {
    const c = by(remoteAccessChecks(report({ servePorts: [443], port443Busy: true, others443: ["caddy"] })), "443 冲突");
    expect(c).toHaveLength(1);
    expect(c[0].detail).toContain("caddy");
    const hidden = by(remoteAccessChecks(report({ servePorts: [443], port443Busy: true, others443: [] })), "443 冲突");
    expect(hidden[0].detail).toContain("root");
    expect(by(remoteAccessChecks(report({ servePorts: [443], port443Busy: false })), "443 冲突")).toHaveLength(0);
  });

  test("web 听通配地址不单独告警（有人有意留明文备用），只写进 HTTPS 入口的 detail", () => {
    const c = remoteAccessChecks(report({ webBind: ["*:3333"], entries: [https()] }));
    expect(c.every((x) => x.status === "ok")).toBe(true);
    expect(by(c, "HTTPS 入口")[0].detail).toContain("*:3333");
  });
});
