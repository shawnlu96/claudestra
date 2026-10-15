/**
 * web/features/asks/asks-store.ts 的乐观作答状态机（PR0 审查 r1 的 P2-1～4、6）：到点自己撤、只撤自己那一笔、乱序拉取丢旧的、
 * 服务端结案后清掉失败红字。接口 mock 掉（@/lib/api/asks），拉取可以手动按顺序放行。
 * 以及列表拉不到时（老 bridge 404、503、断网、超时）不让聊天气泡永久「正在核对」（PR B 第 3 轮 P1）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

type A = Record<string, unknown>;
interface AsksStore {
  get(): { asks: A[]; loaded: boolean; full?: boolean; banner: A | null; notes: Record<string, { ok: boolean; text: string } | undefined> };
  refresh(): Promise<void>;
  loadHistory(): Promise<void>;
  start(key: string): () => void;
  answer(id: string, shown: unknown, submit: () => Promise<unknown>, words: { ok: string; fail: (e: unknown) => string }): Promise<boolean>;
  dismiss(id: string, submit: () => Promise<unknown>, fail: (e: unknown) => string): Promise<boolean>;
}
let serverList: A[] = [];
const queue: { resolve: (v: unknown) => void; snapshot: A[] }[] = [];
let manual = false;
let failWith: unknown = null;
/** 接下来几次拉取失败（之后恢复） */
let failNext = 0;
let mockActive = false;
/** 每次拉取带的 history 参数（SYN-2：合并重复刷新、抽屉「更多」） */
const fetchLog: boolean[] = [];
let streamOpts: { onOpen: () => void; onAsk: () => void } | null = null;
// mock.module 不随文件结束撤销：只在本文件用假实现，后续文件须转回真实 API，也保留其余真导出。
// 先复制真导出，避免 mock 改写模块绑定后，关闭开关仍转调回假实现。
const realAsks = { ...await import("@/lib/api/asks") };
mock.module("@/lib/api/asks", () => ({
  ...realAsks,
  fetchAsks: (signal?: AbortSignal, history = false) => {
    if (!mockActive) return realAsks.fetchAsks(signal, history);
    fetchLog.push(history);
    if (failWith) return Promise.reject(failWith);
    if (failNext > 0) return (failNext--, Promise.reject(new TypeError("Failed to fetch")));
    const snapshot = structuredClone(serverList);
    if (!manual) return Promise.resolve({ ok: true, asks: snapshot, now: Date.now() });
    return new Promise((resolve) => queue.push({ resolve, snapshot }));
  },
  followAskEvents: (...args: Parameters<typeof realAsks.followAskEvents>) => mockActive ? ((streamOpts = args[0]), new Promise(() => {})) : realAsks.followAskEvents(...args),
  postPresence: (visible: boolean) => mockActive ? Promise.resolve() : realAsks.postPresence(visible),
}));
beforeAll(() => { mockActive = true; });
afterAll(() => { mockActive = false; });
// 变量路径：根 tsconfig 没有 DOM 类型，store 用到 document / serviceWorker，只在运行时加载（类型取 AsksStore 的形状）
const STORE = "@/features/asks/asks-store";
const { asksStore } = (await import(STORE)) as { asksStore: AsksStore };
const { askCounts, ASK_EVENT_REFRESH_MS, ASK_LIST_WAIT_MS, PENDING_MAX_MS } = await import("@/features/asks/asks-model");
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
  failNext = 0;
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

