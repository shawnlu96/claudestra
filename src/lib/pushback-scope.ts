/**
 * send_to_agent 回推的**归属判据**：一段文字到底是不是 target 本人产出的答复。
 * 纯逻辑，单测在 tests/pushback-scope.test.ts。
 *
 * ## 背景
 *
 * `pendingAgentCalls` 以 **target 的 channelId** 为 key。两个消费点原先都只按
 * 「频道对得上」取 pending，**完全没验证这段文字是谁产出的**：
 *
 * ```ts
 * const pending = pendingAgentCalls.get(msg.chatId);        // reply 路径
 * const pendingAgent = pendingAgentCalls.get(cid);          // Stop drain 路径
 * ```
 *
 * 于是任何 agent 只要 reply 到 target 的频道，**它自己那条**就会被当成 target 的
 * 答复推回给 caller——带 `intent=response`、带「对方答复如下，请按计划继续」、还
 * 附上 caller 自己填的 `expecting`。
 *
 * owner 2026-09-18 实报（稳定复现，一晚上撞了十几次）：
 *   > 它一度以为我回了并准备据此动手，靠「看 git 有没有新提交」才识破；
 *   > 我这边也收到过好几条正文逐字是我自己写的「答复」。
 *
 * 这比丢消息更危险：caller 拿到的是一条**看起来完全合法**的答复（格式、前缀、
 * expecting 提醒一应俱全），没有任何迹象表明它是自己的回声，于是会据此往下动手。
 *
 * ## 判据
 *
 * key 既然就是 target 的 channelId，那么「是 target 本人」等价于
 * **产出方自己的频道 == 那个 key**。两条路径各有一个自然的产出方标识：
 *   - reply 路径：发这条 reply 的 channel-server 反查出来的 `fromChannelId`
 *   - Stop drain 路径：Stop hook 报的 `channelId`（以及与它同 ws 的频道）
 *
 * ⚠ Stop drain 那条必须额外防一手：`channelsToClear` 里除了本 agent 自己的频道，
 * 还塞了 `pendingReplies` 里 **别人的** `intendedReplyChannel`（为了把「💭 思考中」
 * 改成「✅ 完成」）。拿那些频道去取 pending，等于用 A 的收尾去回答 B 的提问。
 */

/**
 * reply 路径：这条 reply 算不算「target 自己在自己频道里发了答案」。
 *
 * @param replyToChatId  reply 的目的 chat_id（也就是 pendingAgentCalls 的 key 候选）
 * @param replierChannelId 发这条 reply 的 agent 自己的频道（ws 反查所得）
 */
export function isTargetsOwnReply(
  replyToChatId: string,
  replierChannelId: string,
  replierWs?: unknown,
  targetWs?: unknown,
): boolean {
  if (!replyToChatId) return false;
  if (replierChannelId && replyToChatId === replierChannelId) return true;
  // ⚠ 一个 ws 可能挂多条频道（见 bridge.ts 的 sameWsChannels）。ws→频道的反查只取
  //   第一条命中，所以 fromChannelId 可能是同一个 agent 的**另一条**频道——这时
  //   频道号对不上，但产出方确实是 target 本人，不能把它的答复丢掉。
  // ⚠ 两边都认不出 ws 时 `undefined === undefined` 会误判成真，必须先要求 replierWs 存在
  if (replierWs === undefined || replierWs === null) return false;
  return targetWs === replierWs;
}

/**
 * Stop drain 路径：`channelsToClear` 里的这条频道，算不算「本轮结束的这个 agent 自己的」。
 *
 * 同一个 ws 可能挂多个频道（sameWsChannels），那些仍然是同一个 agent，算自己的；
 * 别人的 intendedReplyChannel 不算。
 *
 * @param candidateChannelId channelsToClear 里的某一条
 * @param stopChannelId      Stop hook 报上来的频道
 * @param stopWs             stopChannelId 当前注册的 ws（认不出来时传 undefined）
 * @param candidateWs        candidateChannelId 当前注册的 ws
 */
export function isOwnStopChannel(
  candidateChannelId: string,
  stopChannelId: string,
  stopWs: unknown,
  candidateWs: unknown,
): boolean {
  if (!candidateChannelId) return false;
  if (candidateChannelId === stopChannelId) return true;
  // ⚠ 两边都认不出 ws 时 `undefined === undefined` 会误判成真，必须先要求 stopWs 存在
  if (stopWs === undefined || stopWs === null) return false;
  return candidateWs === stopWs;
}
