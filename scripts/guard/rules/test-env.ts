// 测试起子进程的最小 env 必须经 tests/test-env.ts 的 testChildEnv（T45）：手写的 `env: { PATH, HOME }` 丢了测试标记，
// 子进程里 lib/test-guard.ts 的闸就不生效，漏配 BRIDGE_URL 会回落到线上 3847。只有展开继承（`...process.env`）或整个
// 传 process.env 的不算——`{ PATH: process.env.PATH }` 照样是手写最小 env。
// 边界（源码扫描做不到的，靠 lib 里的闸兜底）：选项先放进变量再传、env 来自函数返回值 / Object.assign、
// .mts / .cts 文件（guard 不收集）。别名导入、从 Bun / child_process 解构、带引号的 "env" 键、Bun $ 的 .env() 认得。
import type { Files, RuleResult } from "../types.ts";
import { maskStrings } from "./lex.ts";

const SPAWN_NAMES = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"];
const SAFE_LITERAL = /testChildEnv\s*\(|\.\.\.\s*\(?\s*process\.env\b/;
const SAFE_VALUE = /^(?:testChildEnv\s*\(|process\.env\b)/;

/** open 位置的括号 / 花括号到与之配对的闭合处（含两端）；字符串已被遮罩，不会误配 */
function balanced(src: string, open: number): string {
  const pair: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const stack: string[] = [];
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (pair[c]) stack.push(pair[c]!);
    else if (c === stack.at(-1)) {
      stack.pop();
      if (!stack.length) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

/** 起子进程的函数在本文件里的别名：`import { spawnSync as run }`、`const { spawnSync: sp } = Bun / require(…) / await import(…)` */
function spawnAliases(src: string): string[] {
  const names = SPAWN_NAMES.join("|");
  const out = [...src.matchAll(new RegExp(String.raw`\b(?:${names})\s+as\s+([\w$]+)`, "g"))].map((m) => m[1]!);
  for (const d of src.matchAll(/\{([^{}]*)\}\s*=\s*(?:Bun\b|require\s*\(|(?:await\s+)?import\s*\()/g)) {
    for (const m of d[1]!.matchAll(new RegExp(String.raw`\b(?:${names})\s*:\s*([\w$]+)`, "g"))) out.push(m[1]!);
  }
  return out;
}

/**
 * env 的值安全吗：对象字面量要经 testChildEnv 或展开 process.env；标识符看同文件里对它的每一次赋值（声明时的 `= {}`
 * 占位之后在 beforeAll 里再赋也算）——有一次是不安全的非空字面量、或只有空字面量，就不安全；没找到赋值（参数等）放过。
 */
function envSafe(src: string, value: string): boolean {
  if (value.startsWith("{")) return SAFE_LITERAL.test(value);
  if (SAFE_VALUE.test(value)) return true;
  const id = /^[\w$]+/.exec(value)?.[0];
  if (!id) return true;
  const inits = [...src.matchAll(new RegExp(String.raw`(?<![\w$.])${id.replace(/\$/g, "\\$")}\s*(?::\s*[\w$<>, \[\]]+)?=(?![=>])\s*`, "g"))].map((m) => {
    const at = (m.index ?? 0) + m[0].length;
    return src[at] === "{" ? balanced(src, at) : src.slice(at, at + 80);
  });
  if (!inits.length) return true;
  const unsafeLiteral = (v: string) => v.startsWith("{") && !SAFE_LITERAL.test(v) && v.replace(/\s/g, "") !== "{}";
  return !inits.some(unsafeLiteral) && inits.some((v) => SAFE_LITERAL.test(v) || !v.startsWith("{"));
}

/** 一次 spawn 调用里的 env 选项的值（`env: X` 或简写 `env`）；没有 env 选项为 null */
function envValue(call: string): string | null {
  const m = /[{,]\s*env\s*(:\s*|(?=[,}]))/.exec(call);
  if (!m) return null;
  if (!m[1]) return "env";
  const at = m.index + m[0].length;
  return call[at] === "{" ? balanced(call, at) : call.slice(at, at + 80);
}

const lineOf = (src: string, at: number) => src.slice(0, at).split("\n").length;

export function measureTestEnv(files: Files): RuleResult {
  let n = 0;
  const detail: string[] = [];
  for (const [f, raw] of files) {
    if (!/^tests\/.*\.(?:ts|tsx|mjs)$/.test(f)) continue;
    // 字符串内容遮成 _，但 "env" / 'env' 这种键还原成同长度的 ` env `，带引号的键也认得
    const src = maskStrings(raw, true).replace(/(["'])___\1/g, (m, _q, at: number) => (raw.slice(at + 1, at + 4) === "env" ? " env " : m));
    const names = [...SPAWN_NAMES, ...spawnAliases(src)].map((s) => s.replace(/\$/g, "\\$")).join("|");
    const hits: number[] = [];
    for (const m of src.matchAll(new RegExp(String.raw`(?:\bBun\.spawn(?:Sync)?|(?<![\w$])(?:${names}))\s*\(`, "g"))) {
      const value = envValue(balanced(src, (m.index ?? 0) + m[0].length - 1));
      if (value !== null && !envSafe(src, value)) hits.push(m.index ?? 0);
    }
    // Bun 的 $`…`.env(X)
    for (const m of src.matchAll(/\.env\s*\(/g)) {
      const arg = balanced(src, (m.index ?? 0) + m[0].length - 1).slice(1, -1).trim();
      if (arg && !envSafe(src, arg)) hits.push(m.index ?? 0);
    }
    for (const at of hits) detail.push(`testenv ${f}:${lineOf(src, at)} 最小 env 没经 testChildEnv（tests/test-env.ts）`);
    n += hits.length;
  }
  return { counts: { "testenv:bare-spawn-env": n }, detail };
}
