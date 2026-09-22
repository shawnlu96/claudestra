// 双份文件一致性：去注释后逐行一致，否则每对不一致记 1。
import { TWINS } from "../config.ts";
import type { Counts, Files, RuleResult } from "../types.ts";
import { codeLines } from "./strip.ts";

export function measureTwins(files: Files, twins: [string, string][] = TWINS): RuleResult {
  const counts: Counts = {};
  const detail: string[] = [];
  for (const [a, b] of twins) {
    const key = `twins:${a} <-> ${b}`;
    const ta = files.get(a);
    const tb = files.get(b);
    if (ta === undefined || tb === undefined) {
      counts[key] = 1;
      detail.push(`twin 缺了一份：${ta === undefined ? a : b}`);
      continue;
    }
    const la = codeLines(ta);
    const lb = codeLines(tb);
    const i = la.findIndex((l, k) => l !== lb[k]);
    if (i >= 0 || la.length !== lb.length) {
      counts[key] = 1;
      const at = i >= 0 ? i + 1 : Math.min(la.length, lb.length) + 1;
      detail.push(`twin 第 ${at} 条有效行起不一致：${a} / ${b}`);
    }
  }
  return { counts, detail };
}
