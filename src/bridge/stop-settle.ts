/**
 * Stop hook 里的兜底结算（从 bridge.ts 搬出、依赖注入，单测 tests/stop-settle.test.ts）：target 这一轮没调 reply() 就结束了，
 * send_to_agent 回程拿 drain 出来的 assistant 文字推回 caller（没文字就静默消化），挂着的 API 请求也在这一轮结掉。
 *
 * 以 API 错误结束的一轮（Claude Code 的 StopFailure，或最后一条 assistant 是 isApiErrorMessage——额度墙也是）不结算回程：
 * 那句错误不是答复，回程留着等它接着做完的那一轮；不是撞墙的错误给 caller 推一条说明（每槽一次）。API 请求照常结掉、
 * 回 reply:null + apiError（挂着等下一轮会把别的回合的文字当成答复发给那个 token）。
 * Codex 的 StopFailure 不是这个意思，照常结算：撞额度时是 codex-turn-failure 替它补的（⛔ 那句要推给 caller，
 * 它的额度条目不带 isApiErrorMessage），被打断时是 typing-hook 把 Interrupt 映射过来的（那一轮就该结掉）。
 */
import type { MetricEvent } from "../lib/metrics.js";
import { isOwnerSource } from "../lib/delegate-marker.js";
import { apiQueueToSettle } from "../lib/pending-reply-scope.js";
import { isOwnStopChannel } from "../lib/pushback-scope.js";
import { isModelLimitHit, wallHitOf } from "../lib/quota-wall-text.js";
import { DEFAULT_RUNTIME } from "../lib/runtimes/index.js";
import { withExpecting, withheldNotice, withheldParts, type PendingAgentCall } from "./agent-calls.js";
import { cardsToClose, productionView } from "../lib/agent-supervisor-bridge.js";
import { closeAsk } from "../lib/ledger-asks.js";
import { readRegistryAgentsSync } from "../lib/registry.js";
import { askDbIfExists, publishAsk } from "./asks.js";
import { spokenBefore, takeTurnFailure, turnFailureNotice, type TurnFailure } from "./turn-failure.js";

export interface StopTurn {
  /** 要结算的频道（channelsToClear 里的一个） */
  cid: string;
  /** Stop hook 报上来的频道和它的 ws；candidateWs = cid 当前连接 */
  stopChannelId: string;
  stopWs: unknown;
  candidateWs: unknown;
  event: string;
  /** cid 这个 agent 的 runtime（ClientInfo.runtime；master / 老连接没有 = Claude Code） */
  runtime?: string;
  /** drainChannelWatcher 的结果：text 是兜底要转的答复文字（不含错误原文），apiError / error = 最后一条 assistant 是 API 错误 */
  drain: { text: string | null; apiError?: boolean; error?: { error: string; text: string }; turnMark?: string };
  /** 同一轮的 Stop 又来了一次（markRepeat）：什么都不结、不动来源记录 */
  repeated?: boolean;
  /** 触发这一轮的是谁；不给 = 按 noteDelivered 记下的来源判 */
  trigger?: TurnTrigger;
}

