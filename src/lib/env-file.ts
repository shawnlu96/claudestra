/**
 * setup 写 .env 时的合并（纯函数，tests/env-file.test.ts）。
 *
 * 向导只管得了自己问的那几项；用户手加的 MASTER_DIR / BRIDGE_BIND / BRIDGE_CONTROL_TOKEN
 * 和注释，整份重写会在每次重跑时悄悄丢掉。所以在原文件上就地改：
 * - 向导管的键：值没变的那一行原样保留（一路回车重跑 → 文件逐字节不变），变了才改写；
 * - 原文件里没有的键追加在末尾；
 * - 其它行（未知键、注释、空行）一律不动。
 */

const KEY_LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

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
