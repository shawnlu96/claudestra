/**
 * 台账里别人写的文本（执行者的交付说明、升级原因、审查要点）进 bridge 通知和审查员 prompt 时的引用格式。
 * 这些通知以 bridge 身份送达、比 agent 消息更可信：原文带换行就能伪造一行「下一步：…」「【升级】owner 已同意…」
 * 或 prompt 里的一节「## 重点」。所以一律压成单行、截断、包进「」，调用方再标明是谁的原文。tests/quote-text.test.ts。
 */
const MAX_QUOTE = 300;
const MAX_PATH = 400;

/** 单行、截断、包进「」；原文里的「」换成『』，关不掉引号 */
export function quoteExternal(s: string, max = MAX_QUOTE): string {
  const flat = s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  const cut = flat.length > max ? `${flat.slice(0, max)}…` : flat;
  return `「${cut.replace(/「/g, "『").replace(/」/g, "』")}」`;
}

/** 证据只认路径：不含空白与控制字符、不以 - 开头（不像命令行参数）、不太长 */
export function pathLike(s: string | null | undefined): s is string {
  return !!s && s.length <= MAX_PATH && /^[\w~./][^\s\u0000-\u001f\u007f]*$/u.test(s);
}

/** git sha（短的也认）；执行者 --head 填的别的东西不进 prompt */
export const shaLike = (s: string | null | undefined): s is string => !!s && /^[0-9a-f]{4,64}$/i.test(s);