/**
 * 最近一条真正送到 cid 手上的消息是谁发的（deliverToLocal 发出去那一刻记），按 principal 分（PM 09-29）：
 * insider = 别的 agent 和 bridge 自己（续跑、补投、看门狗）；owner = Discord 上的 owner、Web 上 owner 的设备 / web-ui、
 * owner:self 的 API（lib/delegate-marker.ts isOwnerSource，全仓唯一的 owner 判定）；stranger = guest、scoped / 外部 token、peer。
 * 以 API 错误结束后回程照常由 insider 和 owner 触发的回合结算（owner 和 PM 在同一侧，推过去不跨 principal）；stranger 触发的
 * 回合答的是那个外人，不结算、它说的话也不扣。不看 lastMessageSource：api-routes 投递后会把它改成 "agent"。
 * 开启这一轮的那条说了算：回合进行中送到的（bridge 消息、peer 请求照投不押）不覆盖它（T24 r2 P2-1，PM 09-29）；
 * 开头几秒里一起送到的一批（押后队列补投）取最严的：stranger > owner > insider。这一轮 Stop 时清掉。
 * 被打断的回合 CC 不发 Stop：送到时目标闲着、离上一条又过了一批的时间，就是新一轮，重记；终端里按 Esc 时事件态还停在 thinking、
 * 判不出闲，靠会话记录里的打断标记（noteTurnCut）收掉这一轮，下一条送到的重记。
 * 没有记录：这一轮不是 bridge 送的消息开的——CC 到点自己接着跑撞墙那一轮（owner 在终端里打字也是这样），继承撞错那一轮
 * （没有就上一轮）的来源和回程，回合进行中送到的（peer 请求照投不押）不覆盖；bridge 的续跑消息（「接着做」、出闸续跑）同样。
 * 重启后还没见过这个频道的 Stop，上一轮不知道 = stranger（不结算，PM 09-29）。
 */
export type TurnTrigger = "insider" | "owner" | "stranger";
const RANK: Record<TurnTrigger, number> = { insider: 0, owner: 1, stranger: 2 };
/** 同一批：第一条送到后这么久内到的算一起开启这一轮 */
const TRIGGER_BATCH_MS = 3_000;
/**
 * callers = 这一轮是哪几个 agent 的消息开的（扣下的话只挂在唯一的那一个上，markApiError）；
 * askers = 其中发的是请求（send_to_agent 不带 oneShot）的那几个：这一轮失败要告诉它们（notifyFailedTurn），答复 / 转发 / FYI 不算
 */
interface TriggerRec { who: TurnTrigger; at: number; callers: string[]; askers: string[] }
const turnTrigger = new Map<string, TriggerRec>();
/** 上一轮（本进程见过它的 Stop）按什么来源结的：没有投递记录的下一轮继承它 */
const prevTrigger = new Map<string, TriggerRec>();
/** 被打断、没有 Stop 的频道：下一条送到的消息开新一轮 */
const cutSince = new Set<string>();
/** bridge 自己的续跑消息：接着做上一轮（撞错 / 撞墙那一轮）的事，来源和 caller 都是上一轮的（quota-wall-wiring 的 label） */
const RESUME_LABELS = new Set(["api-error-resume", "quota-wall"]);
/**
 * 最近一轮以 API 错误结束（撞错 / 撞墙）的那一轮的来源：续跑（CC 到点自己接着跑、bridge 的续跑消息）接着做的是它，
 * 不是「上一轮」——中间插进一轮外人的（guest 抢占、出闸补投外人消息）不改它（T24 wf3 delivery-hold-1）。
 * 自己人的一轮正常结束就清掉（错误那一轮的事已经接着做完 / 回程已结算）。
 */
const errTrigger = new Map<string, TriggerRec>();
const resumeRec = (cid: string): TriggerRec | undefined => errTrigger.get(cid) ?? prevTrigger.get(cid);
type Sender = { kind: string; owner?: boolean; peer?: string; channelId?: string; label?: string };
/** 发送方按 principal 分成哪一类（见 TurnTrigger）；出闸判「补投会不会接着做被打断的事」也用它（bridge/quota-wall-wiring.ts） */
export const senderTrigger = (from: Sender): TurnTrigger =>
  from.kind !== "user" && from.kind !== "api" ? "insider" : isOwnerSource(from) ? "owner" : "stranger";
