/**
 * 跨机 send_to_agent（HTTP peer）在等对方回复的调用簿：对方收下请求、给了 thread 之后，bridge 每 30s 轮询那条 thread
 * 最长 2 小时。轮询只活在进程里，bridge 一重启（部署、自动更新）对方的回复就再也没人去取——对方照常答了，发起方永远收不到。
 * 落盘到 ~/.claude-orchestrator/pending-peer-calls.json，启动时按原来的截止时间接着轮询（http-peer.ts resumePeerCalls）。
 * 不存 ws、不存 token：推回时按 callerChannelId 取当前连接，轮询每一拍按 peerName 重读 peers.json（token 可能已轮换），
 * 并核对 peerId——同名 peer 删了重建成别的实例时不串线。
 */
import type { HttpPeer } from "../lib/peers.js";
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
  /** peer 的稳定身份（peerIdOf）；老记录没有就只按名字认 */
  peerId?: string;
}

/** 对方实例 id（自报）优先，老 peer 记录没有就用出站地址 */
export const peerIdOf = (p: HttpPeer): string => p.instanceId || p.baseUrl || "";

type FindPeer = (name: string) => Promise<HttpPeer | null>;

/** 按名字重读 peer 并核对身份：undefined = peers.json 这会儿读不了（稍后再试）；null = 删了，或同名的已是另一个实例 */
export async function currentPeer(rec: PendingPeerCall, find: FindPeer): Promise<HttpPeer | null | undefined> {
  let p: HttpPeer | null;
  try {
    p = await find(rec.peerName);
  } catch (e) {
    console.error(`peers.json 读不了（跨机调用 ${rec.peerName}/${rec.peerAgent}），稍后再试:`, (e as Error).message);
    return undefined;
  }
  if (!p) return null;
  return !rec.peerId || peerIdOf(p) === rec.peerId ? p : null;
}

export interface ResumeHooks {
  poll: (callId: string, rec: PendingPeerCall, peer: HttpPeer) => void;
  /** peer 没了：告诉发起方（记录已摘） */
  gone: (rec: PendingPeerCall) => Promise<void>;
}

/** bridge 启动时逐条恢复；peers.json 暂时读不了的每 retryMs 后台重试，最多 tries 次（不等下一次重启） */
export function resumePeerCalls(book: PeerCallBook, find: FindPeer, h: ResumeHooks, retryMs = 60_000, tries = 10): void {
  const one = async (callId: string, rec: PendingPeerCall, left: number): Promise<void> => {
    const peer = await currentPeer(rec, find);
    if (peer === undefined) {
      if (left > 0) setTimeout(() => void one(callId, rec, left - 1), retryMs);
      return;
    }
    if (!peer) {
      book.delete(callId);
      await h.gone(rec);
      return;
    }
    h.poll(callId, rec, peer);
  };
  for (const [callId, rec] of [...book]) void one(callId, rec, tries);
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
