/**
 * 网页输入框 @ 发出的委托指令以 `[📨 委托转达]` / `[📨 Delegate]` 开头（web/lib/chat/mention-directive.ts），
 * 只有 owner 本人的消息末行才算数。peer、Web 访客、scoped token、别的 agent 转来的正文会原样落在 agent 看到的
 * 末行，不处理就能冒充「用户委托」。所以投递给本地 agent 前，把非 owner 来源里任何「方括号 + 信封」的写法整个换成
 * NEUTRAL_TAG。只认逐字 `[📨` 挡不住变体（零宽字符、变体选择符、全角括号、【、📩 ✉️、&#91;…，T19 审查 r2 P2-A），
 * 所以「[」之后跳过不可见的东西（零宽 / 格式字符、C0 / C1 控制字符、整段终端转义序列），第一个看得见的是信封就算标记；
 * 替换后再按规范形（去掉这些 + NFKC）复查一遍。全程线性扫描，不用可回溯的正则拼转义序列（外源正文能构造指数级回溯卡住 bridge）。
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

// 左方括号的各种写法（NFKC 会归一成 [ 的全角 / 竖排形也列上）、各种信封 emoji
const OPEN = /(?:\[|［|﹇|【|〖|〘|&#0*91;|&#x0*5b;|&lsqb;|&lbrack;)/iuy;
const OPEN_FIRST = "[［﹇【〖〘&";
const ENVELOPE = /📨|📩|✉|📧|💌|📬|📭|📪|📫|🖂/gu;
// 快速路径：信封只有 ✉（U+2709）和 U+1F4xx–1F5xx（高位代理都是 \ud83d）两类；正文里两样都没有就不可能有标记，
// 被转义序列从代理对中间拆开的信封也还留着 \ud83d。加信封前先看它在不在这两类里（tests/delegate-marker.test.ts 逐个核对）
const MAYBE_ENVELOPE = /[\u2709\ud83d]/;
// 标记连同后面 40 字以内的标签与右括号一起换掉；没有右括号就只换括号 + 信封
const LABEL = /(?:[^\]】〗〙\n]{0,40}[\]】〗〙])?/uy;
const INVISIBLE = /[\p{Cc}\p{Cf}\uFE00-\uFE0F\s]/u;
const inRange = (c: string | undefined, lo: string, hi: string) => c !== undefined && c >= lo && c <= hi;

/** OSC / DCS / SOS / PM / APC 的字符串体：到 BEL、ST（ESC \ 或 \x9c）为止；没有结束符就到换行、下一个 ESC 或正文末尾 */
function stringEnd(s: string, j: number): number {
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === "\x07" || c === "\x9c") return j + 1;
    if (c === "\x1b") return s[j + 1] === "\\" ? j + 2 : j;
    if (c === "\n") return j;
  }
  return j;
}

/**
 * s[i] 起的终端转义序列 [长度, 是否是完整的 CSI / ESC 序列]，不是转义序列长度为 0。整段算不可见：只跳过引导字符的话，
 * `[0m` 这类参数是可见字，`[\x1b[0m📨` 就混过去了（T35 adv3 P2-3、adv4 P2-1）。完整的 CSI / ESC 序列里的「[」是序列自己的字，
 * 不算标记左括号（adv5 P2-1：`\x1b[1m📨 新邮件` 不改写）；字符串体里的「[」和没收尾的 `ESC [` 仍算，宁可多中和
 */
function escapeAt(s: string, i: number): [number, boolean] {
  const c = s[i];
  let j: number;
  if (c === "\x1b" && s[i + 1] === "[") j = i + 2;
  else if (c === "\x9b") j = i + 1;
  else if (c === "\x1b" && "]PX^_".includes(s[i + 1] ?? "\n")) return [stringEnd(s, i + 2) - i, false];
  else if (c !== undefined && "\x90\x98\x9d\x9e\x9f".includes(c)) return [stringEnd(s, i + 1) - i, false];
  else if (c === "\x1b") {
    for (j = i + 1; inRange(s[j], " ", "/"); j++);
    return inRange(s[j], "0", "~") ? [j + 1 - i, true] : [j - i, false];
  } else return [0, false];
  while (inRange(s[j], "0", "?")) j++;
  while (inRange(s[j], " ", "/")) j++;
  return inRange(s[j], "@", "~") ? [j + 1 - i, true] : [j - i, false];
}

