import { describe, expect, test } from "bun:test";
import { autoRevertButtonId, isAutoPermButton, parseAutoPermButton } from "../src/bridge/auto-allow";

describe("auto 临时放行按钮 id", () => {
  test("放行 → 切 bypass", () => {
    expect(parseAutoPermButton("auto_allow:123")).toEqual({ isAllow: true, channelId: "123", target: "bypassPermissions" });
  });

  test("切回 → 回到放行前记下的模式（不再写死 auto）", () => {
    const id = autoRevertButtonId("123", "plan");
    expect(id).toBe("auto_revert:123:plan");
    expect(parseAutoPermButton(id)).toEqual({ isAllow: false, channelId: "123", target: "plan" });
    expect(parseAutoPermButton(autoRevertButtonId("9", "acceptEdits"))?.target).toBe("acceptEdits");
  });

  test("老消息上不带模式的切回按钮仍按 auto", () => {
    expect(parseAutoPermButton("auto_revert:123")).toEqual({ isAllow: false, channelId: "123", target: "auto" });
  });

  test("编进 id 的模式不认识 → 退回 auto，不把任意串送去算 Shift+Tab 步数", () => {
    expect(parseAutoPermButton("auto_revert:123:nope")?.target).toBe("auto");
  });

  test("其它按钮不命中", () => {
    expect(isAutoPermButton("focus:1")).toBe(false);
    expect(parseAutoPermButton("focus:1")).toBeNull();
    expect(isAutoPermButton("auto_allow:1")).toBe(true);
    expect(isAutoPermButton("auto_revert:1:plan")).toBe(true);
  });

  test("id 在 Discord custom_id 100 字符上限内", () => {
    expect(autoRevertButtonId("12345678901234567890", "bypassPermissions").length).toBeLessThanOrEqual(100);
  });
});
