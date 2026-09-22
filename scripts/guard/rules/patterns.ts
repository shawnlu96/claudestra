// 绕过规范 helper 的写法 + 无声吞错 + web 路由鉴权。全部按全仓总数棘轮（搬代码不受影响）。
import {
  CATCH_COMMENT_MIN, PATTERNS, PLACEHOLDER_CJK, PLACEHOLDER_PREFIXES, PLACEHOLDER_WORDS, PUBLIC_ROUTES, type PatternDef,
} from "../config.ts";
import type { Counts, Files, RuleResult } from "../types.ts";
import { maskStrings } from "./lex.ts";
import { stripComments } from "./strip.ts";

/** 只看生产代码：tests 和 guard 自己的 fixture/正则不算。 */
const productionFile = (f: string) => /^(src|web)\//.test(f) && /\.(ts|tsx|mjs)$/.test(f);

// 在遮罩了字符串的文本上匹配：字符串里的 "catch {}" 不算；字符串常量遮罩后是 "___"。
const EMPTY_CATCH = /catch\s*(?:\(\s*[\w$]*\s*(?::\s*\w+)?\s*\))?\s*\{([^{}]*)\}/g;
const CONST_VALUE = String.raw`undefined|null|void\s+0|true|false|-?\d+|"_*"|'_*'|\x60_*\x60|\[\s*\]|\(\s*\{\s*\}\s*\)`;
const PROMISE_CATCH = new RegExp(
  String.raw`\.catch\(\s*(?:async\s+)?(?:(?:\([^()]*\)|[\w$]+)\s*=>\s*(?:\{([^{}]*)\}|(?:${CONST_VALUE}))` +
    String.raw`|function\s*[\w$]*\s*\([^()]*\)\s*\{([^{}]*)\}|(?:noop|nop|ignore\w*|swallow\w*|[\w$]*Noop))\s*\)`,
  "g",
);

/** catch 体里只有无副作用的表达式语句（空、`;`、`void 0`、单个标识符或字面量）= 空块。 */
const INERT_STMT = /^(?:void\s+[\w$.]+|[\w$.]+|(["'`])_*\1)?$/;
const CONTROL_FLOW = /^(return|break|continue|throw|debugger)$/;
function inertBody(body: string): boolean {
  return stripComments(body)
    .split(/[;\n]/)
    .map((s) => s.trim())
    .every((s) => INERT_STMT.test(s) && !CONTROL_FLOW.test(s));
}

/** 注释是否真的说明了「为什么丢了也没事」：去掉占位词、标点、空白后 ≥6 字。 */
export function commentExplains(comment: string): boolean {
  const words = comment.replace(/\/\*|\*\/|\/\//g, " ").toLowerCase().split(/[^\p{L}\p{N}]+/u);
  let kept = "";
  for (const w of words) {
    if (!w || PLACEHOLDER_WORDS.has(w) || PLACEHOLDER_PREFIXES.some((p) => w.startsWith(p))) continue;
    kept += PLACEHOLDER_CJK.reduce((acc, p) => acc.split(p).join(""), w);
  }
  return [...kept].length >= CATCH_COMMENT_MIN;
}

const commentsIn = (s: string) => (s.match(/\/\*[\s\S]*?\*\/|\/\/.*$/gm) ?? []).join(" ");

/** 匹配之后同一行的尾注释（`.catch(() => {}); // 为什么`）。 */
function trailingComment(src: string, end: number): string {
  const eol = src.indexOf("\n", end);
  const rest = src.slice(end, eol < 0 ? undefined : eol);
  const m = rest.match(/\/\/.*$|\/\*.*?\*\//);
  return m ? m[0] : "";
}

function countSilent(masked: string, re: RegExp): number {
  let n = 0;
  for (const m of masked.matchAll(re)) {
    const body = m[1] ?? m[2] ?? "";
    if (!inertBody(body)) continue;
    const why = `${commentsIn(body)} ${trailingComment(masked, (m.index ?? 0) + m[0].length)}`;
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
    const masked = maskStrings(src);
    const e = countSilent(masked, EMPTY_CATCH);
    const s = countSilent(masked, PROMISE_CATCH);
    counts["catch:empty-block"] += e;
    counts["catch:silent-promise"] += s;
    if (e + s) perFile.set(f, e + s);
    // 鉴权要么直接调 isAuthed，要么走 web/lib/bff 的包装（authed / authedLegacy / withAuth / proxyGet / proxyPost / agentAction 内部都先验 isAuthed）
    const viaBff = /from\s+["']@\/lib\/bff["']/.test(src) && /\b(authed|authedLegacy|withAuth|proxyGet|proxyPost|agentAction)\s*\(/.test(src);
    if (/^web\/app\/api\/.+\/route\.ts$/.test(f) && !PUBLIC_ROUTES.includes(f) && !/\bisAuthed\b/.test(src) && !viaBff) {
      counts[`route:${f}`] = 1;
    }
  }
  const detail = [...perFile].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([f, n]) => `catch ${f}: ${n}`);
  return { counts, detail };
}
