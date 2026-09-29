/**
 * T37b r3b / r4：审查员「慢但不溢出」的几类构造（reviews/T37b-r3b.md、T37b-r4.md）——护栏必须认出来，而且判得快；
 * 全文累计的 HTML 行 / 图片行只在同步路径拦（Worker 路径有时间预算）。
 * 阈值下面一点的同类构造 do-md 解析要在 Worker 预算内（bun/JSC 下量级参考，chromium 约慢 3～5 倍）。
 */
import { describe, expect, test } from "bun:test";
import { domdSafe } from "@/components/domd/probe";
import { MD_MAX_HTML_TOTAL, MD_MAX_IMG_TOTAL, MD_MAX_NEST_TOTAL, MD_MAX_SRC_SPACE, mdTooHeavy } from "@/lib/chat/md-guard";
import { PROBE_BUDGET_MS } from "@/lib/chat/probe-queue";

const EM = (k: number) => "*a _b ".repeat(k);
const ms = (f: () => unknown) => {
  const t = performance.now();
  f();
  return performance.now() - t;
};

const BOMBS: Record<string, string> = {
  "图片 src 里 2040 个空格": "![a](" + " ".repeat(2040) + '"x)',
  "图片 src 里 400 个空格 × 10 行": ("![a](" + " ".repeat(400) + '"x)\n\n').repeat(10),
  "src 里 tab / nbsp / 图片在行中间": "说明 ![a](x" + "\t ".repeat(40) + '"t)',
  "链接 src 里长空白": "[a](" + " ".repeat(200) + ")",
  "列表 / 引用 / 序号 / 任务框后接 `<字母`": ["- ", "> ", "1. ", "- [ ] "].map((p) => p + "<a" + "a".repeat(4200)).join("\n\n"),
  "只有空格的行不分段": Array(8).fill(EM(1000)).join("\n \n"),
  "每行 `- `×50 × 400 行": ("- ".repeat(50) + "x\n").repeat(400),
};
/** 每行都过得了单行上限、叠起来才慢：只在同步路径拦 */
const SYNC_BOMBS: Record<string, string> = {
  "`<字母` 行 4 KB × 6": ("<a" + "a".repeat(4094) + "\n\n").repeat(6),
  "`<字母` 行 100 字 × 1800": ("<a" + "a".repeat(100) + "\n\n").repeat(1800),
  "图片 src 一串引号 4 KB × 6（r4）": Array(6).fill("![a](" + '"'.repeat(4091)).join("\n"),
  "图片 src 引号空格交替 4 KB × 48（r4）": Array(48).fill("![a](" + '" '.repeat(2045)).join("\n"),
};

describe("r3b 构造：护栏认得出、判得快", () => {
  for (const [name, md] of Object.entries(BOMBS)) {
    test(name, () => {
      let heavy = false;
      expect(ms(() => (heavy = mdTooHeavy(md)))).toBeLessThan(50);
      expect(heavy).toBe(true);
    });
  }
  for (const [name, md] of Object.entries(SYNC_BOMBS)) {
    test(`同步路径：${name}`, () => {
      let heavy = false;
      expect(ms(() => (heavy = mdTooHeavy(md, { sync: true })))).toBeLessThan(50);
      expect(heavy).toBe(true);
      expect(mdTooHeavy(md)).toBe(false); // Worker 路径交给时间预算
    });
  }
  test("CRLF 按 LF 算：空行照常分段（Domd 也换成 LF 再交给 do-md），段内定界符不再累成一段", () => {
    const md = Array(8).fill(EM(1000)).join("\r\n\r\n");
    expect(mdTooHeavy(md)).toBe(false);
    expect(mdTooHeavy(Array(8).fill(EM(1000)).join("\r\n"))).toBe(true); // 真在同一段里的照样拦
    expect(ms(() => domdSafe({ editable: false, initMd: md.replace(/\r\n/g, "\n") }))).toBeLessThan(PROBE_BUDGET_MS);
  });
});

describe("阈值下面一点：不降级，解析在预算内", () => {
  const UNDER: Record<string, string> = {
    [`src 空白 ${MD_MAX_SRC_SPACE} 个 × 40 行`]: ("![a](" + " ".repeat(MD_MAX_SRC_SPACE) + '"x)\n\n').repeat(40),
    [`\`<字母\` 行累计 ${MD_MAX_HTML_TOTAL} 字`]: ("<a" + "a".repeat(2046) + "\n\n").repeat(MD_MAX_HTML_TOTAL / 2048),
    [`图片行累计 ${MD_MAX_IMG_TOTAL} 字`]: Array(MD_MAX_IMG_TOTAL / 1024).fill("![a](" + '"'.repeat(1019)).join("\n"),
    [`嵌套总量 ${MD_MAX_NEST_TOTAL}`]: ("- ".repeat(50) + "x\n\n").repeat(MD_MAX_NEST_TOTAL / 50),
  };
  for (const [name, md] of Object.entries(UNDER)) {
    test(name, () => {
      expect(mdTooHeavy(md, { sync: true })).toBe(false);
      expect(ms(() => domdSafe({ editable: false, initMd: md }))).toBeLessThan(PROBE_BUDGET_MS);
    });
  }
  test("多一点就降级", () => {
    expect(mdTooHeavy("![a](" + " ".repeat(MD_MAX_SRC_SPACE + 1) + '"x)')).toBe(true);
    expect(mdTooHeavy(("<a" + "a".repeat(2046) + "\n\n").repeat(MD_MAX_HTML_TOTAL / 2048) + "<a", { sync: true })).toBe(true);
    expect(mdTooHeavy(Array(MD_MAX_IMG_TOTAL / 1024).fill("![a](" + '"'.repeat(1019)).join("\n") + "\n![", { sync: true })).toBe(true);
    expect(mdTooHeavy(("- ".repeat(50) + "x\n\n").repeat(MD_MAX_NEST_TOTAL / 50) + "- x")).toBe(true);
  });
  test("正常写法不受影响：src 带 title、链接后面跟对齐空格的表格", () => {
    expect(mdTooHeavy('![图](https://a.example/p.png "标题")')).toBe(false);
    expect(mdTooHeavy("| [a](b) |" + " ".repeat(120) + "|\n|---|---|")).toBe(false);
    expect(mdTooHeavy("<p align=\"center\">\n  <img src=\"x.png\">\n</p>\n")).toBe(false);
  });
});
