/**
 * 文本里像密钥的片段换成 [redacted]（已知形态的 token + 「key=值」里名字像密钥的值）。不依赖别的模块：
 * Pi 的 ACP 适配器进程也用它给扩展通知脱敏，从 usage-classify 引会经 session-history 绕出依赖环。tests/usage-classify.test.ts。
 */
/** 已知形态的密钥 / token，以及「key=值」里名字像密钥的值 */
const SECRET_RES: RegExp[] = [
  // 标准 Base64 字母表（含 + /）的 40 位以上串，大小写和数字都有：AWS secret access key 等。仓库路径大多带 - 或 .，碰不上
  /(?<![A-Za-z0-9+/])(?=[A-Za-z0-9+/]*[0-9])(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[A-Z])[A-Za-z0-9+/]{40,}=*/g,
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g,
  /\b[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27,}/g,
  /\b[a-f0-9]{32,}\b/gi,
  /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}/g,
];
const BEARER_RE = /\b(bearer|token)\s+[A-Za-z0-9._~+/-]{12,}=*/gi;
const SECRET_KEY = String.raw`\b([\w-]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key)[\w-]*)`;
/** 引号括起来的值整段遮（值里可以有空格）；没引号的值遇空白 / 分隔符为止 */
const KV_QUOTED_RE = new RegExp(String.raw`${SECRET_KEY}(["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*')`, "gi");
const KV_SECRET_RE = new RegExp(String.raw`${SECRET_KEY}(["']?\s*[:=]\s*["']?)[^\s"',;&]{4,}`, "gi");

/** 把文本里像密钥的片段换成 [redacted]；先整段脱敏再截断，截断不会把半个密钥留下 */
export function redactSecrets(s: string): string {
  let out = s.replace(KV_QUOTED_RE, '$1$2"[redacted]"').replace(KV_SECRET_RE, "$1$2[redacted]").replace(BEARER_RE, "$1 [redacted]");
  for (const re of SECRET_RES) out = out.replace(re, "[redacted]");
  return out;
}
