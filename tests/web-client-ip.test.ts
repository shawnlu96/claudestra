import { describe, expect, test } from "bun:test";
import { clientIp, isLoopback, requestClientIp, PEER_HEADER } from "@/lib/client-ip";

describe("clientIp（登录限流的分桶地址，D4-9）", () => {
  test("直连（对端不是本机）：只认对端，客户端自己写的 XFF 一律不信", () => {
    expect(clientIp({ peer: "100.64.1.2", xff: "1.2.3.4" })).toBe("100.64.1.2");
    expect(clientIp({ peer: "192.168.1.9", xff: "9.9.9.9, 8.8.8.8" })).toBe("192.168.1.9");
  });

  test("轮换 XFF 连打 6 次：直连时始终落在同一个桶", () => {
    const keys = new Set(
      Array.from({ length: 6 }, (_, i) => clientIp({ peer: "192.168.1.9", xff: `10.0.0.${i}` })),
    );
    expect(keys.size).toBe(1);
  });

  test("来自本机反代（对端是回环）：取 XFF 最右一项（最近一跳代理追加的）", () => {
    expect(clientIp({ peer: "127.0.0.1", xff: "203.0.113.7" })).toBe("203.0.113.7");
    expect(clientIp({ peer: "::1", xff: "forged, 203.0.113.7" })).toBe("203.0.113.7");
    expect(clientIp({ peer: "::ffff:127.0.0.1", xff: " 198.51.100.2 " })).toBe("198.51.100.2");
  });

  test("本机直接访问、没有 XFF：用回环地址本身", () => {
    expect(clientIp({ peer: "127.0.0.1", xff: null })).toBe("127.0.0.1");
  });

  test("拿不到对端（探针没装上）：退回 XFF 最右一项，不再信最左", () => {
    expect(clientIp({ peer: null, xff: "forged-left, 203.0.113.9" })).toBe("203.0.113.9");
    expect(clientIp({ peer: "", xff: "" })).toBe("");
  });

  test("isLoopback 边界", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("127.8.8.8")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("::FFFF:127.0.0.1")).toBe(true);
    expect(isLoopback("100.64.0.1")).toBe(false);
    expect(isLoopback("::ffff:192.168.0.1")).toBe(false);
    expect(isLoopback("1127.0.0.1")).toBe(false);
  });

  test("requestClientIp 从请求头读（对端头由 peer-stamp 覆盖写入）", () => {
    const req = new Request("http://x/api/auth/login", {
      headers: { [PEER_HEADER]: "192.168.1.9", "x-forwarded-for": "1.1.1.1" },
    });
    expect(requestClientIp(req)).toBe("192.168.1.9");
  });
});
