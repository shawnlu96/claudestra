/**
 * 中继「按路径找机器」的纯函数（src/lib/relay-machine-path.ts）：路径解析与规范化、请求 cookie 过滤、机器响应头过滤。
 */
import { describe, expect, test } from "bun:test";
import {
  apiPathAllowed, filterMachineRequestHeaders, filterMachineResponseHeaders, parseMachinePath, pinDeviceCookie, prefixLocation,
} from "../src/lib/relay-machine-path.js";
import { SET_COOKIE_SEP } from "../src/lib/relay-stream.js";

const FP = "16f9-b5d1-30fb-8923";

describe("parseMachinePath / apiPathAllowed", () => {
  test("合法：/m/<fp>/api/v1/…，指纹大小写不敏感，前缀与 rest 分开", () => {
    expect(parseMachinePath(`/m/${FP.toUpperCase()}/api/v1/agents`)).toEqual({ fp: FP, rest: "/api/v1/agents", prefix: `/m/${FP}` });
    expect(parseMachinePath(`/m/${FP}/api/v1`)).toMatchObject({ rest: "/api/v1" });
    expect(parseMachinePath(`/m/${FP}/api/v1/agents/%E5%A4%A7%E6%80%BB%E7%AE%A1/messages`)).toMatchObject({ rest: "/api/v1/agents/%E5%A4%A7%E6%80%BB%E7%AE%A1/messages" });
  });
  test("不是机器路径 / 指纹形状不对", () => {
    expect(parseMachinePath("/api/v1/agents")).toBe("not_machine_path");
    expect(parseMachinePath("/m/not-a-fp/api/v1/agents")).toBe("bad_fingerprint");
    expect(parseMachinePath(`/m/${FP}`)).toBe("path_forbidden"); // 没有 rest = "/"，不在 /api/v1 下
  });
  test("只放 /api/v1：控制路由、穿越、编码穿越、连续斜线、控制字符、反斜线全拒", () => {
    const bads = ["/hook", "/events", "/api/v2/x", "/api/v1/../hook", "/api/v1/./x", "/api/v1//x", "/api/v1/%2e%2e/hook", "/api/v1/a%2fb", "/api/v1/%25",
      "/api/v1/x\u0000", "/api/v1/a\\b", "/api/v1/%zz", "/apiv1/x", "/api/v10/x"];
    for (const bad of bads) {
      expect(apiPathAllowed(bad)).toBe(false);
      expect(parseMachinePath(`/m/${FP}${bad}`)).toBe("path_forbidden");
    }
    expect(apiPathAllowed("/api/v1/agents/x/messages?x=1")).toBe(true); // 查询串不在 pathname 里，但带了也无害
  });
});

describe("请求头过滤", () => {
  test("Cookie 只留 cstra_dev 一对；别的头原样", () => {
    const h = filterMachineRequestHeaders({ cookie: "other=1; cstra_dev=dev_abc; cstra_home=mini", accept: "*/*" });
    expect(h).toEqual({ cookie: "cstra_dev=dev_abc", accept: "*/*" });
    expect(filterMachineRequestHeaders({ cookie: "other=1" })).toEqual({});
  });
});

describe("机器响应头过滤", () => {
  const prefix = `/m/${FP}`;
  test("Set-Cookie：只放 cstra_dev，属性一律改写、Path 钉死、Max-Age 保留；别的 cookie 丢", () => {
    expect(pinDeviceCookie("cstra_dev=dev_x-Y_9; Path=/; HttpOnly; Max-Age=7776000; SameSite=Lax", prefix))
      .toBe(`cstra_dev=dev_x-Y_9; Path=${prefix}/; Max-Age=7776000; HttpOnly; Secure; SameSite=Strict`);
    expect(pinDeviceCookie("cstra_dev=; Path=/; Max-Age=0", prefix)).toBe(`cstra_dev=; Path=${prefix}/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
    expect(pinDeviceCookie("cstra_session=abc; Path=/", prefix)).toBeNull();
    expect(pinDeviceCookie("cstra_dev=has space; Path=/", prefix)).toBeNull();
    expect(pinDeviceCookie("cstra_dev=a;b=c", prefix)).toBe(`cstra_dev=a; Path=${prefix}/; HttpOnly; Secure; SameSite=Strict`);
  });
  test("多条 Set-Cookie 以分隔符连接：过滤后重新连接；全丢就没有这个头", () => {
    const h = filterMachineResponseHeaders({ "set-cookie": ["cstra_session=x; Path=/", "cstra_dev=dev_1; Path=/"].join(SET_COOKIE_SEP), "content-type": "application/json" }, prefix);
    expect(h["set-cookie"]).toBe(`cstra_dev=dev_1; Path=${prefix}/; HttpOnly; Secure; SameSite=Strict`);
    expect(filterMachineResponseHeaders({ "set-cookie": "a=1" }, prefix)["set-cookie"]).toBeUndefined();
  });
  test("能影响整个主源的头丢掉；Location 根相对补前缀，绝对与 // 不动", () => {
    const h = filterMachineResponseHeaders({ "clear-site-data": '"*"', "service-worker-allowed": "/", "alt-svc": "h3", location: "/chat", "x-other": "1" }, prefix);
    expect(h).toMatchObject({ location: `${prefix}/chat`, "x-other": "1" });
    for (const k of ["clear-site-data", "service-worker-allowed", "alt-svc"]) expect(h[k]).toBeUndefined();
    expect(prefixLocation("https://relay.example.com/x", prefix)).toBe("https://relay.example.com/x");
    expect(prefixLocation("//evil.example/x", prefix)).toBe("//evil.example/x");
  });
  test("活动内容边界：机器的 HTML / SVG 在共享源上跑不了脚本——中继钉 CSP sandbox + nosniff，机器自带的 CSP / XFO 作废", () => {
    const html = filterMachineResponseHeaders({ "content-type": "text/html", "content-security-policy": "script-src *", "x-frame-options": "ALLOWALL" }, prefix);
    expect(html["content-security-policy"]).toBe("sandbox; default-src 'none'; frame-ancestors 'none'");
    expect(html["x-content-type-options"]).toBe("nosniff");
    expect(html["x-frame-options"]).toBeUndefined();
    expect(filterMachineResponseHeaders({ "content-type": "image/svg+xml" }, prefix)["content-security-policy"]).toContain("sandbox");
    expect(filterMachineResponseHeaders({}, prefix)["content-security-policy"]).toContain("sandbox"); // 没声明类型（嗅探）同样沙箱
    expect(filterMachineResponseHeaders({ "content-type": "application/json" }, prefix)["content-security-policy"]).toContain("sandbox");
    expect(filterMachineResponseHeaders({ "content-type": "application/pdf" }, prefix)["content-security-policy"]).toBe("frame-ancestors 'none'");
  });
  test("脚本类响应改成 text/plain（配 nosniff）：托管页的 script-src 'self' 不会把机器的 JS / wasm 当脚本执行", () => {
    for (const t of ["application/javascript", "text/javascript; charset=utf-8", "application/x-javascript", "text/ecmascript", "application/wasm"]) {
      expect(filterMachineResponseHeaders({ "content-type": t }, prefix)["content-type"]).toBe("text/plain; charset=utf-8");
    }
    expect(filterMachineResponseHeaders({ "content-type": "application/json" }, prefix)["content-type"]).toBe("application/json");
    expect(filterMachineResponseHeaders({ "content-type": "text/event-stream" }, prefix)["content-type"]).toBe("text/event-stream");
    expect(filterMachineResponseHeaders({ "content-type": "image/png" }, prefix)["content-type"]).toBe("image/png");
  });
});
