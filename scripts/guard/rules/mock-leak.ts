// 测试里的 mock.module 对整个 bun test 进程生效、文件跑完也不撤（MOCKLEAK1）：同一 CI 分片里后跑的文件会拿到这份 mock。
// partial：工厂返回的对象字面量没有展开（`...x`），也没列全被 mock 模块的运行时导出（只缺 type / interface 不算）。
// live-ns：工厂体里经 X.foo 调，X 是同一模块的活命名空间（裸 `await import(同一路径)` / `import * as X`）——mock 会原地
// 改写它，等于 mock 调自己。被 mock 的模块只从 Files 里找；解析不到（变量路径、包名、node 内置）或目标有 `export * from`
// 时只认展开写法。边界：工厂返回的不是对象字面量（`() => real`）不判；导出名用正则认，`export const { a } = …` 认不出。
import { posix } from "path";
import { EXCLUDE } from "../config.ts";
import type { Files, RuleResult } from "../types.ts";
import { maskStrings } from "./lex.ts";

const TEST_FILE = /^tests\/.*\.(?:ts|tsx|mjs)$/;
const PAIR: Record<string, string> = { "(": ")", "{": "}", "[": "]" };

/** open 位置的括号到与之配对的闭合处的下标（字符串已遮罩） */
function closeOf(src: string, open: number): number {
  const stack: string[] = [];
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (PAIR[c]) stack.push(PAIR[c]!);
    else if (c === stack.at(-1)) {
      stack.pop();
      if (!stack.length) return i;
    }
  }
  return src.length - 1;
}

/** [from, to) 之间按顶层逗号切开，返回各段的 [起, 止) 下标 */
function splitTop(src: string, from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  let start = from;
  for (let i = from; i < to; i++) {
    const c = src[i]!;
    if (PAIR[c]) i = closeOf(src, i);
    else if (c === ",") {
      out.push([start, i]);
      start = i + 1;
    }
  }
  if (src.slice(start, to).trim()) out.push([start, to]);
  return out;
}

