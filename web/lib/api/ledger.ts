/**
 * 台账读接口（bridge T8c：GET /api/v1/ledger/:project[/tasks/:id]）与协作视图的事件订阅。
 * 权限是 canReadLedger（全 scope 的 owner 设备）；403 由调用方收起入口，不当成故障。
 */
import type { LedgerEventView, LedgerOverview } from "@/features/collab/collab-model";
import type { TaskDetail } from "@/features/collab/collab-detail-model";
import type { DagBoard, DagDiffResponse, FeatureDetail } from "@/features/collab/dag/dag-types";
import { drainFrames, type BridgeEvent } from "@/lib/chat/stream-shape";
import { apiAgentName } from "@/lib/chat/agents";
import { api, apiStream } from "./client";

const enc = encodeURIComponent;

export function fetchLedger(project: string, signal?: AbortSignal): Promise<LedgerOverview & { ok: boolean }> {
  return api(`/ledger/${enc(project)}`, { timeoutMs: 10_000, signal });
}

/** 子 DAG 两张图共用的快照（bridge i28-L4，同一道 canReadLedger 门）；老 bridge 没有这条路由 = 404，调用方回落到因果线画布 */
export function fetchDagBoard(project: string, signal?: AbortSignal): Promise<DagBoard> {
  return api(`/ledger/${enc(project)}/dag`, { timeoutMs: 10_000, signal });
}

/** 某个 feature 的版本列表 + 一版快照；version 缺省 = 当前版，"pending" = 等批的重写 */
export function fetchDagFeature(project: string, featureId: string, version?: number | "pending", signal?: AbortSignal): Promise<FeatureDetail> {
  const q = version === undefined ? "" : `?version=${enc(String(version))}`;
  return api(`/ledger/${enc(project)}/dag/${enc(featureId)}${q}`, { timeoutMs: 10_000, signal });
}

/** 两版对比（to 可以是 "pending"） */
export function fetchDagDiff(project: string, featureId: string, from: number, to: number | "pending", signal?: AbortSignal): Promise<DagDiffResponse> {
  return api(`/ledger/${enc(project)}/dag/${enc(featureId)}/diff?from=${from}&to=${enc(String(to))}`, { timeoutMs: 10_000, signal });
}

export interface LastSeenView {
  /** 服务端记的上次看过的时刻（按 principal × 项目）；null = 没记过 */
  lastSeen: number | null;
  now: number;
  /** 基准（since，缺省 lastSeen）之后、now 之前的任务事件；老 bridge 没有 */
  events?: LedgerEventView[];
  truncated?: boolean;
}

/** 「上次以来」一个请求拿齐：基准 + 之后的事件（bridge local-api/last-seen.ts）；since 覆盖基准（同一标签页刷新前那份） */
export function fetchLastSeen(project: string, signal?: AbortSignal, since?: number | null): Promise<LastSeenView> {
  return api(`/me/last-seen/${enc(project)}?events=1${typeof since === "number" ? `&since=${since}` : ""}`, { timeoutMs: 8000, signal });
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
 * 订阅 bridge /events（path 可带 ?types= 让 bridge 先滤一道），逐条回调；onOpen 在连上时调一次（调用方据此全量重拉，T8c 约定）。
 * 流正常结束或出错都 resolve / reject 给调用方决定重连；signal 中止即关连接。协作视图与侧栏「待你处理」共用。
 */
export async function followEventStream(path: string, opts: { signal: AbortSignal; onOpen?: () => void; onEvent: (e: BridgeEvent) => void }): Promise<void> {
  const res = await apiStream(path, { signal: opts.signal });
  opts.onOpen?.();
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      const { events, rest } = drainFrames(buffer + dec.decode(value, { stream: true }));
      buffer = rest;
      for (const evt of events) opts.onEvent(evt);
    }
  } finally {
    reader.cancel().catch(() => undefined); // 已断开的流再 cancel 会抛，这里只是善后
  }
}

/** 协作视图：只关心 WANTED 这几类 */
export function followCollabEvents(opts: { signal: AbortSignal; onOpen: () => void; onEvent: (e: BridgeEvent) => void }): Promise<void> {
  // types= 让 bridge 先滤（thinking_telemetry、assistant_text 之类不必经中继上行再扔掉）；老 bridge 不认就照发，这里再筛一道
  return followEventStream(`/events?types=${[...WANTED].join(",")}`, { ...opts, onEvent: (evt) => WANTED.has(evt.type) && opts.onEvent(evt) });
}
