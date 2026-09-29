/**
 * 有上限地读对方的响应正文（src/lib/body-reader.ts）：空段不算动静、一字节一字节地喂撑不过总时限、超限当场掐断并 cancel。
 */
import { describe, expect, test } from "bun:test";
import { BodyTimeoutError, CappedBytes, drainBody, readJsonCapped } from "../src/lib/body-reader.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = (s: string) => new TextEncoder().encode(s);

/** 每 everyMs 吐一段 next()；next 返回 null 就结束。记下被没被 cancel */
function slowStream(everyMs: number, next: (i: number) => Uint8Array | null) {
  const st = { cancelled: false, i: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull: async (c) => {
      await sleep(everyMs);
      const v = next(st.i++);
      if (v === null) c.close();
      else c.enqueue(v);
    },
    cancel: () => void (st.cancelled = true),
  });
  return { st, res: new Response(stream) };
}

describe("drainBody / readJsonCapped", () => {
  test("空段洪泛不刷新空闲计时：idle 10 ms、每 6 ms 一个空段，58 ms 后才来的 JSON 不被接受", async () => {
    const forged = enc('{"ok":true,"forged":1}');
    const { st, res } = slowStream(6, (i) => (i < 10 ? new Uint8Array(0) : i === 10 ? forged : null));
    expect(await readJsonCapped(res, 1024, { idleMs: 10, totalMs: 5_000 })).toBeNull();
    expect(st.cancelled).toBe(true);
    expect(st.i).toBeLessThan(5);
  });

  test("一字节一字节地喂：每段都在空闲时限内，也撑不过总时限（BodyTimeoutError total）", async () => {
    const { st, res } = slowStream(5, () => enc(" "));
    const t0 = Date.now();
    const err = await drainBody(res, () => {}, { idleMs: 50, totalMs: 120 }).catch((e) => e);
    expect(err).toBeInstanceOf(BodyTimeoutError);
    expect(err.kind).toBe("total");
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(st.cancelled).toBe(true);
  });

  test("超过上限当场掐断：只拉了几段就 cancel，返回 null", async () => {
    const { st, res } = slowStream(0, () => new Uint8Array(4096));
    expect(await readJsonCapped(res, 10_000)).toBeNull();
    expect(st.cancelled).toBe(true);
    expect(st.i).toBeLessThan(6);
  });

  test("单字节分片灌满：不按分片留对象，扩容次数只随 log(总字节) 增长；超上限当场拒", () => {
    const acc = new CappedBytes(1 << 20);
    const one = new Uint8Array([0x61]);
    for (let i = 0; i < 300_000; i++) acc.push(one);
    expect(acc.bytes().length).toBe(300_000);
    expect(acc.allocs).toBeLessThanOrEqual(6); // 16 KiB → 32 → … → 512 KiB，不是 30 万个分片对象
    const tiny = new CappedBytes(3);
    tiny.push(enc("ab"));
    expect(() => tiny.push(enc("cd"))).toThrow(RangeError);
    expect(new TextDecoder().decode(tiny.bytes())).toBe("ab");
  });

  test("流式单字节分片的合法 JSON 照样读对（跨分片的多字节 UTF-8 也拼得回来）", async () => {
    const bytes = enc(JSON.stringify({ ok: true, text: "中文 é ✓".repeat(50) }));
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({ pull: (c) => (i < bytes.length ? c.enqueue(bytes.subarray(i, ++i)) : c.close()) });
    expect(await readJsonCapped(new Response(stream))).toEqual({ ok: true, text: "中文 é ✓".repeat(50) });
  });

  test("正常的 JSON 照读；不是 JSON 返回 null", async () => {
    expect(await readJsonCapped(Response.json({ ok: true, agents: [] }))).toEqual({ ok: true, agents: [] });
    expect(await readJsonCapped(new Response("<html>bad gateway</html>", { status: 502 }))).toBeNull();
    expect(await readJsonCapped(new Response(null, { status: 204 }))).toBeNull();
  });
});