const STR_LIT = /^\s*(["'`])([^"'`$\\]*)\1\s*$/;

/**
 * 模块说明符参数（原文片段）解析成仓库相对路径的候选：字面量、`join(import.meta.dir, "<字面量>")`、
 * `new URL("<字面量>", import.meta.url)`（可带 .href / .pathname）。解析不到返回 null。
 */
function specCandidates(testFile: string, arg: string): string[] | null {
  const join = /^\s*join\s*\(\s*import\.meta\.dir\s*,\s*(["'`])([^"'`$\\]*)\1\s*\)\s*$/.exec(arg);
  const url = /^\s*new\s+URL\s*\(\s*(["'`])([^"'`$\\]*)\1\s*,\s*import\.meta\.url\s*\)\s*(?:\.\s*(?:href|pathname))?\s*$/.exec(arg);
  const lit = STR_LIT.exec(arg);
  const spec = join ? `./${join[2]}` : url ? url[2]! : lit ? lit[2]! : null;
  if (spec === null) return null;
  let base: string;
  if (spec.startsWith("@/")) base = `web/${spec.slice(2)}`;
  else if (spec.startsWith("./") || spec.startsWith("../")) base = posix.normalize(posix.join(posix.dirname(testFile), spec));
  else return null;
  const bare = base.replace(/\.js$/, "");
  const out = /\.(?:ts|tsx|mjs)$/.test(bare) ? [bare] : [];
  return [...out, `${bare}.ts`, `${bare}.tsx`, `${bare}/index.ts`, `${bare}/index.tsx`];
}

type Target = { kind: "excluded" } | { kind: "file"; path: string } | { kind: "unknown"; key: string };

function resolveTarget(files: Files, testFile: string, arg: string): Target {
  const cands = specCandidates(testFile, arg);
  for (const c of cands ?? []) {
    if (EXCLUDE.some((re) => re.test(c))) return { kind: "excluded" };
    if (files.has(c)) return { kind: "file", path: c };
  }
  return { kind: "unknown", key: arg.trim() };
}

const sameTarget = (a: Target, b: Target) =>
  a.kind === "file" ? b.kind === "file" && a.path === b.path : a.kind === "unknown" && b.kind === "unknown" && a.key === b.key;

/** 模块的运行时导出名；有 `export * from`（整体转出、列不全）返回 null */
function runtimeExports(raw: string): Set<string> | null {
  const src = maskStrings(raw, true);
  if (/\bexport\s*\*\s*from\b/.test(src)) return null;
  const names = new Set<string>();
  const decl = /\bexport\s+(?:default\b|(?:abstract\s+)?class\s+([\w$]+)|(?:async\s+)?function\s*\*?\s*([\w$]+)|(?:const\s+)?enum\s+([\w$]+)|(?:const|let|var)\s+([\w$]+))/g;
  for (const m of src.matchAll(decl)) names.add(m[1] ?? m[2] ?? m[3] ?? m[4] ?? "default");
  for (const m of src.matchAll(/\bexport\s*\*\s*as\s+([\w$]+)\s+from\b/g)) names.add(m[1]!);
  for (const m of src.matchAll(/\bexport\s*\{([^{}]*)\}/g)) {
    for (const part of m[1]!.split(",")) {
      const p = part.trim();
      if (!p || /^type\s/.test(p)) continue;
      const as = /\bas\s+([\w$]+)$/.exec(p);
      names.add(as ? as[1]! : /^[\w$]+/.exec(p)![0]);
    }
  }
  return names;
}

/** 工厂（第二个参数）返回的对象字面量 `{` 的下标；不是对象字面量返回 -1 */
function returnedObject(src: string, from: number, to: number): number {
  const body = /^\s*(?:async\s+)?(?:\([^)]*\)|[\w$]+)\s*(?::[^=]*)?=>\s*/.exec(src.slice(from, to));
  if (body) {
    const at = from + body[0].length;
    if (src[at] === "(") {
      const inner = at + /^\(\s*/.exec(src.slice(at))![0].length;
      return src[inner] === "{" ? inner : -1;
    }
    if (src[at] !== "{") return -1;
    return returnIn(src, at, closeOf(src, at));
  }
  const fn = /^\s*(?:async\s+)?function\b[^{]*\{/.exec(src.slice(from, to));
  return fn ? returnIn(src, from + fn[0].length - 1, closeOf(src, from + fn[0].length - 1)) : -1;
}

/** close 位置的 `)` / `]` 往回配对的开括号下标（字符串已遮罩） */
function openOf(src: string, close: number): number {
  const shut = src[close]!;
  const open = shut === "]" ? "[" : "(";
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (src[i] === shut) depth++;
    else if (src[i] === open && --depth === 0) return i;
  }
  return -1;
}

/** at 位置的 `{` 是函数体吗：`=> {`，或 `(…) {` / `(…): 返回类型 {` 且这对括号是函数签名的参数表（见 isSignature） */
function isFnBody(src: string, at: number): boolean {
  const before = src.slice(Math.max(0, at - 400), at);
  if (/=>\s*$/.test(before)) return true;
  const close = /\)\s*$/.test(before) ? at - before.length + before.trimEnd().length - 1 : returnTypeParen(src, at);
  if (close < 0) return false;
  const paren = openOf(src, close);
  return paren >= 0 && isSignature(src, paren);
}

const NOT_METHOD = /^(?:if|for|while|switch|catch|with|await|return|typeof|void|new|delete|in|of|case|yield)$/;
const MODIFIER = /(?:(?<![\w$#])(?:async|get|set|static|public|private|protected|readonly|override|abstract|accessor)\s+|\*\s*)$/;

/**
 * paren 位置的 `(` 是函数签名吗：前面是 `function [*] [名字]`，或处在成员位置（`{ , ; }` 或类体内换行之后，可带修饰词 / `*`）的
 * 方法名 / 计算键，可带泛型参数。`case f(): {`、`for await (…) {`、`a.b() {` 这类调用或语句不算。
 */
function isSignature(src: string, paren: number): boolean {
  let end = src.slice(0, paren).trimEnd().length;
  if (src[end - 1] === ">") end = typeParamsOpen(src, end - 1);
  if (end < 0) return false;
  end = src.slice(0, end).trimEnd().length;
  const head = src.slice(Math.max(0, end - 200), end);
  if (/(?:^|[^\w$.])function\s*(?:\*\s*)?(?:[\w$]+)?$/.test(head)) return true;
  let start = end - (/[\w$#]+$/.exec(head)?.[0] ?? "").length;
  if (src[end - 1] === "]") start = openOf(src, end - 1);
  else if (start === end || NOT_METHOD.test(src.slice(start, end))) return false;
  if (start < 0) return false;
  let rest = src.slice(Math.max(0, start - 200), start);
  for (let m = MODIFIER.exec(rest); m; m = MODIFIER.exec(rest)) rest = rest.slice(0, m.index);
  return /[{,;}]\s*$/.test(rest) || (/\n[ \t]*$/.test(rest) && inClassBody(src, paren)) || (start <= 200 && !rest.trim());
}

/** 换行只有在类的成员层才允许省略分号；switch 的 case 表达式也能换行，不能因此把调用当方法。 */
function inClassBody(src: string, at: number): boolean {
  const stack: number[] = [];
  for (let i = 0; i < at; i++) {
    const c = src[i]!;
    if (PAIR[c]) stack.push(i);
    else if (c === PAIR[src[stack.at(-1) ?? -1]!]) stack.pop();
  }
  const open = stack.at(-1);
  return open !== undefined && src[open] === "{" && /\bclass\b[^{};]*$/.test(src.slice(0, open));
}

/** gt 位置的 `>` 往回配对的泛型 `<` 下标（跳过 `=>`），配不上返回 -1 */
function typeParamsOpen(src: string, gt: number): number {
  let depth = 0;
  for (let i = gt; i >= Math.max(0, gt - 400); i--) {
    if (src[i] === ">" && src[i - 1] === "=") i--;
    else if (src[i] === ">") depth++;
    else if (src[i] === "<" && --depth === 0) return i;
  }
  return -1;
}

/** at 位置的 `{` 前面是 `) : 返回类型` 吗：往回跳过配平的括号到顶层 `:`，返回它前面 `)` 的下标，不是返回 -1 */
function returnTypeParen(src: string, at: number): number {
  let depth = 0;
  for (let i = at - 1; i >= Math.max(0, at - 400); i--) {
    const c = src[i]!;
    if (c === ">" && src[i - 1] === "=") i--;
    else if (c === ")" || c === "}" || c === "]" || c === ">") depth++;
    else if (c === "(" || c === "{" || c === "[" || c === "<") {
      if (--depth < 0) return -1;
    } else if (depth === 0 && (c === ";" || c === "," || c === "=")) return -1;
    else if (depth === 0 && c === ":") {
      const j = src.slice(0, i).trimEnd().length - 1;
      return src[j] === ")" ? j : -1;
    }
  }
  return -1;
}

/** 块 [open, close] 里属于本函数（跳过嵌套函数体）的第一个 `return {…}` / `return ({…})` 的 `{` 下标 */
function returnIn(src: string, open: number, close: number): number {
  for (let i = open + 1; i < close; i++) {
    if (src[i] === "{" && isFnBody(src, i)) i = closeOf(src, i);
    else if (src.startsWith("return", i) && !/[\w$.]/.test(src[i - 1]!) && !/[\w$]/.test(src[i + 6] ?? "")) {
      const m = /return\s*\(?\s*\{/y;
      m.lastIndex = i;
      if (m.exec(src)) return m.lastIndex - 1;
      i += 5;
    }
  }
  return -1;
}

/** 对象字面量的键；有展开返回 null（视为全导出） */
function objectKeys(src: string, raw: string, open: number): Set<string> | null {
  const keys = new Set<string>();
  for (const [a, b] of splitTop(src, open + 1, closeOf(src, open))) {
    const lead = a + (/^\s*/.exec(src.slice(a, b))![0].length);
    const part = src.slice(lead, b);
    if (part.startsWith("...")) return null;
    const quoted = /^(["'])[^"']*\1\s*[:(]/.exec(part);
    if (quoted) {
      keys.add(raw.slice(lead + 1, lead + quoted[0].indexOf(quoted[1]!, 1)));
      continue;
    }
    const m = /^(?:(?:get|set|async)\s+)?\*?\s*([\w$]+)\s*(?:[:(]|$)/.exec(part);
    if (m) keys.add(m[1]!);
  }
  return keys;
}

/** 同文件里 X 是 target 模块的活命名空间吗：`X = await import(<同一模块>)`（不是 `{ ...await import() }` 快照）或 `import * as X` */
function liveNamespace(files: Files, f: string, src: string, raw: string, id: string, target: Target): boolean {
  const esc = id.replace(/\$/g, "\\$");
  const assign = new RegExp(String.raw`(?<![\w$.])${esc}\s*(?::[^=;]+)?=(?![=>])\s*\(?\s*await\s+import\s*\(`, "g");
  for (const m of src.matchAll(assign)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const arg = raw.slice(open + 1, closeOf(src, open));
    if (sameTarget(resolveTarget(files, f, arg), target)) return true;
  }
  const star = new RegExp(String.raw`\bimport\s*\*\s*as\s+${esc}\s+from\s*(["'])`, "g");
  for (const m of src.matchAll(star)) {
    const q = (m.index ?? 0) + m[0].length - 1;
    const end = raw.indexOf(m[1]!, q + 1);
    if (sameTarget(resolveTarget(files, f, raw.slice(q, end + 1)), target)) return true;
  }
  return false;
}

/** 工厂体里经成员访问用到的标识符（`X.foo` / `X?.foo`，不含 `a.X.foo` 与 `...X`） */
function memberRoots(src: string, from: number, to: number): Set<string> {
  const out = new Set<string>();
  for (const m of src.slice(from, to).matchAll(/(?<![\w$.])([\w$]+)\s*\??\.\s*[\w$]/g)) out.add(m[1]!);
  return out;
}

const lineOf = (src: string, at: number) => src.slice(0, at).split("\n").length;

function checkCall(files: Files, f: string, src: string, raw: string, open: number, detail: string[]): [number, number] {
  const args = splitTop(src, open + 1, closeOf(src, open));
  if (args.length < 2) return [0, 0];
  const specArg = raw.slice(...args[0]!);
  const target = resolveTarget(files, f, specArg);
  if (target.kind === "excluded") return [0, 0];
  const where = `${f}:${lineOf(src, open)}`;
  const [fa, fb] = args[1]!;
  let partial = 0;
  const obj = returnedObject(src, fa, fb);
  const keys = obj < 0 ? null : objectKeys(src, raw, obj);
  if (keys) {
    const exp = target.kind === "file" ? runtimeExports(files.get(target.path)!) : null;
    const missing = exp ? [...exp].filter((n) => !keys.has(n)) : null;
    const spec = specArg.trim();
    if (!missing) detail.push(`mockleak ${where} ${spec} 列不出全部导出（解析不到或有 export * from）：工厂里要展开真实模块快照`);
    else if (missing.length) {
      const shown = missing.slice(0, 6).join(", ") + (missing.length > 6 ? "..." : "");
      detail.push(`mockleak ${where} ${spec} 缺 ${missing.length} 个导出:${shown}`);
    }
    partial = !missing || missing.length ? 1 : 0;
  }
  let live = 0;
  for (const id of memberRoots(src, fa, fb)) {
    if (!liveNamespace(files, f, src, raw, id, target)) continue;
    detail.push(`mockleak ${where} 经活命名空间 ${id} 调自己`);
    live++;
  }
  return [partial, live];
}

export function measureMockLeak(files: Files): RuleResult {
  let partial = 0;
  let live = 0;
  const detail: string[] = [];
  for (const [f, raw] of files) {
    if (!TEST_FILE.test(f)) continue;
    const src = maskStrings(raw, true);
    for (const m of src.matchAll(/(?<![\w$.])mock\s*\.\s*module\s*\(/g)) {
      const [p, l] = checkCall(files, f, src, raw, (m.index ?? 0) + m[0].length - 1, detail);
      partial += p;
      live += l;
    }
  }
  return { counts: { "mockleak:partial": partial, "mockleak:live-ns": live }, detail };
}
