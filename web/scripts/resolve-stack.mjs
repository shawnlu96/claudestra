#!/usr/bin/env node
/**
 * 把生产环境的压缩 JS 栈还原到源码位置(配合 next.config 的 productionBrowserSourceMaps)。
 *
 * 用法:
 *   node scripts/resolve-stack.mjs '<stack 文本>'          # 直接传
 *   grep "error #185" ~/.claude-orchestrator/web/client.log | tail -1 | node scripts/resolve-stack.mjs
 *
 * 识别 `.../_next/static/chunks/<file>.js:<line>:<col>`(含 ⏎ 折行的日志格式),
 * 到 .next/static/chunks/<file>.js.map 查 originalPositionFor。构建号不同的
 * 栈对不上当前 .map(会打印 ? 标记),先确认 splash 显示的 commit 与 .next 一致。
 */
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { SourceMapConsumer } from "source-map-js";

const here = dirname(fileURLToPath(import.meta.url));
const CHUNKS = join(here, "..", ".next", "static", "chunks");

const input = process.argv[2] ?? readFileSync(0, "utf8");
const text = input.replace(/ ⏎ /g, "\n");
const frameRe = /(?:https?:\/\/[^\s)]+\/_next\/static\/chunks\/|\/_next\/static\/chunks\/)?([\w.-]+\.js):(\d+):(\d+)/g;

const cache = new Map();
function consumer(file) {
  if (cache.has(file)) return cache.get(file);
  const p = join(CHUNKS, `${file}.map`);
  const c = existsSync(p) ? new SourceMapConsumer(JSON.parse(readFileSync(p, "utf8"))) : null;
  cache.set(file, c);
  return c;
}

let m;
let any = false;
while ((m = frameRe.exec(text))) {
  any = true;
  const [, file, line, col] = m;
  const c = consumer(file);
  if (!c) {
    console.log(`  ${file}:${line}:${col}  → (no .map in .next/static/chunks)`);
    continue;
  }
  const pos = c.originalPositionFor({ line: Number(line), column: Number(col) });
  const src = pos.source ? pos.source.replace(/^webpack:\/\/(_N_E\/)?/, "") : "?";
  console.log(`  ${file}:${line}:${col}  → ${src}:${pos.line ?? "?"}:${pos.column ?? "?"}  ${pos.name ?? ""}`);
}
if (!any) console.log("no chunk frames found in input");
