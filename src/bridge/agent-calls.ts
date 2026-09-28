/**
 * send_to_agent 的回程路由簿：记下「谁在等谁的答复」，target 答复时 bridge 把那段话推回 caller，caller 不必 fetch_messages 轮询。
 *
 * 每个 (target, caller) 一槽：以前 key 只是 target，B 问同一个 target 会覆盖 A 的槽，A 的答复就推给了 B（信息串给别人）。
 * 归属规则（codex 2026-09-28 复核）：target 回发 send_to_agent 给 X、或 reply 到 X 的频道 → 精确消化 X 那槽；target 在自己频道
 * reply / 回合结束兜底 → 只有恰好一个已投递的 caller 在等才推给它；多个在等就不推给任何人、不广播，提醒 target 用 send_to_agent 分别回。
 *
 * 同一 caller 连着问同一个 target：并进同一槽（expecting 合并、记下每条请求的 message_id、rev 加一），不覆盖前一个问题；
 * 「请求还押着」按这些 message_id 判（后一条押着不挡前一条的回程）；consume 带 rev，旧快照不会删掉后来并进来的新请求。
 * 仍然没有显式回复 ID：同一 caller 的两个问题共用一次答复（codex 复核：最终要 callId，过渡期每对一个未完成请求）。
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
  /** 这一槽的版本：同一 caller 又问一次就加一（consume 带它，旧快照不删新请求） */
  rev?: number;
  /** 并进这一槽的请求 message_id（判「请求还押着」用） */
  messageIds?: string[];
}

type StillHeld = (call: PendingAgentCall) => boolean;

const isCall = (v: unknown): boolean => {
  const c = v as Partial<PendingAgentCall> | null;
  return !!c && typeof c === "object" && typeof c.callerChannelId === "string" && typeof c.callerName === "string"
    && typeof c.targetName === "string" && typeof c.ts === "number";
};

const SEP = "\u001f";
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

  /** 记一槽；同一 caller 这一槽还没答完就并进去（不覆盖前一个问题）。返回这一槽现在的 rev 和是否并入 */
  add(target: string, call: PendingAgentCall, messageId?: string): { rev: number; merged: boolean } {
    const prev = this.slot(target, call.callerChannelId);
    const ids = messageId ? [messageId] : [];
    if (!prev) {
      this.set(keyOf(target, call.callerChannelId), { ...call, targetChannelId: target, rev: 1, messageIds: ids });
      return { rev: 1, merged: false };
    }
    const rev = (prev.rev ?? 1) + 1;
    const expecting = [prev.expecting, call.expecting].filter(Boolean).join("；接着又问了一件：") || undefined;
    this.set(keyOf(target, call.callerChannelId), {
      ...prev, ...call, targetChannelId: target, rev, expecting, ambiguityNotifiedAt: undefined,
      originalReplyChannel: call.originalReplyChannel ?? prev.originalReplyChannel, messageIds: [...(prev.messageIds ?? []), ...ids],
    });
    return { rev, merged: true };
  }

  slot(target: string, caller: string): PendingAgentCall | undefined {
    return this.get(keyOf(target, caller));
  }

  /** 消化一槽；给了 rev 且槽已被后来的请求并入（rev 变了）就不删 */
  consume(target: string, caller: string, rev?: number): boolean {
    const cur = this.slot(target, caller);
    if (!cur || (rev !== undefined && cur.rev !== undefined && cur.rev !== rev)) return false;
    return this.delete(keyOf(target, caller));
  }

  forTarget(target: string): PendingAgentCall[] {
    return [...this.entries()].filter(([k, c]) => targetOf(k, c) === target).map(([, c]) => c);
  }

  /** 在等 target 答复、且请求已经送到 target 手上的（还押在 target 队里的它根本没看到，不算） */
  waiting(target: string, stillHeld: StillHeld): PendingAgentCall[] {
    return this.forTarget(target).filter((c) => !stillHeld(c));
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
    for (const c of w) this.setQuiet(keyOf(target, c.callerChannelId), { ...c, ambiguityNotifiedAt: now });
    this.persist();
    return w;
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
