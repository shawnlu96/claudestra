/** 撤销设备凭据要连带在途的流（src/bridge/credential-revocation.ts）：中止读端、cancel 源流；别的凭据 / Bearer 身份不受影响 */
import { describe, expect, test } from "bun:test";
import { emitCredentialRevoked, onCredentialRevoked, revocable } from "../src/bridge/credential-revocation.js";
import type { Principal } from "../src/lib/principals.js";

const owner = (credential?: string): Principal => ({ id: "owner:self", role: "owner", agents: ["*"], createdAt: "x", ...(credential ? { credential } : {}) });

/** 每 5 ms 吐一块的 SSE 样式源流；记录有没有被 cancel */
function ticking() {
  let cancelled = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      timer = setInterval(() => c.enqueue(new TextEncoder().encode(": ping\n")), 5);
    },
    cancel() {
      cancelled = true;
      if (timer) clearInterval(timer);
    },
  });
  return { stream, cancelled: () => cancelled, stop: () => timer && clearInterval(timer) };
}

describe("revocable", () => {
  test("撤销这条凭据：浏览器那头的读出错，源流被 cancel；监听器随之注销", async () => {
    const src = ticking();
    const res = revocable(new Response(src.stream, { status: 200, headers: { "content-type": "text/event-stream" } }), owner("dev_1"));
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    emitCredentialRevoked("dev_other"); // 别人的凭据：无事发生
    expect((await reader.read()).done).toBe(false);
    emitCredentialRevoked("dev_1");
    await expect(drain(reader)).rejects.toBeDefined();
    await new Promise((r) => setTimeout(r, 20));
    expect(src.cancelled()).toBe(true);
  });

  test("Bearer 身份（没有 credential）或无正文的响应原样返回", () => {
    const res = new Response("x");
    expect(revocable(res, owner())).toBe(res);
    const empty = new Response(null, { status: 204 });
    expect(revocable(empty, owner("dev_2"))).toBe(empty);
  });

  test("onCredentialRevoked 的退订生效", () => {
    let hits = 0;
    const off = onCredentialRevoked(() => hits++);
    emitCredentialRevoked("a");
    off();
    emitCredentialRevoked("a");
    expect(hits).toBe(1);
  });
});

async function drain(reader: { read(): Promise<{ done: boolean }> }): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const { done } = await reader.read();
    if (done) return;
  }
}
