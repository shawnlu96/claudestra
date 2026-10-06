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
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key（39 位，够不上上面 40 位那条）
];
/** 认证头：值是「方案 + 凭据」，方案留着（看得出是 Basic 还是 Bearer），凭据遮到行尾 / 引号（Digest 的参数带逗号）；KV 规则遇空格就停，会漏在方案后面 */
const AUTH_HEADER_RE = /\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?)((?:basic|bearer|digest|token|negotiate|ntlm)\s+)?[^\n"']+/gi;
/** URL 里的账号密码（scheme://user:pass@host）、curl 的 -u / --user user:pass、查询串里常放凭据的参数 */
const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const USER_FLAG_RE = /(\s(?:-u|--user)[\s=]+)[^\s:]+:\S+/g;
const QUERY_SECRET_RE = /([?&](?:key|sig|signature|code|auth)=)[^&\s#"']+/gi;
const BEARER_RE = /\b(bearer|token)\s+[A-Za-z0-9._~+/-]{12,}=*/gi;
const SECRET_KEY = String.raw`\b([\w-]*(?:token|secret|password|passwd|passphrase|[_-]pwd\b|credentials?|cookie|api[_-]?key|access[_-]?key|private[_-]?key)[\w-]*)`;
/** 引号括起来的值整段遮（值里可以有空格），引号到行尾都没闭合就遮到行尾（被截断的行）；没引号的值遇空白 / 分隔符为止 */
const KV_QUOTED_RE = new RegExp(String.raw`${SECRET_KEY}(["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|["'][^\n]*(?=\n|$))`, "gi");
const KV_SECRET_RE = new RegExp(String.raw`${SECRET_KEY}(["']?\s*[:=]\s*["']?)[^\s"',;&]{4,}`, "gi");

/** 把文本里像密钥的片段换成 [redacted]；先整段脱敏再截断，截断不会把半个密钥留下 */
export function redactSecrets(s: string): string {
  let out = s.replace(AUTH_HEADER_RE, "$1$2[redacted]").replace(URL_USERINFO_RE, "$1[redacted]@").replace(USER_FLAG_RE, "$1[redacted]")
    .replace(QUERY_SECRET_RE, "$1[redacted]");
  out = out.replace(KV_QUOTED_RE, '$1$2"[redacted]"').replace(KV_SECRET_RE, "$1$2[redacted]").replace(BEARER_RE, "$1 [redacted]");
  for (const re of SECRET_RES) out = out.replace(re, "[redacted]");
  return out;
}
