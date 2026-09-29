/** 协作视图两侧栏收起状态的存取（web/features/collab/v4/panes.ts）：默认值、存储不可用 / 内容坏了回默认、写失败不抛 */
import { describe, expect, test } from "bun:test";
import { defaultPanes, PANES_KEY, readPanes, writePanes } from "../web/features/collab/v4/panes";

const mem = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};
const broken = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceeded"); } };

describe("两侧栏收起状态", () => {
  test("默认：大纲展开；窄于 1280 右栏收起", () => {
    expect(defaultPanes(1440)).toEqual({ left: true, right: true });
    expect(defaultPanes(1024)).toEqual({ left: true, right: false });
  });
  test("存储不可用 / 没有 / 坏 JSON / 字段类型不对 → 默认值（逐字段）", () => {
    expect(readPanes(null, 1024)).toEqual({ left: true, right: false });
    expect(readPanes(broken, 1440)).toEqual({ left: true, right: true });
    expect(readPanes(mem({ [PANES_KEY]: "{oops" }), 1024)).toEqual({ left: true, right: false });
    expect(readPanes(mem({ [PANES_KEY]: JSON.stringify({ left: false, right: "yes" }) }), 1440)).toEqual({ left: false, right: true });
  });
  test("写进去再读回来；写失败不抛", () => {
    const s = mem();
    writePanes(s, { left: false, right: true });
    expect(readPanes(s, 800)).toEqual({ left: false, right: true });
    expect(() => writePanes(broken, { left: true, right: true })).not.toThrow();
    expect(() => writePanes(null, { left: true, right: true })).not.toThrow();
  });
});
