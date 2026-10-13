// 效果点清单原文的计数改写（纯函数），从 scripts/skip-effects.ts 原样搬来：脚本入口和调度器进程内的计数刷新
// （effect-count-refresh-git.ts，PR 树只当数据读、不执行）共用这一份。tests/skip-effects.test.ts。
import { ENTRY, inventoryLines, isEntryLine, parseInventory } from "./skip-effects-auto-scope-scan.js";

/** 折行上限，和 guard 的 LONG_LINE 一致。 */
const MAX_LINE = 200;

export type SkipEffectsRewrite = {
  text: string;
  changed: { file: string; from: string; to: string }[];
  removed: { file: string; was: string }[];
  unregistered: { file: string; sites: string }[];
  /** 改了或删了的文件在清单 `//` 注释里被提到的行（1 起），注释不自动改，只提醒人工核。 */
  comments: { file: string; line: number }[];
};

const isComment = (l: string) => l.trimStart().startsWith("//");

/** 超过 MAX_LINE 的条目行在条目之间折开，缩进和原行一样。 */
function fold(indent: string, entries: string[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const last = out.length ? out[out.length - 1]! : null;
    if (last !== null && `${last} ${e}`.length <= MAX_LINE) out[out.length - 1] = `${last} ${e}`;
    else out.push(`${indent}${e}`);
  }
  return out;
}

/** 纯函数：清单原文 + 扫描结果 → 新原文和改了 / 删了 / 未登记的表。组、顺序、注释和其余字节都不动。 */
export function rewriteInventory(text: string, scan: Map<string, string>): SkipEffectsRewrite {
  const lines = text.split("\n"), { start, end } = inventoryLines(lines), registered = parseInventory(text);
  const changed: SkipEffectsRewrite["changed"] = [], removed: SkipEffectsRewrite["removed"] = [];
  const body: string[] = [];
  for (const l of lines.slice(start, end)) {
    if (!isEntryLine(l)) { body.push(l); continue; }
    // 行尾 \r 单独留着，改写后原样接回，CRLF 原文不变成混合换行。
    const eol = l.endsWith("\r") ? "\r" : "", src = eol ? l.slice(0, -1) : l;
    let touched = false, cut = false;
    const replaced = src.replace(ENTRY, (all, file: string, was: string, space: string) => {
      const now = scan.get(file);
      if (now === undefined) { removed.push({ file, was }); touched = cut = true; return ""; }
      if (now === was) return all;
      changed.push({ file, from: was, to: now }); touched = true;
      return `"${file}": "${now}",${space}`;
    });
    // 只换计数时行尾字节原样保留；删了条目才收掉留下的尾空白。
    const next = cut ? replaced.trimEnd() : replaced;
    if (!touched) body.push(l);
    else if (next.trim() && next.length <= MAX_LINE) body.push(next + eol);
    else if (next.trim()) body.push(...fold(/^\s*/.exec(next)![0], [...next.matchAll(ENTRY)].map((m) => m[0].trimEnd())).map((f) => f + eol));
  }
  const unregistered = [...scan].filter(([f]) => !registered.has(f)).sort(([a], [b]) => a.localeCompare(b)).map(([file, sites]) => ({ file, sites }));
  const touchedFiles = [...changed, ...removed].map((c) => c.file);
  const comments = touchedFiles.flatMap((file) => {
    const word = new RegExp(`(?<![\\w.-])${file.replace(/\.ts$/, "").replace(/[.-]/g, "\\$&")}(?![\\w-])`);
    return lines.map((l, i) => ({ l, i })).filter(({ l, i }) => i >= start && i < end && isComment(l) && word.test(l)).map(({ i }) => ({ file, line: i + 1 }));
  });
  return { text: [...lines.slice(0, start), ...body, ...lines.slice(end)].join("\n"), changed, removed, unregistered, comments };
}
