/**
 * check_inbox 的批次文本（bridge/inbox.ts 写给 agent 的工具结果）→ 一条条领走的消息（i28-IBX1）。
 * 领走的消息在会话记录里只存在于这次工具结果里，网页历史要靠这里拆回来（lib/session-history-inbox.ts）。
 *
 * 条目抬头由这里出（inbox.ts 引用同一个函数），读写不会各说各话；其余措辞（批首、预览尾注）靠
 * tests/session-history-inbox.test.ts 用 inbox.ts 实际产出的文本守着，格式一改测试就红。
 *
 * 防冒充：条目正文是别人写的（peer / agent），里面可以照抄一行抬头。批首写了「N 条」、条目编号 1/N…N/N 依次出现，
 * 正文里多抄一行带编号的抬头条数就对不上；不带编号的（预览）只能出现在全部编号条目之后、且必须带同一 message_id 的预览尾注。
 * 带编号的条目也可能是预览（已打租约的长消息被原样重给），同样按尾注认出来：预览只是开头，不能当全文去重。
 * 对不上 = malformed，调用方不按条拆、不认任何发送者。
 */

/** 一条的抬头（不带批内编号；batchText 再把「── 来自」换成「── k/N · 来自」） */
export function inboxEntryHead(from: string, messageId: string, mins: number, back: string): string {
  return `── 来自 ${from} · message_id=${messageId} · 排队 ${mins} 分钟${back} ──`;
}

const HEAD_RE = /^── (?:(\d+)\/(\d+) · )?来自 (.+?) · message_id=(\S+) · 排队 \d+ 分钟(?: · 回复用 reply，chat_id=(\S+))? ──$/gm;
const BATCH_RE = /^\[📬 收件箱 inbox_[\w-]+：(\d+) 条/;
const EMPTY_LINE = "收件箱里没有可领取的消息。";
const PAGE_RE = /^\[📬 message_id=(\S+) 第 (\d+)\/(\d+) 页。[^\n]*\]\n\n/;
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
  /** 预览才有：全文去掉抬头行后的正文字数（尾注的字数含当时那行抬头，抬头里「排队 N 分钟」会变，正文不变）——分页拼接拿它核对 */
  bodyLen?: number;
}

/** 不是批次（ack 回执 / 分页读 / 「正在投递」/ 空收件箱且没有预览）→ null；拆不对 → "malformed" */
export function parseInboxBatch(text: string): InboxEntry[] | "malformed" | null {
  const n = Number(BATCH_RE.exec(text)?.[1] ?? 0);
  if (!n && !text.split("\n")[0].endsWith(EMPTY_LINE)) return null;
  const heads = [...text.matchAll(HEAD_RE)];
  const out: InboxEntry[] = [];
  let numbered = 0;
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    const end = i + 1 < heads.length ? heads[i + 1].index! : text.length;
    const body = text.slice(h.index! + h[0].length + 1, end).replace(/\n\n$/, "");
    const entry: InboxEntry = { from: h[3], messageId: h[4], ...(h[5] ? { replyTo: h[5] } : {}), body };
    // 预览尾注编号条目也会带：分页读给它打了租约后，没 ack 再调，「原样重给」的那批里它仍只给开头（inbox.ts fitEntry）
    const tail = PREVIEW_TAIL_RE.exec(body);
    const headLen = h[0].length - (h[1] ? `${h[1]}/${h[2]} · `.length : 0); // 尾注字数按不带批内编号的抬头算（batchText 后插的编号）
    if (tail && tail[2] === h[4]) Object.assign(entry, { body: body.slice(0, tail.index), previewOf: Number(tail[1]), bodyLen: Number(tail[1]) - headLen - 1 });
    if (i < n) {
      if (Number(h[1]) !== i + 1 || Number(h[2]) !== n) return "malformed";
      numbered++;
    } else if (h[1] || entry.previewOf === undefined) return "malformed";
    out.push(entry);
  }
  return numbered === n ? out : "malformed";
}

/** 分页读的一页（check_inbox({ read }) 的结果）：bridge 写的页头 + 这一页的原文切片；不是分页结果 → null */
export function parseInboxPage(text: string): { messageId: string; page: number; pages: number; chunk: string } | null {
  const m = PAGE_RE.exec(text);
  return m ? { messageId: m[1], page: Number(m[2]), pages: Number(m[3]), chunk: text.slice(m[0].length) } : null;
}

/**
 * 分页切片包含每次重算的排队分钟抬头，正文长度只能核对首末页，不能证明中间页的切片边界。
 * 因此三页以上保留拼接展示但不认作权威全文；否则乱序跨分钟位数变化会吞掉随后正确的普通重投。
 * 两页可按正文字数反推末页漂移，核对重复边界后去掉重叠；没有预览字数也不能核对。
 */
export function joinInboxPages(chunks: string[], bodyLen: number | undefined): { full: string; ok: boolean } {
  const joined = chunks.join("");
  const h1 = chunks[0].indexOf("\n");
  if (bodyLen === undefined || h1 < 0 || chunks.length > 2) return { full: joined, ok: false };
  if (chunks.length === 1) return { full: joined, ok: joined.length - h1 - 1 === bodyLen };
  const size = chunks[0].length, last = chunks[chunks.length - 1];
  if (chunks.slice(0, -1).some((c) => c.length !== size)) return { full: joined, ok: false };
  const drift = last.length + (chunks.length - 1) * size - 1 - bodyLen - h1; // 两页时末页抬头比第 1 页长几位
  if (drift === 0) return { full: joined, ok: true };
  if (drift < 0 || chunks.length !== 2 || drift > last.length || !chunks[0].endsWith(last.slice(0, drift))) return { full: joined, ok: false };
  return { full: chunks[0] + last.slice(drift), ok: true };
}

/**
 * 分页读拼回的整条（inbox.ts entryText：一行抬头 + 正文）→ 一条领走的消息。只认第 1 行的抬头（bridge 写的），
 * 正文里再抄的抬头只是正文；抬头不带批内编号、message_id 要和页头一致，对不上 → null
 */
export function parseInboxEntry(full: string, messageId: string): InboxEntry | null {
  const nl = full.indexOf("\n");
  const h = new RegExp(HEAD_RE.source).exec(nl < 0 ? full : full.slice(0, nl));
  if (!h || h[1] || h[4] !== messageId || nl < 0) return null;
  return { from: h[3], messageId, ...(h[5] ? { replyTo: h[5] } : {}), body: full.slice(nl + 1) };
}
