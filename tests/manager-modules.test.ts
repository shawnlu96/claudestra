import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

// src/manager/* 是从 manager.ts 拆出去的命令族。两条约束靠测试钉住：
// 1. 不许反向 import 入口 manager.ts——它顶层就是 switch 执行，被 import = 直接跑一遍 CLI
// 2. stdout 只能由 core 的 output() 写：bridge 的 runManager 把整段 stdout 当一个 JSON 解析，
//    模块里多一句 console.log 就会让调用方拿到解析失败（诊断信息请用 console.error）
const DIR = join(import.meta.dir, "..", "src", "manager");
const files = readdirSync(DIR).filter((f) => f.endsWith(".ts"));

describe("src/manager 模块约束", () => {
  test("有模块可查", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const f of files) {
    const src = readFileSync(join(DIR, f), "utf8");
    test(`${f} 不 import manager.ts 入口`, () => {
      expect(/from\s+["']\.\.\/manager(\.js|\.ts)?["']/.test(src)).toBe(false);
      expect(/import\(\s*["']\.\.\/manager(\.js|\.ts)?["']\s*\)/.test(src)).toBe(false);
    });
    test(`${f} 不直接 console.log（stdout 只走 output()）`, () => {
      const hits = src.split("\n").filter((l) => /\bconsole\.log\(/.test(l));
      const allowed = f === "core.ts" ? 1 : 0; // core 的 output() 本身
      expect(hits.length).toBe(allowed);
    });
  }
});
