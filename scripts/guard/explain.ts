// 失败时指出新违规在哪：对改过的文件，单独量「当前版本」和「比较基准版本」，只打印变多的项。
// 全仓总量类规则（catch / fn:overflow / comments / longLine）的失败明细靠它落到具体文件上；
// dup 是跨文件的，只能给出改过的文件当前有多少行与别处重复。
import { prefixOf } from "./config.ts";
import { measureComments } from "./rules/comments.ts";
import { measureFn, type SpanParser } from "./rules/fn.ts";
import { measurePatterns } from "./rules/patterns.ts";
import { measureSize } from "./rules/size.ts";
import type { Counts } from "./types.ts";

/** 只看一个文件时能算出来的计数（size / longLine / catch / pattern / comments / fn）。 */
function localCounts(file: string, text: string, parse: SpanParser | null): Counts {
  const one = new Map([[file, text]]);
  const out: Counts = {
    ...measureSize(one, new Map()).counts,
    ...measurePatterns(one).counts,
    ...measureComments(one).counts,
  };
  if (parse) Object.assign(out, measureFn(one, parse).counts);
  return out;
}

export interface ChangedFile {
  file: string;
  cur: string;
  /** 比较基准里的内容；新文件为 null。 */
  base: string | null;
}

/** 改过的文件里，属于失败规则、且比基准版本变多的计数，一行一个文件。 */
export function explainChanged(
  changed: ChangedFile[],
  failed: Set<string>,
  parse: SpanParser | null,
  dupPerFile: Record<string, number> = {},
): string[] {
  const out: string[] = [];
  for (const c of changed) {
    const cur = localCounts(c.file, c.cur, parse);
    const prev = c.base === null ? {} : localCounts(c.file, c.base, parse);
    const ups = Object.entries(cur)
      .filter(([k, v]) => failed.has(prefixOf(k)) && v > (prev[k] ?? 0))
      .map(([k, v]) => `${k.replace(`:${c.file}`, "")} ${prev[k] ?? (c.base === null ? "新文件" : "—")} → ${v}`);
    if (failed.has("dup") && dupPerFile[c.file]) ups.push(`dup ${dupPerFile[c.file]} 行与别处重复`);
    if (ups.length) out.push(`${c.file}: ${ups.join("，")}`);
  }
  return out;
}
