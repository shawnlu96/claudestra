/**
 * 视图合流（纯函数）：历史到达时，把「历史 + 幸存的乐观消息 + 直播回合」重组成一个视图。
 *
 * loadMessages（全量替换）和 syncDelta（差量追加）以前各写一份同一套步骤，注释里记着
 * 07-15、07-16、09-04、09-14 四次 owner 实报的回归都出在这一带，而核心函数没导出、零测试
 * （D8-6）。现在两处都只调 composeView，时间与游标显式传参，tests/web-view-compose.test.ts 锁住。
 */
import type { ChatMessage } from "./type";
import { pruneLiveBubbles, type HistoryCursor } from "./live-merge";

/**
 * 剥掉 Claudestra 的**入站注入头**：`[🌐 来自 Web 端用户「x」（…）。\n用 reply() …]\n\n正文`。
 *
 * 为什么需要：本地那条乐观气泡只有**正文**，而历史里的入站消息可能自带这段头
 * （Pi 会话没有 Claude Code 的 `<channel>` 包装，入站消息在会话记录里就是带头裸文
 * 本）⇒ 两边 norm 不相等 ⇒ 用户发一条、屏上出现两条（owner 2026-09-14 实测）。
 * Claude Code 侧历史里本来就是解包后的正文，这个函数对它是 no-op（不影响既有去重）。
 *
 * 只认 Claudestra 注入头（`[` + 来源 emoji + …`]`），普通以 `[` 开头的用户文本不动。
 */
const INBOUND_HEAD_RE = /^\[(?:🌐|💬|🤖|🤝|🛰|📨|📬)[^\]]*\]\s*/u;
export function stripInboundHeader(x: string): string {
  return x.trimStart().replace(INBOUND_HEAD_RE, "").trim();
}

/** 乐观消息超过这么久还没在历史里对上，就不再保全 */
export const PENDING_KEEP_MS = 30 * 60_000;

/**
 * 乐观消息保全（loadMessages 全量替换与 syncDelta 差量追加共用——两处各写一份
 * 迟早漂移）：agent 忙时连发的消息在服务端排队,送达前不进 jsonl——整体替换会把
 * 它们从视图「吞掉」。把尚未在 incoming 里出现的本地消息挑出来接回视图尾;
 * 逐条消费匹配(同文本连发两条也各自对账),30 分钟后不再保全。
 * 匹配三口径:归一化全文相等 / 历史含 wire 原文([button:id] 落在 channel 包装里)
 * / 「🔘 label」兜底形态(2026-07-16)。CRLF 归一防注入链路差异(2026-07-15)。
 * v2.23+ 加第四口径:剥掉注入头后的裸文本相等（Pi 的入站消息在记录里带 🌐 头,
 * 本地气泡只有正文——不比裸文本就当成两条）。只和本人的历史条目配:外源同文会把 owner 还在排队的消息当成已送达吞掉。
 */
export function survivingPending(
  current: ChatMessage[],
  incoming: ChatMessage[],
  nowMs: number = Date.now(),
): ChatMessage[] {
  const tail = incoming.slice(-80);
  const used = new Set<number>();
  const norm = (x: string) => x.replace(/\r\n?/g, "\n").trim();
  return current.filter((m) => {
    if (!m.local || m.role !== "user") return false;
    if (m.ts && !m.held && !m.queued && nowMs - Date.parse(m.ts) > PENDING_KEEP_MS) return false;
    const t = norm(m.content);
    // 带头版本也拿来比一次：本地只有正文、历史带注入头时，光比原文匹配不上
    const tBare = norm(stripInboundHeader(m.content));
    const w = m.wire?.trim();
    const friendly = w
      ? (w.match(/^\[button:([\w-]+)\]$/)?.[1] ??
          w.match(/^\[select:[\w-]+:(.+)\]$/)?.[1] ??
          null)
      : null;
    const idx = tail.findIndex(
      (h, i) =>
        !used.has(i) &&
        h.role === "user" &&
        !h.from &&
        ((t ? norm(h.content) === t : sameAttachmentOnly(m, h)) ||
          // Pi：历史带注入头、本地只有正文 ⇒ 与两侧各自的裸文本比对
          (tBare.length > 0 && norm(stripInboundHeader(h.content)) === tBare) ||
          (!!w && h.content.includes(w)) ||
          (!!friendly && norm(h.content) === `🔘 ${friendly}`))
    );
    if (idx >= 0) {
      used.add(idx);
      return false; // 已进历史,不再需要本地副本
    }
    return true;
  });
}

