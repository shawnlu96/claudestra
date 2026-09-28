/**
 * 台账读接口（bridge T8c：GET /api/v1/ledger/:project[/tasks/:id]）与协作视图的事件订阅。
 * 权限是 canReadLedger（全 scope 的 owner 设备）；403 由调用方收起入口，不当成故障。
 */
import type { LedgerOverview } from "@/features/collab/collab-model";
import type { TaskDetail } from "@/features/collab/collab-detail-model";
import { drainFrames, type BridgeEvent } from "@/lib/chat/stream-shape";
import { api, apiStream } from "./client";

const enc = encodeURIComponent;

export function fetchLedger(project: string, signal?: AbortSignal): Promise<LedgerOverview & { ok: boolean }> {
  return api(`/ledger/${enc(project)}`, { timeoutMs: 10_000, signal });
}

export function fetchLedgerTask(project: string, id: string, signal?: AbortSignal): Promise<TaskDetail & { ok: boolean }> {
  return api(`/ledger/${enc(project)}/tasks/${enc(id)}`, { timeoutMs: 10_000, signal });
}

/** 协作视图只关心这几类：台账变了、各 agent 的此刻动作 */
const WANTED = new Set(["ledger", "tool_start", "tool_done", "agent_status"]);

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
