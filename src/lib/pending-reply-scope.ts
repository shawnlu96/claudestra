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

/** 叫停时作废的一条请求：它的 messageId，发送方是本地 agent 时再带上它的频道 */
export interface VoidedRequest {
  messageId: string;
  agentChannel?: string;
}

/** dropVoidedPendings 要动的几本账（字段名就是 bridge.ts 里的变量名：补答账、thread 追踪、inter-agent 看门狗、回程簿） */
export interface VoidableBooks {
  pendingReplies: Map<string, { msgId: string; threadId?: string }>;
  pendingThreads: Map<string, unknown>;
  pendingInterAgentMsg: Map<string, { fromChannelId?: string; ts: number }>;
  pendingAgentCalls: { dropRequest(target: string, caller: string, messageId: string): void };
  /** API 请求队列（bridge/pi-abort.ts holdStopWait 看停字自己有没有在同步等待） */
  pendingApiRequests?: Map<string, ApiWait[]>;
}

/**
 * Pi 叫停时作废的消息（bridge/pi-abort.ts）从账上销掉，返回销掉几条。发送方已被告知「不会执行」，补 reply 拦截或看门狗再催 Pi 处理它
 * 就自相矛盾，还会把刚停住的 Pi 拉起来。补答账按 msgId 认（连同它的 thread）；看门狗以接收方频道为 key、只记最后一个发送方，
 * 只在它就是作废消息的 agent、且挂在叫停之前时销（叫停之后它又发来的是新请求）；回程槽只撤这一条。tests/pending-reply-scope.test.ts。
 */
export function dropVoidedPendings(books: VoidableBooks, channelId: string, voided: readonly VoidedRequest[], abortAt: number): number {
  const ids = new Set(voided.map((v) => v.messageId));
  let n = 0;
  for (const [key, p] of books.pendingReplies) {
    if (!ids.has(p.msgId) || !books.pendingReplies.delete(key)) continue;
    if (p.threadId) books.pendingThreads.delete(p.threadId);
    n++;
  }
  const w = books.pendingInterAgentMsg.get(channelId);
  const bySender = voided.some((v) => !!v.agentChannel && v.agentChannel === w?.fromChannelId);
  if (w && bySender && w.ts <= abortAt && books.pendingInterAgentMsg.delete(channelId)) n++;
  for (const v of voided) if (v.agentChannel) books.pendingAgentCalls.dropRequest(channelId, v.agentChannel, v.messageId);
  return n;
}

/** 认领要看的字段；siblingThreadId = 它等着时 agent 的回复记到了同一调用方的另一条（那条的 threadId），Stop 兜底据此说明「没单独答复」 */
type ApiQueued = { messageId?: string; threadId: string; siblingThreadId?: string };
/** 已结掉的 API 请求（apiThreadResults 的条目，按形状收）：reply 空着 = 调用方还在轮询这个 thread 等补答（peer 空回合后盯 2 小时） */
type ApiSettled = { result: { reply: string | null }; ts: number; tokenId?: string; agentChannelId?: string; messageId?: string };
export interface ApiReplyClaim<T> { taken?: T; threadId?: string; warning?: string; error?: string }

/**
 * 出站回复认领挂着的哪条 API 请求（队列按 token + agent 频道分、按到达顺序）。inReplyTo（bridge 的作废回显）/ replyTo（agent 的 reply_to）
 * 只认那一条，对不上谁也不认：落到同一 token 的另一条上，那条的等待就拿到了别人的答复（adv5）。都没给：认 agent 看到过的最新一条——
 * 它答的通常是最近那条，押着还没送到它手上的（unseen）不算；一条都没看到过才退回最早一条（单条时与改前一致）。waiting = 剩下看到过的。
 */
function takeApiPending<T extends ApiQueued>(queue: T[], id: string | undefined, unseen?: ReadonlySet<string | undefined>): { taken?: T; waiting: T[] } {
  const seen = (p: T) => !p.messageId || !unseen?.has(p.messageId);
  const newestSeen = queue.findLastIndex(seen);
  const k = id ? queue.findIndex((p) => p.messageId === id) : newestSeen >= 0 ? newestSeen : queue.length ? 0 : -1;
  const taken = k >= 0 ? queue.splice(k, 1)[0] : undefined;
  return { taken, waiting: queue.filter(seen) };
}

