/**
 * check_inbox 的批次文本（bridge/inbox.ts 写给 agent 的工具结果）→ 一条条领走的消息（i28-IBX1）。
 * 领走的消息在会话记录里只存在于这次工具结果里，网页历史要靠这里拆回来（lib/session-history-inbox.ts）。
 *
 * 条目抬头由这里出（inbox.ts 引用同一个函数），读写不会各说各话；其余措辞（批首、预览尾注）靠
 * tests/session-history-inbox.test.ts 用 inbox.ts 实际产出的文本守着，格式一改测试就红。
 *
 * 防冒充：条目正文是别人写的（peer / agent），里面可以照抄一行抬头。批首写了「N 条」、条目编号 1/N…N/N 依次出现，
 * 正文里多抄一行带编号的抬头条数就对不上；不带编号的（预览）只能出现在全部编号条目之后、且必须带同一 message_id 的预览尾注。
 * 对不上 = malformed，调用方不按条拆、不认任何发送者。
 */

/** 一条的抬头（不带批内编号；batchText 再把「── 来自」换成「── k/N · 来自」） */
export function inboxEntryHead(from: string, messageId: string, mins: number, back: string): string {
  return `── 来自 ${from} · message_id=${messageId} · 排队 ${mins} 分钟${back} ──`;
}

const HEAD_RE = /^── (?:(\d+)\/(\d+) · )?来自 (.+?) · message_id=(\S+) · 排队 \d+ 分钟(?: · 回复用 reply，chat_id=(\S+))? ──$/gm;
const BATCH_RE = /^\[📬 收件箱 inbox_[\w-]+：(\d+) 条/;
const EMPTY_LINE = "收件箱里没有可领取的消息。";
const PREVIEW_TAIL_RE = /\n…（这条共 (\d+) 字，这里只给开头；要现在看全文用 check_inbox\(\{ read: "([^"\n]+)" \}\) 分页读，否则这一轮结束时送达）\s*$/;

export interface InboxEntry {
  /** 抬头里的发送者（agent 名 / owner / owner 的卡片答复 / peer X） */
  from: string;
  messageId: string;
  /** 回程 chat_id（只有人 / peer 的有；本机 agent 没有） */
  replyTo?: string;
  /** bridge 渲染后的正文（含注入头，调用方自己剥） */
  body: string;
  /** 太长没进批、只给了开头：全文字数 */
  previewOf?: number;
}

/** 不是批次（ack 回执 / 分页读 / 「正在投递」/ 空收件箱且没有预览）→ null；拆不对 → "malformed" */
export function parseInboxBatch(text: string): InboxEntry[] | "malformed" | null {
  const n = Number(BATCH_RE.exec(text)?.[1] ?? 0);
  if (!n && !text.split("\n")[0].endsWith(EMPTY_LINE)) return null;
  const heads = [...text.matchAll(HEAD_RE)];
  const out: InboxEntry[] = [];
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    const end = i + 1 < heads.length ? heads[i + 1].index! : text.length;
    let body = text.slice(h.index! + h[0].length + 1, end).replace(/\n\n$/, "");
    const entry: InboxEntry = { from: h[3], messageId: h[4], ...(h[5] ? { replyTo: h[5] } : {}), body };
    if (i < n) {
      if (Number(h[1]) !== i + 1 || Number(h[2]) !== n) return "malformed";
    } else {
      const tail = PREVIEW_TAIL_RE.exec(body);
      if (h[1] || !tail || tail[2] !== h[4]) return "malformed";
      body = body.slice(0, tail.index);
      Object.assign(entry, { body, previewOf: Number(tail[1]) });
    }
    out.push(entry);
  }
  return out.filter((e) => e.previewOf === undefined).length === n ? out : "malformed";
}
