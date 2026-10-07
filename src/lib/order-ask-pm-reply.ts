/**
 * ASKPM1：执行者用 reply 按钮问本卡 PM 的提问（kind = decide、挂卡、extra.parent = 派发它的 PM）。以前只有 owner 在「待你处理」里点得掉，
 * 卡上的人工合并请求就一直停在「审批未答」。现在 PM 用 send_to_agent 回给提问的执行者、正文带 `ask <id>`，recordDefaultPmReply 一并记成
 * 「PM 已回复」。发送方是不是 bridge 验证过的本卡 PM、目标是不是提问的 agent，由 recordDefaultPmReply 照原口径核；这里只认提问本身。
 * authorize / owner_action / accept 永远不在此列（owner 专属，照旧只认 owner 本人）。tests/order-ask-pm-reply.test.ts。
 */
import type { Ask } from "./ledger-asks.js";

export const agentName = (s: string | null): string | null => s && (s.startsWith("agent-") || s === "master" ? s : `agent-${s}`);

/** 问的就是发送方本人：decide、挂卡、extra.parent 等于发送方 */
export const isPmParentAsk = (a: Ask, sender: string): boolean =>
  a.kind === "decide" && !!a.taskId && typeof a.extra.parent === "string" && !!a.extra.parent && agentName(a.extra.parent) === agentName(sender);
