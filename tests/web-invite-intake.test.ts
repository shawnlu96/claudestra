import { describe, expect, test } from "bun:test";
import { firstSeen, setHandlerState, shouldAskHandler } from "@/features/chat/invite-intake";

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe("收邀请：浏览器登记提醒", () => {
  test("不支持登记（Safari / iOS App）→ 不提醒", () => {
    expect(shouldAskHandler(false, 0, mem())).toBe(false);
  });
  test("没确认过就提醒；点了「以后再说」3 天内不再提醒，过了再提醒", () => {
    const s = mem();
    expect(shouldAskHandler(true, 1000, s)).toBe(true);
    setHandlerState("later", 1000, s);
    expect(shouldAskHandler(true, 1000 + 3600_000, s)).toBe(false);
    expect(shouldAskHandler(true, 1000 + 4 * 24 * 3600_000, s)).toBe(true);
  });
  test("真从链接进过 /join（确认生效）→ 再也不提醒", () => {
    const s = mem();
    setHandlerState("confirmed", 0, s);
    expect(shouldAskHandler(true, 9e12, s)).toBe(false);
  });
  test("存储不可用也不报错（照样提醒）", () => {
    expect(shouldAskHandler(true, 0, null)).toBe(true);
    expect(() => setHandlerState("later", 0, null)).not.toThrow();
  });
});

describe("收邀请：剪贴板里同一个邀请只提示一次", () => {
  test("第一次 true，之后 false；不同邀请各自计", () => {
    const s = mem();
    expect(firstSeen("eyJ2IjoyL" + "a".repeat(60), s)).toBe(true);
    expect(firstSeen("eyJ2IjoyL" + "a".repeat(60), s)).toBe(false);
    expect(firstSeen("eyJ2IjoyL" + "b".repeat(60), s)).toBe(true);
  });
  test("存的内容坏了当没见过", () => {
    const s = mem();
    s.setItem("cstra_invite_seen", "{broken");
    expect(firstSeen("eyJ2IjoyL" + "c".repeat(60), s)).toBe(true);
  });
});
