/**
 * 跨机 send_to_agent（HTTP peer）在等对方回复的调用簿：对方收下请求、给了 thread 之后，bridge 每 30s 轮询那条 thread
 * 最长 2 小时。轮询只活在进程里，bridge 一重启（部署、自动更新）对方的回复就再也没人去取——对方照常答了，发起方永远收不到。
 * 落盘到 ~/.claude-orchestrator/pending-peer-calls.json，启动时按原来的截止时间接着轮询（http-peer.ts resumePeerCalls）。
 * 不存 ws、不存 token：推回时按 callerChannelId 取当前连接，轮询时按 peerName 重读 peers.json（token 可能已轮换）。
 */
import { statePath } from "../lib/paths.js";
import { PersistedMap } from "./persisted-map.js";

export interface PendingPeerCall {
  callerChannelId: string;
  callerName: string;
  peerName: string;
  peerAgent: string;
  threadId: string;
  expecting?: string;
  /** 已经告诉过发起方「对方回合结束但没文本」，重启后别再说一遍 */
  emptyNoticed?: boolean;
  /** 放弃轮询的时刻（绝对时间，重启不重新计时） */
  deadline: number;
}

const isCall = (v: unknown): boolean => {
  const c = v as Partial<PendingPeerCall> | null;
  return !!c && typeof c === "object" && typeof c.callerChannelId === "string" && typeof c.callerName === "string"
    && typeof c.peerName === "string" && typeof c.peerAgent === "string" && typeof c.threadId === "string"
    && typeof c.deadline === "number";
};

export const PEER_CALLS_PATH = statePath("pending-peer-calls.json");

export class PeerCallBook extends PersistedMap<PendingPeerCall> {
  constructor(path: string | null = PEER_CALLS_PATH) {
    super(path, "跨机调用簿", isCall);
  }
}
