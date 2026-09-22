import { test, expect, describe } from "bun:test";
import { isTailscaleAddr, isPrivateAddr, detectBridgeUrls, classifyInterfaces } from "../src/lib/net-addr";
import type { NetworkInterfaceInfo } from "os";

describe("isTailscaleAddr", () => {
  // Tailscale 用 CGNAT 段 100.64.0.0/10 —— 边界两侧都不能算错，
  // 认错会把一个对方连不上的地址填进 peer 握手，而错误要到 peer-http-test 才暴露。
  test("100.64–100.127 属于 Tailscale", () => {
    expect(isTailscaleAddr("100.64.0.1")).toBe(true);
    expect(isTailscaleAddr("100.101.102.103")).toBe(true);
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
    expect(isPrivateAddr("100.101.102.103")).toBe(false); // Tailscale 归 Tailscale
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

describe("classifyInterfaces（CLI 状态作为注入参数）", () => {
  const v4 = (address: string, internal = false) =>
    ({ address, family: "IPv4", internal, netmask: "", mac: "", cidr: null }) as unknown as NetworkInterfaceInfo;
  const ifaces = {
    lo0: [v4("127.0.0.1", true)],
    en0: [v4("192.168.1.20")],
    utun4: [v4("100.64.0.1")],
    utun9: [v4("100.100.9.9")], // 别的 overlay / 运营商 CGNAT 落在同一段
  };

  test("拿不到 status → 按地址段兜底（两个 100.x 都当 Tailscale）", () => {
    const kinds = classifyInterfaces(ifaces, 3333).map((c) => [c.address, c.kind]);
    expect(kinds).toEqual([["100.64.0.1", "tailscale"], ["100.100.9.9", "tailscale"], ["192.168.1.20", "lan"]]);
  });

  test("有 status → 只有 TailscaleIPs 里的才算，误标消失", () => {
    const c = classifyInterfaces(ifaces, 3333, { ipv4: ["100.64.0.1"] });
    expect(c.map((x) => x.address)).toEqual(["100.64.0.1", "192.168.1.20"]);
  });

  test("显式要求时追加 MagicDNS 候选，排在 tailnet IP 之后、LAN 之前", () => {
    const c = classifyInterfaces(ifaces, 3333, { ipv4: ["100.64.0.1"], dnsName: "my-mac.tail0000.ts.net" }, { includeMagicDNS: true });
    expect(c.map((x) => x.kind)).toEqual(["tailscale", "magicdns", "lan"]);
    expect(c[1].url).toBe("http://my-mac.tail0000.ts.net:3333");
  });

  test("默认不出 magicdns（跨 tailnet 的 peer 解析不了对方的名字）", () => {
    const c = classifyInterfaces(ifaces, 3333, { ipv4: ["100.64.0.1"], dnsName: "my-mac.tail0000.ts.net" });
    expect(c.some((x) => x.kind === "magicdns")).toBe(false);
  });
});
