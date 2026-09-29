/**
 * 「待你处理」谁能看、谁能答（docs 13 §4.7 + T11b 第 3 条）：全仓只有这一份，列表（local-api/asks.ts）、SSE（ledger-feed.ts）、
 * 推送（push/dispatcher.ts）、作答（ask-entry.ts）都调它，T28a 复用。改口径只改这里，tests/ask-access.test.ts 的矩阵一起改。
 * - 看：指给自己的（assignee = local:<本人 principal id> 或合并过的同一个人，guest 也算，不经过台账的门）；其余走 canReadLedger，大总管的另要 scope 含 master。
 * - 答：assignee 本人，或 owner 本人（isOwnerPrincipal）且看得见。peer 一律不行（远端的人不能作答我方的 ask，T28 Q15）。
 */
import { canReadLedger } from "./devices.js";
import type { Ask } from "./ledger-asks.js";
import { agentInScope, isOwnerPrincipal, type Principal } from "./principals.js";
import { isMasterName } from "./registry.js";

type AskWho = Pick<Ask, "fromAgent" | "assignee">;

/** 人的 assignee 写法（T8h cd914851 的 HUMAN_RE 同形）：local:<principalId> */
export const humanAssignee = (principalId: string): string => `local:${principalId}`;

/** 凭据 → 它算作的 assignee：同一个人合并过的设备都算（talk 的 people 表，bridge/talk.ts 注入）；没注入只认本人 */
let assigneesOfId = (principalId: string): readonly string[] => [humanAssignee(principalId)];
export function setAskAssigneesOf(fn: (principalId: string) => readonly string[]): void {
  assigneesOfId = fn;
}
export const assigneesOf = (p: Principal): readonly string[] => assigneesOfId(p.id);

/** 这条是不是指给这个凭据本人的 */
export function isAskAssignee(p: Principal, a: Pick<Ask, "assignee">): boolean {
  return !!a.assignee && !p.peer && !p.disabled && assigneesOf(p).includes(a.assignee);
}

/**
 * SSE ask 事件（bridge/asks.ts publishAsk 的 data 带 fromAgent / assignee）→ 判定要的那两项。data 里没有 fromAgent 这个键的
 * （老的发法）按事件的 agent 算，别让大总管的 ask 因为少了字段漏给不含 master 的凭据
 */
export function askWhoOf(data: unknown, agent = ""): AskWho {
  const d = (data ?? {}) as Record<string, unknown>;
  const from = "fromAgent" in d ? d.fromAgent : agent;
  return { fromAgent: typeof from === "string" && from ? from : null, assignee: typeof d.assignee === "string" ? d.assignee : null };
}

/** 被禁用的 principal 什么都看不见（鉴权本来就挡在前面，这里再兜一层：推送认人读的是最多 60 s 前的 principals.json） */
export function canSeeAsk(p: Principal, a: AskWho): boolean {
  if (p.disabled) return false;
  if (isAskAssignee(p, a)) return true;
  return canReadLedger(p) && (!isMasterName(a.fromAgent) || agentInScope(p, "master"));
}

export function canAnswerAsk(p: Principal, a: AskWho): boolean {
  if (isAskAssignee(p, a)) return true;
  return isOwnerPrincipal(p) && canSeeAsk(p, a);
}