export function noteDelivered(cid: string, from: Sender, now = Date.now(), idle = false, asks = false): void {
  const who = senderTrigger(from);
  const caller = from.kind === "local" && from.channelId ? [from.channelId] : [];
  const asker = asks ? caller : [];
  const prev = resumeRec(cid);
  // 续跑消息开的一轮继承撞错那一轮；重启后没有记录 = 来源未知，按外人算（不结算，adv3 P2-8）
  const resume = from.kind === "bridge" && RESUME_LABELS.has(from.label ?? "");
  const fresh = (): TriggerRec => (resume && prev ? { ...prev, at: now } : { who: resume ? "stranger" : who, at: now, callers: caller, askers: asker });
  if (cutSince.delete(cid)) return void turnTrigger.set(cid, fresh());
  const cur = turnTrigger.get(cid);
  const batch = !!cur && now - cur.at <= TRIGGER_BATCH_MS;
  // 回合进行中、这一轮不是 bridge 送的消息开的（CC 到点自己续跑）：先按上一轮建出这一轮，中途送到的不覆盖（T24 wf2 delivery-hold-3）
  if (!cur && !idle && prev) turnTrigger.set(cid, { ...prev, at: -Infinity });
  else if (!cur || (idle && !batch)) turnTrigger.set(cid, fresh());
  else if (batch) {
    turnTrigger.set(cid, { who: RANK[who] > RANK[cur.who] ? who : cur.who, at: cur.at,
      callers: [...new Set([...cur.callers, ...caller])], askers: [...new Set([...cur.askers, ...asker])] });
  }
}
/**
 * 会话记录里出现打断标记（终端里 Esc、抢占）：这一轮到此为止，下一条送到的开新一轮（T24 wf2 delivery-hold-4）。
 * at = 标记写下的时刻：抢占时插话那条比标记晚送到、已经记成新一轮，标记晚到不能把它收掉。
 */
export function noteTurnCut(cid: string, at = Date.now()): void {
  const cur = turnTrigger.get(cid);
  if (cur && cur.at >= at) return;
  if (cur) prevTrigger.set(cid, cur);
  turnTrigger.delete(cid);
  cutSince.add(cid);
}
/** 这一轮没有投递记录（CC 到点自己续跑）：接着做的是撞错那一轮，中间插进的外人一轮不算（resumeRec） */
const recOf = (t: StopTurn): TriggerRec | undefined => turnTrigger.get(t.cid) ?? resumeRec(t.cid);
/** 这个频道当前这一轮的开启时刻；没有 = 这一轮不是 bridge 送的消息开的，或已经 Stop / 被打断（bridge/held-flush.ts 用它判补投记录过没过期） */
export const turnStartedAt = (cid: string): number | undefined => turnTrigger.get(cid)?.at;
const triggerOf = (t: StopTurn): TurnTrigger => t.trigger ?? recOf(t)?.who ?? "stranger";
const strangerTurn = (t: StopTurn): boolean => triggerOf(t) === "stranger";
/**
 * 这一轮答的是哪个 caller：恰好一个 agent 开的就是它；好几个、或不是 agent 开的（owner / bridge 自己，callers 为空）= null，
 * 不猜、不扣进任何一槽，只告诉 owner（T24 wf2 delivery-hold-2，PM 09-29）。续跑消息开的一轮继承上一轮的 callers（noteDelivered）。
 */
const callerOf = (t: StopTurn): string | null => {
  const c = recOf(t)?.callers ?? [];
  return c.length === 1 ? c[0]! : null;
};

const ranIntoApiError = (t: StopTurn): boolean =>
  !!t.drain.apiError || (t.event === "StopFailure" && (t.runtime ?? DEFAULT_RUNTIME) === DEFAULT_RUNTIME);

/**
 * 这一轮算不算 cid 自己「答完了」——只有算的才去结算回程簿、看门狗。
 * 别人的频道不算（channelsToClear 里还有 pendingReplies 里别人的 intendedReplyChannel，拿别人的收尾结算就是张冠李戴）；
 * 以 API 错误结束的也不算（Codex 的 StopFailure 除外，见文件头）。
 */
export function settlesOwnTurn(t: StopTurn): boolean {
  return !ranIntoApiError(t) && isOwnStopChannel(t.cid, t.stopChannelId, t.stopWs, t.candidateWs);
}

