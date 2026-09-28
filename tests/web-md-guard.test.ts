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
    expect(mdTooHeavy("```ts\n" + brackets(MD_MAX_TOTAL_DELIMS + 100) + "\n```\nok")).toBe(false);
    expect(mdTooHeavy("```\n" + brackets(MD_MAX_TOTAL_DELIMS + 100))).toBe(false); // 没闭合：do-md 吞到文末
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
  test("行首嵌套标记超过 50 层降级（不缩进的 `- - -` / `> > >` 也会栈溢出）", () => {
    for (const m of ["- ", "> ", "+ ", "* ", "1. ", "2) ", "> - "]) {
      expect(mdTooHeavy(m.repeat(10) + "x")).toBe(false);
      expect(mdTooHeavy(m.repeat(MD_MAX_NEST + 1) + "x")).toBe(true);
    }
    expect(mdTooHeavy(">".repeat(MD_MAX_NEST + 1) + " x")).toBe(true);
    expect(mdTooHeavy("-".repeat(200) + "\n" + "*".repeat(100) + "\n2024. x")).toBe(false); // 分隔线 / 不带空格的不是标记
    expect(mdTooHeavy("- ".repeat(95000) + "x")).toBe(true);
  });
  test("裸链接按 8 个定界符计：同一段 250 个以上降级", () => {
    const urls = (n: number, sep: string) => "https://t.example/p".concat(sep).repeat(n);
    expect(mdTooHeavy(urls(250, " "))).toBe(false);
    expect(mdTooHeavy(urls(251, " "))).toBe(true);
    expect(mdTooHeavy(urls(251, "\n"))).toBe(true); // 单个换行连起来仍是一段
    expect(mdTooHeavy("www.a.b ".repeat(300))).toBe(true);
    expect(mdTooHeavy(Array(8).fill(urls(200, " ")).join("\n\n"))).toBe(false);
  });
  test("一段里的表格单元格（`|` 个数）超过 10000 降级：超宽表格贵在列数 × 行数", () => {
    const table = (cols: number, rows: number) => ("|" + "a|".repeat(cols) + "\n").repeat(rows);
    expect(mdTooHeavy(table(99, 100))).toBe(false);
    expect(mdTooHeavy(table(47000, 2))).toBe(true);
    expect(mdTooHeavy(table(100, 101))).toBe(true);
    expect(mdTooHeavy(Array(8).fill(table(50, 100)).join("\n"))).toBe(false); // 空行分开的各算各的
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
  });
  test("imageHost：占位上显示的域名", () => {
    expect(imageHost("https://tracker.example:8443/p.gif?id=1")).toBe("tracker.example:8443");
    expect(imageHost("https://")).toBe("");
  });
});
