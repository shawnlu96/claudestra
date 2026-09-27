import { describe, expect, test } from "bun:test";
import { relayChecks } from "../src/lib/doctor-relay";

const G = "手机访问";
const NOW = 1_790_000_000_000;

describe("doctor 的「中继」一项（relayChecks）", () => {
  test("没配 RELAY_URL：ok + 怎么开（可选项没开不是问题）", () => {
    const [c] = relayChecks({ enabled: false }, G, NOW);
    expect(c).toMatchObject({ group: G, name: "中继", status: "ok" });
    expect(c.detail).toContain("RELAY_URL");
    expect(c.fix).toBeUndefined();
  });

  test("连上：ok，detail 就是这台机器的网页地址", () => {
    const [c] = relayChecks({ enabled: true, connected: true, url: "https://mini.relay.example.com" }, G, NOW);
    expect(c.status).toBe("ok");
    expect(c.detail).toContain("https://mini.relay.example.com");
  });

  test("配了没连上：warn，带状态、原因、几秒后重试与排查步骤", () => {
    const [c] = relayChecks({ enabled: true, connected: false, state: "offline", relayUrl: "wss://relay.example.com", lastError: "socket error", retryAt: NOW + 12_400 }, G, NOW);
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("wss://relay.example.com");
    expect(c.detail).toContain("offline: socket error");
    expect(c.detail).toContain("13 秒后重试");
    expect(c.fix).toContain("healthz");
  });

  test("retryAt 已过 / 没给 → 不写重试时间；连着但还没拿到地址也算没连上", () => {
    expect(relayChecks({ enabled: true, connected: false, retryAt: NOW - 1 }, G, NOW)[0].detail).not.toContain("重试");
    expect(relayChecks({ enabled: true, connected: true, url: null }, G, NOW)[0].status).toBe("warn");
  });
});
