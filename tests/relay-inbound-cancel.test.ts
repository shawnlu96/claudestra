/**
 * 中继路径模式整链：发起方 cancel → InboundRouter abort → pumpBody cancel 源流 → bridge 侧 SSE 的 cancel() 跑到。
 * 这条链断过：pumpBody 只 releaseLock，终端 viewer / events 订阅留到 bridge 重启（TRM1，手机终端报 max 8）。
 */
import { expect, test } from "bun:test";
import { InboundRouter } from "../src/lib/relay-client-inbound.js";
import { dispatchMachineRequest } from "../src/bridge/relay-dispatch.js";
import { RELAY_MODE_API, RELAY_MODE_HEADER } from "../src/lib/relay-machine-path.js";
import type { ReqFrame } from "../src/lib/relay-protocol.js";

test("路径模式 SSE：发起方 cancel 后源流 cancel 被调、ping 停推、不再发 data 帧", async () => {
  let cancelled = false;
  let signalAborted = false;
  let ping: ReturnType<typeof setInterval> | undefined;
  const handleApi = async (req: Request) => {
    req.signal.addEventListener("abort", () => { signalAborted = true; });
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(": connected\n\n"));
        ping = setInterval(() => c.enqueue(enc.encode(": ping\n\n")), 20);
      },
      cancel() {
        cancelled = true;
        clearInterval(ping);
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };
  const frames: { t: string }[] = [];
  const router = new InboundRouter(
    (f) => { frames.push(f as { t: string }); return true; },
    (req, ctx) => dispatchMachineRequest(req, ctx, handleApi),
    () => {},
  );
  const req: ReqFrame = { t: "req", id: "r1", method: "GET", path: "/api/v1/agents/x/terminal", headers: { [RELAY_MODE_HEADER]: RELAY_MODE_API }, more: false };
  router.onReq(req);
  try {
    await Bun.sleep(80);
    expect(frames.some((f) => f.t === "data")).toBe(true);

    router.onCancel("relay", "r1");
    await Bun.sleep(30);
    expect(signalAborted).toBe(true);
    expect(cancelled).toBe(true);
    const after = frames.length;
    await Bun.sleep(80);
    expect(frames.length).toBe(after); // 取消后既不再推 data，也不补发 end
    expect(frames.some((f) => f.t === "end")).toBe(false);
  } finally {
    clearInterval(ping); // 断言失败时也别让定时器把测试进程挂住
  }
});