/**
 * 回合级幂等：同一轮的 Stop 会重复到达（hook 配了两处、CC 重发），而 API / peer 开的回合不写 lastCompletionSent、去抖拦不住。
 * 第二次要是照常拍快照结算，那一刻刚送到的 B（已经开了下一轮）会被结成 null、waiter 被摘掉。判据是会话记录：上次结算之后
 * 没有新的 assistant 条目 = 还是那一轮（drain 的 turnMark）。只记自己频道的（别人的频道结不结不归这次 Stop 管）；没有 watcher 判不了，照旧结算。
 * tests/stop-settle-wf2.test.ts「回合级幂等」
 */
const settledMark = new Map<string, string>();
export function markRepeat<T extends StopTurn>(t: T): T {
  const mark = t.drain.turnMark;
  if (!mark || !isOwnStopChannel(t.cid, t.stopChannelId, t.stopWs, t.candidateWs)) return t;
  if (settledMark.get(t.cid) === mark) return { ...t, repeated: true };
  settledMark.set(t.cid, mark);
  return t;
}

/** bridge 的 Stop 处理每个频道调一次：判这一轮算不算 cid 答完、算就结算回程簿。返回判定，看门狗照它走 */
export async function settleStopTurn(d: CallerSettleDeps, t: StopTurn): Promise<boolean> {
  if (t.repeated) return false;
  const mine = isOwnStopChannel(t.cid, t.stopChannelId, t.stopWs, t.candidateWs);
  try {
    return await settleOwn(d, t, mine);
  } finally {
    if (mine && t.event === "Stop" && !ranIntoApiError(t)) (d.recovered ?? closeRecoveredCards)(t.cid); // 正常结束的一轮 = 恢复了（i28-S1 监护关卡）
    if (mine) {
      const rec = { at: 0, callers: [], askers: [], ...recOf(t), who: triggerOf(t) };
      if (ranIntoApiError(t)) errTrigger.set(t.cid, rec);
      else if (rec.who !== "stranger") errTrigger.delete(t.cid);
      prevTrigger.set(t.cid, rec); // 下一轮的来源从它的第一条消息重新记
      turnTrigger.delete(t.cid);
      cutSince.delete(t.cid);
    }
  }
}

async function settleOwn(d: CallerSettleDeps, t: StopTurn, mine: boolean): Promise<boolean> {
  const failed = mine && (await failedTurn(d, t));
  const own = settlesOwnTurn(t);
  if (!own) {
    if (mine) await onApiErrorTurn(d, t);
    return false;
  }
  const waiting = d.waiting(t.cid);
  if (waiting.some((c) => c.apiErrorAt) && strangerTurn(t)) {
    d.rearmResume(t.cid); // 答的是外人：回程留着；它的 60 秒续跑要是被这一轮取消了，重新排上，不然没人再叫它接着做
    return own;
  }
  // 扣下的话按条逐个推（每份挂在归属确定的那条请求上、推到那条的回复频道，markApiError）；推失败这一轮的正文扣回它该归的那一条，不丢
  for (const c of waiting.flatMap(withheldParts)) {
    if (await pushWithheld(d, t.cid, c)) continue;
    markWithheld(d, t, t.drain.text);
    return own;
  }
  if (!failed) await settleCallers(d, t.cid, t.drain.text); // 失败那一轮的 drain 是错误原文，不是答谁的
  return own;
}

/**
 * ACP 宿主报这一轮以不可重试的错误中止（turn-failure.ts）：开这一轮的每个请求方推一条带原文的说明，回程槽在不在都推——
 * 它中途 reply 过一句就把槽消化了，靠槽就是静默。有槽的推完就消化，不再拿「API Error: …」当答复兜底推一遍；
 * 以 API 错误结束、等续跑的槽（适配器没说能不能重试）留给 onApiErrorTurn 那句「回程保留」，不说两遍。
 * 自己续跑的一轮（at = -Infinity，按上一轮建出来的）不算谁开的；owner 有回合失败卡，peer 走 API 请求的兜底结算，都不在 askers 里。
 * 出错前说的话只在这一轮完全是它一个自己人开的时候带上；外人参与开的一轮只推通用说明、不消化槽（留给下面 strangerTurn 那道保护）。
 */
