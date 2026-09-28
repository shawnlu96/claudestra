/**
 * 网页输入框 @ 发出的委托指令以 `[📨 委托转达]` / `[📨 Delegate]` 开头（web/lib/chat/mention-directive.ts），
 * 只有 owner 本人的消息末行才算数。peer、Web 访客、scoped token、别的 agent 转来的正文会原样落在 agent 看到的
 * 末行，如果不处理，外源就能冒充「用户委托」。所以投递给本地 agent 前，把非 owner 来源正文里的 `[📨` 换成全角 `［📨`：
 * agent 仍看得到原文，但它不再是标记（文档见 lib/agent-tool-docs.ts）。tests/delegate-marker.test.ts。
 */
import { OWNER_PRINCIPAL_ID } from "./devices.js";

/** owner 本人：Discord 上的放行用户在 agent 自己的频道里（kind=user），或 owner 设备共用的 owner:self 身份 */
export function isOwnerSource(from: { kind: string; tokenId?: string; peer?: string }): boolean {
  if (from.kind === "user") return true;
  return from.kind === "api" && !from.peer && from.tokenId === OWNER_PRINCIPAL_ID;
}

export function neutralizeDelegateMarker(content: string): string {
  return content.replace(/\[📨/gu, "［📨");
}
