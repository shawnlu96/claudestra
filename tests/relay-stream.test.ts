/**
 * 帧 ↔ HTTP 搬运的纯函数（src/lib/relay-stream.ts）：分块、流的拼装与取消、正文上限、头过滤与 Location 改写。
 */
import { describe, expect, test } from "bun:test";
import { b64, chunkBytes, collectBody, dropForPeer, forwardHeaders, headersToObject, pumpBody, rewriteLocation, streamSink } from "../src/lib/relay-stream.js";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (u: Uint8Array) => new TextDecoder().decode(u);
const streamOf = (...parts: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of parts) c.enqueue(enc(p));
      c.close();
    },
  });

describe("分块与 pump", () => {
  test("chunkBytes：按上限切，空输入空数组", () => {
    expect(chunkBytes(new Uint8Array(0), 4)).toEqual([]);
    expect(chunkBytes(enc("abcdefghij"), 4).map(dec)).toEqual(["abcd", "efgh", "ij"]);
    expect(chunkBytes(enc("abcd"), 4).map(dec)).toEqual(["abcd"]);
  });
  test("pumpBody：字节与流都切块，最后 emit(null)；null 正文只 emit(null)", async () => {
    const seen: (string | null)[] = [];
    await pumpBody(enc("abcdefg"), (c) => seen.push(c ? dec(c) : null), undefined, 3);
    expect(seen).toEqual(["abc", "def", "g", null]);
    seen.length = 0;
    await pumpBody(streamOf("abcd", "efghi"), (c) => seen.push(c ? dec(c) : null), undefined, 3);
    expect(seen).toEqual(["abc", "d", "efg", "hi", null]);
    seen.length = 0;
    await pumpBody(null, (c) => seen.push(c ? dec(c) : null));
    expect(seen).toEqual([null]);
  });
  test("pumpBody：abort 后停止读并抛", async () => {
    const ac = new AbortController();
    const slow = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(enc("x"));
        ac.abort();
      },
    });
    const seen: (string | null)[] = [];
    await expect(pumpBody(slow, (c) => seen.push(c ? dec(c) : null), ac.signal)).rejects.toThrow(/aborted/);
    expect(seen).toEqual(["x"]);
  });
});

describe("streamSink 与 collectBody", () => {
  test("push / end 读回全部；closed 状态；end 后 push 不抛", async () => {
    const s = streamSink();
    s.push(enc("he"));
    s.push(enc("llo"));
    expect(s.closed).toBe(false);
    s.end();
    expect(s.closed).toBe(true);
    s.push(enc("late"));
    expect(dec(await collectBody(s.stream, 100))).toBe("hello");
  });
  test("fail 让读端报错", async () => {
    const s = streamSink();
    s.push(enc("a"));
    s.fail(new Error("boom"));
    await expect(collectBody(s.stream, 100)).rejects.toThrow("boom");
  });
  test("读端 cancel 触发 onCancel，之后 push 无效", async () => {
    let cancelled = 0;
    const s = streamSink(() => cancelled++);
    await s.stream.cancel();
    expect(cancelled).toBe(1);
    expect(s.closed).toBe(true);
    s.push(enc("x"));
    s.end();
  });
  test("collectBody：字节直通、流拼接、超限抛", async () => {
    expect(dec(await collectBody(enc("ab"), 2))).toBe("ab");
    await expect(collectBody(enc("abc"), 2)).rejects.toThrow(/exceeds 2/);
    expect(dec(await collectBody(streamOf("ab", "cd"), 4))).toBe("abcd");
    await expect(collectBody(streamOf("ab", "cd", "e"), 4)).rejects.toThrow(/exceeds/);
    expect((await collectBody(null, 1)).length).toBe(0);
  });
  test("b64 往返", () => {
    expect(dec(b64.dec(b64.enc(enc("héllo"))))).toBe("héllo");
  });
});

describe("头处理", () => {
  test("forwardHeaders：去 hop-by-hop 与 content-length，键小写，drop 回调可再去", () => {
    const raw = { Connection: "keep-alive", "Content-Length": "3", "X-Keep": "1", Host: "h", "X-Forwarded-For": "1.1.1.1", "X-Claudestra-Relay-From": "spoof", Authorization: "Bearer t" };
    const h = forwardHeaders(raw);
    expect(h).toEqual({ "x-keep": "1", host: "h", "x-forwarded-for": "1.1.1.1", "x-claudestra-relay-from": "spoof", authorization: "Bearer t" });
    expect(forwardHeaders(h, dropForPeer)).toEqual({ "x-keep": "1", authorization: "Bearer t" });
  });
  test("headersToObject：fetch Headers → 小写键对象", () => {
    expect(headersToObject(new Headers({ "Content-Type": "a", "X-B": "c" }))).toEqual({ "content-type": "a", "x-b": "c" });
  });
  test("rewriteLocation：只改本主机的 http:// 绝对地址", () => {
    expect(rewriteLocation({ location: "http://mini.relay.test/login?x=1" }, "mini.relay.test").location).toBe("https://mini.relay.test/login?x=1");
    expect(rewriteLocation({ location: "http://Mini.Relay.Test" }, "mini.relay.test").location).toBe("https://mini.relay.test");
    expect(rewriteLocation({ location: "http://mini.relay.test.evil/x" }, "mini.relay.test").location).toBe("http://mini.relay.test.evil/x");
    expect(rewriteLocation({ location: "/relative" }, "mini.relay.test").location).toBe("/relative");
    expect(rewriteLocation({ location: "http://other.test/" }, "mini.relay.test").location).toBe("http://other.test/");
    expect(rewriteLocation({ "x-a": "1" }, "h")).toEqual({ "x-a": "1" });
    expect(rewriteLocation({ location: "http://h/x" }, "").location).toBe("http://h/x");
  });
});

import { headersToObject as h2o, recordToHeaders, SET_COOKIE_SEP } from "../src/lib/relay-stream.ts";

describe("set-cookie 多值：帧里 \\n 连接，出帧拆回多条", () => {
  test("两条 Set-Cookie 不会被合成一条", () => {
    const h = new Headers();
    h.append("set-cookie", "a=1; Path=/; Expires=Sun, 26 Sep 2027 18:45:18 GMT");
    h.append("set-cookie", "b=2; Path=/; HttpOnly");
    h.set("content-type", "application/json");
    const rec = h2o(h);
    expect(rec["set-cookie"]).toBe(`a=1; Path=/; Expires=Sun, 26 Sep 2027 18:45:18 GMT${SET_COOKIE_SEP}b=2; Path=/; HttpOnly`);
    const back = recordToHeaders(rec);
    expect(back.getSetCookie()).toEqual(["a=1; Path=/; Expires=Sun, 26 Sep 2027 18:45:18 GMT", "b=2; Path=/; HttpOnly"]);
    expect(back.get("content-type")).toBe("application/json");
  });
  test("没有 cookie 时不产生 set-cookie 键", () => {
    expect(h2o(new Headers({ "x-a": "1" }))).toEqual({ "x-a": "1" });
  });
});
