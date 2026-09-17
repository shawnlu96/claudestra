import type { ChatMessage } from "./type";

/**
 * v2.23.2+ 直播气泡 ↔ 历史气泡的合流规则（纯函数，tests/web-live-merge.test.ts 覆盖）。
 *
 * 视图 = 历史气泡（h 前缀，来自 /api/chat/history 全量或差量）+ 直播气泡（SSE 事件
 * 现画）。同一条 jsonl 记录两条路都会到：watcher 推事件、7s 对账拉差量，先后不定。
 * 以前按「时间戳 ±5s」猜哪份是重复，流一延迟 / 两端时钟一偏就漏成两份（owner
 * 2026-09-17 桌面端两次截图）。现在 watcher 给每条事件带 jsonl 行号 seq + 会话 sid，
 * 历史游标 {sid,lastSeq} 说「≤ lastSeq 的记录都已在历史里」——比较是精确的：
 *
 * - 事件先到、差量后到：差量应用时 pruneLiveBubbles 把直播气泡里 seq ≤ lastSeq 的段剥掉，
 *   剥空即整泡丢弃（coveredByCursor 之外的另一半）；
 * - 差量先到、事件后到：事件到达时 coveredByCursor 命中 → 根本不画（chat-store 侧）。
 *
 * 没带 seq 的旧事件 / reply 段（bridge 直投，不经 watcher）退回时间戳规则。
 */
export interface HistoryCursor {
  sid: string;
  lastSeq: number;
}

/** 直播事件来源记录的坐标（watcher 带上的 jsonl 行号 + 会话 id） */
export interface RecordSrc {
  seq?: number;
  sid?: string;
}

/** 历史/差量拉回来的气泡（h 前缀，见 hydrateHistoryMessages）。直播事件**绝不能**并进去。 */
export function isHistoryBubble(m: ChatMessage): boolean {
  return m.id.startsWith("h");
}

/** 这条直播事件的记录是否已被历史游标覆盖（= 内容已以历史气泡形态在视图里） */
export function coveredByCursor(cursor: HistoryCursor | null | undefined, src?: RecordSrc): boolean {
  return (
    !!cursor &&
    !!src &&
    typeof src.seq === "number" &&
    typeof src.sid === "string" &&
    src.sid === cursor.sid &&
    src.seq <= cursor.lastSeq
  );
}

/**
 * 时间戳兜底（2026-09-17 第一版）：只留比 incoming 里最后一条 assistant **更新**的直播气泡。
 * 容 5s 时钟偏差且偏向丢弃：丢了下一个流事件/差量会补回，留错了就是两份。incoming 没有
 * assistant 时全部保留（jsonl 尚未落盘，历史吞不掉正在流的内容——2026-07-16「头像和动效
 * 都消失了」）。只用于没带 seq 的气泡。
 */
export function liveBubblesNewerThan(streamed: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  let lastAsst = -Infinity;
  for (const m of incoming) {
    if (m.role !== "assistant" || !m.ts) continue;
    const t = Date.parse(m.ts);
    if (Number.isFinite(t) && t > lastAsst) lastAsst = t;
  }
  if (lastAsst === -Infinity) return streamed;
  return streamed.filter((m) => {
    const t = m.ts ? Date.parse(m.ts) : NaN;
    return Number.isFinite(t) && t > lastAsst + 5_000;
  });
}

/** 直播气泡里带 seq 的段/工具的最大 seq（无标记 → null） */
function maxTaggedSeq(m: ChatMessage): number | null {
  let max = typeof m.seqEnd === "number" ? m.seqEnd : -Infinity;
  for (const seg of m.segments ?? []) {
    if (seg.kind === "text" && typeof seg.seq === "number") max = Math.max(max, seg.seq);
    else if (seg.kind === "tools") for (const t of seg.tools) if (typeof t.seq === "number") max = Math.max(max, t.seq);
  }
  for (const t of m.toolCalls ?? []) if (typeof t.seq === "number") max = Math.max(max, t.seq);
  return max === -Infinity ? null : max;
}

/** 剥掉 seq ≤ lastSeq 的段/工具；没剩东西返回 null */
function stripCovered(m: ChatMessage, lastSeq: number): ChatMessage | null {
  const covered = (seq: number | undefined) => typeof seq === "number" && seq <= lastSeq;
  const segments: NonNullable<ChatMessage["segments"]> = [];
  for (const seg of m.segments ?? []) {
    if (seg.kind === "text") {
      if (!covered(seg.seq)) segments.push(seg);
    } else if (seg.kind === "tools") {
      const tools = seg.tools.filter((t) => !covered(t.seq));
      if (tools.length) segments.push({ ...seg, tools });
    } else segments.push(seg);
  }
  const toolCalls = (m.toolCalls ?? []).filter((t) => !covered(t.seq));
  if (!segments.length && !m.replyText) return null;
  // 直播侧 content = 非进度文本段的拼接（flushPendingText 的 += 语义）
  const content = segments.filter((s) => s.kind === "text" && !s.progress).map((s) => (s.kind === "text" ? s.text : "")).join("");
  return { ...m, segments, content, ...(toolCalls.length ? { toolCalls } : { toolCalls: undefined }) };
}

