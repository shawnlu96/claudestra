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
    expect(mdTooHeavy("~~~\n" + brackets(MD_MAX_TOTAL_DELIMS + 100) + "\n~~~")).toBe(false);
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
    expect(imageSrcKind("data:image/png;base64,AAAA")).toBe("inline");
    expect(imageSrcKind("blob:https://x/1")).toBe("inline");
    expect(imageSrcKind("https://tracker.example/p.gif")).toBe("external");
    expect(imageSrcKind("http://1.2.3.4/p.gif")).toBe("external");
    for (const s of ["javascript:alert(1)", "data:text/html,<b>", "file:///x.png", "/api/v1/agents", "a.png", undefined]) expect(imageSrcKind(s)).toBe("blocked");
  });
  test("imageHost：占位上显示的域名", () => {
    expect(imageHost("https://tracker.example:8443/p.gif?id=1")).toBe("tracker.example:8443");
    expect(imageHost("https://")).toBe("");
  });
});
