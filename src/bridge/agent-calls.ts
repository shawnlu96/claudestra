/**
 * send_to_agent 的回程路由簿：记下「谁在等谁的答复」，target 答复时 bridge 把那段话推回 caller，caller 不必 fetch_messages 轮询。
 *
 * 每个 (target, caller) 一槽：以前 key 只是 target，B 问同一个 target 会覆盖 A 的槽，A 的答复就推给了 B（信息串给别人）。
 * 归属规则（codex 2026-09-28 复核）：target 回发 send_to_agent 给 X、或 reply 到 X 的频道 → 精确消化 X 那槽；target 在自己频道
 * reply / 回合结束兜底 → 只有恰好一个已投递的 caller 在等才推给它；多个在等就不推给任何人、不广播，提醒 target 用 send_to_agent 分别回。
 *
 * 同一 caller 连着问同一个 target：槽里逐条记请求（message_id / expecting / 回复频道），不合并覆盖。target 答复时只算
 * 「已送到它手上」的那几条（视图），消化也只删这几条——还押着的问题留在槽里，等它送到后再答（codex 2026-09-28 复核：
 * 并槽后回答旧问题会把押着的新问题一起删掉）。仍然没有显式回复 ID：同时送到的几条共用一次答复。
 *
 * 落盘（~/.claude-orchestrator/pending-agent-calls.json）：bridge 重启后对方照常回复也知道推给谁。不存 caller 的 ws：推回时按
 * callerChannelId 取当前连接。老文件（key = target）启动时迁成新 key。
 */
import { requestExpired, type HeldFromLike } from "../lib/held-pac.js";
import { statePath } from "../lib/paths.js";
import { PersistedMap } from "./persisted-map.js";
import type { Envelope } from "./router.js";

export interface PendingAgentCall {
  /** 谁发起的（master 或某个 agent） */
  callerChannelId: string;
  callerName: string;
  targetName: string;
  /** 被问的 agent 的频道（新格式必有；老文件迁移时从 key 补上） */
  targetChannelId?: string;
  /**
   * caller 发起时手头正在处理的 inbound 请求的 intendedReplyChannel（通常是 caller 自己的频道）。推回的
   * meta.chat_id 用它，免得 caller 把 target 的私频当回复目标；没有正在处理的请求时是 undefined。
   */
  originalReplyChannel?: string;
  /** caller 填的「答完后我该做啥」，推回时放在最前面，caller 不靠自己记得也能接着干 */
  expecting?: string;
  ts: number;
  /** 已经提醒过 target「好几个人在等你，分别回」的时刻（同一批只提醒一次） */
  ambiguityNotifiedAt?: number;
  /** 已经告诉过 caller「它这轮以 API 错误结束、回程保留」的时刻（每槽一次，bridge/stop-settle.ts） */
  apiErrorNotifiedAt?: number;
  /** target 以 API 错误结束、这一槽在等它接着做完的那一轮（bridge/stop-settle.ts）；withheld = 错误前它已经说了的话 */
  apiErrorAt?: number;
  withheld?: string[];
  /** 撞错那一轮 target 已看到的请求 id：等续跑标记和扣下的话属于它们，不转挂到后来送到的请求上（过期 / 推回都按它找频道） */
  apiErrorFor?: string[];
  /** 这一槽的各条请求（老数据没有：整槽当一条） */
  requests?: CallRequest[];
  /** requests 的 message_id（#116 时期的老槽只有它，requestsOf 据此拆成逐条） */
  messageIds?: string[];
}

export interface CallRequest {
  messageId?: string;
  expecting?: string;
  originalReplyChannel?: string;
  ts: number;
  /** 真正送到 target 手上的时刻（失效钟）：记下时先填发出时刻，押后的送达时 touch 改掉；老数据没有，过期时回落槽级 ts */
  deliveredAt?: number;
}

/** 这条请求还押在 target 队里（它没看到） */
type StillHeld = (req: { messageId?: string; callerChannelId: string }) => boolean;

const isCall = (v: unknown): boolean => {
  const c = v as Partial<PendingAgentCall> | null;
  return !!c && typeof c === "object" && typeof c.callerChannelId === "string" && typeof c.callerName === "string"
    && typeof c.targetName === "string" && typeof c.ts === "number";
};

