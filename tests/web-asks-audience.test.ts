import { expect, test } from "bun:test";
import { askByIdCache } from "@/features/asks/ask-by-id";
import type { WebAsk } from "@/features/asks/asks-model";
import { machines, type MachineRecord } from "@/lib/machines";

test("按 id 单取也不能绕过收件范围；owner 引用标题不变", async () => {
  const get = askByIdCache(async (id) => ({ ask: {
    id, title: "是否继续", assignee: id === "pm" ? "agent-claudestra" : "local:owner:self", canAnswer: true,
  } as WebAsk }));
  expect(await get("pm")).toBeNull();
  expect(await get("pm")).toBeNull();
  expect((await get("owner"))?.title).toBe("是否继续");
});

test("同一 id 的缓存按机器 / 本人隔离：owner 看不到的 guest ask 不会遮住收件人自己的", async () => {
  const current = machines.current;
  let machine: MachineRecord | null = null;
  machines.current = () => machine;
  let calls = 0;
  const get = askByIdCache(async () => (calls++, { ask: { id: "a", assignee: "local:guest:abc" } as WebAsk }));
  try {
    expect(await get("a")).toBeNull();
    machine = { fp: "m", name: "m", addedAt: 0, lastUsedAt: 0, principalId: "guest:abc" };
    expect((await get("a"))?.id).toBe("a");
    expect(calls).toBe(2);
    machine = null;
    expect(await get("a")).toBeNull();
    expect(calls).toBe(2);
  } finally {
    machines.current = current;
  }
});