async function failedTurn(d: CallerSettleDeps, t: StopTurn): Promise<boolean> {
  const rec = turnTrigger.get(t.cid);
  const opened = rec && rec.at !== -Infinity ? rec : undefined;
  const f = takeTurnFailure(t.cid, opened?.at ?? Infinity);
  if (!f || t.event !== "StopFailure") return false;
  const waiting = d.waiting(t.cid);
  const askers = opened?.askers ?? [];
  const stranger = strangerTurn(t);
  const sole = !stranger && opened?.who === "insider" && opened.callers.length === 1 && askers.length === 1 && !ranIntoApiError(t);
  const said = sole ? spokenBefore(t.drain.text, f) : undefined;
  for (const caller of askers) {
    const slot = waiting.find((p) => p.callerChannelId === caller);
    if (slot && ranIntoApiError(t)) continue;
    const pac = slot ?? stubCall(caller, t.cid, f);
    const r = await d.notify(pac, t.cid, turnFailureNotice(f, !slot, said)).catch((e: Error) => ({ kind: "error", error: e }));
    const kind = (r as { kind?: string } | undefined)?.kind;
    if (kind === "error" || kind === "dropped") console.error(`⚠️ ${f.agent} 回合失败的说明没推到 ${pac.callerName}（${kind}），回程照旧留着`);
    else if (slot && !stranger) d.consume(t.cid, slot);
    console.log(`⚠️ ${f.agent} 这一轮以不可重试的错误中止 → 告诉请求方 ${pac.callerName}${slot ? "" : "（回程已被更早的回复消化）"}`);
  }
  return true;
}

/** 回程槽已经被这一轮更早的回复消化了：按频道现拼一个推回地址（名字查 registry，查不到就用频道号，只影响显示） */
function stubCall(caller: string, cid: string, f: TurnFailure): PendingAgentCall {
  let callerName = caller;
  try {
    callerName = readRegistryAgentsSync().find((a) => a.channelId === caller)?.name ?? caller;
  } catch (e) {
    console.warn(`回合失败说明：查 ${caller} 的名字失败，按频道号显示：${(e as Error).message}`);
  }
  return { callerChannelId: caller, callerName, targetName: f.agent, targetChannelId: cid, ts: Date.now() };
}

/** 撞墙前扣下的话单独推一条、带抬头：和这一轮（可能是不相干的一轮）的正文拼在一起，caller 分不清哪句是答它的 */
async function pushWithheld(d: CallerSettleDeps, cid: string, pac: PendingAgentCall): Promise<boolean> {
  try {
    const r = await d.pushBack(pac, cid, withheldNotice(pac));
    // pushBackToCaller 不抛错，失败是返回 error / dropped：当成送到了就会清掉扣下的话、消化回程
    if (r && (r.kind === "error" || r.kind === "dropped")) throw new Error(`投递结果 ${r.kind}`);
    d.clearWithheld(cid, pac);
    return true;
  } catch (e) {
    console.error(`撞墙前扣下的答复推给 ${pac.callerName} 失败（回程留着）:`, e);
    return false;
  }
}

/** 记上等续跑并把 text 扣到归属确定的那一槽；归属不明（几个 caller 一起开的、或不是 agent 开的）不猜，只告诉 owner 有这么段话没转给任何人 */
function markWithheld(d: CallerSettleDeps, t: StopTurn, text: string | null): void {
  const to = d.markApiError(t.cid, text, callerOf(t));
  const waiting = d.waiting(t.cid).length;
  const err = t.drain.error;
  const wall = !!err && (t.runtime ?? DEFAULT_RUNTIME) === DEFAULT_RUNTIME && !!wallHitOf(err.error, err.text, Date.now());
  if (text && !to && waiting) d.unattributed?.(t.cid, text, { callers: recOf(t)?.callers.length ?? 0, waiting, wall });
}

