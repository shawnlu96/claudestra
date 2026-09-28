import { describe, expect, test } from "bun:test";
import { createOpenSettle } from "../web/features/terminal/open-settle";

// 终端连上后等输出停下来才揭开（尺寸一变 CC 会整段重画，边画边揭开就是一段「往下滚」）
describe("createOpenSettle", () => {
  test("start 之后静默 quietMs 才触发；期间的输出顺延，字节累计", async () => {
    const fired: number[] = [];
    const s = createOpenSettle((bytes) => fired.push(bytes), 40, 1000);
    s.data(5); // start 前的输出只计数
    s.start();
    await Bun.sleep(25);
    s.data(10);
    await Bun.sleep(25);
    expect(fired).toEqual([]); // 被顺延了
    await Bun.sleep(40);
    expect(fired).toEqual([15]);
  });
  test("一直有输出也不会永远不揭开：maxMs 兜底，只触发一次", async () => {
    const fired: number[] = [];
    const s = createOpenSettle((bytes) => fired.push(bytes), 30, 80);
    s.start();
    for (let i = 0; i < 8; i++) {
      await Bun.sleep(15);
      s.data(1);
    }
    await Bun.sleep(60);
    expect(fired.length).toBe(1);
  });
  test("cancel 之后不再触发", async () => {
    let n = 0;
    const s = createOpenSettle(() => n++, 10, 50);
    s.start();
    s.cancel();
    await Bun.sleep(70);
    expect(n).toBe(0);
  });
});