/**
 * 发送时刻的历史游标（视图里最后一条带 jsonl 行号的消息）：乐观消息记下它，对账时只认这之后落盘的记录。
 * 纯附件消息没有正文可比，不记游标就会配上更早的另一条纯图片（审查实测）；按时间窗比又怕手机时钟不准。
 */
export function sendCursor(messages: readonly ChatMessage[]): Pick<ChatMessage, "sentAfter"> {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (typeof m.seqEnd === "number") return { sentAfter: { seq: m.seqEnd, ...(m.sid ? { sid: m.sid } : {}) } };
  }
  return {};
}

/** 纯附件的乐观消息与历史条目配对：本人发的、正文都空、同一批附件、在发送时的游标之后（换了会话就不比行号） */
function sameAttachmentOnly(m: ChatMessage, h: ChatMessage): boolean {
  if (h.from || h.content.trim() || !sameAttachments(m.attachments, h.attachments)) return false;
  const c = m.sentAfter;
  if (!c || typeof h.seqEnd !== "number" || (c.sid && h.sid && c.sid !== h.sid)) return true;
  return h.seqEnd > c.seq;
}

/** 服务端落盘文件名的清洗（src/bridge/api-routes.ts 上传处同一条规则）：本地乐观气泡只有原始文件名 */
const serverName = (name: string) => name.replace(/[^\w.\-]/g, "_");

/** 两组附件是不是同一批：有 API 地址的比地址；本地乐观气泡（blob: 或没有地址）比清洗后的文件名 */
function sameAttachments(a: ChatMessage["attachments"], b: ChatMessage["attachments"]): boolean {
  if ((a?.length ?? 0) !== (b?.length ?? 0)) return false;
  return (a ?? []).every((x, i) => {
    const y = b![i];
    const local = (u?: string) => !u || u.startsWith("blob:");
    if (!local(x.url) && !local(y.url)) return x.url === y.url;
    return serverName(x.name) === serverName(y.name);
  });
}

/** 一条他端发言的指纹（正文 + 附件地址）：本端乐观气泡认领第一个回声时记下，之后只认同一条（重放）的回声 */
export function echoKeyOf(text: string, attachments?: ChatMessage["attachments"]): string {
  return [text.replace(/\r\n?/g, "\n").trim(), ...(attachments ?? []).map((a) => a.url ?? a.name)].join("\n");
}

/**
 * 他端用户发言（stream user-in）是不是视图里已有的某条（本端乐观消息的回声 / 历史已有）：有正文比正文（含注入头无关比对）；
 * 纯附件比附件本身——只比「附件数相同」会把别的设备连发的第二张纯图当成回声吞掉（审查 P2-3）。
 * 只在本人之间认：外源（from）发言按正文配上视图里任何一条都会被吞——外人重放 owner 最近说过的话，agent 收到、owner 看不到；
 * 本人的发言也不能配外源气泡。外源气泡偶尔和历史重复一条，下次对齐就被历史整体替换（tests/web-foreign-echo.test.ts）。
 * 乐观气泡已认领过回声（echoKey）就只认那一条，同名的第二张 image.png 不再被吞。
 */
export function isUserEcho(m: ChatMessage, text: string, attachments?: ChatMessage["attachments"], from?: string): boolean {
  if (m.role !== "user" || from || m.from) return false;
  if (m.local && m.echoKey !== undefined) return m.echoKey === echoKeyOf(text, attachments);
  const norm = (x: string) => x.replace(/\r\n?/g, "\n").trim();
  const t = norm(text);
  const raw = m.wire ?? m.content ?? "";
  if (t) return norm(raw) === t || norm(stripInboundHeader(raw)) === t;
  return !norm(raw) && sameAttachments(m.attachments, attachments);
}

