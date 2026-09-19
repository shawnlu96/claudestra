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
 */
export interface LastSend {
  agent: string;
  wire: string;
  at: number;
}

export const SEND_DEDUPE_MS = 1_500;

/** 这次发送是否该被当成重复丢弃。 */
export function isDuplicateSend(
  last: LastSend | null,
  cur: { agent: string; wire: string; at: number; hasFiles?: boolean },
  windowMs = SEND_DEDUPE_MS,
): boolean {
  if (cur.hasFiles) return false;
  if (!last) return false;
  if (last.agent !== cur.agent || last.wire !== cur.wire) return false;
  const dt = cur.at - last.at;
  return dt >= 0 && dt < windowMs;
}
