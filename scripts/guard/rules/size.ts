// 文件行数（按文件棘轮）+ 单行长度（全仓总数）+ 文档字节（按文件）。
import { capFor, DOC_FILES, LONG_LINE } from "../config.ts";
import type { Counts, Files, RuleResult } from "../types.ts";

export function lineCount(text: string): number {
  if (text === "") return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

/** code: 代码文件集合；docs: 文档路径 → 内容（按 UTF-8 字节计）。 */
export function measureSize(code: Files, docs: Files): RuleResult {
  const counts: Counts = {};
  let longLines = 0;
  const perFile: [string, number][] = [];
  for (const [f, text] of code) {
    const n = lineCount(text);
    const key = `size:${f}`;
    if (n > capFor(key)) counts[key] = n;
    const ll = text.split("\n").filter((l) => l.length > LONG_LINE).length;
    if (ll) {
      longLines += ll;
      perFile.push([f, ll]);
    }
  }
  counts["longLine:total"] = longLines;
  for (const f of DOC_FILES) {
    const text = docs.get(f);
    if (text !== undefined) counts[`doc:${f}`] = Buffer.byteLength(text, "utf8");
  }
  const detail = perFile.sort((a, b) => b[1] - a[1]).slice(0, 8).map(([f, n]) => `longLine ${f}: ${n}`);
  return { counts, detail };
}
