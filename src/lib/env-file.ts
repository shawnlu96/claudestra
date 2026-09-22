/**
 * setup 写 .env 时的合并（纯函数，tests/env-file.test.ts）。
 *
 * 向导只管得了自己问的那几项；用户手加的 MASTER_DIR / BRIDGE_BIND / BRIDGE_CONTROL_TOKEN
 * 和注释，整份重写会在每次重跑时悄悄丢掉。所以在原文件上就地改：
 * - 向导管的键：值没变的那一行原样保留（一路回车重跑 → 文件逐字节不变），变了才改写；
 * - 原文件里没有的键追加在末尾；
 * - 其它行（未知键、注释、空行）一律不动。
 */

import { readFileSync } from "fs";
import { REPO_ROOT } from "./repo-root.js";

const KEY_LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

// ── 读 .env（2026-09 审查 D7-8 / D6-11）──────────────────────────────────────
// 之前 doctor / cli-install / manager / setup 各写了一个正则，口径各不相同：
// `BRIDGE_PORT="13847"` 会被 Bun 正确解析（bridge 真在 13847 上），doctor 的 `(\d+)`
// 却匹配不上，于是按 3847 去探、给出错误的 kickstart 建议。

/**
 * 与 Bun 的 .env 加载口径对齐的解析（bun 1.3.14 实测，用例见 tests/env-file.test.ts）：
 * - `export ` 前缀、空值、键名含数字；
 * - 未加引号的值：第一个 `#` 起都是注释（`p#q` → `p`，不要求 `#` 前有空格），再去首尾空白；
 * - 单/双/反引号：闭合引号 = 其后只剩空白或注释的那个同类引号，可以落在后面的行上（多行值）；
 *   找不到这样的闭合引号 → 按未加引号处理（`"a"b` → `"a"b`，`"noclose` → `"noclose`）；
 * - 双引号里只有 `\n` 转成换行，其余反斜杠原样保留（`\t`、`\"` 都不转义）。
 * 不做 `${VAR}` 展开。
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  for (let i = 0; i < lines.length; i++) {
    const m = KEY_LINE_RE.exec(lines[i]!);
    if (!m) continue;
    let v = m[2]!.replace(/^[ \t]+/, "");
    const q = v[0];
    if (q === '"' || q === "'" || q === "`") {
      const rest = [v.slice(1), ...lines.slice(i + 1)].join("\n");
      const close = new RegExp(`${q}[ \\t]*(?:#[^\\n]*)?(?:\\n|$)`).exec(rest);
      if (close) {
        const body = rest.slice(0, close.index);
        i += body.split("\n").length - 1; // 多行值吃掉的后续行
        out[m[1]!] = q === '"' ? body.replace(/\\n/g, "\n") : body;
        continue;
      }
    }
    const hash = v.indexOf("#");
    if (hash >= 0) v = v.slice(0, hash);
    out[m[1]!] = v.trim();
  }
  return out;
}

/**
 * setup 向导读 .env 的口径：`KEY=` 后的**原文**（不去引号、不去空白）。mergeEnvContent
 * 按原文比对「值变没变」，这里若去了引号，一路回车重跑就会把带引号的行改写掉。
 */
export function parseEnvRaw(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/** 读并解析一个 .env；文件不存在 / 读不了返回 null（调用方决定「没配过」怎么处理） */
export function readDotenvFileSync(path: string): Record<string, string> | null {
  try {
    return parseDotenv(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * 安装级变量（BRIDGE_PORT / BRIDGE_BIND / USER_NAME / MASTER_DIR …）：先看 process.env，
 * 没有再读仓库根的 .env。Bun 只自动加载 **cwd** 的 .env，而 manager 常被大总管从
 * ~/.claude-orchestrator/master 之类的目录调起；tmux 全局环境又停在 server 创建那一刻、
 * 缺了后来加的键——直接读 process.env 会拿到默认值（D7-3：master 跑 peer-invite-new
 * 报「bridge 只监听 127.0.0.1」而 bridge 实际在 *:3847）。
 * doctor 不用它：doctor 要看的是 daemon 实际拿到的文件内容，终端 export 的值不该掩盖它。
 */
export function repoEnvVar(key: string, repoRoot = REPO_ROOT, env: Record<string, string | undefined> = process.env): string {
  if (env[key]) return env[key]!;
  return readDotenvFileSync(`${repoRoot}/.env`)?.[key] || "";
}

export function mergeEnvContent(
  existing: string | null,
  updates: Record<string, string>,
  headerComment: string,
): string {
  if (existing === null || existing.trim() === "") {
    return [headerComment, ...Object.entries(updates).map(([k, v]) => `${k}=${v}`), ""].join("\n");
  }
  const lines = existing.split("\n");
  const seen = new Set<string>();
  const out = lines.map((line) => {
    const m = KEY_LINE_RE.exec(line);
    if (!m || !(m[1] in updates)) return line;
    const key = m[1];
    seen.add(key);
    // setup 的 parseEnv 取的是 `=` 后的原文，这里同样按原文比，保证没改就逐字节不变
    return m[2] === updates[key] ? line : `${key}=${updates[key]}`;
  });
  const missing = Object.entries(updates).filter(([k]) => !seen.has(k));
  if (!missing.length) return out.join("\n");
  // 追加前保证原文末尾有换行，且不在末尾多出一个空行
  while (out.length && out[out.length - 1] === "") out.pop();
  return [...out, ...missing.map(([k, v]) => `${k}=${v}`), ""].join("\n");
}
