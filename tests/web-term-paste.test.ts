import { describe, expect, test } from "bun:test";
import { pasteFromClipboard } from "../web/features/terminal/clipboard-paste";

// 终端「粘贴」键：读剪贴板 → 交给 xterm paste；绝不替用户回车，读不到只返回结果给提示用、不抛
const fakeTerm = (bracketedPasteMode: boolean) => {
  const got: string[] = [];
  return { got, paste: (s: string) => void got.push(s), modes: { bracketedPasteMode } };
};
const clip = (text: string) => ({ readText: async () => text });

describe("pasteFromClipboard", () => {
  test("单行命令原样交给 paste，readText 只调一次", async () => {
    let reads = 0;
    const term = fakeTerm(false);
    expect(await pasteFromClipboard({ readText: async () => (reads++, "ls -la") }, term)).toBe("ok");
    expect(reads).toBe(1);
    expect(term.got).toEqual(["ls -la"]);
  });
  test("bracketed 关、只有末尾换行 → 剥掉再发，不带任何回车", async () => {
    const term = fakeTerm(false);
    expect(await pasteFromClipboard(clip("echo hi\r\n\n"), term)).toBe("ok");
    expect(term.got).toEqual(["echo hi"]);
  });
  test("bracketed 关、中间有换行 → 不发（否则逐行执行），返回 multiline", async () => {
    const term = fakeTerm(false);
    expect(await pasteFromClipboard(clip("echo first\necho second\n"), term)).toBe("multiline");
    expect(term.got).toEqual([]);
  });
  test("bracketed 开、多行 → 照常 paste（末尾换行仍剥掉）", async () => {
    const term = fakeTerm(true);
    expect(await pasteFromClipboard(clip("echo first\necho second\n"), term)).toBe("ok");
    expect(term.got).toEqual(["echo first\necho second"]);
  });
  test("用户拒绝 / 不支持 → blocked，不抛也不 paste", async () => {
    const term = fakeTerm(true);
    const denied = { readText: () => Promise.reject(new DOMException("denied", "NotAllowedError")) };
    expect(await pasteFromClipboard(denied, term)).toBe("blocked");
    expect(await pasteFromClipboard(undefined, term)).toBe("blocked");
    expect(term.got).toEqual([]);
  });
  test("剪贴板为空或只有换行 → empty，不 paste", async () => {
    const term = fakeTerm(true);
    expect(await pasteFromClipboard(clip(""), term)).toBe("empty");
    expect(await pasteFromClipboard(clip("\n"), term)).toBe("empty");
    expect(term.got).toEqual([]);
  });
});
