/**
 * `pendingReplies` 的两个作用域判据。纯逻辑，单测在 tests/pending-reply-scope.test.ts。
 *
 * `pendingReplies` 以**回信地址**（replyBackChannel）为 key，值里的 `targetWs` 是
 * 「欠这条回复的那个 agent」。它同时支撑两件事：Stop hook 的补 reply 拦截
 * （lib/reply-nudge.ts）和 💭→✅ 的状态收尾。所以什么时候挂、什么时候销，
 * 判错一次就是「该催的不催」或「该欠的被别人销掉」。
 */

/**
 * 这条 envelope 要不要挂 pendingReply。
 *
 * ⚠ `skipInterAgentWatchdog` 是**共享**标记，不等于 oneShot：
 *   - bridge.ts 的 send_to_agent 里 `oneShot || undefined`（本判据要挡的就是它）；
 *   - bridge/api-routes.ts 的 HTTP 入站 **恒 true**（注释：「API 请求不需要
 *     inter-agent watchdog（有自己的 wait/轮询语义）」）。
 * 只看这个标记就跳过挂载，会顺手把**每一条 Web/API 消息**的 pendingReply 也取消 ⇒
 * 「agent 结束回合却没 reply」的 Stop 拦截对整个 Web 端失效（owner 的流量 100% 走
 * Web）。所以必须再要求来源是 local——只有 agent→agent 的 oneShot 才是真不期待回应。
 */
export function hangsPendingReply(
  intent: string,
  fromKind: string,
  skipInterAgentWatchdog: boolean | undefined,
): boolean {
  if (intent !== "request") return false;
  return !(fromKind === "local" && skipInterAgentWatchdog === true);
}

/**
 * 这条挂起的 pendingReply 是不是「本 agent 自己欠的」——只有自己欠的才轮得到自己销账。
 *
 * ⚠ key 是回信地址而不是欠账人：B 给 C 发过请求时，`pendingReplies[B 的频道]` 的
 *   `targetWs` 是 **C**。此时 A 也给 B 发消息，若无条件 delete 就把 C 的欠账销了 ⇒
 *   C 的 Stop 不再被拦、B 永远等不到答复。与 lib/pushback-scope.ts 同一条纪律：
 *   频道对得上不等于人对得上。
 */
export function ownsPendingReply(pendingTargetWs: unknown, senderWs: unknown): boolean {
  if (pendingTargetWs === undefined || pendingTargetWs === null) return false;
  return pendingTargetWs === senderWs;
}
