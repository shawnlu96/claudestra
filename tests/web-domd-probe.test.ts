/**
 * T37b 纵深防御（web/components/domd/probe.ts）：护栏认不出的 md 渲染前先试解析——解析抛错、树太深都退回纯文本。
 * 深树的栈溢出发生在 React 提交阶段，ErrorBoundary 接不住，只能靠这里；阈值和实测见 probe.ts 头注释。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MD_MAX_TREE_DEPTH, domdSafe } from "@/components/domd/probe";

const safe = (initMd: string) => domdSafe({ editable: false, initMd });

describe("domdSafe", () => {
  test("真实文档照常渲染", () => {
    for (const f of ["CLAUDE.md", "docs/architecture/features.md", "docs/web/data-flow.md"]) {
      expect(safe(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"))).toBe(true);
    }
    expect(safe("# 标题\n\n- a\n  - b\n    - [ ] c\n\n> 引用\n\n```ts\nx\n```")).toBe(true);
  });
  test("解析树超过上限（护栏漏算的嵌套写法）→ 不安全", () => {
    expect(safe("- ".repeat(40) + "x")).toBe(true);
    expect(safe("- ".repeat(MD_MAX_TREE_DEPTH) + "x")).toBe(false);
    expect(safe("1. ".repeat(400) + "x")).toBe(false);
    expect(safe("- [ ] ".repeat(500) + "x")).toBe(false);
  });
  test("解析抛错被接住 → 不安全，不往外抛（栈溢出那类只在浏览器的小栈里出现，headless 实测见 PR）", () => {
    expect(() => domdSafe({ editable: false, initMd: 42 as unknown as string })).not.toThrow();
    expect(domdSafe({ editable: false, initMd: 42 as unknown as string })).toBe(false);
  });
});
