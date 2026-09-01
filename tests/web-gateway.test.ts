/**
 * v2.10+ web-gateway 单测：CORS 白名单匹配 / 静态路径解析（穿越防护 + SPA fallback）
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  corsHeadersFor,
  resolveStaticPath,
  isCrossOrigin,
  isOriginExplicitlyAllowed,
  isLoopbackAddress,
  controlAccessVerdict,
} from "../src/bridge/web-gateway.js";

describe("跨源判定（ws 控制面防护）", () => {
  const BRIDGE = "http://127.0.0.1:3847/";

  test("无 Origin 头 → 不算跨源（channel-server / manager / 服务端 fetch 都不带）", () => {
    expect(isCrossOrigin(null, BRIDGE)).toBe(false);
    expect(isCrossOrigin("", BRIDGE)).toBe(false);
  });

  test("同源页面 → 不算跨源（同源 fetch 也会带 Origin，不能一见 Origin 就拒）", () => {
    expect(isCrossOrigin("http://127.0.0.1:3847", BRIDGE)).toBe(false);
    expect(isCrossOrigin("http://127.0.0.1:3847", "http://127.0.0.1:3847/events")).toBe(false);
  });

  test("其它站点 → 跨源", () => {
    expect(isCrossOrigin("https://evil.example.com", BRIDGE)).toBe(true);
    // 同 host 不同端口 / 不同协议都是不同源
    expect(isCrossOrigin("http://127.0.0.1:5173", BRIDGE)).toBe(true);
    expect(isCrossOrigin("https://127.0.0.1:3847", BRIDGE)).toBe(true);
    // localhost 与 127.0.0.1 字面量不同 → 不同源
    expect(isCrossOrigin("http://localhost:3847", BRIDGE)).toBe(true);
  });

  test("请求 URL 不可解析 → 按最坏情况算跨源", () => {
    expect(isCrossOrigin("https://evil.example.com", "not-a-url")).toBe(true);
  });

  test("显式白名单逐条匹配", () => {
    expect(isOriginExplicitlyAllowed("http://localhost:5173", "http://localhost:5173")).toBe(true);
    expect(
      isOriginExplicitlyAllowed("http://localhost:5173", "https://a.com, http://localhost:5173")
    ).toBe(true);
    expect(isOriginExplicitlyAllowed("https://evil.example.com", "http://localhost:5173")).toBe(false);
  });

  test('"*" 不放行 ws —— 通配符不该顺带交出控制面', () => {
    expect(isOriginExplicitlyAllowed("https://evil.example.com", "*")).toBe(false);
    // 对照：同样的设置在 HTTP CORS 上是放行的，两者刻意不一致
    expect(corsHeadersFor("https://evil.example.com", "*")).not.toBeNull();
  });

  test("未配置白名单 → 任何跨源都不放行（默认安全）", () => {
    expect(isOriginExplicitlyAllowed("https://evil.example.com", "")).toBe(false);
    expect(isOriginExplicitlyAllowed(null, "")).toBe(false);
  });
});

describe("corsHeadersFor", () => {
  test("未配置 → null（默认关闭）", () => {
    expect(corsHeadersFor("http://localhost:5173", "")).toBeNull();
  });

  test("* 通配：任意 origin 都发 *", () => {
    const h = corsHeadersFor("http://anything.example", "*");
    expect(h?.["Access-Control-Allow-Origin"]).toBe("*");
    expect(h?.Vary).toBeUndefined();
  });

  test("白名单精确匹配：命中回显 origin + Vary，未命中 null", () => {
    const setting = "http://localhost:5173, https://ui.example.com";
    const hit = corsHeadersFor("http://localhost:5173", setting);
    expect(hit?.["Access-Control-Allow-Origin"]).toBe("http://localhost:5173");
    expect(hit?.Vary).toBe("Origin");
    expect(corsHeadersFor("http://evil.example", setting)).toBeNull();
    expect(corsHeadersFor(null, setting)).toBeNull();
  });

  test("允许的 header 覆盖 SSE 场景（Authorization + Last-Event-ID）", () => {
    const h = corsHeadersFor("x", "*");
    expect(h?.["Access-Control-Allow-Headers"]).toContain("Authorization");
    expect(h?.["Access-Control-Allow-Headers"]).toContain("Last-Event-ID");
  });
});

describe("resolveStaticPath", () => {
  function setup() {
    const root = mkdtempSync(join(tmpdir(), "static-"));
    writeFileSync(join(root, "index.html"), "<html>app</html>");
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "assets", "app.js"), "js");
    return root;
  }

  test("命中真实文件", () => {
    const root = setup();
    expect(resolveStaticPath(root, "/assets/app.js")).toBe(join(root, "assets", "app.js"));
    expect(resolveStaticPath(root, "/index.html")).toBe(join(root, "index.html"));
  });

  test("SPA fallback：无扩展名路径回 index.html，缺失资源文件 404", () => {
    const root = setup();
    expect(resolveStaticPath(root, "/")).toBe(join(root, "index.html"));
    expect(resolveStaticPath(root, "/agents/claudestra")).toBe(join(root, "index.html"));
    expect(resolveStaticPath(root, "/assets/missing.js")).toBeNull();
  });

  test("路径穿越与非法编码拦截", () => {
    const root = setup();
    expect(resolveStaticPath(root, "/../../etc/passwd")).toBeNull();
    expect(resolveStaticPath(root, "/%2e%2e/%2e%2e/etc/passwd")).toBeNull();
    expect(resolveStaticPath(root, "/%zz")).toBeNull();
  });

  test("root 未设 → null", () => {
    expect(resolveStaticPath("", "/index.html")).toBeNull();
  });
});

// ── v2.21.1+ 控制面非回环鉴权(security-audit P0)──

describe("isLoopbackAddress", () => {
  test("回环各形态命中", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.1.2.3")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });
  test("非回环 / 空 不命中", () => {
    expect(isLoopbackAddress("192.168.3.10")).toBe(false);
    expect(isLoopbackAddress("100.82.126.45")).toBe(false);
    expect(isLoopbackAddress("::ffff:192.168.1.1")).toBe(false);
    expect(isLoopbackAddress(null)).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress("")).toBe(false);
  });
});

describe("controlAccessVerdict", () => {
  const CT = "secret-control-token";
  test("回环豁免一切(裸路由/ws 全放)", () => {
    expect(controlAccessVerdict({ loopback: true, pathname: "/hook", providedToken: null, controlToken: "" }).allow).toBe(true);
    expect(controlAccessVerdict({ loopback: true, pathname: "/", providedToken: null, controlToken: CT }).allow).toBe(true);
  });
  test("非回环 /api/v1 放行(交给自己的 Bearer——peer 入站)", () => {
    const v = controlAccessVerdict({ loopback: false, pathname: "/api/v1/agents/x/messages", providedToken: null, controlToken: CT });
    expect(v.allow).toBe(true);
    expect(v.reason).toBe("api-bearer");
  });
  test("非回环裸路由:token 命中放行,不命中拒", () => {
    expect(controlAccessVerdict({ loopback: false, pathname: "/hook", providedToken: CT, controlToken: CT }).allow).toBe(true);
    expect(controlAccessVerdict({ loopback: false, pathname: "/hook", providedToken: "wrong", controlToken: CT }).allow).toBe(false);
    expect(controlAccessVerdict({ loopback: false, pathname: "/skills/rescan", providedToken: null, controlToken: CT }).allow).toBe(false);
  });
  test("token 长度不等 → 拒(常量时间比较不抛)", () => {
    expect(controlAccessVerdict({ loopback: false, pathname: "/hook", providedToken: "short", controlToken: CT }).allow).toBe(false);
  });
  test("回环归一化边角形态命中", () => {
    expect(isLoopbackAddress("::FFFF:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::ffff:7f00:1")).toBe(true);
  });
  test("fail-closed:未配 token 时非回环裸路由一律拒", () => {
    const v = controlAccessVerdict({ loopback: false, pathname: "/events", providedToken: "anything", controlToken: "" });
    expect(v.allow).toBe(false);
    expect(v.reason).toBe("no-token-configured");
  });
  test("非回环 ws 升级(根路径)未配 token → 拒(route_to_agent RCE 面)", () => {
    expect(controlAccessVerdict({ loopback: false, pathname: "/", providedToken: null, controlToken: "" }).allow).toBe(false);
  });
});
