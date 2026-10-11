/**
 * 外部通知渠道的 HTTP 发送（src/bridge/notify/transport.ts）：重试、不跟随重定向、本机地址拒发（bridge 控制面对回环免鉴权）、
 * 出错回包只读 4 KB、失败原因先脱敏后截断（Codex 对抗审查 notify r1 的 #1–#3）。假 fetch / 假 DNS，不出网。
 */
import { describe, expect, test } from "bun:test";
import { isLoopbackAddress, sendToChannel, type Lookup } from "../src/bridge/notify/transport.js";
import { normalizeChannel, type NotifyChannel, type NotifyMessage } from "../src/lib/notify-channels.js";

const ch = (raw: Record<string, unknown>): NotifyChannel => {
  const c = normalizeChannel(raw);
  if (typeof c === "string") throw new Error(c);
  return c;
};
const MSG: NotifyMessage = { type: "system", title: "x", body: "y", tag: "t", ts: 1 };
const PUBLIC: Lookup = async () => ["203.0.113.7"];
const fetchOf = (f: (url: string, init: RequestInit) => Response | Promise<Response>) => f as unknown as typeof fetch;

describe("重试与原因", () => {
  test("5xx 重试一次后成功；4xx 不重试，记一句回包原因", async () => {
    const c = ch({ kind: "ntfy", topic: "t" });
    let n = 0;
    const flaky = fetchOf(() => new Response("", { status: n++ === 0 ? 502 : 200 }));
    expect(await sendToChannel(c, MSG, { fetch: flaky, lookup: PUBLIC, retryDelayMs: 1 })).toEqual({ ok: true, status: 200 });
    expect(n).toBe(2);
    let m = 0;
    const bad = fetchOf(() => (m++, new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })));
    expect(await sendToChannel(c, MSG, { fetch: bad, lookup: PUBLIC, retryDelayMs: 1 })).toEqual({ ok: false, status: 401, error: "HTTP 401 · unauthorized" });
    expect(m).toBe(1);
  });
  test("网络错误信息里的请求地址换成主机名（webhook 地址带 token）", async () => {
    const c = ch({ kind: "webhook", url: "https://hooks.example.com/services/T0/B0/SECRETTOKEN" });
    const boom = fetchOf((url) => {
      throw new Error(`connect failed: ${url}`);
    });
    expect((await sendToChannel(c, MSG, { fetch: boom, lookup: PUBLIC, retryDelayMs: 1 })).error).toBe("connect failed: hooks.example.com");
  });
  test("先脱敏后截断：密钥跨在截断处也不留前半截；超长地址里的凭据同样换掉", async () => {
    const bark = ch({ kind: "bark", deviceKey: "AbCdEf123456" });
    const echo = fetchOf(() => new Response(JSON.stringify({ message: `${"x".repeat(150)}AbCdEf123456 tail` }), { status: 400 }));
    const r = await sendToChannel(bark, MSG, { fetch: echo, lookup: PUBLIC, retryDelayMs: 1 });
    expect(r.error).not.toContain("AbCdEf");
    expect(r.error!.length).toBeLessThanOrEqual(200);
    const long = `https://hooks.example.com/${"p".repeat(170)}/TOKEN_EXPOSED`;
    const hook = ch({ kind: "webhook", url: long });
    const echoUrl = fetchOf((url) => new Response(JSON.stringify({ error: `bad ${url}` }), { status: 400 }));
    expect((await sendToChannel(hook, MSG, { fetch: echoUrl, lookup: PUBLIC, retryDelayMs: 1 })).error).toBe("HTTP 400 · bad hooks.example.com");
  });
});

