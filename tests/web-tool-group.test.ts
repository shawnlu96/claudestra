import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { toolGroupLayout } from "../web/features/chat/tool-group";

// 连续工具调用的收拢方式（web/features/chat/components/tool-rows.tsx ToolGroup）。
// 导出稿（分享 → HTML / PDF）复用同一套组件但没有 JS：收起态会让每组只剩最后一张卡、「展开全部」点不动。
describe("toolGroupLayout", () => {
  test("单步平铺，不出组头", () => {
    for (const exporting of [false, true]) {
      expect(toolGroupLayout(1, false, exporting)).toEqual({ framed: false, toggle: false, showAll: true });
    }
  });
  test("≥2 步：默认收起只露最后一张，组头可点；展开后全部", () => {
    expect(toolGroupLayout(2, false, false)).toEqual({ framed: true, toggle: true, showAll: false });
    expect(toolGroupLayout(12, true, false)).toEqual({ framed: true, toggle: true, showAll: true });
  });
  test("导出稿：不管 open 与否都全展开，组头不是按钮", () => {
    expect(toolGroupLayout(3, false, true)).toEqual({ framed: true, toggle: false, showAll: true });
    expect(toolGroupLayout(40, true, true)).toEqual({ framed: true, toggle: false, showAll: true });
  });
  test("ToolGroup 真的读了导出开关、组头不用 emoji", () => {
    // tool-rows.tsx 带 JSX，根目录 tsc 没开 jsx，只能读源码核对接线
    const src = readFileSync(new URL("../web/features/chat/components/tool-rows.tsx", import.meta.url), "utf8");
    const group = src.slice(src.indexOf("export function ToolGroup"));
    expect(group).toContain("useIsExport()");
    expect(group).toContain("toolGroupLayout(tools.length, open, exporting)");
    expect(group).not.toMatch(/[⚠▸▾]/u);
  });
});
