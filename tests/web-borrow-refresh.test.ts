/**
 * 借入卡写后的解锁只认新快照（i28-R7d r5 refresh-unlock，PM 定 23:30）：走真实刷新路径
 * （borrowFeed.load = useBorrowView 的 load / 15 秒轮询 → fetchBorrow → API 客户端），只把 fetch 换成内存 bridge。
 * 卡片这边用它真实调用的 saveThenRefresh / dropPeer / cardLocked / visiblePeers，加卡片里那三行「锁着就不写」。
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { borrowFeed, cardLocked, dropPeer, EMPTY_FEED, saveThenRefresh, visiblePeers, type FeedState } from "@/features/borrow/borrow-feed";
import { machineNow } from "@/features/borrow/borrow-api";
import { oneAtATime } from "@/features/borrow/borrow-model";
import { setAppConfigForTest } from "@/lib/app-config";
import { machines } from "@/lib/machines";

const realFetch = globalThis.fetch;
const prevFp = machines.currentFp();
let stored: number | undefined;
let getMode: "ok" | "503" | "hang" = "ok";
const writes: string[] = [];
const hung: { release: () => void }[] = [];

beforeAll(async () => {
  setAppConfigForTest({ mode: "relay", relayBase: "relay.invalid", version: "test" });
  await machines.add({ fp: "machine-r", name: "R" });
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "PUT") stored = (JSON.parse(String(init!.body)) as { maxOpen: number }).maxOpen;
    if (method === "DELETE") stored = undefined;
    if (method !== "GET") {
      writes.push(method === "PUT" ? `PUT ${stored}` : "DELETE");
      return new Response("{}", { status: 200 });
    }
    // 快照取发出 GET 那一刻的服务端值：挂起后再放行的，拿到的是旧值
    const peers = stored === undefined ? [] : [{ peer: "lab-box", maxOpen: stored, projects: ["p"], capacity: null, reported: null, paused: null, grant: null }];
    const view = JSON.stringify({ now: 0, peers, borrow: { dropped: [] } });
    if (getMode === "hang") {
      const signal = init?.signal;
      await new Promise<void>((release, reject) => {
        hung.push({ release });
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if (getMode === "503") return new Response('{"error":"injected"}', { status: 503 });
    return new Response(view, { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  await machines.setCurrent(prevFp);
  await machines.remove("machine-r");
  setAppConfigForTest(null);
});

/** 一张卡：busy（oneAtATime）+ waitAfter，跟 BorrowPeerCard 一样「锁着就不写」；显示值永远是快照里的服务端值 */
function rig() {
  let state: FeedState = EMPTY_FEED;
  const feed = borrowFeed((s) => void (state = s));
  let busy = false;
  let waitAfter: number | null = null;
  const gate = oneAtATime((b) => void (busy = b));
  const locked = () => cardLocked(busy, waitAfter, state.seq);
  const shown = () => visiblePeers(state).find((p) => p.peer === "lab-box")?.maxOpen;
  const write = (job: () => Promise<void>) => (locked() ? Promise.resolve(false) : gate(job));
  const save = (maxOpen: number) =>
    write(async () => void (await saveThenRefresh({ peer: "lab-box", body: { projects: ["p"], maxOpen }, at: machineNow(), feed, hold: (n) => void (waitAfter = n) })));
  const plus = () => save(shown()! + 1);
  const drop = () => write(() => dropPeer("lab-box", feed, { fade: async () => undefined, fail: () => undefined }));
  return { feed, state: () => state, locked, shown, save, plus, drop };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

beforeEach(async () => {
  stored = 3;
  getMode = "ok";
  writes.length = 0;
  hung.length = 0;
  await machines.setCurrent("machine-r");
});

test("PUT 成功后 GET 503：卡保持锁住，不会用旧值 3 再发 PUT；之后成功的轮询快照到了才解锁", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const c = rig();
    await c.feed.load();
    expect(c.shown()).toBe(3);
    getMode = "503";
    await c.save(20);
    expect(stored).toBe(20);
    expect(c.shown()).toBe(3); // 刷新失败，还是旧快照
    expect(c.locked()).toBe(true);
    expect(await c.plus()).toBe(false); // 旧值 3 + 1 = 4 不会发出去
    expect(writes).toEqual(["PUT 20"]);
    getMode = "ok";
    await c.feed.load(); // 15 秒轮询
    expect(c.locked()).toBe(false);
    expect(c.shown()).toBe(20);
    await c.plus();
    expect(writes).toEqual(["PUT 20", "PUT 21"]);
  } finally {
    console.warn = warn;
  }
});

test("DELETE 成功后 GET 503：卡立刻不在，不会再有这个 peer 的 PUT；之后的快照里确实没有它才清掉记号", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const c = rig();
    await c.feed.load();
    getMode = "503";
    await c.drop();
    expect(stored).toBeUndefined();
    expect(c.shown()).toBeUndefined(); // 旧快照里还有它，但不渲染
    expect(c.state().view!.peers.length).toBe(1);
    expect(writes).toEqual(["DELETE"]);
    getMode = "ok";
    await c.feed.load();
    expect(c.state().gone.size).toBe(0);
    expect(c.shown()).toBeUndefined();
    expect(writes).toEqual(["DELETE"]);
  } finally {
    console.warn = warn;
  }
});

test("删后又加回来：删除之后发起的快照里有它，就照常显示（记号不会把它永远藏起来）", async () => {
  const c = rig();
  await c.feed.load();
  await c.drop();
  expect(c.shown()).toBeUndefined();
  stored = 5; // 新增表单又加回来了
  await c.feed.load();
  expect(c.state().gone.size).toBe(0);
  expect(c.shown()).toBe(5);
});

test("PUT 成功后的 GET 挂起、被 15 秒轮询中止，轮询的 GET 也挂着：卡一直锁着；轮询拿回来才解锁并显示 20", async () => {
  const c = rig();
  await c.feed.load();
  getMode = "hang";
  const saving = c.save(20);
  await tick();
  expect(hung.length).toBe(1);
  const poll = c.feed.load(); // 轮询：中止写后的 GET，自己也挂着
  await saving;
  await tick();
  expect(c.shown()).toBe(3);
  expect(c.locked()).toBe(true); // 写的 job 已结束（busy 释放），但没有写之后的快照
  expect(await c.plus()).toBe(false);
  expect(writes).toEqual(["PUT 20"]);
  hung.at(-1)!.release();
  await poll;
  expect(c.locked()).toBe(false);
  expect(c.shown()).toBe(20);
});

test("写请求本身失败：立即解锁，显示仍是服务端原值", async () => {
  const c = rig();
  await c.feed.load();
  const put = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) =>
    init?.method === "PUT" ? new Response('{"error":"refused"}', { status: 409 }) : put(url, init)) as typeof fetch;
  try {
    await c.save(20);
  } finally {
    globalThis.fetch = put;
  }
  expect(c.locked()).toBe(false);
  expect(c.shown()).toBe(3);
});
