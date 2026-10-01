/**
 * 借入写入跟着来源机器（i28-R7d r3 machine-scope）：中继页面上，A 机器的微调停手前切到 B，到点后仍写给 A；
 * A 上删掉的同名 peer 不影响 B 的保存。用真的 borrowSaver / API 客户端 / 机器表，只把 fetch 换成记录器。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { borrowSaver } from "@/features/borrow/borrow-api";
import { setAppConfigForTest } from "@/lib/app-config";
import { machines } from "@/lib/machines";

const realFetch = globalThis.fetch;
const sent: { url: string; method: string; body: unknown }[] = [];
const prev = machines.currentFp();

beforeAll(async () => {
  setAppConfigForTest({ mode: "relay", relayBase: "relay.invalid", version: "test" });
  await machines.add({ fp: "machine-a", name: "A" });
  await machines.add({ fp: "machine-b", name: "B" });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  await machines.setCurrent(prev);
  await machines.remove("machine-a");
  await machines.remove("machine-b");
  setAppConfigForTest(null);
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("A 上点 +，停手前切到 B：到点后写给 A，不写 B", async () => {
  await machines.setCurrent("machine-a");
  borrowSaver.save("shared-peer", { projects: ["project-a"], maxOpen: 13 }, undefined, 50);
  await machines.setCurrent("machine-b");
  await wait(120);
  expect(sent.map((r) => `${r.method} ${r.url}`)).toEqual(["PUT /m/machine-a/api/v1/borrow/peers/shared-peer"]);
  expect(sent[0]!.body).toEqual({ projects: ["project-a"], maxOpen: 13 });
});

test("A 上删掉 other-peer 后切 B：B 的同名 peer 照常保存、照常收尾", async () => {
  sent.length = 0;
  await machines.setCurrent("machine-a");
  await borrowSaver.remove("other-peer");
  await machines.setCurrent("machine-b");
  let settled = false;
  borrowSaver.save("other-peer", { projects: ["project-b"], maxOpen: 20 }, () => void (settled = true));
  await wait(20);
  expect(sent.map((r) => `${r.method} ${r.url}`)).toEqual([
    "DELETE /m/machine-a/api/v1/borrow/peers/other-peer",
    "PUT /m/machine-b/api/v1/borrow/peers/other-peer",
  ]);
  expect(settled).toBe(true);
  // A 上它仍是删掉的：切回 A 再存被丢掉
  await machines.setCurrent("machine-a");
  borrowSaver.save("other-peer", { projects: ["project-a"], maxOpen: 5 });
  await wait(20);
  expect(sent.length).toBe(2);
});
