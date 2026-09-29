/** 协作视图两侧栏收起状态的存取（web/features/collab/v4/panes.ts）：默认值、存储不可用 / 内容坏了回默认、写失败不抛 */
import { describe, expect, test } from "bun:test";
import { defaultPanes, keepDismissed, PANES_KEY, readPanes, toggleRight, writePanes, type Panes } from "../web/features/collab/v4/panes";

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
  test("临时浮出收回只管这一次：A 收回 → 选 B → 再选 A，A 照样浮出", () => {
    let d: string | null = "A"; // 选中 A 时点了收回
    expect(keepDismissed(d, "A")).toBe("A"); // 还是 A：保持收回
    d = keepDismissed(d, "B"); // 直接换到 B
    expect(d).toBeNull();
    expect(keepDismissed(d, "A")).toBeNull(); // 再选回 A：不再被上一次的收回挡住
    expect(keepDismissed("A", null)).toBeNull();
  });

  test("选中详情时点「收起右栏」一次就收（审查 r2）：不再同一轮临时浮出；之后选别的任务才浮出，展开回来照常", () => {
    const shown = (p: Panes, key: string | null, d: string | null) => p.right || (key !== null && key !== keepDismissed(d, key));
    const peekOf = (p: Panes, key: string | null, d: string | null) => !p.right && key !== null && key !== d;
    const open = { left: true, right: true };
    let s = toggleRight(open, peekOf(open, "A", null), "A", null);
    expect(s.panes.right).toBe(false);
    expect(shown(s.panes, "A", s.dismissed)).toBe(false); // 第一次点就收起，不是变成浮层
    expect(shown(s.panes, "B", keepDismissed(s.dismissed, "B"))).toBe(true); // 换选 B：右栏收着，临时浮出
    s = toggleRight(s.panes, true, "B", null); // 浮出时点收起：只收回这一次，不写存储
    expect(s.panes.right).toBe(false);
    expect(shown(s.panes, "B", s.dismissed)).toBe(false);
    s = toggleRight(s.panes, false, "B", s.dismissed); // 再点：展开常驻
    expect(s.panes.right).toBe(true);
    expect(toggleRight(open, false, null, null)).toEqual({ panes: { left: true, right: false }, dismissed: null });
  });
});
