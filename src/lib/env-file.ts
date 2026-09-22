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

const KEY_LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

// ── 读 .env（2026-09 审查 D7-8 / D6-11）──────────────────────────────────────
// 之前 doctor / cli-install / manager / setup 各写了一个正则，口径各不相同：
// `BRIDGE_PORT="13847"` 会被 Bun 正确解析（bridge 真在 13847 上），doctor 的 `(\d+)`
// 却匹配不上，于是按 3847 去探、给出错误的 kickstart 建议。

/**
 * 与 Bun 的 .env 加载口径对齐的解析：`export ` 前缀、成对的单/双引号、未加引号值的
 * 行内注释（` #` 之后）、空值、键名含数字。不做 `${VAR}` 展开。
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = KEY_LINE_RE.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    const q = v[0];
    if (q === '"' || q === "'") {
      // 取到下一个同类引号为止（后面可能跟着注释）；没闭合就去掉开引号
      const end = v.indexOf(q, 1);
      v = end > 0 ? v.slice(1, end) : v.slice(1);
    } else {
      const hash = v.search(/(^|\s)#/);
      if (hash >= 0) v = v.slice(0, hash).trimEnd();
    }
    out[m[1]!] = v;
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
export function repoEnvVar(key: string, repoRoot: string, env: Record<string, string | undefined> = process.env): string {
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