const SEP = "\u001f";
/**
 * 老数据（没有 requests）：每个记过的 message_id 各算一条请求，一条都不丢（codex 复核：只取第一个会让押着的第二条回程被整槽删掉）。
 * 老槽的 expecting / 回复频道是合并过的、拆不回逐条，保守地每条都带上；连 id 都没有就整槽当一条。
 */
const requestsOf = (c?: PendingAgentCall): CallRequest[] => {
  if (!c) return [];
  if (c.requests) return c.requests;
  const base = { expecting: c.expecting, originalReplyChannel: c.originalReplyChannel, ts: c.ts };
  return c.messageIds?.length ? c.messageIds.map((messageId) => ({ ...base, messageId })) : [base];
};
/** 槽按逐条请求重算冗余字段：messageIds、expecting / 回复频道（取最后一条） */
const shaped = (target: string, base: PendingAgentCall, reqs: CallRequest[]): PendingAgentCall => {
  const last = reqs[reqs.length - 1];
  return {
    ...base, targetChannelId: target, requests: reqs, messageIds: idsOf(reqs),
    expecting: last?.expecting, originalReplyChannel: last?.originalReplyChannel,
  };
};
const idsOf = (reqs: CallRequest[]) => reqs.map((r) => r.messageId).filter((x): x is string => !!x);
const NO_API_ERROR = { apiErrorAt: undefined, withheld: undefined, apiErrorFor: undefined };
/** 推扣下的话用：回复频道 / expecting 取这几条里属于撞错那一轮的最后一条（老数据没记归属就取最后一条） */
const ownedBy = (c: PendingAgentCall, reqs: CallRequest[]): PendingAgentCall => {
  const own = c.apiErrorFor ? reqs.filter((r) => r.messageId && c.apiErrorFor!.includes(r.messageId)) : reqs;
  const last = own[own.length - 1];
  return last ? { ...c, expecting: last.expecting, originalReplyChannel: last.originalReplyChannel } : c;
};
const keyOf = (target: string, caller: string) => `${target}${SEP}${caller}`;
const targetOf = (key: string, c: PendingAgentCall) => c.targetChannelId ?? key.split(SEP)[0];

export class AgentCallBook extends PersistedMap<PendingAgentCall> {
  constructor(path: string | null = statePath("pending-agent-calls.json")) {
    super(path, "回程路由簿", isCall);
    let migrated = false;
    for (const [k, c] of [...this.entries()]) {
      if (k.includes(SEP)) continue;
      this.deleteQuiet(k); // 老格式 key = target：迁成 (target, caller)
      this.setQuiet(keyOf(k, c.callerChannelId), { ...c, targetChannelId: k });
      migrated = true;
    }
    if (migrated) this.persist();
    if (this.size) console.log(`♻️ 恢复待回程的 send_to_agent ${this.size} 条（对方的答复仍会推回发起方）`);
  }

  /** 带着扣下的话（stop-settle 的 withheld）的槽被 reply / send_to_agent 直接答掉时调，bridge 接成推给 caller */
  onWithheld?: (pac: PendingAgentCall) => void;
  /** 以 API 错误结束、等续跑的槽没等到就被删了（过期 / target 被关掉）：bridge 接成 expiredNotice 推给 caller，不静默丢 */
  onExpired?: (pac: PendingAgentCall, why: string) => void;

  /** 记一条请求（同一 caller 还没答完的请求留着，新的追加在后面） */
  add(target: string, call: PendingAgentCall, messageId?: string): void {
    const prev = this.slot(target, call.callerChannelId);
    const req: CallRequest = { messageId, expecting: call.expecting, originalReplyChannel: call.originalReplyChannel, ts: call.ts, deliveredAt: call.ts };
    this.store(target, { ...(prev ?? call), ...call, ambiguityNotifiedAt: undefined, apiErrorNotifiedAt: undefined }, [...requestsOf(prev), req]);
  }

  slot(target: string, caller: string): PendingAgentCall | undefined {
    return this.get(keyOf(target, caller));
  }

