/**
 * web/features/chat/guard-store.ts 的机器隔离：卡片 / 已拉标记 / 气泡标记都按 agent 名记，切机器后同名 agent 不能看到上一台的待放行卡，
 * 也不能因为「已拉过」不去拉新机器的；切机器前发出、切完才回来的清单丢掉。接口 mock 掉（@/lib/api/guard），按当前机器回不同清单。
 */
import { beforeAll, describe, expect, mock, test } from "bun:test";

type Item = { id: string; agent: string };
interface GuardStore {
  loadGuard(agent: string): Promise<void>;
  guardPendingOf(agent: string | undefined): Item[];
  guardMarkOf(id: string): "held" | "dropped" | null;
  noteGuardedSend(messageId: string | undefined, bubbleId: string): void;
}
const { machines } = await import("@/lib/machines");
const byMachine: Record<string, Item[]> = { A: [{ id: "a1", agent: "dev" }], B: [{ id: "b1", agent: "dev" }] };
let hold: ((v: Item[]) => void) | null = null;
// mock.module 对整个进程生效：同进程后面的文件要拿到其余真导出
const realGuard = await import("@/lib/api/guard");
mock.module("@/lib/api/guard", () => ({
  ...realGuard,
  listGuard: () => {
    const items = byMachine[machines.currentFp() ?? ""] ?? [];
    if (!hold) return Promise.resolve(items);
    return new Promise<Item[]>((resolve) => (hold = () => resolve(items)));
  },
}));
// 变量路径：根 tsconfig 不检查 web 的 React 文件，只在运行时加载（类型取 GuardStore 的形状）
const STORE = "@/features/chat/guard-store";
const store = (await import(STORE)) as GuardStore;
const ids = (agent: string) => store.guardPendingOf(agent).map((i) => i.id);

beforeAll(async () => {
  await machines.add({ fp: "A", name: "机器 A" });
  await machines.add({ fp: "B", name: "机器 B" });
});

describe("切机器", () => {
  test("同名 agent 不显示上一台的卡片，重拉拿到新机器自己的", async () => {
    await machines.setCurrent("A");
    await store.loadGuard("dev");
    expect(ids("dev")).toEqual(["a1"]);
    await machines.setCurrent("B");
    expect(ids("dev")).toEqual([]);
    await store.loadGuard("dev");
    expect(ids("dev")).toEqual(["b1"]);
  });

  test("切机器前发出的拉取切完才回来：旧机器的清单不落进新机器", async () => {
    await machines.setCurrent("A");
    hold = () => {};
    const pending = store.loadGuard("dev");
    await machines.setCurrent("B");
    hold!([]);
    hold = null;
    await pending;
    expect(ids("dev")).toEqual([]);
  });

  test("本端气泡的守门标记一并清掉", async () => {
    await machines.setCurrent("A");
    store.noteGuardedSend("api_1", "bubble-1");
    expect(store.guardMarkOf("bubble-1")).toBe("held");
    await machines.setCurrent("B");
    expect(store.guardMarkOf("bubble-1")).toBeNull();
  });
});
