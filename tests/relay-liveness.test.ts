/** 心跳判死的旁证与上限（src/lib/relay-liveness.ts）：Bun 客户端看不到发送队列，只能靠这些推断 */
import { describe, expect, test } from "bun:test";
import { RelayLiveness } from "../src/lib/relay-liveness.js";

const opts = { queuedAheadBytes: 1000, maxGraces: 3 };

describe("RelayLiveness", () => {
  test("空闲连接等不到 pong → 立刻判死", () => {
    const l = new RelayLiveness(opts);
    l.onPing();
    expect(l.onPongTimeout().dead).toBe(true);
  });
  test("ping 前压着大段上行数据 → 顺延，满上限仍判死", () => {
    const l = new RelayLiveness(opts);
    l.onSend(5000);
    for (let i = 0; i < 3; i++) {
      l.onPing();
      expect(l.onPongTimeout().dead).toBe(false);
    }
    l.onPing();
    const v = l.onPongTimeout();
    expect(v.dead).toBe(true);
    expect(v.reason).toContain("queued=5000B");
  });
  test("积压不到阈值 → 不算旁证", () => {
    const l = new RelayLiveness(opts);
    l.onSend(999);
    l.onPing();
    expect(l.onPongTimeout().dead).toBe(true);
  });
  test("本轮 ping 之后有入站帧 → 顺延；下一轮没有就判死", () => {
    const l = new RelayLiveness(opts);
    l.onPing();
    l.onInbound();
    expect(l.onPongTimeout().dead).toBe(false);
    l.onPing();
    expect(l.onPongTimeout().dead).toBe(true);
  });
  test("迟到的 pong 清零积压与顺延计数", () => {
    const l = new RelayLiveness(opts);
    l.onSend(5000);
    for (let i = 0; i < 3; i++) {
      l.onPing();
      l.onPongTimeout();
    }
    l.onPong();
    l.onSend(5000);
    l.onPing();
    expect(l.onPongTimeout().dead).toBe(false);
    l.onPong();
    l.onPing();
    expect(l.onPongTimeout().dead).toBe(true);
  });
});
