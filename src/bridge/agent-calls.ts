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
import { statePath } from "../lib/paths.js";
import { PersistedMap } from "./persisted-map.js";

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
  /** 这一槽的各条请求（老数据没有：整槽当一条） */
  requests?: CallRequest[];
  /** requests 的 message_id（stale 扫描判「全都还押着」用，lib/held-pac.ts） */
  messageIds?: string[];
}

export interface CallRequest {
  messageId?: string;
  expecting?: string;
  originalReplyChannel?: string;
  ts: number;
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

  /** 记一条请求（同一 caller 还没答完的请求留着，新的追加在后面） */
  add(target: string, call: PendingAgentCall, messageId?: string): void {
    const prev = this.slot(target, call.callerChannelId);
    const req: CallRequest = { messageId, expecting: call.expecting, originalReplyChannel: call.originalReplyChannel, ts: call.ts };
    this.store(target, { ...(prev ?? call), ...call, ambiguityNotifiedAt: undefined, apiErrorNotifiedAt: undefined }, [...requestsOf(prev), req]);
  }

  slot(target: string, caller: string): PendingAgentCall | undefined {
    return this.get(keyOf(target, caller));
  }

  /** 消化一次答复：只删视图里（已送到 target 的）那几条请求，删空了才删整槽；不给视图 = 整槽删 */
  consume(target: string, caller: string, answered?: PendingAgentCall): boolean {
    const cur = this.slot(target, caller);
    if (!cur) return false;
    if (!answered?.requests) return this.delete(keyOf(target, caller));
    const done = new Set(answered.requests.map((r) => r.messageId));
    const left = requestsOf(cur).filter((r) => !done.has(r.messageId));
    if (!left.length) return this.delete(keyOf(target, caller));
    this.store(target, { ...cur, apiErrorAt: undefined, withheld: undefined }, left); // 扣下的话已随答复推走
    return true;
  }

  /** send_to_agent 投递失败：只撤这一条请求 */
  dropRequest(target: string, caller: string, messageId: string): void {
    const cur = this.slot(target, caller);
    if (cur) this.consume(target, caller, { ...cur, requests: [{ messageId, ts: 0 }] });
  }

  private store(target: string, base: PendingAgentCall, reqs: CallRequest[]): void {
    const last = reqs[reqs.length - 1];
    this.set(keyOf(target, base.callerChannelId), {
      ...base, targetChannelId: target, requests: reqs, messageIds: reqs.map((r) => r.messageId).filter((x): x is string => !!x),
      expecting: last?.expecting, originalReplyChannel: last?.originalReplyChannel,
    });
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

  /** target 这一轮以 API 错误结束：在等它的槽都记上等续跑（第一次的时刻），withheld 有字就追加；落盘 */
  markApiError(target: string, stillHeld: StillHeld, withheld: string | null, now = Date.now()): void {
    const w = this.waiting(target, stillHeld);
    for (const c of w) {
      const raw = this.slot(target, c.callerChannelId);
      if (raw) this.setQuiet(keyOf(target, c.callerChannelId), { ...raw, apiErrorAt: raw.apiErrorAt ?? now, withheld: [...(raw.withheld ?? []), ...(withheld ? [withheld] : [])] });
    }
    if (w.length) this.persist();
  }

  /** 有 caller 在等 target 接着做完（它上一轮以 API 错误结束）：这时 owner 在 Discord 打字不算接管 */
  awaitingResume(target: string, stillHeld: StillHeld): boolean {
    return this.waiting(target, stillHeld).some((c) => c.apiErrorAt);
  }

  /** 失效钟重新起算（押后的消息真正送达时调）：给了 caller 只动那一槽，否则 target 名下全部 */
  touch(target: string, caller?: string, now = Date.now()): void {
    let changed = false;
    for (const [k, c] of [...this.entries()]) {
      if (targetOf(k, c) !== target || (caller && c.callerChannelId !== caller)) continue;
      this.setQuiet(k, { ...c, ts: now });
      changed = true;
    }
    if (changed) this.persist();
  }

  /** 这个频道作为 target 或 caller 的槽全清掉（用户接管 / agent 被 kill），返回清掉几条 */
  dropChannel(channelId: string): number {
    let n = 0;
    for (const [k, c] of [...this.entries()]) {
      if (targetOf(k, c) !== channelId && c.callerChannelId !== channelId) continue;
      this.deleteQuiet(k);
      n++;
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
