// 测试起子进程的最小 env 必须经 tests/test-env.ts 的 testChildEnv（T45）：手写的 `env: { PATH, HOME }` 丢了测试标记，
// 子进程里 lib/test-guard.ts 的闸就不生效，漏配 BRIDGE_URL 会回落到线上 3847。继承当前环境（带 ...process.env）的不算。
import type { Files, RuleResult } from "../types.ts";
import { maskStrings } from "./lex.ts";

const SPAWN_CALL = /\b(?:Bun\.spawn(?:Sync)?|spawn(?:Sync)?|execFile(?:Sync)?|execSync|fork)\s*\(/g;
const SAFE_ENV = /testChildEnv\s*\(|process\.env\b/;

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

/**
 * env 的值安全吗：对象字面量要含 testChildEnv / process.env；标识符看同文件里对它的每一次赋值（声明时的 `= {}` 占位
 * 之后在 beforeAll 里再赋也算）——有一次是非空的不安全字面量、或只有空字面量，就不安全；没找到赋值（参数等）放过。
 */
function envSafe(src: string, value: string): boolean {
  if (value.startsWith("{")) return SAFE_ENV.test(value);
  if (SAFE_ENV.test(value)) return true;
  const id = /^[\w$]+/.exec(value)?.[0];
  if (!id) return true;
  const inits = [...src.matchAll(new RegExp(String.raw`(?<![\w$.])${id}\s*(?::\s*[\w$<>, \[\]]+)?=(?![=>])\s*`, "g"))].map((m) => {
    const at = (m.index ?? 0) + m[0].length;
    return src[at] === "{" ? balanced(src, at) : src.slice(at, at + 80);
  });
  if (!inits.length) return true;
  const unsafeLiteral = (v: string) => v.startsWith("{") && !SAFE_ENV.test(v) && v.replace(/\s/g, "") !== "{}";
  return !inits.some(unsafeLiteral) && inits.some((v) => SAFE_ENV.test(v) || !v.startsWith("{"));
}

/** 一次 spawn 调用里的 env 选项的值（`env: X` 或简写 `env`）；没有 env 选项为 null */
function envValue(call: string): string | null {
  const m = /[{,]\s*env\s*(:\s*|(?=[,}]))/.exec(call);
  if (!m) return null;
  if (!m[1]) return "env";
  const at = m.index + m[0].length;
  return call[at] === "{" ? balanced(call, at) : call.slice(at, at + 80);
}

export function measureTestEnv(files: Files): RuleResult {
  let n = 0;
  const detail: string[] = [];
  for (const [f, raw] of files) {
    if (!/^tests\/.*\.ts$/.test(f)) continue;
    const src = maskStrings(raw, true);
    for (const m of src.matchAll(SPAWN_CALL)) {
      const call = balanced(src, (m.index ?? 0) + m[0].length - 1);
      const value = envValue(call);
      if (value === null || envSafe(src, value)) continue;
      n++;
      detail.push(`testenv ${f}:${src.slice(0, m.index).split("\n").length} 最小 env 没经 testChildEnv（tests/test-env.ts）`);
    }
  }
  return { counts: { "testenv:bare-spawn-env": n }, detail };
}
