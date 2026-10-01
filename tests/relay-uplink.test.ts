/**
 * 中继上行：流量账（src/lib/relay-traffic.ts）的聚合与摘要、入站路由（relay-client-inbound.ts）的记账点、
 * 路径模式 JSON 压缩（relay-stream.ts gzipJson）、/events 的 agent 过滤参数（bridge/event-bus.ts eventsQueryFilter）。
 */
import { describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { RelayTraffic, trafficPath } from "../src/lib/relay-traffic.js";
import { InboundRouter } from "../src/lib/relay-client-inbound.js";
import { gzipJson } from "../src/lib/relay-stream.js";
import { eventsQueryFilter } from "../src/bridge/event-bus.js";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe("trafficPath", () => {
  test("去掉查询串与片段，长随机段 / 长数字折成 :id，agent 名留着", () => {
    expect(trafficPath("/api/v1/events?since=1790777671875&token=secret")).toBe("/api/v1/events");
    expect(trafficPath("/api/v1/agents/claudestra-debug/history?after=12#x")).toBe("/api/v1/agents/claudestra-debug/history");
    expect(trafficPath("/api/v1/threads/thr_8f2a9c1d4e5b6a7f/x")).toBe("/api/v1/threads/:id/x");
    expect(trafficPath("/_next/static/chunks/page-dda3dcb73e4097f8.js")).toBe("/_next/static/chunks/:id");
    expect(trafficPath("/api/v1/asks/1790777671875")).toBe("/api/v1/asks/:id");
    expect(trafficPath("/api/v1/handoff/AbCdEfGhIjKlMnOpQr")).toBe("/api/v1/handoff/:id"); // 没有数字的随机口令也折
    expect(trafficPath("/api/v1/agents/claudestra-audit-codex/pending")).toBe("/api/v1/agents/claudestra-audit-codex/pending");
    expect(trafficPath("")).toBe("/");
  });
});

describe("RelayTraffic 摘要", () => {
  test("窗口不满不出行；满了按字节排前 N，带取消 / 失败 / 状态码，不含查询串", () => {
    const c = clock();
    const t = new RelayTraffic(c.now, { windowMs: 60_000, topN: 2 });
    const a = t.open("get", "/api/v1/agents?x=secret");
    a.sent(40_000);
    c.advance(16_000);
    a.end("cancelled", 200);
    const b = t.open("GET", "/api/v1/agents");
    b.sent(30_000);
    b.end("ok", 200);
    const h = t.open("GET", "/api/v1/agents/x/history");
    h.sent(5_000);
    h.end("ok", 429);
    const tiny = t.open("GET", "/api/v1/asks");
    tiny.sent(10);
    tiny.end("failed");
    t.onWire(100_000);
    t.onLate();
    expect(t.tick()).toBeNull();
    c.advance(44_000);
    const line = t.tick()!;
    expect(line).toContain("上行 60s：ws 97.7KB/1 帧");
    expect(line).toContain("新请求 4（取消 1，失败 1），在途 0；迟到帧 1");
    expect(line).toContain("GET /api/v1/agents 68.4KB/2帧（×2 取消1 最长16.0s）");
    expect(line).toContain("GET /api/v1/agents/x/history 4.9KB/1帧（×1 429×1）");
    expect(line).not.toContain("/api/v1/asks"); // topN=2
    expect(line).not.toContain("secret");
    expect(t.tick()).toBeNull(); // 窗口清零
  });

  test("长连接跨窗口：每个窗口只记本窗口的字节，显示在途；只有心跳的分钟不出行", () => {
    const c = clock();
    const t = new RelayTraffic(c.now);
    const sse = t.open("GET", "/api/v1/events?agents=a");
    sse.sent(9_000);
    c.advance(60_000);
    expect(t.flush()).toContain("GET /api/v1/events 8.8KB/1帧（×1 在途1）");
    sse.sent(8); // 一次 ": ping"
    c.advance(60_000);
    expect(t.flush()).toBeNull();
    sse.sent(6_000);
    sse.end("cancelled");
    c.advance(60_000);
    expect(t.flush()).toContain("GET /api/v1/events 5.9KB/1帧（×0 取消1 最长120.0s）");
    sse.sent(99_999); // 收尾之后再记无效
    expect(t.flush()).toBeNull();
  });
});

describe("InboundRouter 记账", () => {
  const req = (id: string, path: string) => ({ t: "req" as const, id, method: "GET", path, headers: {} });

  test("分块响应：正文字节、帧数、正常收尾", async () => {
    const c = clock();
    const traffic = new RelayTraffic(c.now);
    const frames: Record<string, unknown>[] = [];
    const body = new Uint8Array(100 * 1024);
    const r = new InboundRouter((f) => (frames.push(f as Record<string, unknown>), true), async () => ({ status: 200, headers: {}, body }), () => {}, 64 * 1024, traffic);
    r.onReq(req("a1", "/api/v1/agents/x/history?limit=50"));
    while (!frames.some((f) => f.t === "end")) await Bun.sleep(1);
    await Bun.sleep(1);
    expect(r.size).toBe(0);
    expect(traffic.flush()).toContain("GET /api/v1/agents/x/history 100.0KB/2帧（×1）");
  });

  test("发起方取消：记取消、在途归零，之后不再发数据帧", async () => {
    const traffic = new RelayTraffic(clock().now);
    const frames: Record<string, unknown>[] = [];
    const ctl: { c?: ReadableStreamDefaultController<Uint8Array> } = {};
    const stream = new ReadableStream<Uint8Array>({ start: (c) => void (ctl.c = c) }); // start 在构造时同步调用
    const r = new InboundRouter((f) => (frames.push(f as Record<string, unknown>), true), async () => ({ status: 200, headers: {}, body: stream }), () => {}, 64 * 1024, traffic);
    r.onReq(req("s1", "/api/v1/events"));
    ctl.c!.enqueue(new Uint8Array(5000));
    while (!frames.some((f) => f.t === "data")) await Bun.sleep(1);
    expect(r.onCancel("relay", "s1")).toBe(true);
    ctl.c!.enqueue(new Uint8Array(5000));
    await Bun.sleep(5);
    expect(frames.filter((f) => f.t === "data")).toHaveLength(1);
    const line = traffic.flush()!;
    expect(line).toContain("在途 0");
    expect(line).toContain("GET /api/v1/events 4.9KB/1帧（×1 取消1）");
  });
});

describe("gzipJson", () => {
  const stream = (u: Uint8Array) => new Response(u).body!;
  const big = new TextEncoder().encode(JSON.stringify({ ok: true, messages: Array.from({ length: 200 }, (_, i) => ({ seq: i, text: "同一段回复正文 " + i })) }));

  test("浏览器接受 gzip 的 JSON ≥1KB：压缩、去 content-length、加 vary，解开还是原文", async () => {
    const out = await gzipJson({ "content-type": "application/json", "content-length": String(big.length) }, stream(big), "gzip, deflate, br");
    expect(out.headers["content-encoding"]).toBe("gzip");
    expect(out.headers["content-length"]).toBeUndefined();
    expect(out.headers.vary).toBe("Accept-Encoding");
    const zipped = out.body as Uint8Array;
    expect(zipped.length).toBeLessThan(big.length / 4);
    expect(new TextDecoder().decode(gunzipSync(zipped))).toBe(new TextDecoder().decode(big));
  });

  test("不该压的原样放行：SSE、没声明 gzip、已有编码；小 JSON 整读但不压", async () => {
    const sse = stream(big);
    expect((await gzipJson({ "content-type": "text/event-stream" }, sse, "gzip")).body).toBe(sse);
    const noAccept = stream(big);
    expect((await gzipJson({ "content-type": "application/json" }, noAccept, "")).body).toBe(noAccept);
    const encoded = stream(big);
    expect((await gzipJson({ "content-type": "application/json", "content-encoding": "br" }, encoded, "gzip")).body).toBe(encoded);
    const small = await gzipJson({ "content-type": "application/json; charset=utf-8" }, stream(new TextEncoder().encode('{"ok":true}')), "gzip");
    expect(small.headers["content-encoding"]).toBeUndefined();
    expect(new TextDecoder().decode(small.body as Uint8Array)).toBe('{"ok":true}');
    expect((await gzipJson({ "content-type": "application/json" }, null, "gzip")).body).toBeNull();
  });
});

describe("eventsQueryFilter", () => {
  test("agent / agents 两种写法，叠在调用方给的过滤上", () => {
    const allow = () => true;
    expect(eventsQueryFilter(new URLSearchParams("agents=debug,agent-debug&since=5"), { allow })).toEqual({ allow, agents: ["debug", "agent-debug"] });
    expect(eventsQueryFilter(new URLSearchParams("agent=master"))).toEqual({ agent: "master" });
    expect(eventsQueryFilter(new URLSearchParams("agents=,"))).toEqual({});
    expect(eventsQueryFilter(new URLSearchParams(""))).toEqual({});
  });
});
