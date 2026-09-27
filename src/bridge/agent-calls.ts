/**
 * send_to_agent 的回程路由簿：记下「谁在等谁的答复」，target 下一次 reply 到自己频道（或回合结束 drain 出文字）时，
 * bridge 把那段话推回 caller，caller 不必 fetch_messages 轮询。key = target 的 channelId，同一 target 后一次调用覆盖前一次。
 *
 * 落盘（~/.claude-orchestrator/pending-agent-calls.json）：消息本身押后队列已经不丢，回程簿要跟着不丢——否则
 * bridge 重启后对方照常回复，却没人知道该推给谁（codex 2026-09-28 复核 i15 指出）。不存 caller 的 ws：
 * 推回时按 callerChannelId 取当前连接，caller 重连 / bridge 重启都不影响。
 */
import { statePath } from "../lib/paths.js";
import { PersistedMap } from "./persisted-map.js";

export interface PendingAgentCall {
  /** 谁发起的（master 或某个 agent） */
  callerChannelId: string;
  callerName: string;
  targetName: string;
  /**
   * caller 发起时手头正在处理的 inbound 请求的 intendedReplyChannel（通常是 caller 自己的频道）。推回的
   * meta.chat_id 用它，免得 caller 把 target 的私频当回复目标；没有正在处理的请求时是 undefined。
   */
  originalReplyChannel?: string;
  /** caller 填的「答完后我该做啥」，推回时放在最前面，caller 不靠自己记得也能接着干 */
  expecting?: string;
  ts: number;
}

const isCall = (v: unknown): boolean => {
  const c = v as Partial<PendingAgentCall> | null;
  return !!c && typeof c === "object" && typeof c.callerChannelId === "string" && typeof c.callerName === "string"
    && typeof c.targetName === "string" && typeof c.ts === "number";
};

export class AgentCallBook extends PersistedMap<PendingAgentCall> {
  constructor(path: string | null = statePath("pending-agent-calls.json")) {
    super(path, "回程路由簿", isCall);
    if (this.size) console.log(`♻️ 恢复待回程的 send_to_agent ${this.size} 条（对方的答复仍会推回发起方）`);
  }

  /** 失效钟重新起算（押后的消息真正送达时调），并落盘 */
  touch(targetChannelId: string, now = Date.now()): void {
    const c = this.get(targetChannelId);
    if (c) this.set(targetChannelId, { ...c, ts: now });
  }
}
