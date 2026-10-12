/**
 * reply 发到 `api:<tokenId>` 时这个 token 还收不收得到（bridge.ts deliverToApi 在认领请求之前调；tests/api-reply-target.test.ts）。
 * token 已删除 / 已停用就返回原因，deliverToApi 报错、请求不出队。不拦的话：删掉的 token 查不到 principal，被当成网页调用方照投；
 * 停用的 peer 旧 token 上撤销前挂着的请求还能被认领，结果记在旧 token 名下，对方换了新 token 轮询不到——两种 agent 都看到 Sent。
 * 撤销立刻生效：对方还有同步等待开着也不投。有效 token 不归这里管（peer 没在等的请求见 lib/pending-reply-scope.ts claimApiReply）。
 * 开头核过之后、登记附件期间才撤销的，由下面的 settleApiReply 在交结果前拦下。
 */
import { OWNER_PRINCIPAL_ID } from "./devices.js";
import { activePeerTokens } from "./peer-tidy.js";
import { findByTokenId, readPrincipalsStrict, readPrincipalsStrictSync, type PrincipalsFile } from "./principals.js";

/** peer 的旧 token：附同一 peer 当前启用的那一个 chat_id（token id 不是密钥）；启用的不止一个或没有就不猜、不列 */
function disabledReason(file: PrincipalsFile, tokenId: string, peer?: string): string {
  if (!peer) return `api:${tokenId} 的 token 已停用，这条回复没有投递。`;
  const live = activePeerTokens(file.principals).filter((t) => t.peer === peer);
  const now = live.length === 1 ? `对方现在发来的消息 chat_id 是 api:${live[0]!.tokenId}；` : "";
  return `api:${tokenId} 是 peer「${peer}」已停用的旧 token（对方重新配对过，或已被移除），这条回复没有投递。`
    + `${now}要主动联系对方，用 send_to_agent(target="<对方 agent>@${peer}")。`;
}

/** null = token 还在用。owner:self 永不拦：owner 没配对过设备时 principals 里没有它，网页照样收得到 */
export function deadApiTargetReason(file: PrincipalsFile, tokenId: string): string | null {
  if (tokenId === OWNER_PRINCIPAL_ID) return null;
  const p = findByTokenId(file, tokenId);
  if (!p) return `api:${tokenId} 的 token 不存在（已删除或撤销），这条回复没有投递。`;
  return p.disabled ? disabledReason(file, tokenId, p.peer) : null;
}

const unverified = (tokenIds: string): string => `⚠️ 发往 api:${tokenIds} 的回复没能核对 token 状态（principals.json 读不出来），按放行处理`;

/**
 * 读 principals.json 再判。文件损坏（strict 读抛错）时放行：一次读盘失败不该把 owner 的正常回复也挡掉；
 * 日志只写 token id 和原因——错误原文带路径和解析片段，可能夹着文件内容。文件不存在 = 没有任何 token，照常判。
 */
export async function deadApiTarget(
  tokenId: string, read: () => Promise<PrincipalsFile> = readPrincipalsStrict, log: (msg: string) => void = console.error,
): Promise<string | null> {
  if (tokenId === OWNER_PRINCIPAL_ID) return null;
  let file: PrincipalsFile;
  try {
    file = await read();
  } catch {
    log(unverified(tokenId));
    return null;
  }
  return deadApiTargetReason(file, tokenId);
}

/**
 * 一次同步快照判一批 token，返回还收得到的（Stop 兜底，bridge/stop-settle.ts takeLiveApiWaiters；判定和上面是同一个）。
 * 同步是为了让调用方把「核对、出队、交结果」放在同一段同步代码里：逐个 await 着判的话，先判过的 token 在等后面的读盘时被撤销，
 * 名单里还留着它，这一轮的文字照样交出去。全是 owner:self 不读盘；读坏时全部放行，日志同上。
 */
export function liveApiTargets(
  tokenIds: readonly string[], read: () => PrincipalsFile = readPrincipalsStrictSync, log: (msg: string) => void = console.error,
): Set<string> {
  const checked = tokenIds.filter((id) => id !== OWNER_PRINCIPAL_ID);
  const file = checked.length ? snapshot(checked.join("、api:"), read, log) : null;
  return new Set(file ? tokenIds.filter((id) => !deadApiTargetReason(file, id)) : tokenIds);
}

/** 同步读一版 principals.json；读坏返回 null，调用方按放行处理（日志和 deadApiTarget 是同一句） */
function snapshot(tokenIds: string, read: () => PrincipalsFile, log: (msg: string) => void): PrincipalsFile | null {
  try {
    return read();
  } catch {
    log(unverified(tokenIds));
    return null;
  }
}

/** 挂着的一条 API 请求、已结掉的结果，按形状收（bridge/api-routes.ts 的 PendingApiRequest 与 apiThreadResults；lib 不 import bridge） */
interface ApiPending<R> { ts: number; messageId?: string; agentChannelId?: string; resolve?: (result: R) => void }
type ApiSettled<R> = { result: R; ts: number; tokenId?: string; messageId?: string; agentChannelId?: string };

export interface ApiReplySettle<R, W extends ApiPending<R>> {
  tokenId: string;
  threadId: string;
  result: R;
  /** 开头认领走的那条（claimApiReply 的 taken）；没有 = 写回旧 thread 或主动消息 */
  pending?: W;
  results: Map<string, ApiSettled<R>>;
  /** pending 原来所在的队列：核不过时放回去 */
  queues: Map<string, W[]>;
  key: string;
}

/**
 * deliverToApi 交结果的那一步，同步：再核一次 token，还有效才记结果、resolve 等待。开头那次核对之后还要 await 着登记附件
 * （拷文件、算 sha256），期间 token 被删除 / 停用的话，不在这里再核就照样交给旧 token。返回原因 = 没交：认领走的请求按到达时间
 * 放回队里，和开头就被拦住一样留给超时。返回 null 之后调用方到发事件之间不能再有 await。tests/api-reply-late-token.test.ts。
 */
export function settleApiReply<R, W extends ApiPending<R>>(
  o: ApiReplySettle<R, W>, read: () => PrincipalsFile = readPrincipalsStrictSync, log: (msg: string) => void = console.error,
): string | null {
  const file = o.tokenId === OWNER_PRINCIPAL_ID ? null : snapshot(o.tokenId, read, log);
  const dead = file && deadApiTargetReason(file, o.tokenId);
  if (dead) {
    if (o.pending) requeue(o.queues, o.key, o.pending);
    return dead;
  }
  const req = o.pending ?? o.results.get(o.threadId); // 答的是哪条请求（写回旧 thread 时沿用它的）
  o.results.set(o.threadId, { result: o.result, ts: Date.now(), tokenId: o.tokenId, messageId: req?.messageId, agentChannelId: req?.agentChannelId });
  o.pending?.resolve?.(o.result);
  return null;
}

/** 队列按到达顺序：放回到比它晚到的前面（登记附件期间新挂上的排在它后面）；队列空了被删过就重新建 */
function requeue<W extends { ts: number }>(queues: Map<string, W[]>, key: string, w: W): void {
  const queue = queues.get(key) ?? [];
  const later = queue.findIndex((p) => p.ts > w.ts);
  queue.splice(later < 0 ? queue.length : later, 0, w);
  queues.set(key, queue);
}
