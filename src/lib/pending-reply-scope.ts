/**
 * `pendingReplies` / `pendingThreads` 的作用域判据。纯逻辑，单测在 tests/pending-reply-scope.test.ts。
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

/** `pendingReplies` 里判断归属只需要这两个字段 */
export interface OwedEntry {
  /** 欠这条回复的 agent 的 ws */
  targetWs: unknown;
  /** 该回给谁（Discord 频道 id，或 Web/API 的 `api:<tokenId>`） */
  intendedReplyChannel: string;
}

/**
 * 「这个 agent 欠这个地址的那些账」的 key 列表。
 *
 * ⚠ 为什么不能按地址直接 `get`/`delete`：`pendingReplies` 曾以**回信地址**为 key，
 * 而 Web/API 用户的回信地址是 `api:<tokenId>`——**同一个 token 跟几个 agent 说话
 * 共用这一个 key**。后果有两层，2026-09-22 两条都实测到了：
 *   1. 任何一个 agent 回复这个用户，`delete(chatId)` 就把别的 agent 的欠账一起销了
 *      （mm-pm 的 1267 字答复因此全渲染成灰字旁白——它的 Stop 拦截被别人拆了）；
 *   2. 同一个 token **同时**问两个 agent 时，后挂的直接覆盖先挂的，先被问的那个
 *      即使没人 reply 也不会被拦。
 * 所以 key 改成 threadId（每条请求天生唯一，与 `pendingThreads` 对齐），销账一律
 * 走这里：**按「欠账人 + 回信地址」找**，找出几条销几条。
 */
export function pendingKeysOwedBy<T extends OwedEntry>(
  entries: Iterable<[string, T]>,
  debtorWs: unknown,
  replyChannel: string,
): string[] {
  if (debtorWs === undefined || debtorWs === null || !replyChannel) return [];
  const keys: string[] = [];
  for (const [key, p] of entries) {
    if (p.targetWs === debtorWs && p.intendedReplyChannel === replyChannel) keys.push(key);
  }
  return keys;
}

/**
 * Stop 的「补 reply」拦截追不追这条欠账：agent 来源（from.kind=local，含 master）不追——它们的答复走
 * send_to_agent / 回程簿推回，看门狗兜底；逼它 reply 到对方频道只会多出一次 forward（第三条路）。
 * 人类、peer（没有回程簿）、bridge 来源照旧拦。挂载本身不变：💭→✅ 的状态收尾还要用。
 */
export function nudgesForOrigin(fromKind: string | undefined): boolean {
  return fromKind !== "local";
}

/** pendingThreads 里判断「和某频道有关」只需要请求的两端 */
export interface ThreadEnds {
  request: { from: { kind: string; channelId?: string }; to: { kind: string; channelId?: string } };
}

/**
 * agent 被永久 kill（/agent/cleanup）后，和它的频道有关的欠账全部销掉，返回销掉的条数：
 * - pendingReplies：回信地址是它的频道——它发出的请求，别人还欠着答复；不销的话欠账人的 Stop 会被逼着 reply 到已删的频道；
 * - pendingThreads：发给它的，和由它发起的；
 * - inter-agent 看门狗：它发给别人、对方还没回应的（看门狗以接收方频道为 key，不销的话对方下次 Stop 会被催着回一个已销毁的 agent）。
 * 发给它、它自己欠着的 pendingReplies 不在这里：它的 ws 已经没了，Stop 不会再来。
 */
export function dropPendingsForChannel(
  replies: Map<string, { intendedReplyChannel: string }>,
  threads: Map<string, ThreadEnds>,
  watchdogs: Map<string, { fromChannelId?: string }>,
  channelId: string,
): number {
  let n = 0;
  for (const [key, p] of replies) if (p.intendedReplyChannel === channelId && replies.delete(key)) n++;
  for (const [key, w] of watchdogs) if (w.fromChannelId === channelId && watchdogs.delete(key)) n++;
  for (const [tid, t] of threads) {
    const { from, to } = t.request;
    const touches = (from.kind === "local" && from.channelId === channelId) || (to.kind === "local" && to.channelId === channelId);
    if (touches && threads.delete(tid)) n++;
  }
  return n;
}

/**
 * agent→agent 消息送达时要不要给接收方挂 inter-agent 看门狗（Stop 时没回应就催一次）。
 * 发送方已不在册（被 kill；押在队列里的消息在它死后才投出）就不挂——内容照投，但催接收方回一个已销毁的 agent 没有意义。
 * 「在册」看 registry 而不是看 ws 在不在：bridge 刚重启、发送方还在重连退避时 ws 不在，但它没死。
 * 发给自己（同一个 ws）和 oneShot（skipInterAgentWatchdog）也不挂。
 */
export function hangsInterAgentWatchdog(sameWs: boolean, skipWatchdog: boolean | undefined, senderRegistered: boolean): boolean {
  return !sameWs && !skipWatchdog && senderRegistered;
}
