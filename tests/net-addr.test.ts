import { test, expect, describe } from "bun:test";
import { isTailscaleAddr, isPrivateAddr, detectBridgeUrls } from "../src/lib/net-addr";

describe("isTailscaleAddr", () => {
  // Tailscale 用 CGNAT 段 100.64.0.0/10 —— 边界两侧都不能算错，
  // 认错会把一个对方连不上的地址填进 peer 握手，而错误要到 peer-http-test 才暴露。
  test("100.64–100.127 属于 Tailscale", () => {
    expect(isTailscaleAddr("100.64.0.1")).toBe(true);
    expect(isTailscaleAddr("100.120.71.107")).toBe(true);
    expect(isTailscaleAddr("100.127.255.254")).toBe(true);
  });

  test("段外的 100.x 不是（100.0/100.63/100.128 都是公网）", () => {
    expect(isTailscaleAddr("100.0.0.1")).toBe(false);
    expect(isTailscaleAddr("100.63.255.255")).toBe(false);
    expect(isTailscaleAddr("100.128.0.1")).toBe(false);
    expect(isTailscaleAddr("100.255.0.1")).toBe(false);
  });

  test("其它网段一律不是", () => {
    expect(isTailscaleAddr("192.168.1.1")).toBe(false);
    expect(isTailscaleAddr("10.0.0.1")).toBe(false);
    expect(isTailscaleAddr("1.100.64.1")).toBe(false); // 100.64 出现在中间，不能误匹配
  });
});

describe("isPrivateAddr", () => {
  test("三段 RFC1918 都认", () => {
    expect(isPrivateAddr("192.168.3.168")).toBe(true);
    expect(isPrivateAddr("10.1.2.3")).toBe(true);
    expect(isPrivateAddr("172.16.0.1")).toBe(true);
    expect(isPrivateAddr("172.31.255.254")).toBe(true);
  });

  test("172 段的边界不能放宽（172.15 / 172.32 是公网）", () => {
    expect(isPrivateAddr("172.15.0.1")).toBe(false);
    expect(isPrivateAddr("172.32.0.1")).toBe(false);
  });

  test("公网地址不是私网", () => {
    expect(isPrivateAddr("8.8.8.8")).toBe(false);
    expect(isPrivateAddr("100.120.71.107")).toBe(false); // Tailscale 归 Tailscale
  });
});

describe("detectBridgeUrls", () => {
  test("返回的都是带端口的 http URL", () => {
    for (const c of detectBridgeUrls(3847)) {
      expect(c.url).toBe(`http://${c.address}:3847`);
      expect(["tailscale", "lan"]).toContain(c.kind);
    }
  });

  test("Tailscale 排在 LAN 前面 —— 它是唯一跨网络可达的", () => {
    const kinds = detectBridgeUrls(3847).map((c) => c.kind);
    const firstLan = kinds.indexOf("lan");
    const lastTs = kinds.lastIndexOf("tailscale");
    if (firstLan !== -1 && lastTs !== -1) expect(lastTs).toBeLessThan(firstLan);
  });

  test("绝不返回回环地址（填进 peer 握手对方永远连不上）", () => {
    const urls = detectBridgeUrls(3847).map((c) => c.url);
    expect(urls.some((u) => u.includes("127.0.0.1") || u.includes("localhost"))).toBe(false);
  });

  test("端口参数被带进 URL", () => {
    const c = detectBridgeUrls(9999)[0];
    if (c) expect(c.url.endsWith(":9999")).toBe(true);
  });
});