/** unattributed 的说明（发 #control）：按这一轮是谁开的、实际有几个 caller 在等写（T24 wf3 delivery-hold-5） */
export function unattributedNotice(agent: string, n: { callers: number; waiting: number }): string {
  const whose = n.callers > 1 ? `是 ${n.callers} 个 agent 的请求一起开的，出错前说的话对不上是答谁的` : `不是 agent 开的（owner / bridge 的消息），出错前说的话不是答 caller 的`;
  return `ℹ️ ${agent} 那一轮以 API 错误结束，${whose}：没有转给在等它的 ${n.waiting} 个 caller（在它自己的频道里看得到）`;
}

/**
 * 自己频道这一轮以 API 错误结束：在等它的回程都记上「等续跑」（落在回程簿上，重启后还在、几个 caller 都记），
 * 错误前它已经说了的话扣在回程上、接着做完时一起推（外人触发的那一轮说的是给外人的，不扣）；不是撞墙的给 caller 推一条说明
 */
async function onApiErrorTurn(d: CallerSettleDeps, t: StopTurn): Promise<void> {
  markWithheld(d, t, strangerTurn(t) ? null : t.drain.text);
  const err = t.drain.error;
  // 撞墙的留给额度闸（整台机器押住、出闸续跑，caller 不用知道）；没读到错误条目（Stop 比 jsonl 先到）不猜
  if (!err || ((t.runtime ?? DEFAULT_RUNTIME) === DEFAULT_RUNTIME && wallHitOf(err.error, err.text, Date.now()))) return;
  const summary = err.text.split("\n")[0].trim().slice(0, 160) || err.error;
  for (const pac of d.takeApiErrorNotice(t.cid)) {
    const body = isModelLimitHit(err.error, err.text)
      ? `[ℹ️ ${pac.targetName} 撞了单个模型的额度：${summary}；要 owner 在它窗口里换模型（/model）后才会接着做，回程保留，答复到了仍会推给你]`
      : `[ℹ️ ${pac.targetName} 这轮以 API 错误结束：${summary}；回程保留，它恢复后的答复仍会推给你]`;
    await d.notify(pac, t.cid, body).catch((e) => console.error(`API 错误说明推给 ${pac.callerName} 失败（回程照旧留着）:`, e));
    console.log(`ℹ️ ${pac.targetName} 这轮以 API 错误结束 → 告诉 ${pac.callerName}（${summary.slice(0, 60)}）`);
  }
}

/** 挂着的 API 请求（bridge 的 pendingApiRequests 条目；这里不 import api-routes，按形状收） */
export interface ApiWaiter { agentChannelId: string; agentName: string; threadId: string; tokenId: string; messageId?: string; siblingThreadId?: string }
/** siblingThreadId：它等着时 agent 的回复记到了同一调用方的另一条（lib/pending-reply-scope.ts claimApiReply），reply 是 bridge 写的说明、不是 agent 的话 */
export interface ApiWaiterResult { reply: string | null; threadId: string; agent: string; viaFallback: true; apiError?: boolean; error?: string; siblingThreadId?: string }

/** 回给「没单独答复」的那条：明说不是空答。不能回 reply:null——peer 把空回复读成「对方回合结束但没有文本」，以为 agent 没理它 */
const notSeparatelyAnswered = (agent: string, sibling: string): string =>
  `[ℹ️ bridge 兜底] ${agent} 本回合没有单独答复这条请求：同一回合它回复了你的另一条请求（thread ${sibling}），可能已在那条回复里一并作答。`;

/** Stop 兜底结掉一条 API 请求时的 chat_message(out) 负载和日志里的结局 */
export function apiFallbackEvent(p: ApiWaiter, r: ApiWaiterResult): { data: Record<string, unknown>; label: string } {
  // 上面那句是写给轮询 / 等待方的：事件里不放进 text，网页会把它接在 agent 那条回复后面，像是 agent 说的
  const text = r.siblingThreadId ? "" : r.reply || "";
  const data = { direction: "out", from: p.agentName, text, threadId: p.threadId, api: true, viaFallback: true,
    ...(r.apiError ? { apiError: true } : {}), ...(r.siblingThreadId ? { siblingThreadId: r.siblingThreadId } : {}) };
  const label = r.apiError ? `API 错误 ${r.error}` : r.siblingThreadId ? `没单独答复，回复记在 ${r.siblingThreadId}` : r.reply ? `${r.reply.length} chars` : "no-text";
  return { data, label };
}