  /** 消化一次答复：只删视图里（已送到 target 的）那几条请求，删空了才删整槽；不给视图 = 整槽删 */
  consume(target: string, caller: string, answered?: PendingAgentCall): boolean {
    const cur = this.slot(target, caller);
    if (!cur) return false;
    if (cur.withheld?.length) this.onWithheld?.(ownedBy(cur, answered?.requests ?? requestsOf(cur))); // 它直接答了：扣下的话推给 caller，不跟着槽悄悄清掉
    if (!answered?.requests) return this.delete(keyOf(target, caller));
    const done = new Set(answered.requests.map((r) => r.messageId));
    const left = requestsOf(cur).filter((r) => !done.has(r.messageId));
    if (!left.length) return this.delete(keyOf(target, caller));
    this.store(target, { ...cur, ...NO_API_ERROR }, left); // 扣下的话已随答复推走
    return true;
  }

  /** send_to_agent 投递失败：只撤这一条请求。不是答复，不走 consume——槽上的等续跑标记和扣下的话都是前面几条请求的，原样留着 */
  dropRequest(target: string, caller: string, messageId: string): void {
    const cur = this.slot(target, caller);
    if (!cur) return;
    const left = requestsOf(cur).filter((r) => r.messageId !== messageId);
    if (left.length) this.store(target, cur, left);
    else this.delete(keyOf(target, caller));
  }

  private store(target: string, base: PendingAgentCall, reqs: CallRequest[]): void {
    this.set(keyOf(target, base.callerChannelId), shaped(target, base, reqs));
  }

  /** 视图：只含已送到 target 手上的请求（expecting 合并、回复频道取最后一条）；一条都没送到 = undefined */
  private view(c: PendingAgentCall, stillHeld: StillHeld): PendingAgentCall | undefined {
    const seen = requestsOf(c).filter((r) => !stillHeld({ messageId: r.messageId, callerChannelId: c.callerChannelId }));
    if (!seen.length) return undefined;
    const expecting = seen.map((r) => r.expecting).filter(Boolean).join("；另一个问题：") || undefined;
    // 回复频道只取已送到的那几条自己的；没有就留空走默认，不借槽里还押着的请求的（codex 复核：会串到别的会话）
    return { ...c, requests: seen, expecting, originalReplyChannel: seen[seen.length - 1].originalReplyChannel };
  }

  /** target 明确答给 caller（回发 send_to_agent / reply 到 caller 的频道） */
  exact(target: string, caller: string, stillHeld: StillHeld): PendingAgentCall | undefined {
    const c = this.slot(target, caller);
    return c && this.view(c, stillHeld);
  }

  forTarget(target: string): PendingAgentCall[] {
    return [...this.entries()].filter(([k, c]) => targetOf(k, c) === target).map(([, c]) => c);
  }

  /** 在等 target 答复、且请求已经送到 target 手上的（还押在 target 队里的它根本没看到，不算） */
  waiting(target: string, stillHeld: StillHeld): PendingAgentCall[] {
    return this.forTarget(target).map((c) => this.view(c, stillHeld)).filter((v): v is PendingAgentCall => !!v);
  }

  /** target 没指明答给谁时的归属：恰好一个在等才算；0 个或多个 → undefined（多个不猜、不广播） */
  answerable(target: string, stillHeld: StillHeld): PendingAgentCall | undefined {
    const w = this.waiting(target, stillHeld);
    return w.length === 1 ? w[0] : undefined;
  }

  /** 多个 caller 在等、这一批还没提醒过 → 返回这批并记下已提醒（落盘）；否则空 */
  takeAmbiguity(target: string, stillHeld: StillHeld, now = Date.now()): PendingAgentCall[] {
    const w = this.waiting(target, stillHeld);
    if (w.length < 2 || w.every((c) => c.ambiguityNotifiedAt)) return [];
    for (const c of w) {
      const raw = this.slot(target, c.callerChannelId);
      if (raw) this.setQuiet(keyOf(target, c.callerChannelId), { ...raw, ambiguityNotifiedAt: now });
    }
    this.persist();
    return w;
  }

  /** 在等 target、还没收到过 API 错误说明的槽：返回并记下已说明（落盘）。caller 再发一条请求会重新计（add） */
  takeApiErrorNotice(target: string, stillHeld: StillHeld, now = Date.now()): PendingAgentCall[] {
    const w = this.waiting(target, stillHeld).filter((c) => !c.apiErrorNotifiedAt);
    for (const c of w) {
      const raw = this.slot(target, c.callerChannelId);
      if (raw) this.setQuiet(keyOf(target, c.callerChannelId), { ...raw, apiErrorNotifiedAt: now });
    }
    if (w.length) this.persist();
    return w;
  }

