/**
 * 提前回响应、没读完分块正文时 keep-alive 连接不能坏：
 *   - bridge 一侧 drainingFetch（bridge/unread-body.ts）把没读的正文读掉再回；
 *   - 隧道一侧 forwardTunnel 带正文的请求不复用连接（bridge/relay-inbound.ts keepalive:false）。
 * 两边都去掉时（Bun 1.3.x），同一条回环连接上紧跟的下一个请求得到空的 400、处理函数不被调用。真 Bun.serve、回环随机端口。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { drainingFetch, drainUnreadBody } from "../src/bridge/unread-body.js";
import { makeInboundHandler } from "../src/bridge/relay-inbound.js";

const chunked = (s: string | Uint8Array) => new ReadableStream<Uint8Array>({
  start: (c) => { c.enqueue(typeof s === "string" ? new TextEncoder().encode(s) : s); c.close(); },
});
const servers: { stop(force?: boolean): void }[] = [];
afterAll(() => { for (const s of servers) s.stop(true); });

function rejectingServer(wrap: boolean) {
  const seen: string[] = [];
  const handler = async (req: Request) => {
    seen.push(`${req.method} ${new URL(req.url).pathname}`);
    return new Response("no", { status: 403 });
  };
  const serve = wrap ? drainingFetch(handler) : handler;
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => (await serve(req, null)) ?? new Response(null, { status: 500 }) });
  servers.push(srv);
  return { base: `http://127.0.0.1:${srv.port}`, seen };
}

describe("drainingFetch", () => {
  test("提前 403 没读的分块正文被读掉：紧跟的请求照常到处理函数", async () => {
    const { base, seen } = rejectingServer(true);
    const got: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r1 = await fetch(`${base}/p${i}`, { method: "POST", body: chunked('{"a":1}'), duplex: "half" } as RequestInit);
      await r1.text();
      const r2 = await fetch(`${base}/g${i}`);
      await r2.text();
      got.push(r1.status, r2.status);
    }
    expect(got).toEqual([403, 403, 403, 403, 403, 403]);
    expect(seen).toEqual(["POST /p0", "GET /g0", "POST /p1", "GET /g1", "POST /p2", "GET /g2"]);
  });

  test("处理函数已经读过正文、没有正文、超过上限：都不卡住", async () => {
    const read = new Request("http://x/", { method: "POST", body: "abc" });
    await read.text();
    await drainUnreadBody(read);
    await drainUnreadBody(new Request("http://x/"));
    const big = new Request("http://x/", { method: "POST", body: chunked(new Uint8Array(4096)), duplex: "half" } as RequestInit);
    await drainUnreadBody(big, 1024);
    expect(big.bodyUsed).toBe(true);
  });
});

describe("隧道 forwardTunnel", () => {
  test("本机 Web 提前拒绝了一个隧道 POST（没读正文）：紧跟的隧道 GET 不是 400", async () => {
    const { base, seen } = rejectingServer(false); // 不带 drainingFetch：只靠隧道一侧不复用连接
    const handler = makeInboundHandler({ webBase: base, ingressBase: () => null, refusePeer: async () => null });
    const ctx = { from: "relay", signal: new AbortController().signal };
    const call = async (method: string, path: string) => {
      const res = await handler({ method, path, headers: { "x-forwarded-host": "mini.relay.test" }, body: chunked(method === "GET" ? "" : '{"join":"x"}') }, ctx);
      if (res.body instanceof ReadableStream) await new Response(res.body).arrayBuffer();
      return res.status;
    };
    const got: number[] = [];
    for (let i = 0; i < 3; i++) got.push(await call("POST", `/api/v1/peers/redeem?i=${i}`), await call("GET", `/api/v1/agents?i=${i}`));
    expect(got).toEqual([403, 403, 403, 403, 403, 403]);
    expect(seen.filter((s) => s.startsWith("GET"))).toHaveLength(3);
  });
});
