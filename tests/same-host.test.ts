/** lib/same-host.ts：请求来源地址的口径（对端回环才信 XFF 最右一跳）与「是不是本机网卡地址」 */
import { describe, expect, test } from "bun:test";
import { isOwnAddress, isSameHostRequest, normalizeIp, ownAddresses, requestSourceIp } from "../src/lib/same-host.js";

const OWN = ["127.0.0.1", "::1", "192.168.1.20", "100.101.102.103", "fe80::1%en0"];

describe("normalizeIp", () => {
  test("去 [ ]、IPv4 端口、zone、IPv4-mapped 前缀，统一小写", () => {
    expect(normalizeIp("[::1]:3847")).toBe("::1");
    expect(normalizeIp("192.168.1.20:5000")).toBe("192.168.1.20");
    expect(normalizeIp("::ffff:192.168.1.20")).toBe("192.168.1.20");
    expect(normalizeIp("FE80::1%en0")).toBe("fe80::1");
    expect(normalizeIp(" 10.0.0.1 ")).toBe("10.0.0.1");
  });
});

describe("requestSourceIp", () => {
  test("对端不是回环 = 直连：只认对端，客户端自己写的 XFF 不算", () => {
    expect(requestSourceIp("192.168.1.50", "127.0.0.1")).toBe("192.168.1.50");
    expect(requestSourceIp("::ffff:100.64.1.2", null)).toBe("100.64.1.2");
  });
  test("对端是回环 + XFF = 本机反代：取最右一跳（反代追加的），左边伪造的够不着", () => {
    expect(requestSourceIp("127.0.0.1", "100.101.102.103")).toBe("100.101.102.103");
    expect(requestSourceIp("127.0.0.1", "127.0.0.1, 203.0.113.9")).toBe("203.0.113.9");
    expect(requestSourceIp("::1", " 192.168.1.20 ")).toBe("192.168.1.20");
  });
  test("对端是回环、没 XFF = 本机进程 / 本机浏览器直连；拿不到对端 → null", () => {
    expect(requestSourceIp("127.0.0.1", null)).toBe("127.0.0.1");
    expect(requestSourceIp("127.0.0.1", " , ")).toBe("127.0.0.1");
    expect(requestSourceIp(null, "127.0.0.1")).toBeNull();
  });
});

describe("isOwnAddress / isSameHostRequest", () => {
  test("回环恒为本机；局域网 / tailnet / 带 zone 的本机地址都认；外部地址不认", () => {
    expect(isOwnAddress("127.8.8.8", [])).toBe(true);
    expect(isOwnAddress("192.168.1.20", OWN)).toBe(true);
    expect(isOwnAddress("fe80::1", OWN)).toBe(true);
    expect(isOwnAddress("192.168.1.21", OWN)).toBe(false);
    expect(isOwnAddress(null, OWN)).toBe(false);
  });
  test("典型入口：本机 Tailscale 域名 / 局域网 IP 打开算本机；手机经同一反代不算；直连伪造 XFF 不算", () => {
    expect(isSameHostRequest("127.0.0.1", "100.101.102.103", OWN)).toBe(true); // tailscale serve，自己的 tailnet IP
    expect(isSameHostRequest("192.168.1.20", null, OWN)).toBe(true); // 本机浏览器开 http://<局域网 IP>:3333
    expect(isSameHostRequest("127.0.0.1", "100.64.7.7", OWN)).toBe(false); // 手机经 tailscale serve
    expect(isSameHostRequest("192.168.1.50", "127.0.0.1", OWN)).toBe(false); // 局域网别的电脑直连，自称回环
  });
  test("ownAddresses 读真实网卡，至少有回环", () => {
    expect(ownAddresses().some((a) => a === "127.0.0.1" || a === "::1")).toBe(true);
  });
});