describe("出站防线", () => {
  test("不跟随重定向：307 当失败、不重试，fetch 带 redirect: manual", async () => {
    const seen: RequestInit[] = [];
    const redirect = fetchOf((_u, init) => (seen.push(init), new Response("", { status: 307, headers: { location: "http://127.0.0.1:3847/relay/pair/new" } })));
    const r = await sendToChannel(ch({ kind: "ntfy", topic: "t" }), MSG, { fetch: redirect, lookup: PUBLIC, retryDelayMs: 1 });
    expect(r).toEqual({ ok: false, status: 307, error: "HTTP 307 · redirect not followed" });
    expect(seen.map((i) => i.redirect)).toEqual(["manual"]);
  });
  test("解析到本机的地址不发（字面量、localhost、IPv6、IPv4 映射、0.0.0.0）；局域网照发", async () => {
    let called = 0;
    const ok = fetchOf(() => (called++, new Response("", { status: 200 })));
    const loop: Lookup = async () => ["127.0.0.1"];
    for (const url of ["http://127.0.0.1:3847/x", "http://[::1]:3847/x", "http://0.0.0.0:3847/x", "http://[::ffff:127.0.0.1]/x"]) {
      expect(await sendToChannel(ch({ kind: "webhook", url }), MSG, { fetch: ok, lookup: PUBLIC })).toEqual({ ok: false, error: "refused: destination is this machine" });
    }
    expect((await sendToChannel(ch({ kind: "webhook", url: "http://localtest.example/x" }), MSG, { fetch: ok, lookup: loop })).error).toBe("refused: destination is this machine");
    expect(called).toBe(0);
    expect((await sendToChannel(ch({ kind: "ntfy", server: "http://192.168.1.10", topic: "t" }), MSG, { fetch: ok, lookup: PUBLIC })).ok).toBe(true);
    const nx: Lookup = async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    };
    expect(await sendToChannel(ch({ kind: "ntfy", topic: "t" }), MSG, { fetch: ok, lookup: nx })).toEqual({ ok: false, error: "dns: ENOTFOUND" });
  });
  test("isLoopbackAddress", () => {
    for (const ip of ["127.0.0.1", "127.8.9.10", "::1", "[::1]", "::", "0.0.0.0", "::ffff:127.0.0.1", "::ffff:7f00:1", "[::ffff:7f00:1]"]) expect(isLoopbackAddress(ip)).toBe(true);
    for (const ip of ["10.0.0.1", "192.168.1.10", "203.0.113.7", "::ffff:10.0.0.1", "::ffff:a00:1", "fe80::1", "2001:db8::1"]) expect(isLoopbackAddress(ip)).toBe(false);
  });
  test("出错回包最多读 4 KB：4 MiB 的回包只被拉了几块就断开", async () => {
    let pulled = 0;
    const huge = new ReadableStream<Uint8Array>({
      pull(ctl) {
        pulled += 1024;
        if (pulled > 4 * 1024 * 1024) ctl.close();
        else ctl.enqueue(new Uint8Array(1024).fill(120));
      },
    });
    const r = await sendToChannel(ch({ kind: "ntfy", topic: "t" }), MSG, { fetch: fetchOf(() => new Response(huge, { status: 400 })), lookup: PUBLIC });
    expect(r).toEqual({ ok: false, status: 400, error: "HTTP 400" });
    expect(pulled).toBeLessThanOrEqual(16 * 1024);
  });
});

describe("Codex 复审 notify r2 #1、#5", () => {
  test("#1 单个 8 MiB 的块也只拷 4 KB：照常返回状态码，不抛", async () => {
    const big = new ReadableStream<Uint8Array>({
      start(ctl) {
        ctl.enqueue(new Uint8Array(8 * 1024 * 1024).fill(120));
        ctl.close();
      },
    });
    const r = await sendToChannel(ch({ kind: "ntfy", topic: "t" }), MSG, { fetch: fetchOf(() => new Response(big, { status: 400 })), lookup: PUBLIC });
    expect(r).toEqual({ ok: false, status: 400, error: "HTTP 400" });
  });
  test("#5 DNS 卡住按超时算失败、重试一次后放弃，不发请求；临时失败后恢复照发", async () => {
    let called = 0;
    const ok = fetchOf(() => (called++, new Response("", { status: 200 })));
    let lookups = 0;
    const hang: Lookup = () => (lookups++, new Promise(() => {}));
    const t0 = Date.now();
    const r = await sendToChannel(ch({ kind: "ntfy", topic: "t" }), MSG, { fetch: ok, lookup: hang, dnsTimeoutMs: 50, retryDelayMs: 1 });
    expect(r).toEqual({ ok: false, error: "dns: timeout" });
    expect(lookups).toBe(2);
    expect(called).toBe(0);
    expect(Date.now() - t0).toBeLessThan(2000);
    let n = 0;
    const flaky: Lookup = async () => {
      if (n++ === 0) throw Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" });
      return ["203.0.113.7"];
    };
    expect(await sendToChannel(ch({ kind: "ntfy", topic: "t" }), MSG, { fetch: ok, lookup: flaky, retryDelayMs: 1 })).toEqual({ ok: true, status: 200 });
    expect(called).toBe(1);
  });
  test("拒发本机地址不重试（只查一次 DNS）", async () => {
    let lookups = 0;
    const loop: Lookup = async () => (lookups++, ["127.0.0.1"]);
    await sendToChannel(ch({ kind: "webhook", url: "http://evil.example/x" }), MSG, { fetch: fetchOf(() => new Response("")), lookup: loop, retryDelayMs: 1 });
    expect(lookups).toBe(1);
  });
});
