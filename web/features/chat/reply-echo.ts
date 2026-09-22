/**
 * 「这段灰字旁白就是刚发出去那条回复的复述」——判据 + 该藏哪一份。
 *
 * ## 现场（owner 2026-09-22）
 *
 * 「你看看回复这两种形式是不是都不太对」：同一段话在气泡里出现两份，一份白字正文
 * （`reply` 工具的 text），一份灰字旁白（assistant 的 text 块）。会话文件里那一轮：
 *
 * ```
 * 02:32:32  assistant  [thinking] [tool:memory_write] [tool:reply]   ← 真正的回复
 * 02:32:41  assistant  [text(1147)]                                  ← 同一段话又写了一遍
 * ```
 *
 * 两份实测**逐字节相同**（1147 == 1147，去空白后 884 == 884）。
 *
 * 渲染层按**来源**分区（调了 `reply` 的算回复、agent 自己打的字算过程）是 owner 定的
 * 语义，这条不动；这里只做一件事：agent 复述时把那份灰的藏掉。
 *
 * ## 判据为什么定得这么严
 *
 * 误判的代价不对称：**藏错了等于把真内容吞掉**（用户永远不知道少看了什么），漏判
 * 只是多显示一份重复。所以只认「归一化后完全相同」或「一方是另一方的前缀且长度差
 * 不到一成」，不做相似度打分。归一化只去空白与 markdown 强调符号（复述时 `**` 常有
 * 增减），不碰文字本身。太短的不判（<24 个归一化字符）：短句撞相同的概率高得多，
 * 而「已发出。」这种两份都留着也不碍事。
 *
 * ## 两种形态
 *
 * - **同一条消息内**：text 段与 reply 段都在这条里（直播就是这样，叙述与 reply 都
 *   追加进同一个 assistant 气泡）→ 藏那个 text 段。
 * - **紧随其后的另一条消息**：历史是按 jsonl 记录切的，02:32:41 那条独立成一条纯
 *   text 消息 → 整条藏掉。用户一发新消息就清账，跨回合的相同文本不算复述。
 */

/** 去空白 + 去 markdown 强调/结构符号（复述时这些最常变动） */
function normalize(s: string): string {
  return s.replace(/\s+/g, "").replace(/[*`_~#>]/g, "");
}

/** 判据下限：归一化后短于这个长度就不判重（宁可多显示一份） */
export const ECHO_MIN_CHARS = 24;
/** 前缀式复述允许的最小长度比（0.9 = 长度差不到一成） */
export const ECHO_MIN_RATIO = 0.9;

export function isReplyEcho(narration: string, reply: string): boolean {
  if (!narration || !reply) return false;
  const a = normalize(narration);
  const b = normalize(reply);
  if (a.length < ECHO_MIN_CHARS || b.length < ECHO_MIN_CHARS) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return long.startsWith(short) && short.length / long.length >= ECHO_MIN_RATIO;
}

/** 判据用到的最小消息形状（避免把 ChatMessage 整个类型拖进来） */
export interface EchoCandidate {
  id: string;
  role: string;
  /** 旁白正文（无 segments 的旧快照走这个） */
  content?: string;
  replyText?: string;
  segments?: { kind: string; text?: string; progress?: boolean }[];
  toolCalls?: unknown[];
}

/** 这条消息里的所有回复正文（segments 里的 reply 段 + 挂在 replyText 上的） */
function repliesOf(m: EchoCandidate): string[] {
  const out: string[] = [];
  for (const seg of m.segments ?? []) {
    if (seg.kind === "reply" && seg.text?.trim()) out.push(seg.text);
  }
  if (m.replyText?.trim()) out.push(m.replyText);
  return out;
}

/** 除了旁白文本之外，这条消息还有别的内容吗（有就不能整条藏） */
function bareNarration(m: EchoCandidate): boolean {
  if (repliesOf(m).length) return false;
  if (m.toolCalls?.length) return false;
  const segs = m.segments ?? [];
  if (segs.some((s) => s.kind !== "text" || s.progress)) return false;
  return true;
}

/**
 * 整条该藏的消息 id 集合（形态②）。O(n) 扫一遍，渲染前算一次。
 */
export function replyEchoMessageIds(messages: EchoCandidate[]): Set<string> {
  const hide = new Set<string>();
  let lastReplies: string[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") {
      lastReplies = []; // 用户 / 系统条目 = 回合边界，清账
      continue;
    }
    const mine = repliesOf(m);
    if (!mine.length && bareNarration(m)) {
      const text = (m.segments ?? []).map((s) => s.text ?? "").join("") || m.content || "";
      if (text && lastReplies.some((r) => isReplyEcho(text, r))) {
        hide.add(m.id);
        continue;
      }
    }
    if (mine.length) lastReplies = mine;
  }
  return hide;
}

/**
 * 形态①：这条消息里的某个 text 段是不是它自己 reply 段的复述。
 * 渲染 segments 时逐段问一次。
 */
export function isEchoSegment(m: EchoCandidate, segText: string | undefined): boolean {
  if (!segText?.trim()) return false;
  return repliesOf(m).some((r) => isReplyEcho(segText, r));
}
