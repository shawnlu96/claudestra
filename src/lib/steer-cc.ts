/**
 * CC 的插队（insert，回合中直投 channel 通知）的两个纯判据，读的都是 CC 会话记录的尾部文本：
 * - 版本闸：只有实测过的 CC 版本才直投（CC_INSERT_MIN_VERSION），读不到版本 / 更低的按排队；
 * - 补投判定：Stop 时这条在 CC 那边是什么状态——作为附件插进了回合（attached，被包成不可信外部消息、已出队）、
 *   还排在 CC 自己的队列里（queued，CC 马上会另起一轮正常投）、已作为正常一轮投过（delivered）、没落盘（absent）。
 * 零 I/O，单测 tests/steer-cc.test.ts；实测与夹具见 scripts/cc-midturn-probe.ts、docs/architecture/inbound-route.md「CC 实测」
 */

/**
 * 实测过的最低 CC 版本（scripts/cc-midturn-probe.ts，2026-10-17）。闸是「≥ 它」：CC 升级后新版本自动放行，挡不住「行为变了」，
 * 只靠补投兜住「丢了」——所以 CC 升级后要重跑探针（docs/architecture/inbound-route.md「CC 实测」已知限制）
 */
export const CC_INSERT_MIN_VERSION = "2.1.302";

/** 只认正式版 x.y.z：带后缀的预发布版（2.1.302-beta 低于 2.1.302）、认不出的都返回 null */
const parts = (v: string): number[] | null => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
/** v >= min（只比正式版 x.y.z；预发布版 / 认不出的 = 不够） */
export function versionAtLeast(v: string | null | undefined, min: string): boolean {
  const a = v ? parts(v) : null, b = parts(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return true;
}

/** 会话记录尾部最后一条带 version 的记录：就是正在跑的那个 CC 进程的版本（装了新版没重启的会话仍报旧版） */
export function ccVersionOf(tail: string): string | null {
  const all = [...tail.matchAll(/"version":"(\d+\.\d+\.\d+[^"]*)"/g)];
  return all.length ? all[all.length - 1]![1]! : null;
}

export type CcInsertState = "attached" | "queued" | "delivered" | "absent";

interface Rec { type?: string; operation?: string; attachment?: { type?: string; prompt?: string }; message?: { role?: string; content?: unknown } }

/**
 * 这条（按 channel 标签里的 message_id 认）在 CC 那边的状态。只看提到它的行：附件（queued_command）= 插进了回合；
 * 正文以 <channel 开头的用户记录 = 作为正常一轮投过（工具结果里碰巧出现同一个 id 不算）；只有 enqueue、没有 remove / dequeue = 还排在
 * CC 队列里；都没有 = 没落盘（被丢了 / 还没到）
 */
export function ccInsertState(tail: string, messageId: string): CcInsertState {
  const tag = `message_id=\\"${messageId}\\"`; // 正文在 JSON 里，引号带反斜杠
  let enq = false, out = false, delivered = false;
  for (const line of tail.split("\n")) {
    if (!line.includes(tag)) continue;
    let r: Rec;
    try {
      r = JSON.parse(line) as Rec;
    } catch {
      continue; // 尾部切在半行上（只可能是第一行）：那行本来就不完整，丢掉不影响判后面的
    }
    if (r.type === "attachment" && r.attachment?.type === "queued_command") return "attached";
    if (r.type === "user" && typeof r.message?.content === "string" && r.message.content.startsWith("<channel")) delivered = true;
    if (r.type === "queue-operation") {
      if (r.operation === "enqueue") enq = true;
      else out = true;
    }
  }
  return delivered ? "delivered" : enq && !out ? "queued" : "absent";
}

/**
 * CC 此刻在工具执行窗口里：尾部最后一批 tool_use 还有没回结果的。只有这时插队才会作为附件插进当前回合（实测）；推理 / 出字时到的
 * 进 CC 自己的队列，owner 按 Escape（抢占 / 叫停）后 CC 会立刻把它当新一轮投——绕过叫停（docs/architecture/inbound-route.md「CC 实测」）
 */
export function ccInToolWindow(tail: string): boolean {
  const open = new Set<string>();
  for (const line of tail.split("\n")) {
    if (!line.includes('"tool_use') && !line.includes('"type":"user"')) continue;
    let r: { type?: string; message?: { content?: unknown } };
    try {
      r = JSON.parse(line);
    } catch {
      continue; // 尾部切在半行上：只可能是第一行，那一批的结果在后面照样数得到
    }
    const c = r.message?.content;
    if (r.type === "user" && typeof c === "string") open.clear(); // 新的一轮（人或 channel 开的）
    if (!Array.isArray(c)) continue;
    for (const b of c as { type?: string; id?: string; tool_use_id?: string }[]) {
      if (r.type === "assistant" && b.type === "tool_use" && b.id) open.add(b.id);
      if (r.type === "user" && b.type === "tool_result" && b.tool_use_id) open.delete(b.tool_use_id);
    }
  }
  return open.size > 0;
}

/** Stop 时要不要补投原文：插进回合的（不可信包装、已出队）和没落盘的补；CC 自己会另起一轮投的、已正常投过的不补 */
export const needsRedeliver = (s: CcInsertState): boolean => s === "attached" || s === "absent";

const REDELIVER_TAG = "[↩︎ 补投：";
/** 补投原文的抬头：插进过回合的（attached）告诉目标之前以附件形式到过；没落盘的（absent）只说没确认送达 */
export function redeliverHead(s: CcInsertState): string {
  return s === "attached"
    ? `${REDELIVER_TAG}这条消息回合中已作为附件送达过（当时被当作不可信外部消息附在工具结果旁）。这里按普通消息投原文，请按正常请求处理。]`
    : `${REDELIVER_TAG}这条消息回合中送出过，但没确认你收到。这里按普通消息投原文，请按正常请求处理。]`;
}
export const isRedeliverText = (content: string): boolean => content.startsWith(REDELIVER_TAG);
