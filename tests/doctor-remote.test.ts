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

  test("证书 19 天 → warn，且外部反代给续签脚本建议（这正是 2026-09 线上的样子）", () => {
    const c = by(remoteAccessChecks(report({ entries: [https({ certDaysLeft: 19 })] })), "证书剩余")[0];
    expect(c.status).toBe("warn");
    expect(c.fix).toContain("renew-ts-cert");
  });

  test("serve 模式的证书临期 → 建议看 tailscaled，而不是自己续", () => {
    const c = by(remoteAccessChecks(report({ entries: [https({ source: "serve", certDaysLeft: 5 })] })), "证书剩余")[0];
    expect(c.status).toBe("fail");
    expect(c.fix).toContain("tailscaled");
  });

  test("证书过期：HTTP 不通 → 入口 fail + 证书 fail", () => {
    const c = remoteAccessChecks(report({ entries: [https({ reachable: false, certDaysLeft: -2, certValid: false })] }));
    expect(by(c, "HTTPS 入口")[0].status).toBe("fail");
    expect(by(c, "证书剩余")[0]).toMatchObject({ status: "fail" });
    expect(by(c, "证书剩余")[0].detail).toContain("已过期");
  });

  test("入口通到别的服务 → fail", () => {
    const c = by(remoteAccessChecks(report({ entries: [https({ matchesLocal: false })] })), "HTTPS 入口")[0];
    expect(c.status).toBe("fail");
  });

  test("没有 HTTPS 入口 → warn；tailnet 没开 HTTPS 时建议先去后台开", () => {
    const a = by(remoteAccessChecks(report()), "HTTPS 入口")[0];
    expect(a.status).toBe("warn");
    const b = by(remoteAccessChecks(report({}, { httpsEnabled: false })), "HTTPS 入口")[0];
    expect(b.fix).toContain("HTTPS Certificates");
  });

  test("serve 占 443 且另有进程听 443 → 冲突 warn", () => {
    const c = by(remoteAccessChecks(report({ servePorts: [443], others443: ["caddy", "caddy"] })), "443 冲突");
    expect(c).toHaveLength(1);
    expect(c[0].detail).toContain("caddy");
    expect(c[0].detail).not.toContain("caddy、caddy");
  });

  test("已有 HTTPS 但 web 仍听通配地址 → 只提示 warn；没 HTTPS 时不提（那是唯一入口）", () => {
    expect(by(remoteAccessChecks(report({ webBind: ["*:3333"], entries: [https()] })), "明文入口")).toHaveLength(1);
    expect(by(remoteAccessChecks(report({ webBind: ["*:3333"] })), "明文入口")).toHaveLength(0);
  });
});
