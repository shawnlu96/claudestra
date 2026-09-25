import { describe, expect, test } from "bun:test";
import { buildChatCss, clampPref, normalizeChatPrefs } from "../web/lib/chat-prefs-parse";

describe("clampPref", () => {
  test("clamps to the range and snaps to the step", () => {
    expect(clampPref("fontSize", 99)).toBe(18);
    expect(clampPref("fontSize", 3)).toBe(12);
    expect(clampPref("fontSize", "15.3")).toBe(15.5);
    expect(clampPref("lineHeight", 1.72)).toBe(1.7);
  });
  test("non-numbers mean default", () => {
    expect(clampPref("narrSize", "abc")).toBeNull();
    expect(clampPref("narrSize", undefined)).toBeNull();
    expect(clampPref("narrSize", null)).toBeNull();
  });
});

describe("normalizeChatPrefs", () => {
  test("fills missing keys with null and clamps stored values", () => {
    expect(normalizeChatPrefs({ fontSize: 40 })).toEqual({ fontSize: 18, lineHeight: null, narrSize: null });
    expect(normalizeChatPrefs(null)).toEqual({ fontSize: null, lineHeight: null, narrSize: null });
  });
});

describe("buildChatCss", () => {
  test("emits only the set variables with units and tidy decimals", () => {
    expect(buildChatCss({ fontSize: 16, lineHeight: 1.7000000000000002, narrSize: null })).toBe(":root{--chat-font-size:16px;--chat-line-height:1.7}");
    expect(buildChatCss({ fontSize: null, lineHeight: null, narrSize: 12.5 })).toBe(":root{--chat-narr-size:12.5px}");
  });
  test("nothing set produces nothing", () => {
    expect(buildChatCss({ fontSize: null, lineHeight: null, narrSize: null })).toBe("");
  });
});
