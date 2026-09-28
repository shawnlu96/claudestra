/**
 * 台账读接口（bridge T8c：GET /api/v1/ledger/:project[/tasks/:id]）与协作视图的事件订阅。
 * 权限是 canReadLedger（全 scope 的 owner 设备）；403 由调用方收起入口，不当成故障。
 */
import type { LedgerOverview } from "@/features/collab/collab-model";
import type { TaskDetail } from "@/features/collab/collab-detail-model";
import { drainFrames, type BridgeEvent } from "@/lib/chat/stream-shape";
import { apiAgentName } from "@/lib/chat/agents";
import { api, apiStream } from "./client";

const enc = encodeURIComponent;

/** since：带上就多要一份 sinceEvents（「上次以来」的原料）；老 bridge 不认这个参数，照常回总览 */
export function fetchLedger(project: string, signal?: AbortSignal, since?: number | null): Promise<LedgerOverview & { ok: boolean }> {
  return api(`/ledger/${enc(project)}${typeof since === "number" ? `?since=${since}` : ""}`, { timeoutMs: 10_000, signal });
}

/** 「上次以来」的基准（bridge local-api/last-seen.ts，按 principal × 项目）；null = 没记过 */
export function fetchLastSeen(project: string, signal?: AbortSignal): Promise<{ lastSeen: number | null; now: number }> {
  return api(`/me/last-seen/${enc(project)}`, { timeoutMs: 8000, signal });
}

/** 记一次「看过」：时刻用服务端的；keepalive 让页面隐藏 / 卸载途中也发得出去 */
export function markLastSeen(project: string): Promise<{ lastSeen: number; now: number }> {
  return api(`/me/last-seen/${enc(project)}`, { method: "PUT", timeoutMs: 8000, keepalive: true });
}

/** 某 agent 当前在跑的 bg 活动快照（审查员信号重连时整表重建用）；查不到回空 */
export function fetchBgTasks(agent: string, signal?: AbortSignal): Promise<{ id: string; kind: string; title: string; startedAt: number }[]> {
  return api<{ tasks?: { id: string; kind: string; title: string; startedAt: number }[] }>(`/agents/${enc(apiAgentName(agent))}/bg-tasks`, { timeoutMs: 5000, signal }).then(
    (r) => r.tasks ?? [],
    () => [], // 查不到（老 bridge / 这台设备看不到 PM）：没有审查员信号，线照常显示
  );
}

export function fetchLedgerTask(project: string, id: string, signal?: AbortSignal): Promise<TaskDetail & { ok: boolean }> {
  return api(`/ledger/${enc(project)}/tasks/${enc(id)}`, { timeoutMs: 10_000, signal });
}

/** 发「对它说」之前实时查一次它在不在回合里（同聊天页连流时补拉的 /pending）；查不到返回 null，由调用方按忙处理 */
export function agentPending(agent: string): Promise<{ thinking?: boolean; compacting?: boolean } | null> {
  return api<{ thinking?: boolean; compacting?: boolean }>(`/agents/${enc(apiAgentName(agent))}/pending`, { timeoutMs: 4000 }).catch(
    () => null, // 查不到（断网 / 老 bridge）：返回 null，liveIdle 会按忙处理，宁可不发
  );
}

/** 协作视图只关心这几类：台账变了、各 agent 的此刻动作、PM 的审查员子 agent 起止 */
const WANTED = new Set(["ledger", "tool_start", "tool_done", "agent_status", "bg_task_started", "bg_task_completed"]);

/**
 * 订阅 bridge /events，逐条回调关心的事件；onOpen 在连上时调一次（调用方据此全量重拉，T8c 约定）。
 * 流正常结束或出错都 resolve / reject 给调用方决定重连；signal 中止即关连接。
 */
export async function followCollabEvents(opts: { signal: AbortSignal; onOpen: () => void; onEvent: (e: BridgeEvent) => void }): Promise<void> {
  const res = await apiStream("/events", { signal: opts.signal });
  opts.onOpen();
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      const { events, rest } = drainFrames(buffer + dec.decode(value, { stream: true }));
      buffer = rest;
      for (const evt of events) if (WANTED.has(evt.type)) opts.onEvent(evt);
    }
  } finally {
    reader.cancel().catch(() => undefined); // 已断开的流再 cancel 会抛，这里只是善后
  }
}
