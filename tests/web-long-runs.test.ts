/**
 * T37b 纯文本降级（web/lib/chat/long-runs.ts）：超长无空白串每 RUN_CHUNK 字切一段（段间插 <wbr>），拼回去一字不差。
 */
import { describe, expect, test } from "bun:test";
import { RUN_CHUNK, longRunSegments } from "@/lib/chat/long-runs";

describe("longRunSegments", () => {
  test("正常文字不切", () => {
    const s = "普通一段话 with words ".repeat(200) + "x".repeat(RUN_CHUNK);
    expect(longRunSegments(s)).toEqual([s]);
  });
  test("超长串每 RUN_CHUNK 字切一刀，拼回去不变", () => {
    const run = '"'.repeat(RUN_CHUNK * 5 + 7);
    const s = "前文 " + run + " 后文\n" + 'a"中*'.repeat(100);
    const parts = longRunSegments(s);
    expect(parts.join("")).toBe(s);
    expect(parts.length).toBe(1 + 5 + 1);
    expect(parts.every((p) => !/\S{201}/.test(p))).toBe(true);
  });
  test("全角空格 / nbsp 不算断点（Chromium 排这种一长串同样慢）", () => {
    for (const s of ["\u3000x".repeat(1000), "\u00a0x".repeat(1000)]) {
      const parts = longRunSegments(s);
      expect(parts.join("")).toBe(s);
      expect(parts.length).toBe(10);
    }
  });
  test("190k 引号", () => {
    const s = "![a](" + '"'.repeat(190000);
    const parts = longRunSegments(s);
    expect(parts.join("")).toBe(s);
    expect(parts.length).toBe(Math.ceil(s.length / RUN_CHUNK));
  });
});
