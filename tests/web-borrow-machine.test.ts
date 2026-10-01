/**
 * 借入 peer 卡的写（i28-R7d，PM 定 22:55 的保守做法）：每次点击立刻存一次、在途时整张卡不接新的写、返回后用服务端的值刷新；
 * 请求在点击那一刻绑定机器。用真的 API 客户端 / 机器表（中继模式），只把 fetch 换成记录器 + 内存 lend.json。
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { machineNow, removeBorrowPeer, saveBorrowPeer, stillOn } from "@/features/borrow/borrow-api";
import { oneAtATime } from "@/features/borrow/borrow-model";
import { setAppConfigForTest } from "@/lib/app-config";
import { machines } from "@/lib/machines";

const realFetch = globalThis.fetch;
const prevFp = machines.currentFp();
const sent: string[] = [];
const store = new Map<string, number>();
let hold = false;
const held: (() => void)[] = [];
const releaseAll = async () => {
  while (held.length) held.shift()!();
  await new Promise((r) => setTimeout(r, 5));
};

beforeAll(async () => {
  setAppConfigForTest({ mode: "relay", relayBase: "relay.invalid", version: "test" });
  await machines.add({ fp: "machine-a", name: "A" });
  await machines.add({ fp: "machine-b", name: "B" });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    sent.push(`${method} ${u}`);
    if (hold) await new Promise<void>((r) => held.push(r));
    const key = u.replace("/api/v1/borrow/peers/", " ");
    if (method === "PUT") store.set(key, (JSON.parse(String(init!.body)) as { maxOpen: number }).maxOpen);
    if (method === "DELETE") store.delete(key);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  await machines.setCurrent(prevFp);
  await machines.remove("machine-a");
  await machines.remove("machine-b");
  setAppConfigForTest(null);
});
beforeEach(async () => {
  sent.length = 0;
  store.clear();
  hold = false;
  await machines.setCurrent("machine-a");
});

const body = (maxOpen: number) => ({ projects: ["project-a"], maxOpen });

test("切机器时在途请求的目标不变：A 上点的照旧打到 A，回来时已不在 A", async () => {
  hold = true;
  const at = machineNow();
  const inflight = saveBorrowPeer("shared-peer", body(13), at).catch(() => undefined); // 切机器会中止上一台的在途请求，这里只看目标
  await machines.setCurrent("machine-b");
  hold = false;
  await saveBorrowPeer("shared-peer", body(5), machineNow());
  await releaseAll();
  await inflight;
  expect(sent).toEqual(["PUT /m/machine-a/api/v1/borrow/peers/shared-peer", "PUT /m/machine-b/api/v1/borrow/peers/shared-peer"]);
  expect(stillOn(at)).toBe(false); // 卡片据此不刷新、不放动效
  expect(stillOn(machineNow())).toBe(true);
});

test("保存期间点击无效、不会多发", async () => {
  const busy: boolean[] = [];
  const write = oneAtATime((b) => busy.push(b));
  hold = true;
  const first = write(() => saveBorrowPeer("lab-box", body(13), machineNow()));
  await new Promise((r) => setTimeout(r, 5));
  expect(await write(() => saveBorrowPeer("lab-box", body(14), machineNow()))).toBe(false);
  expect(await write(() => removeBorrowPeer("lab-box", machineNow()))).toBe(false);
  await releaseAll();
  expect(await first).toBe(true);
  expect(sent).toEqual(["PUT /m/machine-a/api/v1/borrow/peers/lab-box"]);
  expect(busy).toEqual([true, false]);
});

test("删除后不再有该 peer 的 PUT：删的期间点 + 被挡掉，删完也没有待发的", async () => {
  const write = oneAtATime(() => undefined);
  store.set("/m/machine-a lab-box", 12);
  hold = true;
  const del = write(() => removeBorrowPeer("lab-box", machineNow()));
  await new Promise((r) => setTimeout(r, 5));
  expect(await write(() => saveBorrowPeer("lab-box", body(13), machineNow()))).toBe(false);
  await releaseAll();
  await del;
  await new Promise((r) => setTimeout(r, 700)); // 比原来的停手计时还久：没有任何延迟发出的写
  expect(sent).toEqual(["DELETE /m/machine-a/api/v1/borrow/peers/lab-box"]);
  expect(store.has("/m/machine-a lab-box")).toBe(false);
});

test("连点 5 次 +、每次都等返回：最终值 +5，每次一个 PUT", async () => {
  store.set("/m/machine-a lab-box", 12);
  let shown = 12; // 卡片显示的就是服务端的值，没有本地草稿
  const write = oneAtATime(() => undefined);
  for (let k = 0; k < 5; k++) {
    const ok = await write(async () => {
      await saveBorrowPeer("lab-box", body(shown + 1), machineNow());
      shown = store.get("/m/machine-a lab-box")!; // onChanged：重新读服务端
    });
    expect(ok).toBe(true);
  }
  expect(shown).toBe(17);
  expect(sent.length).toBe(5);
});