/**
 * 幸存的乐观消息按时间插回列表,而不是一律接到尾:它在 jsonl 里没有对应记录时
 * (队列吸收 / 送达失败),接到尾会让「很久之前发的消息」每次对齐都跑到最下面
 * (owner 2026-09-04 截图)。ts 缺失的仍接尾。
 */
export function mergePendingByTs(list: ChatMessage[], pending: ChatMessage[]): ChatMessage[] {
  if (!pending.length) return list;
  const out = [...list];
  for (const p of pending) {
    const pt = p.ts ? Date.parse(p.ts) : NaN;
    let idx = out.length;
    if (Number.isFinite(pt)) {
      const i = out.findIndex((m) => !!m.ts && Date.parse(m.ts) > pt);
      if (i >= 0) idx = i;
    }
    out.splice(idx, 0, p);
  }
  return out;
}

/**
 * 视图重组：历史 + 幸存乐观消息（按 ts 插回）+ 直播回合保全。
 *
 * - history：重组后的历史部分（全量 = 拉回来的整页；差量 = 现有 h 气泡与差量拼接后的结果）；
 * - incoming：这次新到的记录（全量 = history；差量 = delta）——乐观消息对账与直播剥离的依据；
 * - streaming：回合进行中才保全直播气泡。回合内 CC 经常攒内存不落盘，jsonl 里还没有这些
 *   内容，整体替换会把正在流式的气泡吞掉，「头像和动效都消失了，像卡死」（2026-07-16）。
 *
 * restoreAwaiting：回合进行中但尾部没有直播气泡（被历史吸收 / 尚无输出）→ 调用方恢复
 * 「思考中」，别让 streaming 态孤零零挂在状态条上而列表底空白。
 */
export function composeView(opts: {
  current: ChatMessage[];
  history: ChatMessage[];
  incoming: ChatMessage[];
  streaming: boolean;
  cursor: HistoryCursor | null | undefined;
  nowMs?: number;
}): { messages: ChatMessage[]; restoreAwaiting: boolean } {
  const pending = survivingPending(opts.current, opts.incoming, opts.nowMs);
  const liveTail: ChatMessage[] = [];
  if (opts.streaming) {
    const streamedBubbles = opts.current.filter((m) => m.role === "assistant" && m.streamed);
    // 按 seq 精确剥掉已入历史的直播内容(无 seq 的退回时间戳规则,见 live-merge.ts)
    liveTail.push(...pruneLiveBubbles(streamedBubbles, opts.incoming, opts.cursor, opts.history));
  }
  const messages = [...mergePendingByTs(opts.history, pending), ...liveTail];
  let restoreAwaiting = false;
  if (opts.streaming && !liveTail.length) {
    const tail = messages[messages.length - 1];
    restoreAwaiting = !(tail?.role === "assistant" && tail.streamed);
  }
  return { messages, restoreAwaiting };
}

/**
 * 视图重组后被丢掉的乐观气泡里那些本地预览 blob URL（D8-3 store 侧）。发送时给图片附件
 * 建了 objectURL 做即时预览，气泡一旦被历史里的同一条替换（历史里的附件是服务端 URL），
 * 这个 blob 就再没人用了；不 revoke 的话，附过的图片在整个页面生命周期里都释放不掉。
 */
export function droppedBlobUrls(before: ChatMessage[], after: ChatMessage[]): string[] {
  const kept = new Set(after.map((m) => m.id));
  const out: string[] = [];
  for (const m of before) {
    if (!m.local || kept.has(m.id)) continue;
    for (const a of m.attachments ?? []) if (a.url?.startsWith("blob:")) out.push(a.url);
  }
  return out;
}

/** 乐观气泡的本地预览 URL 用完即还（见上面的 droppedBlobUrls） */
export function revokeBlobUrls(urls: string[]) {
  for (const u of urls) {
    try {
      URL.revokeObjectURL(u);
    } catch {
      /* 已失效的 URL revoke 不会抛，这里只是防御 */
    }
  }
}