/** 最近几条历史气泡里是否已有同文本的 reply 段 */
export function historyHasReply(history: ChatMessage[], text: string): boolean {
  const want = text.trim();
  if (!want) return true; // 空 reply 无处可留
  for (let i = history.length - 1, seen = 0; i >= 0 && seen < 6; i--) {
    const m = history[i];
    if (m.role !== "assistant") continue;
    seen++;
    if (!isHistoryBubble(m)) continue;
    if ((m.segments ?? []).some((seg) => seg.kind === "reply" && seg.text.trim() === want)) return true;
  }
  return false;
}

/**
 * 差量/全量应用时的直播气泡保全：
 * - 带 seq 标记的气泡按游标精确剥：全被覆盖 → 丢（reply 段例外：历史里还没有同文本的
 *   reply 时留一个只含 reply 的气泡，seqEnd 保留以便下次对账再判）；部分覆盖 → 剥掉已覆盖的段；
 * - 不带标记 / 不同会话的气泡 → 时间戳规则（liveBubblesNewerThan）。
 * history：合流后的历史列表（查 reply 是否已入历史用）。
 */
export function pruneLiveBubbles(
  bubbles: ChatMessage[],
  incoming: ChatMessage[],
  cursor: HistoryCursor | null | undefined,
  history: ChatMessage[],
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const b of bubbles) {
    const max = maxTaggedSeq(b);
    if (max === null || !cursor || (b.sid && b.sid !== cursor.sid)) {
      if (liveBubblesNewerThan([b], incoming).length) out.push(b);
      continue;
    }
    if (max > cursor.lastSeq) {
      const stripped = stripCovered(b, cursor.lastSeq);
      if (stripped) out.push(stripped);
      continue;
    }
    const replies = (b.segments ?? []).filter((s) => s.kind === "reply");
    if (!replies.length) continue;
    if (replies.every((r) => r.kind === "reply" && historyHasReply(history, r.text))) continue;
    out.push({ ...b, segments: replies, content: "", toolCalls: undefined, seqEnd: max });
  }
  return out;
}

/** 历史气泡的首 seq（id = h<seq>） */
function firstSeq(m: ChatMessage): number | null {
  const mm = /^h(\d+)$/.exec(m.id);
  return mm ? Number(mm[1]) : null;
}

/**
 * 差量拼接：差量首条与现有历史尾条都是同一会话的 assistant 历史气泡 → 并成一泡。
 * 服务端只在同一次响应里把连续 assistant 记录合并成一个回合气泡；回合进行中每 7s 一次
 * 差量，一个长回合就被切成 N 个头像。跨差量续接与服务端同一口径（content 用 \n\n 连、
 * reply 用 \n 连、seqEnd 取新的），「删除」按 h<首seq>..seqEnd 隐藏也照样覆盖整段。
 */
export function mergeContiguousAssistant(base: ChatMessage[], delta: ChatMessage[]): ChatMessage[] {
  if (!base.length || !delta.length) return [...base, ...delta];
  const last = base[base.length - 1];
  const first = delta[0];
  const fs = firstSeq(first);
  const joinable =
    last.role === "assistant" &&
    first.role === "assistant" &&
    isHistoryBubble(last) &&
    isHistoryBubble(first) &&
    !!last.sid &&
    last.sid === first.sid &&
    typeof last.seqEnd === "number" &&
    fs !== null &&
    fs > last.seqEnd;
  if (!joinable) return [...base, ...delta];
  const toolCalls = [...(last.toolCalls ?? []), ...(first.toolCalls ?? [])];
  const attachments = [...(last.attachments ?? []), ...(first.attachments ?? [])];
  const replyText = [last.replyText, first.replyText].filter(Boolean).join("\n");
  const merged: ChatMessage = {
    ...last,
    segments: [...(last.segments ?? []), ...(first.segments ?? [])],
    content: [last.content, first.content].filter(Boolean).join("\n\n"),
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(replyText ? { replyText } : {}),
    ...(last.replyTs || first.replyTs ? { replyTs: last.replyTs ?? first.replyTs } : {}),
    ...(first.replyComponents ?? last.replyComponents ? { replyComponents: first.replyComponents ?? last.replyComponents } : {}),
    ...(last.replyClicks || first.replyClicks ? { replyClicks: { ...(last.replyClicks ?? {}), ...(first.replyClicks ?? {}) } } : {}),
    ...(typeof first.turnMs === "number" ? { turnMs: first.turnMs } : {}),
    seqEnd: typeof first.seqEnd === "number" ? first.seqEnd : last.seqEnd,
  };
  return [...base.slice(0, -1), merged, ...delta.slice(1)];
}