/**
 * cid 这一轮收尾时结掉它名下的 API 请求（wait 调用方不必干等超时）：正常结束 → drain 文字（没有 = reply:null，回复记到了同一调用方别的请求上 = 那句说明）；
 * 以 API 错误结束 → reply:null + apiError、error = 错误类型。不能挂着等下一轮：之后随便哪一轮（比如 owner 在 Discord 上聊的）
 * 都会被当成答复发给那个 token，重试的请求还会错位；Bun 对一个字节都没写的 HTTP 请求约 10 秒就掐断。返回结掉的请求。
 * 留在队里不结的：Pi 叫停那次 Stop 里停字自己的等待（stopWait，留给停字那一轮答）；消息还押着、没送到 cid 手上的（held）——
 * 这一轮根本不是答它的，拿这一轮的话结它就是把答 PM / owner 的内容交给了别人（撞墙时押几个小时，TTL 2 小时）。
 */
/**
 * Stop 一进来就拍的快照：那一刻还押着的消息 id、那一刻就挂着的 API 请求。收尾 drain 慢的时候，补投（2 秒定时器 / 扫描 / 窗口活动）可能先把
 * 外人的消息送进新一轮、它的请求也可能是之后才挂上的——只结快照里的、没押着的，这一回合的话才不会结给别人（tests/held-flush.test.ts）
 */
export function stopSnapshot<W>(held: Set<string>, queues: Map<string, W[]>): { held: Set<string>; waiters: Set<W> } {
  return { held, waiters: new Set([...queues.values()].flat()) };
}

export function takeApiWaiters<W extends ApiWaiter>(
  queues: Map<string, W[]>, t: StopTurn, own: boolean, stopWait: ReadonlySet<string> = new Set(), held: ReadonlySet<string> = new Set(), atStop?: ReadonlySet<W>,
): { waiter: W; result: ApiWaiterResult }[] {
  const apiErr = !own && ranIntoApiError(t) && isOwnStopChannel(t.cid, t.stopChannelId, t.stopWs, t.candidateWs);
  if (t.repeated || (!own && !apiErr)) return [];
  const skip = new Set([...stopWait, ...held]);
  const out: { waiter: W; result: ApiWaiterResult }[] = [];
  for (const [key, queue] of [...queues.entries()]) {
    if (!queue.length || queue[0].agentChannelId !== t.cid) continue;
    for (const w of apiQueueToSettle(queues, key, skip, atStop)) {
      const base = { threadId: w.threadId, agent: w.agentName, viaFallback: true as const };
      const sibling = !t.drain.text && w.siblingThreadId ? { reply: notSeparatelyAnswered(w.agentName, w.siblingThreadId), siblingThreadId: w.siblingThreadId } : undefined;
      out.push({ waiter: w, result: apiErr ? { ...base, reply: null, apiError: true, error: t.drain.error?.error || t.event } : { ...base, reply: t.drain.text || null, ...sibling } });
    }
  }
  return out;
}

