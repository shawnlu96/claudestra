/**
 * T37b 图片 alt（web/components/domd/img-alt.ts）：do-md 的 Img 节点只带 src，alt 按节点回原文取。
 * r3b 报的几种对不上的写法：title 前有空格、src 带括号、尖括号 src、同一 src 的第二张图。
 */
import { describe, expect, test } from "bun:test";
import { imageAltOf } from "@/components/domd/img-alt";
import { parseMd } from "@/components/domd/probe";
import { imageSrcOf } from "@/lib/chat/md-guard";

type Node = { htmlType_?: string; htmlProps_?: { src?: string }; children_?: Node[] };

/** 按文档顺序返回每张图的 [地址, alt] */
function images(md: string): [string, string][] {
  const root = parseMd({ editable: false, initMd: md }) as Node;
  const out: [string, string][] = [];
  const walk = (n: Node) => {
    if (n.htmlType_ === "Img") out.push([imageSrcOf(n.htmlProps_?.src), imageAltOf(root, n)]);
    n.children_?.forEach(walk);
  };
  walk(root);
  return out;
}

describe("imageAltOf", () => {
  test("普通写法、空 alt、嵌在链接和加粗里", () => {
    expect(images("![截图 1](a.png)")).toEqual([["a.png", "截图 1"]]);
    expect(images("![](a.png)")).toEqual([["a.png", ""]]);
    expect(images("[![徽章](b.svg)](https://x.example) **![粗](c.png)**")).toEqual([
      ["b.svg", "徽章"],
      ["c.png", "粗"],
    ]);
  });
  test("title 前有空格：src 里带着 title 也对得上", () => {
    expect(images('![b]( https://t.example/p.png "title")')).toEqual([["https://t.example/p.png", "b"]]);
    expect(images("![c](x.png  't')")).toEqual([["x.png", "c"]]);
  });
  test("src 带括号：do-md 在第一个 ) 截断，alt 照样对上", () => {
    expect(images("![a](a_(b).png)")).toEqual([["a_(b", "a"]]);
    expect(images("![危险](javascript:alert(1))")).toEqual([["javascript:alert(1", "危险"]]);
  });
  test("尖括号 src", () => {
    expect(images("![尖](<x y.png>)")).toEqual([["x y.png", "尖"]]);
  });
  test("同一 src 的几张图各取各的 alt", () => {
    expect(images("![第一](x.png) ![第二](x.png)\n\n![第三](x.png)")).toEqual([
      ["x.png", "第一"],
      ["x.png", "第二"],
      ["x.png", "第三"],
    ]);
  });
  test("对不上原文给空串，不抛错", () => {
    expect(imageAltOf(null, { htmlProps_: { src: "a" }, mdSymbols_: ["x"] })).toBe("");
    expect(imageAltOf({ children_: [] }, { htmlProps_: { src: "a" }, mdSymbols_: ["x"] })).toBe("");
    expect(imageAltOf({ children_: [] }, {})).toBe("");
  });
  test("几千张图：每棵树只建一次索引", () => {
    const md = Array.from({ length: 3000 }, (_, i) => `![图${i}](p${i}.png)`).join(" ");
    const t = performance.now();
    const got = images(md);
    expect(got[2999]).toEqual(["p2999.png", "图2999"]);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});