  /**
   * target 这一轮以 API 错误结束：在等它的槽都记上等续跑（第一次的时刻）；withheld 只挂在归属确定的那一槽：caller 给了就是它
   * （null = 确定不了），没给就要恰好一个在等。多个 caller 不猜、不广播，也不按「谁已经扣着话」猜（A 的话推给 B 是串话）。
   * 返回扣到了哪一槽（没扣 = undefined）；落盘
   */
  markApiError(target: string, stillHeld: StillHeld, withheld: string | null, caller?: string | null, now = Date.now()): string | undefined {
    const w = this.waiting(target, stillHeld);
    const owner = caller !== undefined ? caller : w.length === 1 ? w[0]!.callerChannelId : null;
    const to = withheld && owner && w.some((c) => c.callerChannelId === owner) ? owner : undefined;
    for (const c of w) {
      const raw = this.slot(target, c.callerChannelId);
      const add = c.callerChannelId === to ? { withheld: [...(raw?.withheld ?? []), withheld!] } : {};
      const seen = [...new Set([...(raw?.apiErrorFor ?? []), ...idsOf(c.requests ?? [])])];
      if (raw) this.setQuiet(keyOf(target, c.callerChannelId), { ...raw, apiErrorAt: raw.apiErrorAt ?? now, apiErrorFor: seen.length ? seen : undefined, ...add });
    }
    if (w.length) this.persist();
    return to;
  }

  /** 扣下的话已经推给 caller 了：只清那一槽的 withheld */
  clearWithheld(target: string, caller: string): void {
    const raw = this.slot(target, caller);
    if (raw?.withheld) this.set(keyOf(target, caller), { ...raw, withheld: undefined });
  }

  /** 有 caller 在等 target 接着做完（它上一轮以 API 错误结束）：这时 owner 在 Discord 打字不算接管 */
  awaitingResume(target: string, stillHeld: StillHeld): boolean {
    return this.waiting(target, stillHeld).some((c) => c.apiErrorAt);
  }

  /**
   * 失效钟重新起算：给了 caller 只动那一槽，否则 target 名下全部。不给 messageId = 整槽重置（额度闸出闸，显式操作）；
   * 给了（押后的这封真正送达）只动 id 对得上的那条，外加老数据里没记 id、没法对的请求。对不上的（oneShot 通知、推回的答复）
   * 不动已有请求的钟，也不动槽级 ts——否则同一 caller 持续发通知就能让早已送到的请求永不过期（T6c1 r1 P1-1）
   */
  touch(target: string, caller?: string, now = Date.now(), messageId?: string): void {
    let changed = false;
    for (const [k, c] of [...this.entries()]) {
      if (targetOf(k, c) !== target || (caller && c.callerChannelId !== caller)) continue;
      const reqs = requestsOf(c);
      const hit = (r: CallRequest) => !messageId || !r.messageId || r.messageId === messageId;
      if (!reqs.some(hit)) continue;
      this.setQuiet(k, { ...c, ...(messageId ? {} : { ts: now }), requests: reqs.map((r) => (hit(r) ? { ...r, deliveredAt: now } : r)) });
      changed = true;
    }
    if (changed) this.persist();
  }

  /** 押后的这封（押后投递 / check_inbox 领取）这会儿才送到 target 手上。回程簿只记 local caller 的请求，别的来源不用管 */
  touchDelivered(target: string, env: Pick<Envelope, "from" | "meta">, now = Date.now()): void {
    if (env.from.kind === "local") this.touch(target, env.from.channelId, now, env.meta.messageId);
  }

