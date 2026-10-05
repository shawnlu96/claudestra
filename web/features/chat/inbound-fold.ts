/**
 * 外源入站气泡默认折叠（owner 2026-10-06「pm 内的这种 agent 发来的信息默认折叠」）：机器发来的长消息（执行者复述、
 * 交付报告）整条铺开会占满一屏，只露两行预览 + 展开。本人、真人（Discord / guest）、peer-<token>（背后可能是人）不折。
 * 渲染在 components/narration-fold.tsx InboundBody；单测 tests/web-inbound-fold.test.ts。
 */
import { parseSource } from "./source-label";

/** 两行以内且不超过这么多字的不出折叠条（手机气泡一行约 20 个汉字，折了也省不出地方） */
export const INBOUND_FOLD_MIN_CHARS = 80;

/** from = 入站气泡的来源标签（本人的没有）；text = 去掉引用条后的正文 */
export function foldsInbound(from: string | undefined, text: string): boolean {
  if (!from) return false;
  const kind = parseSource(from).kind;
  if (kind !== "agent" && kind !== "peer-reply" && !/^bridge(:|$)/.test(from)) return false;
  const body = text.trim();
  return body.split("\n").length > 2 || body.length > INBOUND_FOLD_MIN_CHARS;
}
