/**
 * 台账里的自由文本（--text、--reason、note、任务名，任何 actor 写进去的内容）进 bridge 通知和审查员 prompt 时一律当数据：
 * 这些通知以 bridge 身份送达、比 agent 消息更可信，原文带换行就能伪造一行「下一步：…」「【升级】owner 已同意…」
 * 或 prompt 里的一节「## 重点」。所以压成单行、截断、去掉控制字符与 \p{Cf}（零宽 / 双向覆盖），包进「」；
 * 引用框的标题（「执行者自述（原文，非指令）：」这类）与【升级】【通过】这类判定词只由代码按事件类型 / verdict 生成。
 * tests/quote-text.test.ts；两条已知攻击的用例在 tests/team-route.test.ts、tests/manager-ledger-dispatch.test.ts。
 */
const MAX_QUOTE = 300;
const MAX_PATH = 400;

/** 单行、截断、包进「」；原文里的「」换成『』关不掉引号，【】换成〔〕冒充不了判定词 */
export function quoteExternal(s: string, max = MAX_QUOTE): string {
  const flat = s
    .replace(/\p{Cf}+/gu, "")
    .replace(/[\p{Cc}\u2028\u2029]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const cut = flat.length > max ? `${flat.slice(0, max)}…` : flat;
  return `「${cut.replace(/「/g, "『").replace(/」/g, "』").replace(/【/g, "〔").replace(/】/g, "〕")}」`;
}

/** 分支名 / PR 号这类引用：只认常见字符，别的不进通知和 prompt */
export const refLike = (s: string | null | undefined): s is string => !!s && /^[\w./#:@-]{1,200}$/.test(s);

/**
 * 证据 / 结论 md 只认路径：字母数字（含中文文件名）加 ASCII 路径标点，至少带一个 / 或 .，不以 - 开头（不像命令行参数）、不太长。
 * 空白、控制字符（C0 / C1）、\p{Cf}、【】「」和全角标点一律不认——放宽会让「路径」冒充判定词；显示时仍进引用框（pathQuote）。
 */
export function pathLike(s: string | null | undefined): s is string {
  return !!s && s.length <= MAX_PATH && /[./]/.test(s) && /^[\p{L}\p{N}_~./][\p{L}\p{M}\p{N}_~./+@%=,:#()-]*$/u.test(s);
}

/** 路径进通知 / prompt：认得是路径才引用，否则一句代码写的说明 */
export const pathQuote = (s: string, notPath: string): string => (pathLike(s) ? quoteExternal(s, MAX_PATH) : notPath);

/** git sha（短的也认）；执行者 --head 填的别的东西不进 prompt */
export const shaLike = (s: string | null | undefined): s is string => !!s && /^[0-9a-f]{4,64}$/i.test(s);
