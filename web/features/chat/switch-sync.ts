/**
 * 切换 agent 走增量（SYN-1）。切走时把「最新视图」的同步锚（差量游标 + 翻页状态）和消息快照一起存下；
 * 切回时恢复锚、只拉游标之后的差量，同时立刻开推送流。
 *
 * 流和历史并行时的竞态：历史落地会按 composeView 重组视图，重组前到达的已定稿直播气泡会被洗掉
 * （reconnect-policy 的 delta 路径因此一直是「先差量后开流」）。所以流先连上、事件先进 EventGate
 * 排队，历史落地后按到达顺序放行——放行时游标已推进，已入历史的事件由 coveredByCursor /
 * historyHasReply / findEchoTarget 这几道既有去重拦下，不重复也不丢。tests/web-switch-sync.test.ts 锁住。
 */
import type { ChatState } from "./chat-store";
import type { HistoryCursor } from "./live-merge";
import type { ChatMessage } from "./type";

/** 最新视图的同步锚：恢复它 = 视图回到切走那一刻，可以只补差量 */
export interface SyncAnchor {
  cursor: HistoryCursor;
  historySessionId: string | null;
  olderCursor: { sid: string; firstSeq: number } | null;
  hasMore: boolean;
}

/** 历史落地前的流事件队列：hold 返回 true = 已排队，调用方别再处理；release 一次性取走并关闸 */
export class EventGate<E> {
  private buf: E[] | null = [];
  hold(e: E): boolean {
    if (!this.buf) return false;
    this.buf.push(e);
    return true;
  }
  release(): E[] {
    const out = this.buf ?? [];
    this.buf = null;
    return out;
  }
}

/** 切到另一个 agent 时重置 per-agent 状态。有快照就先秒开它（无 loading 闪烁）；有锚就沿用切走时的翻页状态 */
export function resetForAgent(s: ChatState, name: string, cached: ChatMessage[] | undefined, anchor: SyncAnchor | undefined): void {
  s.activeAgent = name;
  s.messages = cached ?? [];
  s.loadingHistory = !cached;
  s.syncState = null; // 差量 / 全量会立即重置为 syncing
  s.streamDown = false; // 新会话的流状态从零开始，连上 / 断开由 openStream 说话
  // 翻页态 per-agent：不重置的话上一会话的「还有更早」残留成按钮 / 哨兵鬼影；有锚 = 恢复本会话自己的
  s.historyHasMore = anchor?.hasMore ?? false;
  s.historyNewerHasMore = false;
  s.loadingNewer = false;
  s.loadingOlder = false;
  s.historyError = false;
  s.streaming = false;
  s.awaitingChunk = false;
  s.compacting = false;
  // 交互卡 / bg 面板 / CC 任务清单都是 per-session：先清空，新流连上后 /pending、/bg-tasks 补回，任务清单另拉
  s.pendingPermission = null;
  s.pendingAsk = null;
  s.bgTasks = [];
  s.ccTasks = [];
  s.telemetry = null;
  s.browsing = null; // 切 agent 退出历史现场
}
