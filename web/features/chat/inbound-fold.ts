/**
 * 外源入站气泡默认折叠（owner 2026-10-06「pm 内的这种 agent 发来的信息默认折叠」）：机器发来的长消息（执行者复述、
 * 交付报告）整条铺开会占满一屏，只露两行预览 + 展开。本人、真人（Discord / guest）不折。
 * peer-<token> 入站只带正文、没有人机标记，只认对方自动发件的固定抬头；认不出按真人算不折（宁可不折，别收起人的话）。
 * 渲染在 components/narration-fold.tsx InboundBody；单测 tests/web-inbound-fold.test.ts。
 */
import { parseSource } from "./source-label";

/** 两行以内且不超过这么多字的不出折叠条（手机气泡一行约 20 个汉字，折了也省不出地方） */
export const INBOUND_FOLD_MIN_CHARS = 80;

/** 对方 bridge 自动发件的抬头：调度器 PR 推送（src/lib/peer-pr-message.ts）、扩围自动批准（src/lib/order-ask-default.ts tellText） */
const PEER_MACHINE_HEAD = /^(\[Claudestra 调度器[ ·\]]|【自动定】)/;

/** from = 入站气泡的来源标签（本人的没有）；text = 去掉引用条后的正文 */
export function foldsInbound(from: string | undefined, text: string): boolean {
  if (!from) return false;
  const body = text.trim();
  const kind = parseSource(from).kind;
  const machine = kind === "agent" || kind === "peer-reply" || /^bridge(:|$)/.test(from) || (kind === "peer-notify" && PEER_MACHINE_HEAD.test(body));
  return machine && (body.split("\n").length > 2 || body.length > INBOUND_FOLD_MIN_CHARS);
}
