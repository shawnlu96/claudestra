import { machines } from "@/lib/machines";
import { isAskForAudience } from "./ask-audience";

/** 设备身份来自配对；合并过的 guest 别名由 bridge 的 canAnswer 确认，owner 的代答权限不能扩大收件范围。 */
export function isAskForViewer(ask: { assignee?: string | null; canAnswer?: boolean }): boolean {
  const principal = machines.current()?.principalId ?? "owner:self";
  const aliases = [`local:${principal}`];
  if (principal.startsWith("guest:") && ask.canAnswer === true && ask.assignee) aliases.push(ask.assignee);
  return isAskForAudience(ask, aliases);
}
