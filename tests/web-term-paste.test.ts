import { describe, expect, test } from "bun:test";
import { pasteFromClipboard } from "../web/features/terminal/clipboard-paste";

// 终端「粘贴」键：读剪贴板 → 交给 xterm paste；读不到只返回结果给提示用，不抛
describe("pasteFromClipboard", () => {
  test("读到文字 → 原样交给 paste（不补回车）", async () => {
    let reads = 0;
    const got: string[] = [];
    const r = await pasteFromClipboard({ readText: async () => (reads++, "ls -la\necho hi") }, (s) => got.push(s));
    expect(r).toBe("ok");
    expect(reads).toBe(1);
    expect(got).toEqual(["ls -la\necho hi"]);
  });
  test("用户拒绝 / 不支持 → blocked，不抛也不 paste", async () => {
    const got: string[] = [];
    const denied = { readText: () => Promise.reject(new DOMException("denied", "NotAllowedError")) };
    expect(await pasteFromClipboard(denied, (s) => got.push(s))).toBe("blocked");
    expect(await pasteFromClipboard(undefined, (s) => got.push(s))).toBe("blocked");
    expect(got).toEqual([]);
  });
  test("剪贴板为空 → empty，不 paste", async () => {
    const got: string[] = [];
    expect(await pasteFromClipboard({ readText: async () => "" }, (s) => got.push(s))).toBe("empty");
    expect(got).toEqual([]);
  });
});
