/**
 * ASKPM1：执行者用 reply 按钮问本卡 PM 的提问（kind = decide、挂卡、extra.parent = 派发它的 PM）。以前只有 owner 在「待你处理」里点得掉，
 * 卡上的人工合并请求就一直停在「审批未答」。现在 PM 用 send_to_agent 回给提问的执行者、正文带 `ask <id>`，recordDefaultPmReply 一并记成
 * 「PM 已回复」。发送方是不是 bridge 验证过的本卡 PM、目标是不是提问的 agent，由 recordDefaultPmReply 照原口径核；这里只认提问本身。
 * authorize / owner_action / accept 永远不在此列（owner 专属，照旧只认 owner 本人）。tests/order-ask-pm-reply.test.ts。
 */
import type { Database } from "bun:sqlite";
import type { Ask } from "./ledger-asks.js";
import { getMeta } from "./ledger-store.js";
import { activeProjectPm } from "./pm-role.js";

export const agentName = (s: string | null): string | null => s && (s.startsWith("agent-") || s === "master" ? s : `agent-${s}`);

/** ASKPM2：写的 PM（task.pm / extra.parent）认发送方：字面相等，或写的是本项目 PM 名单里的（调度员除外，同 pmRedirect）、发送方是当班 PM */
export function pmStandsFor(db: Database, project: string, written: string | null, sender: string): boolean {
  const meta = getMeta(db, project), on = (p: string | null) => !!p && agentName(p) === agentName(sender);
  return on(written) || (!!written && written !== meta.team?.dispatcher && meta.pms.some((p) => agentName(p) === agentName(written)) && on(activeProjectPm(db, project)));
}
/** 问的就是发送方本人：decide、挂卡、extra.parent 等于发送方 */
export const isPmParentAsk = (db: Database, a: Ask, sender: string): boolean =>
  a.kind === "decide" && !!a.taskId && typeof a.extra.parent === "string" && pmStandsFor(db, a.project, a.extra.parent, sender);
