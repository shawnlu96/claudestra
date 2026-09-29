/**
 * web/features/asks/asks-store.ts 的乐观作答状态机（PR0 审查 r1 的 P2-1～4、6）：到点自己撤、只撤自己那一笔、乱序拉取丢旧的、
 * 服务端结案后清掉失败红字。接口 mock 掉（@/lib/api/asks），拉取可以手动按顺序放行。
 */
import { beforeEach, expect, mock, test } from "bun:test";

type A = Record<string, unknown>;
interface AsksStore {
  get(): { asks: A[]; notes: Record<string, { ok: boolean; text: string } | undefined> };
  refresh(): Promise<void>;
  answer(id: string, shown: unknown, submit: () => Promise<unknown>, words: { ok: string; fail: (e: unknown) => string }): Promise<boolean>;
}
let serverList: A[] = [];
const queue: { resolve: (v: unknown) => void; snapshot: A[] }[] = [];
let manual = false;
mock.module("@/lib/api/asks", () => ({
  fetchAsks: () => {
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
const { askCounts, PENDING_MAX_MS } = await import("@/features/asks/asks-model");
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
const release = (fetches: typeof queue) => fetches.forEach((f) => f.resolve({ ok: true, asks: f.snapshot, now: 0 }));
const realNow = Date.now;

beforeEach(async () => {
  Date.now = realNow;
  manual = false;
  queue.length = 0;
  serverList = [ask({ id: "ask_1" }), ask({ id: "ask_2" })];
  await asksStore.refresh();
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