/**
 * agent 发往 api:<token> 的回复记到哪：认领到在等的请求（同一调用方还有别的在等时给它们记 siblingThreadId，没指明回哪条就在 warning 里列出）；
 * reply_to 指向已结掉、结果还空着的那条 → 写回它的 thread（调用方还在轮询，能真正送到）；都不是 → peer 只收它在等的请求的答复，报错不投；
 * 网页 / API 调用方经事件流也收得到主动消息，照投，reply_to 对不上时提醒没记到请求上。tests/api-reply-claim.test.ts。
 */
export function claimApiReply<T extends ApiQueued>(queue: T[], settled: Map<string, ApiSettled>, by: {
  tokenId: string; channelId: string; peer?: string; inReplyTo?: string; replyTo?: string; unseen?: ReadonlySet<string | undefined>; now?: number;
}): ApiReplyClaim<T> {
  const { taken, waiting } = takeApiPending(queue, by.inReplyTo ?? by.replyTo, by.unseen);
  if (by.inReplyTo) return { taken }; // 作废回显不是 agent 的答复：不记、不提醒
  const ids = waiting.map((w) => w.messageId ?? w.threadId).join("、");
  if (taken) {
    // 就地写：条目同时被 HTTP 那头的同步等待（entry.resolve）和 Stop 快照（按对象认）引用，换成副本它们就看不到了
    for (const w of waiting) w.siblingThreadId = taken.threadId;
    if (by.replyTo || !waiting.length) return { taken };
    return { taken, warning: `同一调用方有 ${waiting.length + 1} 条请求在等，这条回复记到了最新的 ${taken.messageId}；还在等：${ids}。`
      + `已经一并答了就不用再做什么（回合结束时它们会收到「本回合没有单独答复」的说明）；要分别答复就带 reply_to=<message_id> 再 reply` };
  }
  const mine = [...settled].filter(([, s]) => s.messageId && s.tokenId === by.tokenId && s.agentChannelId === by.channelId);
  const prev = by.replyTo ? mine.find(([, s]) => s.messageId === by.replyTo) : undefined;
  if (prev && !prev[1].result.reply?.trim()) return { threadId: prev[0] };
  const ago = prev ? `${Math.max(1, Math.round(((by.now ?? Date.now()) - prev[1].ts) / 60_000))} 分钟前` : "";
  const why = !by.replyTo ? `api:${by.tokenId} 现在没有在等你答复的请求`
    : prev ? `reply_to=${by.replyTo} 那条请求${ago}已经回过（agent 的答复或 bridge 兜底），对方已取走、不再等待`
    : `reply_to=${by.replyTo} 对不上 api:${by.tokenId} 在等的请求（已答过、已超时被清掉，或不是这个调用方的）`;
  const owed = mine.filter(([, s]) => !s.result.reply?.trim()).map(([, s]) => s.messageId).join("、");
  const rest = (waiting.length ? `；还在等：${ids}，要答它们就带 reply_to=<message_id>` : "")
    + (owed ? `；之前回合没答上、对方还在轮询等补答的：${owed}，带 reply_to=<message_id> 补答能送到` : "");
  if (by.peer) return { error: `${why}${rest}。peer 只收得到它在等的请求的答复，这次回复对方收不到，没有投递` };
  if (!by.replyTo) return {}; // 网页 / API 调用方的主动消息经事件流送达，照旧
  return { warning: `${why}${rest}。这次回复没有记到任何请求上，只经事件流送达：网页看得到，靠 wait / 轮询取答复的调用方收不到` };
}

type ApiWait = { messageId?: string; waitUntil?: number; resolve?: unknown };

/**
 * Stop 兜底收尾要结掉的 API 请求（从账上拿走），skip 里的留在队里：Pi 叫停引起的那次 Stop 不结停字自己的同步等待，
 * 留给停字那一轮去答（adv5 P2-1，bridge/pi-abort.ts stopWaitIds）。
 */
export function apiQueueToSettle<T extends ApiWait>(queues: Map<string, T[]>, key: string, skip: ReadonlySet<string>, only?: ReadonlySet<T>): T[] {
  const q = queues.get(key) ?? [];
  // only：这一回合开始收尾时就在的那批（bridge Stop 开头拍的快照）；之后才挂上的请求不是这一回合的，留着
  const keep = q.filter((p) => (!!p.messageId && skip.has(p.messageId)) || (only !== undefined && !only.has(p)));
  if (keep.length) queues.set(key, keep);
  else queues.delete(key);
  return q.filter((p) => !keep.includes(p));
}
