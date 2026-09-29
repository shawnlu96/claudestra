import { describe, expect, test } from "bun:test";
import { FADE_MS, GUARD_MS, activeAnswered, clearAnswered, cooldownView, markAnswered, subscribeAnswered } from "../web/features/asks/answer-cooldown";

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

// 同家审查 P2-1 / P2-4：作答几毫秒就失败时，卡先淡到透明、失败原因跟着淡没，450ms 后才弹回来
describe("抽屉怎么用这一笔（cooldownView）", () => {
  const asks = [{ id: "ask_a", state: "answered" }, { id: "ask_b", state: "open" }];
  test("没有过渡：不淡出、不挡", () => {
    expect(cooldownView(null, asks)).toEqual({ fadingId: null, guard: false });
  });
  test("淡出中：这张留在原位淡出，别的开着的卡暂不收点击", () => {
    expect(cooldownView({ id: "ask_a", phase: "fading" }, asks)).toEqual({ fadingId: "ask_a", guard: true });
    expect(cooldownView({ id: "ask_a", phase: "guard" }, asks)).toEqual({ fadingId: null, guard: true });
  });
  test("store 里这张又是 open（作答失败回滚）：不淡出、不挡，失败原因照常看得见", () => {
    const failed = [{ id: "ask_a", state: "open" }, { id: "ask_b", state: "open" }];
    expect(cooldownView({ id: "ask_a", phase: "fading" }, failed)).toEqual({ fadingId: null, guard: false });
  });
  test("clearAnswered：只清同一张，别的张的过渡不受影响", () => {
    markAnswered("ask_a");
    clearAnswered("ask_x");
    expect(activeAnswered()).toEqual({ id: "ask_a", phase: "fading" });
    clearAnswered("ask_a");
    expect(activeAnswered()).toBeNull();
  });
});
