import { expect, test } from "bun:test";
import { listWindowIdsByName } from "../src/lib/tmux-helper.ts";
import { readWindowChildren } from "../src/lib/window-child-pids.ts";
test("严格空窗判据拒绝未知或多 pane PID；不能当成零孩子", async () => {
  for (const raw of ["", "bad", "12oops", "1\n2"]) {
    await expect(readWindowChildren("@1", true, async () => raw, () => [])).rejects.toThrow("pane PID 未确认");
  }
});
test("ps 找不到所查 pane 的进程时不证明空窗", async () => {
  await expect(readWindowChildren("@1", true, async () => "2147483000", () => [])).rejects.toThrow("进程列表未确认");
});

test("窗口枚举失败/空响应不能当作无窗；成功枚举没匹配才是真的无窗", async () => {
  await expect(listWindowIdsByName("agent-old", true, async () => { throw new Error("tmux failed"); })).rejects.toThrow("tmux failed");
  await expect(listWindowIdsByName("agent-old", true, async () => "")).rejects.toThrow("窗口列表未确认");
  expect(await listWindowIdsByName("agent-old", true, async () => "master\t@0")).toEqual([]);
});
