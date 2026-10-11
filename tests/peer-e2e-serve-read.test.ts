/**
 * E2E 入口读内层响应的两处加固（规格 peer-PEERE2E2，验收线编号写在各用例名里）：
 *   取消内层响应体有期限（cancel 永不完成也照常返回原因）；分块读取不往长期 Promise 上累积 reaction。
 * 全部内存 ReadableStream；不读 peers / 密钥文件，不联网。
 */
import { heapStats } from "bun:jsc";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readInnerBody } from "../src/lib/peer-e2e-serve.ts";

type Got = Awaited<ReturnType<typeof readInnerBody>>;

/** 有界等待：期限内没返回就是挂住了（不断言墙钟耗时） */
const within = <T = Got>(p: Promise<T>, ms = 2000): Promise<T | "hung"> =>
  Promise.race([p, new Promise<"hung">((r) => setTimeout(() => r("hung"), ms))]);

const SSE = { "content-type": "text/event-stream" };

/** 内层响应体：先给 chunks，之后读挂住；cancel 计数，hangCancel 时返回永不 resolve 的 Promise */
function inner(chunks: Uint8Array[], o: { hangCancel?: boolean; headers?: Record<string, string> } = {}) {
  const st = { cancels: 0, pulls: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      const next = chunks[st.pulls++];
      if (next) c.enqueue(next);
      else return new Promise<void>(() => {});
    },
    cancel() {
      st.cancels++;
      return o.hangCancel ? new Promise<void>(() => {}) : undefined;
    },
  });
  return { res: new Response(body, { headers: o.headers }), st };
}

/** 记下本函数往 signal 上加 / 移除的 abort 监听 */
function tracked(signal: AbortSignal) {
  const live = new Set<unknown>();
  const add = signal.addEventListener.bind(signal);
  const rm = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((t: string, l: Parameters<AbortSignal["addEventListener"]>[1], opt?: AddEventListenerOptions) => {
    live.add(l);
    add(t, l, opt);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((t: string, l: Parameters<AbortSignal["removeEventListener"]>[1], opt?: EventListenerOptions) => {
    live.delete(l);
    rm(t, l, opt);
  }) as typeof signal.removeEventListener;
  return live;
}

let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe("[验收线 1] cancel 永不完成：三种收尾都按期限返回", () => {
  test("外层断开 → aborted，记一条不含正文的诊断", async () => {
    const { res, st } = inner([utf8("secret-body")], { hangCancel: true });
    const ac = new AbortController();
    const p = readInnerBody(res, ac.signal, 1024, { cancelTimeoutMs: 10 });
    while (st.pulls < 2) await Bun.sleep(1);
    ac.abort();
    expect(await within(p)).toBe("aborted");
    expect(st.cancels).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0])).not.toContain("secret-body");
  });

  test("请求进来时外层已断开 → aborted", async () => {
    const { res } = inner([utf8("x")], { hangCancel: true });
    expect(await within(readInnerBody(res, AbortSignal.abort(), 1024, { cancelTimeoutMs: 10 }))).toBe("aborted");
  });

  test("SSE → stream", async () => {
    const { res, st } = inner([utf8("data: x\n\n")], { hangCancel: true, headers: SSE });
    expect(await within(readInnerBody(res, new AbortController().signal, 1024, { cancelTimeoutMs: 10 }))).toBe("stream");
    expect(st.cancels).toBe(1);
  });

  test("超限 → too_large", async () => {
    const { res, st } = inner([new Uint8Array(8)], { hangCancel: true });
    expect(await within(readInnerBody(res, new AbortController().signal, 4, { cancelTimeoutMs: 10 }))).toBe("too_large");
    expect(st.cancels).toBe(1);
  });

  test("cancel 失败 → 照常返回原因并记诊断", async () => {
    const body = new ReadableStream<Uint8Array>({ pull: (c) => c.enqueue(new Uint8Array(8)), cancel: () => Promise.reject(new Error("boom")) });
    expect(await within(readInnerBody(new Response(body), new AbortController().signal, 4))).toBe("too_large");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

/** 读 2000 + n 个单字节分块，在第 2000 块和第 2000+n 块各取一次 GC 后的 Promise / reaction 计数，返回增量 */
async function promiseGrowth(n: number): Promise<number> {
  const at = new Set([2000, 2000 + n]);
  const counts: number[] = [];
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      i++;
      if (at.has(i)) {
        Bun.gc(true);
        const t = heapStats().objectTypeCounts;
        counts.push(Object.entries(t).filter(([k]) => /Promise/.test(k)).reduce((s, [, v]) => s + v, 0));
      }
      if (i > 2000 + n) c.close();
      else c.enqueue(new Uint8Array(1));
    },
  });
  const got = await readInnerBody(new Response(body), new AbortController().signal, 1 << 20);
  expect(got).toBeInstanceOf(Uint8Array);
  expect((got as Uint8Array).length).toBe(2000 + n);
  return counts[1]! - counts[0]!;
}

test("[验收线 2] signal 不取消、读 20000 个单字节分块：常驻 Promise / reaction 数不随块数增长", async () => {
  const n = 20000;
  const grew = await promiseGrowth(n);
  expect(grew).toBeLessThan(n / 20);
});

describe("[验收线 3] 中途断开只取消一次；任何结果返回后 signal 上不残留监听", () => {
  test("读到一半外层断开 → aborted，cancel 恰好一次", async () => {
    const { res, st } = inner([utf8("a"), utf8("b"), utf8("c")]);
    const ac = new AbortController();
    const live = tracked(ac.signal);
    const p = readInnerBody(res, ac.signal, 1024);
    while (st.pulls < 4) await Bun.sleep(1);
    ac.abort();
    expect(await within(p)).toBe("aborted");
    expect(st.cancels).toBe(1);
    expect(live.size).toBe(0);
  });

  test("读完 / 超限 / SSE / 流出错：都不残留监听", async () => {
    const run = async (res: Response, max = 1024): Promise<{ got: Got | "threw"; live: number }> => {
      const ac = new AbortController();
      const live = tracked(ac.signal);
      const got = await readInnerBody(res, ac.signal, max).catch(() => "threw" as const);
      return { got, live: live.size };
    };
    expect(await run(new Response("ok"))).toEqual({ got: utf8("ok"), live: 0 });
    expect(await run(new Response(new Uint8Array(8)), 4)).toEqual({ got: "too_large", live: 0 });
    expect(await run(inner([utf8("x")], { headers: SSE }).res)).toEqual({ got: "stream", live: 0 });
    const broken = new ReadableStream<Uint8Array>({ pull: (c) => c.error(new Error("inner broke")) });
    expect(await run(new Response(broken))).toEqual({ got: "threw", live: 0 });
  });
});

describe("流出错与外层断开交错：先发生的那个说了算（PM 定 3：流本身出错照旧往外抛）", () => {
  const race = async (errorFirst: boolean): Promise<Got | string> => {
    const ac = new AbortController();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
    const p = readInnerBody(new Response(body), ac.signal, 1024, { cancelTimeoutMs: 50 })
      .catch((e: Error) => `throws:${e.message}`);
    await Bun.sleep(1); // 让 read 先挂起
    if (errorFirst) {
      controller.error(new Error("inner broke"));
      ac.abort();
    } else {
      ac.abort();
      controller.error(new Error("inner broke"));
    }
    return within(p);
  };
  test("先流出错再外层断开 → 抛原错误", async () => {
    expect(await race(true)).toBe("throws:inner broke");
  });
  test("先外层断开再流出错 → aborted", async () => {
    expect(await race(false)).toBe("aborted");
  });
});

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
