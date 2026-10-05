/**
 * 发往 peer 的派单最后一道（T48 方案 D）：在拼好的最终正文上判，命中任何一条，dispatch-order.ts 就不发参考资料原文、退成只发引用。
 * 行级脱敏（redact-fields.ts / dispatch-redact.ts）只是尽量遮，不是边界。这里只判不改，宁可多判：敏感字段名后跟分隔符就算命中，
 * 值已经换成占位符也算（续行遮没遮干净这里不去猜）；高熵串只按精确值放行登记过的字段，不按格式放行。
 * 同一份正文看三种样子：原样、去掉「│ 」前缀（「字段名」和「: 值」被折到两行）、再 NFKC 并去掉 \p{Cf}（全角冒号 / 全角字母）。
 * 纯函数，tests/dispatch-gate.test.ts。
 */
import { secretShapeHit } from "./dispatch-redact.js";
import { SENSITIVE_NAMES } from "./redact-fields.js";

/** 字段名 + 分隔符，不看前面是什么、也不看值。复数也认（credentials:），tokens 不认：ctxTokens / maxTokens 是用量字段 */
const FIELD_RE = new RegExp(String.raw`(?:${SENSITIVE_NAMES}|key)(?:(?<!token)s)?["'\x60]?\s*(?:[:=：＝]|->)`, "i");
const CN_FIELD_RE = /(?:密钥|密码|口令|令牌|私钥|凭据|凭证)\s*[:=：＝]/;
/** 命令行参数带值：--token x、--api-key=x */
const FLAG_RE = new RegExp(String.raw`--[\w-]*?(?:${SENSITIVE_NAMES})(?:\s+|=)\S`, "i");
/** 高熵：≥ 16 位十六进制、≥ 20 位字母数字，数字和字母都要有（纯数字的时间戳 / Discord id、纯字母的标识符不算） */
const HEX_RE = /(?<![0-9a-f])[0-9a-f]{16,}(?![0-9a-f])/gi;
const ALNUM_RE = /(?<![A-Za-z0-9])[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g;
const mixed = (s: string): boolean => /\d/.test(s) && /[A-Za-z]/.test(s);

const RULES = ["field", "flag", "shape", "hex", "alnum"] as const;
export type GateRule = (typeof RULES)[number];

function views(text: string): string[] {
  const unwrapped = text.replace(/^│ ?/gm, "");
  return [text, unwrapped, unwrapped.normalize("NFKC").replace(/\p{Cf}+/gu, "")];
}

/** 命中的规则（按 RULES 的顺序，空 = 放行）；allow = 按精确值放行的登记字段（任务号、head、PR 链接里的 sha），只对高熵两条生效 */
export function gateHits(text: string, allow: readonly string[]): GateRule[] {
  const ok = new Set(allow);
  const hits = new Set<GateRule>();
  for (const v of views(text)) {
    if (FIELD_RE.test(v) || CN_FIELD_RE.test(v)) hits.add("field");
    if (FLAG_RE.test(v)) hits.add("flag");
    if (secretShapeHit(v)) hits.add("shape");
    if ((v.match(HEX_RE) ?? []).some((m) => mixed(m) && !ok.has(m))) hits.add("hex");
    if ((v.match(ALNUM_RE) ?? []).some((m) => mixed(m) && !ok.has(m))) hits.add("alnum");
  }
  return RULES.filter((r) => hits.has(r));
}
