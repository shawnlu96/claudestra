/**
 * UXENTRY1：侧栏「协作视图」入口的探测状态（web/features/collab/dag/shared-entry-probe.ts）。
 * 网络失败 → failed + 一条重探；连点 retryNow 不叠在途请求和定时器；403 / 404 → no 且不算失败；成功清掉 failed。
 * fetchLedger 与 collab-cache 用 mock.module 换成可控的假实现（只在本文件开着，结束后转回真实现）。
 * 不挂 DOM；叫 web-dom-* 只因为探测模块和 collab-cache 带 react（guard tests-web-pure）。
 */
import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { ApiError } from "@/lib/api/client";

type Pending = { project: string; resolve: (v: unknown) => void; reject: (e: unknown) => void };
const inflight: Pending[] = [];
/** 同时挂着的探测请求的峰值：每个请求都挂在 inflight 里，直到用例显式 settle 才放 */
let peak = 0;
const access = new Map<string, string>();
let mockActive = false;

const realLedger = { ...await import("@/lib/api/ledger") };
mock.module("@/lib/api/ledger", () => ({
  ...realLedger,
  fetchLedger: (project: string, signal?: AbortSignal) => mockActive
    ? new Promise((resolve, reject) => { inflight.push({ project, resolve, reject }); peak = Math.max(peak, inflight.length); })
    : realLedger.fetchLedger(project, signal),
}));
const realCache = { ...await import("@/features/collab/collab-cache") };
mock.module("@/features/collab/collab-cache", () => ({
  ...realCache,
  setLedgerAccess: (project: string, a: "unknown" | "yes" | "no") => mockActive ? void access.set(project, a) : realCache.setLedgerAccess(project, a),
  cacheOverview: (...args: Parameters<typeof realCache.cacheOverview>) => mockActive ? void access.set(args[0], "yes") : realCache.cacheOverview(...args),
}));

// 计 probe 挂着的重探：只认从 shared-entry-probe.ts 调来的 setTimeout。同分片前面文件遗留的异步活也调全局 setTimeout，
// 一并计进来会把重探数算成 3（PR1665 run 38929662684 shard 4），吞掉它们还会让那些活永远不收尾：照常交给真定时器
const timers = new Map<unknown, () => void>();
const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
const fromProbe = () => /shared-entry-probe\.tsx?:/.test(new Error().stack ?? "");
beforeAll(() => {
  mockActive = true;
  globalThis.setTimeout = ((fn: () => void, ...rest: unknown[]) => {
    if (!fromProbe()) return (realSet as (...a: unknown[]) => unknown)(fn, ...rest);
    const id = Symbol("t"); timers.set(id, fn); return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: unknown) => typeof id === "symbol" ? void timers.delete(id) : realClear(id as Parameters<typeof clearTimeout>[0])) as typeof clearTimeout;
});
afterAll(() => { mockActive = false; globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; });

const { probe, retryNow, cancelRetry, mounted, probeFailed } = await import("@/features/collab/dag/shared-entry-probe");

let n = 0;
let project = "";
afterEach(() => { cancelRetry(project); mounted.delete(project); inflight.length = 0; timers.clear(); });
const fresh = () => { project = `uxentry-${++n}`; mounted.set(project, 1); peak = 0; return project; };
const flush = () => new Promise((r) => setImmediate(r));
const settle = async (how: "ok" | "net" | 403 | 404) => {
  const p = inflight.shift()!;
  if (how === "ok") p.resolve({ ok: true, now: Date.now() });
  else p.reject(how === "net" ? new TypeError("Failed to fetch") : new ApiError("x", how));
  await flush();
};
const fire = async () => { const [[id, fn]] = [...timers]; timers.delete(id); fn(); await flush(); };

test("网络失败：failed 为真，挂着一条重探；重探成功后 failed 清掉、access=yes", async () => {
  const p = fresh();
  const warn = console.warn; console.warn = () => {};
  try {
    probe(p);
    expect(inflight.length).toBe(1);
    await settle("net");
    expect(probeFailed(p)).toBe(true);
    expect(timers.size).toBe(1);
    expect(access.get(p)).toBeUndefined();
    await fire();
    expect(inflight.length).toBe(1);
    await settle("ok");
    expect(probeFailed(p)).toBe(false);
    expect(access.get(p)).toBe("yes");
    expect(timers.size).toBe(0);
  } finally { console.warn = warn; }
});

test("失败后连点 retryNow 三次：在途请求最多一个、挂着的定时器最多一条；再失败照旧只挂一条", async () => {
  const p = fresh();
  const warn = console.warn; console.warn = () => {};
  try {
    probe(p);
    await settle("net");
    expect(timers.size).toBe(1);
    retryNow(p); retryNow(p); retryNow(p);
    expect([inflight.length, peak]).toEqual([1, 1]);
    expect(timers.size).toBe(0);
    await settle("net");
    expect(probeFailed(p)).toBe(true);
    expect(timers.size).toBe(1);
    retryNow(p); retryNow(p); retryNow(p);
    expect([inflight.length, peak]).toEqual([1, 1]);
    expect(timers.size).toBeLessThanOrEqual(1);
    await settle("ok");
    expect(probeFailed(p)).toBe(false);
    expect(timers.size).toBe(0);
  } finally { console.warn = warn; }
});

test("同进程别处的定时器（前面文件遗留的异步活）不算进重探数，照常由真定时器触发；在途峰值仍是一个", async () => {
  const p = fresh();
  const warn = console.warn; console.warn = () => {};
  try {
    const foreign = new Promise<void>((resolve) => { globalThis.setTimeout(resolve, 1); globalThis.setTimeout(() => {}, 1); });
    probe(p);
    await settle("net");
    retryNow(p); retryNow(p); retryNow(p);
    await settle("net");
    expect([timers.size, peak]).toEqual([1, 1]);
    await foreign;
    expect(timers.size).toBe(1);
  } finally { console.warn = warn; }
});

for (const status of [403, 404] as const) {
  test(`${status}：access=no，failed 为假，不挂重探（失败过一次之后也一样）`, async () => {
    const p = fresh();
    probe(p);
    await settle(status);
    expect(access.get(p)).toBe("no");
    expect(probeFailed(p)).toBe(false);
    expect(timers.size).toBe(0);

    const q = fresh();
    const warn = console.warn; console.warn = () => {};
    try {
      probe(q);
      await settle("net");
      expect(probeFailed(q)).toBe(true);
      retryNow(q);
      await settle(status);
      expect(access.get(q)).toBe("no");
      expect(probeFailed(q)).toBe(false);
      expect(timers.size).toBe(0);
    } finally { console.warn = warn; }
  });
}

test("入口全卸载：撤掉重探、清掉 failed；卸载后在途失败不再挂重探", async () => {
  const p = fresh();
  const warn = console.warn; console.warn = () => {};
  try {
    probe(p);
    await settle("net");
    mounted.set(p, 0);
    cancelRetry(p);
    expect(probeFailed(p)).toBe(false);
    expect(timers.size).toBe(0);
    probe(p);
    await settle("net");
    expect(timers.size).toBe(0);
    expect(probeFailed(p)).toBe(false);
  } finally { console.warn = warn; }
});
