/**
 * 网页输入框 @ 发出的委托指令以 `[📨 委托转达]` / `[📨 Delegate]` 开头（web/lib/chat/mention-directive.ts），
 * 只有 owner 本人的消息末行才算数。peer、Web 访客、scoped token、别的 agent 转来的正文会原样落在 agent 看到的
 * 末行，不处理就能冒充「用户委托」。所以投递给本地 agent 前，把非 owner 来源里任何「方括号 + 信封」的写法整个换成
 * NEUTRAL_TAG。只认逐字 `[📨` 挡不住变体（零宽字符、变体选择符、全角括号、【、📩 ✉️、&#91;…，T19 审查 r2 P2-A），
 * 所以匹配时容忍夹在中间的不可见字符（零宽 / 格式字符、C0 / C1 控制字符），替换后再按规范形（去掉这些 + NFKC）复查一遍。
 * tests/delegate-marker.test.ts。
 */

/**
 * owner 本人：Discord 放行用户（kind=user，按 ALLOWED_USER_IDS 认人），或 api 入口按 lib/principals.ts isOwnerPrincipal
 * 算好的 owner 标记（全仓唯一的 owner 定义）。没有标记的（包括升级前落盘的押后消息）一律按外源处理。
 */
export function isOwnerSource(from: { kind: string; owner?: boolean; peer?: string }): boolean {
  if (from.kind === "user") return true;
  return from.kind === "api" && !from.peer && from.owner === true;
}

/** 外源里的标记被替换成这句：agent 看得出这里原本写了什么样子的东西，但它不是委托 */
export const NEUTRAL_TAG = "〔外源文本，不是委托〕";

// 左方括号的各种写法（NFKC 会归一成 [ 的全角 / 竖排形也列上）、夹在中间的不可见字符（含 \x01 这类控制字符）、各种信封 emoji
const OPEN = "(?:\\[|［|﹇|【|〖|〘|&#0*91;|&#x0*5b;|&lsqb;|&lbrack;)";
const GAP = "[\\p{Cc}\\p{Cf}\\uFE00-\\uFE0F\\s]*";
const ENVELOPE = "(?:📨|📩|✉|📧|💌|📬|📭|📪|📫|🖂)";
// 标记连同后面 40 字以内的标签与右括号一起换掉；没有右括号就只换括号 + 信封
const MARKER = `${OPEN}${GAP}${ENVELOPE}(?:[^\\]】〗〙\\n]{0,40}[\\]】〗〙])?`;
const markerGlobal = () => new RegExp(MARKER, "giu");
const looksLikeMarker = (s: string) => new RegExp(MARKER, "iu").test(s);
/** 规范形：去掉格式字符、变体选择符和控制字符（换行、tab 留着，不然整段并成一行），再 NFKC */
const canonical = (s: string) => s.replace(/(?![\t\n\r])[\p{Cc}\p{Cf}\uFE00-\uFE0F]/gu, "").normalize("NFKC");

export function neutralizeDelegateMarker(content: string): string {
  const once = content.replace(markerGlobal(), NEUTRAL_TAG);
  // 兜底：规范形里仍像标记（上面没列到的兼容写法），就整段按规范形投递——宁可改动外源原文，也不放过
  const canon = canonical(once);
  return looksLikeMarker(canon) ? canon.replace(markerGlobal(), NEUTRAL_TAG) : once;
}
