// 绕过规范 helper 的写法 + 无声吞错 + web 路由鉴权。全部按全仓总数棘轮（搬代码不受影响）。
import { CATCH_COMMENT_MIN, PATTERNS, PLACEHOLDER_COMMENTS, PUBLIC_ROUTES, type PatternDef } from "../config.ts";
import type { Counts, Files, RuleResult } from "../types.ts";
import { stripComments } from "./strip.ts";

/** 只看生产代码：tests 和 guard 自己的 fixture/正则不算。 */
const productionFile = (f: string) => /^(src|web)\//.test(f) && /\.(ts|tsx|mjs)$/.test(f);

const EMPTY_CATCH = /catch\s*(?:\(\s*\w*\s*(?::\s*\w+)?\s*\))?\s*\{([^{}]*)\}/g;
const PROMISE_CATCH = /\.catch\(\s*(?:\(\s*\w*\s*(?::\s*\w+)?\s*\)|\w+)\s*=>\s*(?:\{([^{}]*)\}|undefined|null|void 0)\s*\)/g;

/** 注释是否真的说明了「为什么丢了也没事」：去标点后 ≥6 字，且不是占位词。 */
export function commentExplains(comment: string): boolean {
  const norm = comment
    .replace(/\/\*|\*\/|\/\//g, "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
  if (!norm || PLACEHOLDER_COMMENTS.has(norm)) return false;
  return [...norm].length >= CATCH_COMMENT_MIN;
}

const commentsIn = (s: string) => (s.match(/\/\*[\s\S]*?\*\/|\/\/.*$/gm) ?? []).join(" ");

/** 匹配之后同一行的尾注释（`.catch(() => {}); // 为什么`）。 */
function trailingComment(src: string, end: number): string {
  const eol = src.indexOf("\n", end);
  const rest = src.slice(end, eol < 0 ? undefined : eol);
  const m = rest.match(/\/\/.*$|\/\*.*?\*\//);
  return m ? m[0] : "";
}

function countSilent(src: string, re: RegExp): number {
  let n = 0;
  for (const m of src.matchAll(re)) {
    const body = m[1] ?? "";
    if (stripComments(body).trim() !== "") continue;
    const why = `${commentsIn(body)} ${trailingComment(src, (m.index ?? 0) + m[0].length)}`;
    if (!commentExplains(why)) n++;
  }
  return n;
}

function countPattern(p: PatternDef, f: string, src: string): number {
  if (p.allow.test(f)) return 0;
  return (stripComments(src).match(p.re) ?? []).length;
}

export function measurePatterns(files: Files, patterns: PatternDef[] = PATTERNS): RuleResult {
  const counts: Counts = { "catch:empty-block": 0, "catch:silent-promise": 0 };
  for (const p of patterns) counts[`pattern:${p.id}`] = 0;
  const perFile = new Map<string, number>();
  for (const [f, src] of files) {
    if (!productionFile(f)) continue;
    for (const p of patterns) counts[`pattern:${p.id}`] += countPattern(p, f, src);
    const e = countSilent(src, EMPTY_CATCH);
    const s = countSilent(src, PROMISE_CATCH);
    counts["catch:empty-block"] += e;
    counts["catch:silent-promise"] += s;
    if (e + s) perFile.set(f, e + s);
    if (/^web\/app\/api\/.+\/route\.ts$/.test(f) && !PUBLIC_ROUTES.includes(f) && !/\bisAuthed\b/.test(src)) {
      counts[`route:${f}`] = 1;
    }
  }
  const detail = [...perFile].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([f, n]) => `catch ${f}: ${n}`);
  return { counts, detail };
}