export interface CallerSettleDeps {
  answerable(cid: string): PendingAgentCall | undefined;
  /** 在等 cid 的所有槽（请求已送到它手上的） */
  waiting(cid: string): PendingAgentCall[];
  /** 外人那一轮结束、回程还等着：它的 60 秒续跑 / 出闸续跑要是被这一轮当成「它又动了」取消了，重新排上（quota-wall-wiring） */
  rearmResume(cid: string): void;
  consume(cid: string, pac: PendingAgentCall): void;
  /** 推回 caller（bridge 的 pushBackToCaller，返回投递结果；error / dropped = 没送到） */
  pushBack(pac: PendingAgentCall, cid: string, body: string): Promise<{ kind: string } | void>;
  /** 好几个 caller 在等、它又没指明答给谁：提醒它分别回 */
  nudgeAmbiguous(cid: string): void;
  /** 在等 cid 的槽都记上「以 API 错误结束、等续跑」，withheld 只扣到归属确定的那一槽（回程簿 markApiError，落盘），返回扣到哪一槽 */
  markApiError(cid: string, withheld: string | null, caller?: string | null): string | undefined;
  /** 以 API 错误结束的一轮说了话、却对不上是答哪个 caller 的：只告诉 owner，不推给任何 caller（撞墙的 wall = true，闸内不发） */
  unattributed?(cid: string, text: string, n: { callers: number; waiting: number; wall: boolean }): void;
  /** 扣下的话已经推给 caller：清掉这一槽的 withheld（等续跑标记随答复一起消化） */
  clearWithheld(cid: string, pac: PendingAgentCall): void;
  /** 在等 cid 的、还没为 API 错误说明过的槽，取出即记下（落盘，回程簿 takeApiErrorNotice） */
  takeApiErrorNotice(cid: string): PendingAgentCall[];
  /** 推给 caller 一条 intent=notification（不带 expecting、不当答复） */
  notify(pac: PendingAgentCall, cid: string, body: string): Promise<unknown>;
  metric(name: MetricEvent, callerChannelId: string, meta: Record<string, string>): void;
  /** cid 正常结束了一轮：关掉它开着的回合失败卡（缺省 closeRecoveredCards；单测注入） */
  recovered?(cid: string): void;
}

/**
 * 监护开着的项目里，agent 下一个正常结束的回合 = 它从回合失败里恢复了：关掉它此前开出、还开着的「回合失败」卡（额度 / 登录卡不动，
 * lib/agent-supervisor-bridge.ts cardsToClose），当场发布让网页即时刷新。监护关着时一张都不关（与改动前一致）。关卡出错只记日志：最坏卡多开一会儿。
 */
export function closeRecoveredCards(cid: string, now = Date.now()): void {
  try {
    const db = askDbIfExists();
    const row = db && readRegistryAgentsSync().find((a) => a.channelId === cid);
    if (!db || !row) return;
    for (const a of cardsToClose(db, row.name, row.projectId, now, productionView.config())) {
      const c = closeAsk(db, a.id, "cancelled", "agent 已恢复：下一个回合正常结束", now, { recoveredAt: now });
      if (c) publishAsk(c), console.log(`✅ ${row.name} 恢复，关掉回合失败卡 ${a.id}`);
    }
  } catch (e) {
    console.error(`⚠️ 恢复后关回合失败卡出错（卡留着，owner 可手动关）：${(e as Error).message}`);
  }
}

/** 只在 settlesOwnTurn 为真时调（settleStopTurn） */
async function settleCallers(d: CallerSettleDeps, cid: string, drainedText: string | null): Promise<void> {
  const pac = d.answerable(cid);
  if (!pac) {
    d.nudgeAmbiguous(cid);
    return;
  }
  if (!drainedText) {
    // 没文字：静默消化，**不推**。以前推一句「对方没产出，你去追问」会激励 caller 再发一轮 → 聊不停的根因之一；
    // caller 没收到推就不会发起新轮，链条自然断。
    d.consume(cid, pac);
    console.log(`🤫 drain兜底 no-text 静默清 pending: ${pac.targetName} → ${pac.callerName}`);
    d.metric("agent_pushback_drain_silent", pac.callerChannelId, { target: pac.targetName });
    return;
  }
  try {
    const body = withExpecting(pac, `[ℹ️ 对方 (${pac.targetName}) 这轮没用 reply() 工具，下面是 bridge 从 assistant 文字兜底转发的：]\n\n${drainedText}`);
    await d.pushBack(pac, cid, body);
    d.consume(cid, pac);
    console.log(`📨 AGENT PUSH-BACK (drain兜底): ${pac.targetName} → ${pac.callerName}（drain 文字）`);
    d.metric("agent_pushback_drain", pac.callerChannelId, { hadText: "yes" });
  } catch (e) {
    console.error("AGENT PUSH-BACK (drain兜底) 失败:", e);
  }
}
