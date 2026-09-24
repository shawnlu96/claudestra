import { describe, expect, test } from "bun:test";
import { isSelfSource } from "@/lib/chat/me";

// owner 2026-09-24：本人的所有来源靠右（自己的 web、自己的 Discord），其余一律靠左
describe("isSelfSource（本人的所有来源都算本人）", () => {
  const self = new Set(["api:tok_me", "111111111111111111"]);
  test("本端乐观消息（没有 from）= 本人", () => {
    expect(isSelfSource(undefined, undefined, self)).toBe(true);
  });
  test("自己的 web token、自己的 Discord 账号 = 本人", () => {
    expect(isSelfSource("web-ui", "api:tok_me", self)).toBe(true);
    expect(isSelfSource("shawn", "111111111111111111", self)).toBe(true);
  });
  test("别人的 token / 别人的 Discord / peer / agent = 别人", () => {
    expect(isSelfSource("phone-app", "api:tok_other", self)).toBe(false);
    expect(isSelfSource("friend", "222222222222222222", self)).toBe(false);
    expect(isSelfSource("peer-Sekai", "api:tok_peer", self)).toBe(false);
    expect(isSelfSource("agent-x", "agent", self)).toBe(false);
  });
  test("老数据没有 fromId，或 whoami 取不到：退回按 token 名 web-ui 认", () => {
    expect(isSelfSource("web-ui", undefined, self)).toBe(true);
    expect(isSelfSource("shawn", undefined, self)).toBe(false);
    expect(isSelfSource("web-ui", "api:tok_me", new Set())).toBe(true);
    expect(isSelfSource("friend", "222222222222222222", new Set())).toBe(false);
  });
});