  /**
   * 每分钟扫：逐条请求判，送达后 staleMs 还没被消化的删掉，槽里还剩请求就留槽；返回各槽删掉的那几条（requests = 删掉的）。
   * 押在 target 队里（它还没看到）的不删，失效钟从真正送达起算。以 API 错误结束、等续跑的，删掉的每条经 onExpired 告诉 caller。
   */
  sweepStale(now: number, staleMs: number, heldFrom: (target: string) => HeldFromLike[] | undefined, paused?: (target: string) => boolean): PendingAgentCall[] {
    const out: PendingAgentCall[] = [];
    for (const [k, c] of [...this.entries()]) {
      const target = targetOf(k, c);
      if (paused?.(target)) continue;
      const held = heldFrom(target);
      const reqs = requestsOf(c);
      const gone = reqs.filter((r) => requestExpired(r, c, held, now, staleMs));
      if (!gone.length) continue;
      const left = reqs.filter((r) => !gone.includes(r));
      // 等续跑标记和扣下的话只属于撞错那一轮看到的请求（老数据没记：算过期的这几条的），不转挂到别的请求上（T6c1 r1 P1-2）
      const owns = (r: CallRequest) => (c.apiErrorFor ? !!r.messageId && c.apiErrorFor.includes(r.messageId) : gone.includes(r));
      const leftOwners = c.apiErrorAt ? left.filter(owns) : [];
      const rest = leftOwners.length ? { ...c, apiErrorFor: idsOf(leftOwners) } : { ...c, ...NO_API_ERROR };
      if (!left.length) this.deleteQuiet(k);
      else this.setQuiet(k, shaped(target, rest, left));
      const pac = { ...c, targetChannelId: target, requests: gone, messageIds: idsOf(gone) };
      out.push(pac);
      const notify = c.apiErrorAt ? gone.filter(owns) : [];
      if (c.apiErrorAt && !notify.length && !leftOwners.length && c.withheld?.length) console.warn(`⚠️ ${c.targetName} 扣下的话找不到所属请求，随过期丢弃（不转给别的请求）`);
      notify.forEach((r, i) => this.onExpired?.({
        ...pac, requests: [r], expecting: r.expecting, originalReplyChannel: r.originalReplyChannel,
        withheld: !leftOwners.length && i === notify.length - 1 ? c.withheld : undefined, // 扣下的话只附一次；那一轮还有请求在等就留给它
      }, "之后 2 小时没有接着做完"));
    }
    if (out.length) this.persist();
    return out;
  }

  /** 这个频道作为 target 或 caller 的槽全清掉（用户接管 / agent 被 kill），返回清掉几条 */
  dropChannel(channelId: string): number {
    let n = 0;
    for (const [k, c] of [...this.entries()]) {
      if (targetOf(k, c) !== channelId && c.callerChannelId !== channelId) continue;
      this.deleteQuiet(k);
      n++;
      if (c.apiErrorAt && targetOf(k, c) === channelId) this.onExpired?.({ ...c, targetChannelId: channelId }, "之后它被关掉了");
    }
    if (n) this.persist();
    return n;
  }
}

/** 好几个 caller 同时在等、target 又没指明答给谁时发给 target 的提醒（bridge 不猜、不广播） */
export function ambiguityNotice(waiting: PendingAgentCall[]): string {
  const who = waiting.map((c) => c.callerName).join("、");
  return `[ℹ️ 现在有 ${waiting.length} 个 agent 同时在等你的答复：${who}。你没用 send_to_agent 指明答给谁的回复，bridge 分不清归谁，`
    + `所以没有转给任何一方（免得把 A 的内容给了 B）。请用 send_to_agent 分别回复每个发起方（target 填它的名字）。]`;
}

/** caller 当时填的 expecting 放在答复最前面，caller 不靠自己记得也能接着干 */
export function withExpecting(pac: PendingAgentCall, reply: string): string {
  return pac.expecting
    ? `[💡 你之前 send_to_agent 给 ${pac.targetName} 时填的期望：${pac.expecting}\n对方答复如下，请按计划继续，不要只 relay 给用户。]\n\n${reply}`
    : reply;
}

/** 撞错后扣下的话（stop-settle 的 withheld）单独推给 caller 时的抬头：别和不相干那一轮的正文拼在一起 */
export function withheldNotice(pac: PendingAgentCall): string {
  return `[ℹ️ ${pac.targetName} 撞墙前扣下的答复（那一轮以 API 错误结束，下面是出错前它已经说了的话）：]\n\n${(pac.withheld ?? []).join("\n\n")}`;
}

/** 以 API 错误结束、等续跑的回程没了（2 小时没接着做完 / target 被关掉）：不静默删，固定模板告诉 caller，扣下的话附后 */
export function expiredNotice(pac: PendingAgentCall, why = "之后 2 小时没有接着做完"): string {
  const at = new Date(pac.apiErrorAt ?? pac.ts).toTimeString().slice(0, 5);
  const head = `[ℹ️ ${pac.targetName} 没有给出答复（原因：它 ${at} 那一轮以 API 错误结束，${why}），扣下的话附后，请重发或换人]`;
  return pac.withheld?.length ? `${head}\n\n${pac.withheld.join("\n\n")}` : head;
}