describe("SYN-2：重复刷新合并成一次", () => {
  const g = globalThis as Record<string, unknown>;
  const noop = () => undefined;
  let n = 0;
  /** start 要的 window / document 临时补上；记下 visibilitychange 的处理函数 */
  function started(): { stop: () => void; wake: () => void } {
    const saved = { window: g.window, document: g.document };
    const handlers: Record<string, () => void> = {};
    g.window = { addEventListener: noop, removeEventListener: noop, location: { href: "http://x/chat", hash: "", search: "", pathname: "/chat" } };
    g.document = { visibilityState: "visible", addEventListener: (k: string, f: () => void) => (handlers[k] = f), removeEventListener: noop };
    const stop = asksStore.start(`syn2-${++n}`);
    return { stop: () => (stop(), Object.assign(g, { window: saved.window, document: saved.document })), wake: () => handlers.visibilitychange() };
  }
  const settle = () => new Promise((r) => setTimeout(r, ASK_EVENT_REFRESH_MS + 50));

  test("回前台和事件流重连前后脚到：1 秒内只拉一次，过了 1 秒再来才拉", async () => {
    const s = started();
    await tick();
    const t0 = realNow() + 5_000;
    Date.now = () => t0;
    fetchLog.length = 0;
    s.wake();
    streamOpts!.onOpen();
    s.wake();
    expect(fetchLog.length).toBe(1);
    Date.now = () => t0 + 1_100;
    streamOpts!.onOpen();
    expect(fetchLog.length).toBe(2);
    s.stop();
  });

  test("作答期间收到 ask 事件：作答刷新和事件刷新并成一次；事件那次先拉完的，作答后不再补拉", async () => {
    const s = started();
    await tick();
    fetchLog.length = 0;
    // bridge 先写库再推 ask 事件：事件到的时候服务端已经是 answered
    const commit = (id: string) => (serverList = serverList.map((a) => (a.id === id ? { ...a, state: "answered" } : a)), streamOpts!.onAsk());
    await asksStore.answer("ask_1", shown, async () => commit("ask_1"), words);
    await settle();
    expect(fetchLog.length).toBe(1);
    fetchLog.length = 0;
    await asksStore.answer("ask_2", shown, async () => { commit("ask_2"); await settle(); }, words);
    await settle();
    expect(fetchLog.length).toBe(1);
    s.stop();
  });

  test("作答时事件流没推（断了）：去抖后照样拉一次，结果以服务端为准", async () => {
    const s = started();
    await tick();
    fetchLog.length = 0;
    await asksStore.answer("ask_1", shown, async () => undefined, words);
    expect(fetchLog.length).toBe(0);
    await settle();
    expect(fetchLog.length).toBe(1);
    s.stop();
  });

  /** 作答时：服务端改成 change 后的样子、推 ask 事件、事件那次 GET 失败一次；返回「到点撤覆盖」的那个计时器 */
  async function answerWithFailedEventFetch(kind: "answer" | "dismiss", id: string): Promise<() => void> {
    const realSetTimeout = globalThis.setTimeout;
    let expire: () => void = () => undefined;
    globalThis.setTimeout = ((f: () => void, ms: number) => (ms === PENDING_MAX_MS + 1 ? ((expire = f), 0) : realSetTimeout(f, ms))) as typeof setTimeout;
    const submit = async () => {
      serverList = kind === "answer" ? serverList.map((a) => (a.id === id ? { ...a, state: "answered" } : a)) : serverList.filter((a) => a.id !== id);
      failNext = 1;
      streamOpts!.onAsk();
    };
    try {
      if (kind === "answer") await asksStore.answer(id, shown, submit, words);
      else await asksStore.dismiss(id, submit, () => "FAIL");
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    return expire;
  }

  test("事件那次 GET 失败不算确认：恢复后补拉一次，过了 PENDING_MAX_MS 作答的卡不回到 open（r1 P1 refresh-failure）", async () => {
    const s = started();
    await tick();
    fetchLog.length = 0;
    const expire = await answerWithFailedEventFetch("answer", "ask_1");
    await settle();
    await settle();
    expect(fetchLog.length).toBe(2);
    Date.now = () => realNow() + PENDING_MAX_MS + 1_000;
    expire();
    expect(st()).toBe("answered");
    s.stop();
  });

  test("删卡同样：事件 GET 失败一次后恢复，覆盖到点也不再冒出来", async () => {
    const s = started();
    await tick();
    const expire = await answerWithFailedEventFetch("dismiss", "ask_2");
    await settle();
    await settle();
    Date.now = () => realNow() + PENDING_MAX_MS + 1_000;
    expire();
    expect(asksStore.get().asks.some((a) => a.id === "ask_2")).toBe(false);
    s.stop();
  });

  test("后发先到的还是 open、先发的那次随后被丢弃：确认项不能搁住，还要补拉一次（r2 P1）", async () => {
    const s = started();
    await tick();
    fetchLog.length = 0;
    manual = true;
    const realSetTimeout = globalThis.setTimeout;
    let expire: () => void = () => undefined;
    globalThis.setTimeout = ((f: () => void, ms: number) => (ms === PENDING_MAX_MS + 1 ? ((expire = f), 0) : realSetTimeout(f, ms))) as typeof setTimeout;
    try {
      // 提交期间发出两次拉取（A、B），快照都还是 open
      await asksStore.answer("ask_1", shown, async () => void (asksStore.refresh(), asksStore.refresh()), words);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    serverList = serverList.map((a) => (a.id === "ask_1" ? { ...a, state: "answered" } : a));
    manual = false;
    const [a, b] = queue.splice(0);
    release([b]); // B 先回来：open，A 还在路上，先不补
    await tick();
    release([a]); // A 回来被丢弃（比 B 旧）
    await settle();
    expect(fetchLog.length).toBe(3);
    Date.now = () => realNow() + PENDING_MAX_MS + 1_000;
    expire();
    expect(st()).toBe("answered");
    s.stop();
  });

  test("一直拉不到：补拉有上限，不会无限重试", async () => {
    const s = started();
    await tick();
    fetchLog.length = 0;
    failWith = new TypeError("Failed to fetch");
    await asksStore.answer("ask_1", shown, async () => undefined, words);
    for (let i = 0; i < 6; i++) await settle();
    expect(fetchLog.length).toBe(3);
    s.stop();
  });

  test("抽屉「更多」才带 history 拉 3 天内的；平时的拉取不带", async () => {
    fetchLog.length = 0;
    await asksStore.refresh();
    await asksStore.loadHistory();
    expect(fetchLog).toEqual([false, true]);
  });
});
