/** 能被判收件人的最小字段：extra 只读 priorityStall 提醒用到的两项。 */
export interface AudienceAsk {
  assignee?: string | null;
  extra?: { mechanism?: unknown; pm?: unknown } | null;
}

/**
 * 收件人：显式 assignee 优先；历史上没写 assignee 的 priorityStall 提醒是调度器给 PM 的，按 extra.pm 收件。
 * 只认这一种——放宽成「所有系统 ask」会把 owner 授权卡也挪出 owner 待办。其余未指派的归 owner。
 */
function askRecipient(ask: AudienceAsk): string {
  if (ask.assignee) return ask.assignee;
  const pm = ask.extra?.mechanism === "priorityStall" ? ask.extra.pm : null;
  return typeof pm === "string" && pm ? pm : "local:owner:self";
}

/** 收件范围与凭据权限分开：未指派的 ask 归 owner，已指派的只归收件人。 */
export function isAskForAudience(ask: AudienceAsk, assignees: readonly string[] = ["local:owner:self"]): boolean {
  return assignees.includes(askRecipient(ask));
}
