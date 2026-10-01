/** 收件范围与凭据权限分开：未指派的 ask 归 owner，已指派的只归收件人。 */
export function isAskForAudience(
  ask: { assignee?: string | null },
  assignees: readonly string[] = ["local:owner:self"],
): boolean {
  return assignees.includes(ask.assignee || "local:owner:self");
}
