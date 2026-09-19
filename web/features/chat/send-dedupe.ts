/**
 * v2.23.2+ 重复发送闸（owner 2026-09-19 实录：guoqing-trip 同一句话 0.7s 内发了两遍，
 * 第二条还触发了对 agent 的「抢占打断」，把正在跑的回合打断了一次）。
 *
 * 触屏上「发送」走两条路——pointerup 直接执行（3601ee6，为绕开 WebKit 合成 click 的
 * 700ms 延迟）与 click 兜底——各自有防重窗口；但用户手指连点、iOS 听写补发、以及未来
 * 新增的任何触发路径都可能再绕出一条。与其逐条堵，不如在唯一出口 send() 上装一道闸：
 * **同一 agent + 完全相同的 wire 载荷 + 1.5s 内 = 丢弃第二次**。
 *
 * 阈值取 1.5s：人不会在 1.5 秒内故意把同一句话发两遍（真要重复也是隔几秒重打），
 * 而所有已知的误重发都在 1s 内。带附件的发送不参与（同名文件重发是合法操作）。
 *
 * 2026-09-19 第二例（同一天、同一会话）：两条正文**只差标点**——
 * 「…买哪一种票。…槟城。这两站」vs「…买哪一种票？…槟城这两站」，间隔 2.16s。这是 iOS 听写：
 * 发送清空输入框后，听写把最终稿（标点已润色）又写回框里，用户以为没发出去再点一次。
 * 所以除了「逐字相同 + 1.5s」，再加一档「**去标点空白后相同 + 5s**」——同一句话的两个
 * 听写版本必然归一后相等，而真要改内容至少会换掉实词，归一后仍不同。
 */
export interface LastSend {
  agent: string;
  wire: string;
  at: number;
}

export const SEND_DEDUPE_MS = 1_500;
/** 归一后相同（听写两稿）的宽窗：用户重新点发送要慢一些 */
export const SEND_DEDUPE_LOOSE_MS = 5_000;

/**
 * 归一：去掉所有空白与常见中英标点，只留实义字符。
 * 「票。到底」与「票？到底」归一后相同；换了实词则仍不同。
 */
export function normalizeForDedupe(s: string): string {
  return s.replace(/[\s]+/g, "").replace(/[.,!?;:'"`~、。，！？；：…—－·「」『』（）()【】\[\]{}<>《》]+/g, "");
}

/** 这次发送是否该被当成重复丢弃。 */
export function isDuplicateSend(
  last: LastSend | null,
  cur: { agent: string; wire: string; at: number; hasFiles?: boolean },
  windowMs = SEND_DEDUPE_MS,
  looseWindowMs = SEND_DEDUPE_LOOSE_MS,
): boolean {
  if (cur.hasFiles) return false;
  if (!last) return false;
  if (last.agent !== cur.agent) return false;
  const dt = cur.at - last.at;
  if (dt < 0) return false;
  if (last.wire === cur.wire) return dt < windowMs;
  // 归一后相同 = 同一句话的两个听写/修订稿。空串不参与（纯标点消息别互相吞）。
  const a = normalizeForDedupe(last.wire);
  if (!a) return false;
  return a === normalizeForDedupe(cur.wire) && dt < looseWindowMs;
}
