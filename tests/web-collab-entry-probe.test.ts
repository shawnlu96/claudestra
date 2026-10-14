/**
 * UXENTRY1：侧栏「协作视图」入口的探测状态（web/features/collab/dag/shared-entry-probe.ts）。
 * 网络失败 → failed + 一条重探；连点 retryNow 不叠在途请求和定时器；403 / 404 → no 且不算失败；成功清掉 failed。
 * fetchLedger 与 collab-cache 用 mock.module 换成可控的假实现（只在本文件开着，结束后转回真实现）。
 */
import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { ApiError } from "@/lib/api/client";

type Pending = { project: string; resolve: (v: unknown) => void; reject: (e: unknown) => void };
const inflight: Pending[] = [];
const access = new Map<string, string>();
let mockActive = false;

const realLedger = { ...await import("@/lib/api/ledger") };
mock.module("@/lib/api/ledger", () => ({
  ...realLedger,
  fetchLedger: (project: string, signal?: AbortSignal) => mockActive
    ? new Promise((resolve, reject) => inflight.push({ project, resolve, reject }))
    : realLedger.fetchLedger(project, signal),
}));
const realCache = { ...await import("@/features/collab/collab-cache") };
mock.module("@/features/collab/collab-cache", () => ({
  ...realCache,
  setLedgerAccess: (project: string, a: "unknown" | "yes" | "no") => mockActive ? void access.set(project, a) : realCache.setLedgerAccess(project, a),
  cacheOverview: (...args: Parameters<typeof realCache.cacheOverview>) => mockActive ? void access.set(args[0], "yes") : realCache.cacheOverview(...args),
}));

// 计挂着的定时器：probe 只用 setTimeout / clearTimeout 挂重探
const timers = new Map<unknown, () => void>();
const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
beforeAll(() => {
  mockActive = true;
  globalThis.setTimeout = ((fn: () => void) => { const id = Symbol("t"); timers.set(id, fn); return id; }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: unknown) => void timers.delete(id)) as typeof clearTimeout;
});
afterAll(() => { mockActive = false; globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; });

const { probe, retryNow, cancelRetry, mounted, probeFailed } = await import("@/features/collab/dag/shared-entry-probe");

let n = 0;
let project = "";
afterEach(() => { cancelRetry(project); mounted.delete(project); inflight.length = 0; timers.clear(); });
const fresh = () => { project = `uxentry-${++n}`; mounted.set(project, 1); return project; };
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
    expect(inflight.length).toBe(1);
    expect(timers.size).toBe(0);
    await settle("net");
    expect(probeFailed(p)).toBe(true);
    expect(timers.size).toBe(1);
    retryNow(p); retryNow(p); retryNow(p);
    expect(inflight.length).toBe(1);
    expect(timers.size).toBeLessThanOrEqual(1);
    await settle("ok");
    expect(probeFailed(p)).toBe(false);
    expect(timers.size).toBe(0);
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