/** 一遍标出每个位置：0 看得见，1 不可见（控制 / 格式字符、变体选择符、空白、字符串体），2 完整 CSI / ESC 序列里（也不能当左括号） */
function invisibleMask(s: string): Uint8Array {
  const inv = new Uint8Array(s.length);
  for (let i = 0; i < s.length; ) {
    const code = s.charCodeAt(i);
    if (code === 0x1b || (code >= 0x90 && code <= 0x9f)) {
      const [n, whole] = escapeAt(s, i);
      if (n) {
        inv.fill(whole ? 2 : 1, i, i + n);
        i += n;
        continue;
      }
    }
    // ASCII 走快路：不可见的只有控制字符和空白（都 ≤ 0x20）与 DEL
    if (code < 0x80) {
      if (code <= 0x20 || code === 0x7f) inv[i] = 1;
      i++;
      continue;
    }
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    if (INVISIBLE.test(ch)) inv.fill(1, i, i + ch.length);
    i += ch.length;
  }
  return inv;
}

/** 所有标记的 [起, 止)：「[」之后第一个不是不可见的位置（或落在转义序列里的信封）是信封，就连同标签一起算标记 */
function markerSpans(s: string): [number, number][] {
  const inv = invisibleMask(s);
  const envEnd = new Int32Array(s.length + 1).fill(-1);
  for (const m of s.matchAll(ENVELOPE)) envEnd[m.index] = m.index + m[0].length;
  // stop[q] = q 起第一个「看得见或是信封」的位置，从右往左一遍算完，每个「[」查一次
  const stop = new Int32Array(s.length + 1).fill(s.length);
  for (let q = s.length - 1; q >= 0; q--) stop[q] = !inv[q] || envEnd[q]! >= 0 ? q : stop[q + 1]!;
  const spans: [number, number][] = [];
  for (let i = 0; i < s.length; i++) {
    if (inv[i] === 2 || !OPEN_FIRST.includes(s[i]!)) continue;
    OPEN.lastIndex = i;
    if (!OPEN.test(s)) continue;
    const e = envEnd[stop[OPEN.lastIndex]!]!;
    if (e < 0) continue;
    LABEL.lastIndex = e;
    LABEL.test(s);
    spans.push([i, LABEL.lastIndex]);
    i = LABEL.lastIndex - 1;
  }
  return spans;
}

function replaceSpans(s: string, spans: [number, number][]): string {
  const parts: string[] = [];
  let at = 0;
  for (const [a, b] of spans) {
    parts.push(s.slice(at, a), NEUTRAL_TAG);
    at = b;
  }
  parts.push(s.slice(at));
  return parts.join("");
}

/** 规范形：去掉终端转义序列、格式字符、变体选择符和控制字符（换行、tab 留着，不然整段并成一行），再 NFKC */
function canonical(s: string): string {
  const parts: string[] = [];
  let at = 0;
  for (let i = 0; i < s.length; ) {
    const n = escapeAt(s, i)[0];
    if (!n) {
      i++;
      continue;
    }
    parts.push(s.slice(at, i));
    i += n;
    at = i;
  }
  parts.push(s.slice(at));
  return parts.join("").replace(/(?![\t\n\r])[\p{Cc}\p{Cf}\uFE00-\uFE0F]/gu, "").normalize("NFKC");
}

export function neutralizeDelegateMarker(content: string): string {
  if (!MAYBE_ENVELOPE.test(content)) return content;
  const once = replaceSpans(content, markerSpans(content));
  // 兜底：规范形里仍像标记（上面没列到的兼容写法），就整段按规范形投递——宁可改动外源原文，也不放过
  const canon = canonical(once);
  const spans = markerSpans(canon);
  return spans.length ? replaceSpans(canon, spans) : once;
}
