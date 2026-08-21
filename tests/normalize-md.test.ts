/**
 * web 端 markdown 归一化单测（2026-08-22 owner：「表格有时候不渲染了」）。
 *
 * 根因是渲染库 do-md 只认「自成块」的表格：表格前面没有空行，整段就退化成
 * 一个普通段落，竖线原样显示。实测新旧两版（0.2.10 / 0.11.2）行为一致，
 * 升级救不了 —— 所以修法是渲染前补那个空行，这里锁住它的边界。
 *
 * 锁两头：该补的必须补上（否则表格又不见了），不该动的一个字都别动
 * （代码围栏里的竖线是原文，句中的竖线是标点）。
 */

import { describe, test, expect } from "bun:test";
import { padTableBlocks } from "../web/components/domd/normalize-md.js";

const TABLE = "| 协议ID | 厂商 |\n|---|---|\n| `1222` | lz |";

describe("padTableBlocks", () => {
  test("紧贴上文的表格 → 前面补一个空行", () => {
    expect(padTableBlocks(`**支持 4 个协议:**\n${TABLE}`)).toBe(`**支持 4 个协议:**\n\n${TABLE}`);
  });

  test("已经有空行 → 一个字都不动（幂等）", () => {
    const src = `正文\n\n${TABLE}`;
    expect(padTableBlocks(src)).toBe(src);
    expect(padTableBlocks(padTableBlocks(src))).toBe(src);
  });

  test("表格在开头 → 不动", () => {
    expect(padTableBlocks(TABLE)).toBe(TABLE);
  });

  test("表格内部不会被劈开", () => {
    const out = padTableBlocks(`标题\n${TABLE}`);
    expect(out.split("\n\n").length).toBe(2); // 只多出开头那一个空行
  });

  test("一段里两张表都补上", () => {
    const out = padTableBlocks(`一:\n${TABLE}\n二:\n${TABLE}`);
    expect(out).toBe(`一:\n\n${TABLE}\n二:\n\n${TABLE}`);
  });

  test("代码围栏里的竖线是原文,不动", () => {
    const src = "示例:\n```md\n文字\n| a | b |\n|---|---|\n| 1 | 2 |\n```";
    expect(padTableBlocks(src)).toBe(src);
  });

  test("围栏结束之后的表格照常补", () => {
    const src = "```\ncode\n```\n说明:\n| a | b |\n|---|---|";
    expect(padTableBlocks(src)).toBe("```\ncode\n```\n说明:\n\n| a | b |\n|---|---|");
  });

  test("句中竖线 / 没有分隔行 → 都不是表格,不动", () => {
    const noPipe = "普通一段话,没有竖线";
    expect(padTableBlocks(noPipe)).toBe(noPipe);
    const midline = "正文\n普通文字 | 竖线在句中 | 不是表格";
    expect(padTableBlocks(midline)).toBe(midline);
    const noDelim = "正文\n| a | b |\n| 1 | 2 |"; // 少了 |---|---|
    expect(padTableBlocks(noDelim)).toBe(noDelim);
  });

  test("对齐写法的分隔行也认（:-- / --:）", () => {
    expect(padTableBlocks("正文\n| a | b |\n| :-- | --: |")).toBe(
      "正文\n\n| a | b |\n| :-- | --: |"
    );
  });

  test("空串 / 无竖线原样返回", () => {
    expect(padTableBlocks("")).toBe("");
  });
});
