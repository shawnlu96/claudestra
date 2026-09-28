/**
 * lib/keyed-serial.ts：bridge 的 deliverToLocal 按频道串行（N7 定向复验 P2）。deliverToLocal 里有渲染、抢占（等 1.2s 收尾）、
 * 判忙抓屏几处 await；不串行时 A 抢占收尾期间到的 B 会和 A 同时 probe，谁先回来谁先 ws.send——审查员模拟 300 次里 B 先到 140～160 次。
 */
import { describe, expect, test } from "bun:test";
import { createKeyedSerial } from "../src/lib/keyed-serial.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createKeyedSerial", () => {
  test("两条人类消息连发：A 抢占后等收尾、B 冷却中直接判忙，两边判忙的 await 长短随机——到达顺序始终等于发送顺序", async () => {
    let flipped = 0;
    for (let i = 0; i < 300; i++) {
      const serial = createKeyedSerial();
      const sent: string[] = [];
      // 模拟 deliverToLocalInOrder：A 走抢占（多一段等待），B 抢占因冷却立即返回；之后各自 probe（随机 0～3ms）再 ws.send
      const deliver = (name: string, preemptMs: number) =>
        serial("ch", async () => {
          await sleep(preemptMs);
          await sleep(Math.random() * 3);
          sent.push(name);
        });
      await Promise.all([deliver("A", 2), deliver("B", 0)]);
      if (sent[0] !== "A") flipped++;
    }
    expect(flipped).toBe(0);
  });

  test("不串行时确实会乱（对照：同样的时序，不经 serial）", async () => {
    let flipped = 0;
    for (let i = 0; i < 100; i++) {
      const sent: string[] = [];
      const deliver = async (name: string, preemptMs: number) => {
        await sleep(preemptMs);
        await sleep(Math.random() * 3);
        sent.push(name);
      };
      await Promise.all([deliver("A", 2), deliver("B", 0)]);
      if (sent[0] !== "A") flipped++;
    }
    expect(flipped).toBeGreaterThan(0);
  });

  test("不同 key 互不等待；前一个出错不卡同 key 后面的", async () => {
    const serial = createKeyedSerial();
    const order: string[] = [];
    const slow = serial("a", async () => (await sleep(20), order.push("a1")));
    const other = serial("b", async () => void order.push("b1"));
    const boom = serial("a", async () => { throw new Error("tmux gone"); });
    const after = serial("a", async () => void order.push("a3"));
    await Promise.allSettled([slow, other, boom, after]);
    expect(order).toEqual(["b1", "a1", "a3"]);
    await expect(boom).rejects.toThrow("tmux gone");
  });
});
