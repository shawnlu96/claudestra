/**
 * web/features/asks/asks-store.ts 的乐观作答状态机（PR0 审查 r1 的 P2-1～4、6）：到点自己撤、只撤自己那一笔、乱序拉取丢旧的、
 * 服务端结案后清掉失败红字。接口 mock 掉（@/lib/api/asks），拉取可以手动按顺序放行。
 * 以及列表拉不到时（老 bridge 404、503、断网、超时）不让聊天气泡永久「正在核对」（PR B 第 3 轮 P1）。
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

type A = Record<string, unknown>;
interface AsksStore {
  get(): { asks: A[]; loaded: boolean; full?: boolean; banner: A | null; notes: Record<string, { ok: boolean; text: string } | undefined> };
  refresh(): Promise<void>;
  start(key: string): () => void;
  answer(id: string, shown: unknown, submit: () => Promise<unknown>, words: { ok: string; fail: (e: unknown) => string }): Promise<boolean>;
}
let serverList: A[] = [];
const queue: { resolve: (v: unknown) => void; snapshot: A[] }[] = [];
let manual = false;
let failWith: unknown = null;
// mock.module 对整个进程生效、本文件结束也不撤：同进程后面的文件（web-dom-* 经 asks.ts 用 takeAskHint 等）要拿到其余真导出
const realAsks = await import("@/lib/api/asks");
mock.module("@/lib/api/asks", () => ({
  ...realAsks,
  fetchAsks: () => {
    if (failWith) return Promise.reject(failWith);
    const snapshot = structuredClone(serverList);
    if (!manual) return Promise.resolve({ ok: true, asks: snapshot, now: Date.now() });
    return new Promise((resolve) => queue.push({ resolve, snapshot }));
  },
  followAskEvents: () => new Promise(() => {}),
  postPresence: () => Promise.resolve(),
}));
// 变量路径：根 tsconfig 没有 DOM 类型，store 用到 document / serviceWorker，只在运行时加载（类型取 AsksStore 的形状）
const STORE = "@/features/asks/asks-store";
const { asksStore } = (await import(STORE)) as { asksStore: AsksStore };
const { askCounts, ASK_LIST_WAIT_MS, PENDING_MAX_MS } = await import("@/features/asks/asks-model");
const { ApiError } = await import("@/lib/api/client");

const ask = (over: A): A => ({
  id: "ask_1", project: "p", taskId: null, fromAgent: "agent-x", source: "reply", kind: "decide", blocking: true, urgency: "normal",
  title: "t", context: "", body: "", options: [], allowText: false, kindHint: null, expiresAt: 9e12, state: "open", answer: null,
  createdAt: 1, updatedAt: 1, ...over,
});
const shown = { choices: [], labels: ["甲"], text: "", via: "web_card", at: 0 };
const words = { ok: "OK", fail: (e: unknown) => `FAIL:${(e as Error).message}` };
const tick = () => new Promise((r) => setTimeout(r, 5));
const st = () => asksStore.get().asks.find((a) => a.id === "ask_1")?.state;
const release = (fetches: typeof queue, full?: boolean) => fetches.forEach((f) => f.resolve({ ok: true, asks: f.snapshot, full, now: 0 }));
const realNow = Date.now;

beforeEach(async () => {
  Date.now = realNow;
  manual = false;
  failWith = null;
  queue.length = 0;
  serverList = [ask({ id: "ask_1" }), ask({ id: "ask_2" })];
  await asksStore.refresh();
});

test("PM 提问（包括急件）不进收件箱 / 角标 / 横幅，owner 新件正常弹；改派 PM 清掉旧横幅", async () => {
  const pm = ask({ id: "pm", fromAgent: "agent-lend-x@Sekai", assignee: "agent-claudestra", blocking: true, urgency: "urgent", canAnswer: true });
  serverList = [pm];
  await asksStore.refresh();
  expect(asksStore.get().asks).toEqual([]);
  expect(askCounts(asksStore.get().asks as never)).toEqual({ waiting: 0, accept: 0 });
  expect(asksStore.get().banner).toBeNull();
  const owner = ask({ id: "owner-new", assignee: "local:owner:self" });
  serverList = [pm, owner];
  await asksStore.refresh();
  expect(asksStore.get().asks).toEqual([owner]);
  expect(asksStore.get().banner?.id).toBe(owner.id);
  serverList = [pm, { ...owner, assignee: "agent-claudestra" }];
  await asksStore.refresh();
  expect(asksStore.get().asks).toEqual([]);
  expect(asksStore.get().banner).toBeNull();
});

test("成功但服务端一直 open：从请求回来算 20 秒，到点自己撤（不等下一次拉取）", async () => {
  const timers: [() => void, number][] = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((f: () => void, ms: number) => (timers.push([f, ms]), 0)) as unknown as typeof setTimeout;
  try {
    await asksStore.answer("ask_1", shown, () => Promise.resolve(), words);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  await tick();
  expect([st(), askCounts(asksStore.get().asks as never).waiting]).toEqual(["answered", 1]);
  const t0 = realNow();
  Date.now = () => t0 + PENDING_MAX_MS + 10;
  const [fire, ms] = timers.find(([, m]) => m > PENDING_MAX_MS)!;
  expect(ms).toBe(PENDING_MAX_MS + 1);
  fire();
  expect([st(), askCounts(asksStore.get().asks as never).waiting]).toEqual(["open", 2]);
});

test("请求在飞不管多久都不撤；在飞时又点了一次，第一次失败不带走第二次的覆盖", async () => {
  let rej1!: (e: unknown) => void;
  let res2!: () => void;
  const t0 = realNow();
  const p1 = asksStore.answer("ask_1", shown, () => new Promise((_, r) => (rej1 = r)), words);
  Date.now = () => t0 + PENDING_MAX_MS + 1_000;
  await asksStore.refresh();
  expect(st()).toBe("answered");
  const p2 = asksStore.answer("ask_1", shown, () => new Promise<void>((r) => (res2 = r)), words);
  rej1(new ApiError("slow fail", 504));
  await p1;
  expect(st()).toBe("answered");
  res2();
  await p2;
});

test("乱序拉取：作答前发出、确认后才回来的旧结果（open）丢掉，不把卡翻回「等你处理」", async () => {
  manual = true;
  const stale = asksStore.refresh(); // 写库前发出的（例如 30 秒轮询）
  const pAns = asksStore.answer("ask_1", shown, () => Promise.resolve(), words);
  serverList = [ask({ id: "ask_1", state: "answered", answer: { ...shown } }), ask({ id: "ask_2" })];
  await tick();
  const [old, ...rest] = queue.splice(0);
  release(rest);
  await pAns;
  await tick();
  expect(st()).toBe("answered");
  release([old]);
  await stale;
  await tick();
  expect(st()).toBe("answered");
});

test("断网失败留下的红字：这件在别处结案后清掉；失败立即回滚、计数恢复", async () => {
  await asksStore.answer("ask_1", shown, () => Promise.reject(new TypeError("Failed to fetch")), words);
  expect([st(), asksStore.get().notes.ask_1?.ok]).toEqual(["open", false]);
  serverList = [ask({ id: "ask_1", state: "answered", answer: { ...shown, via: "discord" } }), ask({ id: "ask_2" })];
  await asksStore.refresh();
  expect([st(), asksStore.get().notes.ask_1]).toEqual(["answered", undefined]);
});

describe("列表拉不到也不永久锁死：只有第一次请求还没回时是 loading", () => {
  const g = globalThis as Record<string, unknown>;
  const noop = () => undefined;
  let n = 0;
  const loadState = () => [asksStore.get().loaded, asksStore.get().full === true];
  /** 换一台机器 = 快照从头来并发第一次拉取；start 要用的 window / document 只在这里临时补上。setTimeout 记下「最多等多久」那一个 */
  function fresh(): { stop: () => void; slow: () => void } {
    const saved = { window: g.window, document: g.document, setTimeout: globalThis.setTimeout };
    g.window = { addEventListener: noop, removeEventListener: noop, location: { href: "http://x/chat", hash: "", search: "", pathname: "/chat" } };
    g.document = { visibilityState: "visible", addEventListener: noop, removeEventListener: noop };
    let slow: () => void = noop;
    globalThis.setTimeout = ((f: () => void, ms: number) => (ms === ASK_LIST_WAIT_MS ? ((slow = f), 0) : saved.setTimeout(f, ms))) as typeof setTimeout;
    let stop: () => void;
    try {
      stop = asksStore.start(`machine-${++n}`);
    } finally {
      globalThis.setTimeout = saved.setTimeout;
    }
    return { stop: () => (stop(), Object.assign(g, { window: saved.window, document: saved.document })), slow: () => slow() };
  }

  test("老 bridge 没有 /asks（404、405）、503、断网：第一次失败就回落 partial，之后一直失败也不回到 loading", async () => {
    for (const err of [new ApiError("unknown endpoint", 404), new ApiError("method", 405), new ApiError("ledger", 503), new TypeError("Failed to fetch")]) {
      failWith = err;
      const s = fresh();
      await tick();
      expect(loadState()).toEqual([true, false]);
      for (let i = 0; i < 3; i++) await asksStore.refresh();
      expect(loadState()).toEqual([true, false]);
      s.stop();
    }
  });

  test("第一次请求迟迟不回：之前是 loading，等满 ASK_LIST_WAIT_MS 回落 partial；晚到的完整列表照样变 full", async () => {
    manual = true;
    const s = fresh();
    await tick();
    expect(loadState()).toEqual([false, false]);
    s.slow();
    expect(loadState()).toEqual([true, false]);
    release(queue.splice(0), true);
    await tick();
    expect(loadState()).toEqual([true, true]);
    s.stop();
  });

  test("拿到过完整列表后再失败：保留上一份（仍是 full）；404 才改口成 partial", async () => {
    manual = true;
    const s = fresh();
    await tick();
    release(queue.splice(0), true);
    await tick();
    manual = false;
    failWith = new ApiError("ledger", 503);
    await asksStore.refresh();
    expect([...loadState(), asksStore.get().asks.length]).toEqual([true, true, 2]);
    failWith = new ApiError("unknown endpoint", 404);
    await asksStore.refresh();
    expect([...loadState(), asksStore.get().asks.length]).toEqual([true, false, 0]);
    s.stop();
  });

  test("上一台机器在飞的拉取换机器后才失败：不算这台的结果，这台还在等自己的第一次", async () => {
    manual = true;
    const a = fresh();
    await tick();
    const [old] = queue.splice(0);
    a.stop();
    const b = fresh();
    await tick();
    queue.splice(0);
    failWith = new TypeError("Failed to fetch");
    old.resolve(Promise.reject(failWith));
    await tick();
    expect(loadState()).toEqual([false, false]);
    b.stop();
  });
});
