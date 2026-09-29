/**
 * T37b markdown 护栏（web/lib/chat/md-guard.ts）：会让 do-md 卡死 / 栈溢出的 md 改纯文本；链接协议白名单；图片来源分类。
 * 阈值的实测数字在 md-guard.ts 头注释；这里钉住判定边界，并确认真实文档不会被误降级。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  MD_MAX_BLOCK_DELIMS,
  MD_MAX_BYTES,
  MD_MAX_INDENT,
  MD_MAX_NEST,
  MD_MAX_LINE,
  imageSrcOf,
  MD_MAX_TOTAL_DELIMS,
  imageHost,
  imageSrcKind,
  mdTooHeavy,
  safeLinkHref,
} from "@/lib/chat/md-guard";

const brackets = (n: number) => "[".repeat(n / 2) + "](".repeat(n / 4); // n 个定界符

describe("mdTooHeavy", () => {
  test("真实文档不降级（仓库的 CLAUDE.md / web 数据流文档）", () => {
    for (const f of ["CLAUDE.md", "CLAUDE.zh-CN.md", "docs/architecture/features.md", "docs/web/data-flow.md"]) {
      expect(mdTooHeavy(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"))).toBe(false);
    }
  });
  test("总大小超过 200 KB 就降级（按 UTF-8 字节，中文 3 字节）", () => {
    expect(mdTooHeavy("a\n\n".repeat(MD_MAX_BYTES / 3))).toBe(false);
    expect(mdTooHeavy("x".repeat(MD_MAX_BYTES + 1))).toBe(true);
    expect(mdTooHeavy("中".repeat(Math.ceil(MD_MAX_BYTES / 3) + 1))).toBe(true);
  });
  test("单段定界符：2000 以内照常，超过降级；空行分段后各算各的", () => {
    expect(mdTooHeavy(brackets(MD_MAX_BLOCK_DELIMS))).toBe(false);
    expect(mdTooHeavy(brackets(MD_MAX_BLOCK_DELIMS + 4))).toBe(true);
    expect(mdTooHeavy("*a _b ".repeat(1500))).toBe(true); // 3000 个 * _：单段栈溢出那一类
    expect(mdTooHeavy(Array(4).fill(brackets(1600)).join("\n\n"))).toBe(false);
  });
  test("只用单个换行连起来的仍是同一段（do-md 按段解析，拆行没用）", () => {
    const lines = (brackets(MD_MAX_BLOCK_DELIMS + 400).match(/.{1,100}/g) ?? []).join("\n");
    expect(mdTooHeavy(lines)).toBe(true);
  });
  test("全文定界符超过 16000 降级（哪怕每段都不超）", () => {
    const per = 1600;
    const n = Math.floor(MD_MAX_TOTAL_DELIMS / per);
    expect(mdTooHeavy(Array(n).fill(brackets(per)).join("\n\n"))).toBe(false);
    expect(mdTooHeavy(Array(n + 1).fill(brackets(per)).join("\n\n"))).toBe(true);
  });
  test("代码块里的不计数（代码不做行内解析）", () => {
    const code = "```\n" + Array(50).fill("x = [a](b) * c_d `e` ".repeat(20)).join("\n") + "\n```\n";
    expect(mdTooHeavy(code)).toBe(false);
    const bigCode = (brackets(MD_MAX_TOTAL_DELIMS + 200).match(/.{1,200}/g) ?? []).join("\n");
    expect(mdTooHeavy("```ts\n" + bigCode + "\n```\nok")).toBe(false);
    expect(mdTooHeavy("```\n" + bigCode)).toBe(false); // 没闭合：do-md 吞到文末
    expect(mdTooHeavy("# 标题\n```\n" + bigCode + "\n```")).toBe(false); // 紧跟标题行：do-md 照样一直到 ```
  });
  test("围栏按 do-md 的规则认：~~~ / 缩进的 ``` 不算代码；``` 在下一个任意位置的 ``` 就结束", () => {
    const bomb = brackets(MD_MAX_BLOCK_DELIMS + 100);
    expect(mdTooHeavy("~~~\n" + bomb + "\n~~~")).toBe(true);
    expect(mdTooHeavy(" ```\n" + bomb + "\n ```")).toBe(true);
    expect(mdTooHeavy("\t```\n" + bomb + "\n\t```")).toBe(true);
    expect(mdTooHeavy("```a```\n" + bomb)).toBe(true); // 同一行开合
    expect(mdTooHeavy("```\nx ``` " + bomb + "\n```")).toBe(true); // 行中间闭合，剩下的是正文
    expect(mdTooHeavy("~~~\n" + "*a _b ".repeat(15000) + "\n~~~")).toBe(true);
  });
  test("``` 紧跟非空行（段落 / HTML / `\\` 开头）时，代码块在下一个空行就断了，后面按正文计数", () => {
    const bomb = (brackets(MD_MAX_BLOCK_DELIMS + 100).match(/.{1,200}/g) ?? []).join("\n");
    const fenced = (lead: string) => lead + "```\nx\n\n" + bomb + "\n\n```\n";
    expect(mdTooHeavy(fenced("a\n"))).toBe(true);
    expect(mdTooHeavy(fenced("\\a\n"))).toBe(true);
    expect(mdTooHeavy(fenced("<div>\n```\n</div>\n"))).toBe(true);
    expect(mdTooHeavy(fenced(" \n"))).toBe(true); // 只有空格的行不算空行：do-md 只在 \n\n 分段
    expect(mdTooHeavy("a\n```\nx\n\n" + "- ".repeat(500) + "x\n\n```")).toBe(true);
    expect(mdTooHeavy(fenced("a\n\n"))).toBe(false); // 前面是空行：一直到下一个 ```，整块是代码
  });
  test("行首嵌套标记超过 50 层降级（不缩进的 `- - -` / `> > >` 也会栈溢出）", () => {
    for (const m of ["- ", "> ", "+ ", "* ", "1. ", "2) ", "> - "]) {
      expect(mdTooHeavy(m.repeat(10) + "x")).toBe(false);
      expect(mdTooHeavy(m.repeat(MD_MAX_NEST + 1) + "x")).toBe(true);
    }
    expect(mdTooHeavy(">".repeat(MD_MAX_NEST + 1) + " x")).toBe(true);
    expect(mdTooHeavy("-".repeat(200) + "\n" + "*".repeat(100) + "\n2024. x")).toBe(false); // 分隔线 / 不带空格的不是标记
    expect(mdTooHeavy("- ".repeat(95000) + "x")).toBe(true);
  });
  test("嵌套写法和 do-md 对齐：任务框、长序号、各种空白、引用后的缩进都算", () => {
    for (const s of [
      "- [ ] ".repeat(500) + "x",
      "- [x] ".repeat(500) + "x",
      "1234567890. ".repeat(400) + "x",
      "1.\u00a0".repeat(400) + "x",
      "1.\u3000".repeat(400) + "x",
      "1.\f".repeat(400) + "x",
      Array(440).fill("> " + " ".repeat(2000) + "- x").join("\n"),
      Array(440).fill("\f".repeat(2000) + "- x").join("\n"),
      "- [ ] ".repeat(20) + "\u00a0".repeat(90) + "x",
    ]) {
      expect(mdTooHeavy(s)).toBe(true);
    }
    expect(mdTooHeavy("- [ ] 待办\n  - [x] 已完成\n    1. 子项\n> > 引用 - 列表")).toBe(false);
    expect(mdTooHeavy("-".repeat(150) + "\n" + "1".repeat(150) + "\n" + "=".repeat(150))).toBe(false); // 分隔线 / 长数字不是标记
  });
  test("超长行降级：任意一行超过 8 KB；含 `![` 或以 `<字母` 开头的行超过 4 KB（do-md 这两个正则会回溯）", () => {
    expect(mdTooHeavy("![a](" + '"'.repeat(60000))).toBe(true);
    expect(mdTooHeavy("![a](" + '"'.repeat(5000))).toBe(true);
    expect(mdTooHeavy("<a" + "a".repeat(5000))).toBe(true);
    expect(mdTooHeavy(" <div" + "a".repeat(5000))).toBe(true);
    expect(mdTooHeavy("x".repeat(MD_MAX_LINE + 1))).toBe(true);
    expect(mdTooHeavy("```\n" + "x".repeat(MD_MAX_LINE + 1) + "\n```")).toBe(true);
    expect(mdTooHeavy("x".repeat(MD_MAX_LINE))).toBe(false);
    expect(mdTooHeavy("a < b " + "x".repeat(6000))).toBe(false);
  });
  test("裸链接按 8 个定界符计：同一段 250 个以上降级", () => {
    const urls = (n: number, sep: string) => "https://t.example/p".concat(sep).repeat(n);
    expect(mdTooHeavy(urls(250, " "))).toBe(false);
    expect(mdTooHeavy(urls(251, " "))).toBe(true);
    expect(mdTooHeavy(urls(251, "\n"))).toBe(true); // 单个换行连起来仍是一段
    expect(mdTooHeavy("www.a.b ".repeat(300))).toBe(true);
    expect(mdTooHeavy(Array(8).fill(urls(200, " ")).join("\n\n"))).toBe(false);
  });
  test("全文表格单元格（`|` 个数）超过 5000 降级：贵在 React 渲染（Worker 兜不住），真实文档最多 2235", () => {
    const table = (cols: number, rows: number) => ("|" + "a|".repeat(cols) + "\n").repeat(rows);
    expect(mdTooHeavy(table(49, 100))).toBe(false);
    expect(mdTooHeavy(table(50, 100))).toBe(true);
    expect(mdTooHeavy(table(47000, 2))).toBe(true);
    expect(mdTooHeavy(Array(2).fill(table(24, 100)).join("\n"))).toBe(false);
    expect(mdTooHeavy(Array(3).fill(table(24, 100)).join("\n"))).toBe(true); // 空行分开也按全文累计
    expect(mdTooHeavy("```\n" + table(200, 100) + "```")).toBe(false);
  });
  test("缩进超过 80 列降级（深层嵌套列表会栈溢出）；tab 按 4 列", () => {
    expect(mdTooHeavy(" ".repeat(MD_MAX_INDENT) + "- item")).toBe(false);
    expect(mdTooHeavy(" ".repeat(MD_MAX_INDENT + 1) + "- item")).toBe(true);
    expect(mdTooHeavy("\t".repeat(21) + "- item")).toBe(true);
    expect(mdTooHeavy("```\n" + " ".repeat(200) + "code\n```")).toBe(false);
  });
});

describe("safeLinkHref：只放行 http / https / mailto", () => {
  test("放行", () => {
    expect(safeLinkHref("https://github.com/x")).toBe("https://github.com/x");
    expect(safeLinkHref(" HTTP://a.b ")).toBe("HTTP://a.b");
    expect(safeLinkHref("mailto:a@b.c")).toBe("mailto:a@b.c");
  });
  test("其余协议 / 相对路径 / 非字符串一律不放行", () => {
    for (const h of ["javascript:alert(1)", " JavaScript:alert(1)", "data:text/html,<b>", "vbscript:x", "file:///etc/passwd", "/api/v1/x", "./a.md", "#top", "//evil.com", ""]) {
      expect(safeLinkHref(h)).toBeNull();
    }
    expect(safeLinkHref(undefined)).toBeNull();
    expect(safeLinkHref(42)).toBeNull();
  });
});

describe("imageSrcKind：图片来源", () => {
  test("本机附件带凭据取；data: / blob: 照常；http(s) 外链点了才加载；其余只显示 alt", () => {
    expect(imageSrcKind("/api/v1/attachments/a.png")).toBe("attachment");
    expect(imageSrcKind("/api/v1/attachments/1790000000_%E6%88%AA%E5%9B%BE.png?d=2026-09-28")).toBe("attachment");
    expect(imageSrcKind("data:image/png;base64,AAAA")).toBe("inline");
    expect(imageSrcKind("blob:https://x/1")).toBe("inline");
    expect(imageSrcKind("https://tracker.example/p.gif")).toBe("external");
    expect(imageSrcKind("http://1.2.3.4/p.gif")).toBe("external");
    for (const s of ["javascript:alert(1)", "data:text/html,<b>", "file:///x.png", "/api/v1/agents", "a.png", undefined]) expect(imageSrcKind(s)).toBe("blocked");
  });
  test("附件路径只认单段文件名：`..`、编码过的 `..` / 分隔符、多余的 query 都不按附件带凭据取", () => {
    for (const s of [
      "/api/v1/attachments/../agents/x/kill",
      "/api/v1/attachments/..",
      "/api/v1/attachments/%2e%2e/agents",
      "/api/v1/attachments/%2E./x",
      "/api/v1/attachments/a%2f..%2fb",
      "/api/v1/attachments/a%5c..",
      "/api/v1/attachments/.hidden",
      "/api/v1/attachments/a\\..\\agents",
      "/api/v1/attachments/a.png?x=1",
      "/api/v1/attachments/a.png#x",
      "/api/v1/attachments/%E0%A4%A",
      "/api/v1/attachments/",
    ]) {
      expect(imageSrcKind(s)).toBe("blocked");
    }
  });
  test("只解码一次：两次编码的 `%252e%252e` 是名叫 `%2e%2e` 的普通文件（浏览器和服务端都不会再解一次成 ..）", () => {
    expect(imageSrcKind("/api/v1/attachments/%252e%252e")).toBe("attachment");
    expect(imageSrcKind("/api/v1/attachments/%252e%252e%252fagents")).toBe("attachment");
    expect(new URL("/api/v1/attachments/%252e%252e", "http://h").pathname).toBe("/api/v1/attachments/%252e%252e");
    expect(imageSrcKind("/api/v1/attachments/a%E0%A4%A.png")).toBe("blocked"); // 非法 % 序列一律拒
    expect(imageSrcKind("/api/v1/attachments/a%7F.png")).toBe("blocked"); // DEL 和服务端一样算控制字符
  });
  test("imageSrcOf：do-md 给的 src 带着 title / 尖括号，取出真正的地址", () => {
    expect(imageSrcOf('https://t.example/p.png "title"')).toBe("https://t.example/p.png");
    expect(imageSrcOf("x.png  't'")).toBe("x.png");
    expect(imageSrcOf("  <x y.png> ")).toBe("x y.png");
    expect(imageSrcOf('a"b.png')).toBe('a"b.png'); // 引号前不是空白：不是 title
    expect(imageSrcOf(undefined)).toBe("");
    const t = performance.now();
    imageSrcOf("x" + " ".repeat(190000) + '"' + " ".repeat(190000) + '"');
    expect(performance.now() - t).toBeLessThan(50);
  });
  test("imageHost：占位上显示的域名", () => {
    expect(imageHost("https://tracker.example:8443/p.gif?id=1")).toBe("tracker.example:8443");
    expect(imageHost("https://")).toBe("");
  });
});
