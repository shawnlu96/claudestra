import { describe, expect, test } from "bun:test";
import { FADE_MS, GUARD_MS, activeAnswered, markAnswered, subscribeAnswered } from "../web/features/asks/answer-cooldown";

// 09-29：owner 只记得点了一下，两张按钮字相同的卡（#209、T50）隔 1.95 秒先后被答掉；客户端日志这段没有 [tap-synth]，
// 是第一张乐观移走、下一张顶到原位，看着像没点上，又点了一下。改成答完先原位淡出，再短暂不收点击
describe("答完一张：先淡出，再短暂防连点，然后收掉", () => {
  test("fading → guard → null，每次切换都通知订阅方", async () => {
    let n = 0;
    const off = subscribeAnswered(() => n++);
    markAnswered("ask_a");
    expect(activeAnswered()).toEqual({ id: "ask_a", phase: "fading" });
    await Bun.sleep(FADE_MS + 30);
    expect(activeAnswered()).toEqual({ id: "ask_a", phase: "guard" });
    await Bun.sleep(GUARD_MS + 30);
    expect(activeAnswered()).toBeNull();
    expect(n).toBe(3);
    off();
  });

  test("淡出期间又答了一张：以后一张为准，前一张的计时作废", async () => {
    markAnswered("ask_a");
    await Bun.sleep(FADE_MS - 100);
    markAnswered("ask_b");
    await Bun.sleep(150);
    expect(activeAnswered()).toEqual({ id: "ask_b", phase: "fading" });
    await Bun.sleep(FADE_MS + GUARD_MS);
    expect(activeAnswered()).toBeNull();
  });
});
