// 函数体内的长注释块（全仓总数棘轮）：缩进 ≥2 的连续注释行达到 COMMENT_BLOCK_MIN 行算一块。
// 顶层（文件头 / 导出函数上方）的文档注释不计——长注释块的问题是演变史塞进了逻辑中间。
import { COMMENT_BLOCK_MIN } from "../config.ts";
import type { Files, RuleResult } from "../types.ts";

function isCommentLine(line: string, state: { inBlock: boolean }): boolean {
  const t = line.trim();
  if (state.inBlock) {
    if (t.includes("*/")) state.inBlock = false;
    return true;
  }
  if (t.startsWith("//")) return true;
  if (t.startsWith("/*") || t.startsWith("{/*")) {
    if (!t.includes("*/")) state.inBlock = true;
    return true;
  }
  return false;
}

export function countCommentBlocks(src: string, min = COMMENT_BLOCK_MIN): number {
  const state = { inBlock: false };
  let run = 0;
  let blocks = 0;
  const flush = () => {
    if (run >= min) blocks++;
    run = 0;
  };
  for (const line of src.split("\n")) {
    const wasInBlock = state.inBlock;
    const isC = isCommentLine(line, state);
    const indented = /^\s{2,}/.test(line) || (wasInBlock && run > 0);
    if (isC && indented) run++;
    else if (line.trim() === "" && run > 0) continue;
    else flush();
  }
  flush();
  return blocks;
}

export function measureComments(files: Files): RuleResult {
  let total = 0;
  const per: [string, number][] = [];
  for (const [f, src] of files) {
    if (!/^(src|web)\//.test(f)) continue;
    const n = countCommentBlocks(src);
    if (n) {
      total += n;
      per.push([f, n]);
    }
  }
  const detail = per.sort((a, b) => b[1] - a[1]).slice(0, 8).map(([f, n]) => `comments ${f}: ${n}`);
  return { counts: { "comments:blocks": total }, detail };
}
