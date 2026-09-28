/**
 * 批量管理（bridge/local-api/fleet.ts、bridge/fleet/）：GET /fleet/state、POST /fleet/run，以及 SSE 的 low_priority 事件。
 * 只有 owner 本人的全 scope manage 凭据能用，其余 403（面板直接显示错误）。
 */
import { api, apiStream } from "./client";
import { drainFrames } from "@/lib/chat/stream-shape";

export type LpMode = "on" | "off" | "exhausted" | "unknown";
/** bridge/fleet/lp-monitor.ts 的 LpSnapshot */
export interface LpState {
  lowPriority: LpMode;
  walled: boolean;
  offer: boolean;
  resetsAt?: string;
  allowancePct?: number;
  reason?: string;
  at: number;
}

export type FleetActionKind = "lp-on" | "lp-off" | "compact" | "save-compact" | "lp-compact" | "text";
export interface FleetAction { kind: FleetActionKind; keep?: string; text?: string }
export interface FleetSelect { agents?: string[]; all?: boolean; project?: string; walled?: boolean; ctxOver?: number; includeMaster?: boolean }

export interface FleetAgent {
  /** registry 名（带 agent- 前缀）；大总管 = "master" */
  name: string;
  project?: string;
  runtime: string;
  master: boolean;
  online: boolean;
  contextTokens?: number;
  lp?: LpState;
}

export type FleetOutcome = "done" | "queued" | "skipped" | "failed";
export interface FleetResult { agent: string; outcome: FleetOutcome; detail: string }
export interface FleetReport {
  runId: string;
  dryRun: boolean;
  targets: string[];
  results: FleetResult[];
  excluded: { name: string; reason: string }[];
  summary: string;
}

export function fetchFleetState(signal?: AbortSignal): Promise<{ agents: FleetAgent[]; compactKeep: string }> {
  return api("/fleet/state", { timeoutMs: 30_000, signal });
}

/** 每个 agent 最长约 25 秒、bridge 4 路并发；超时给足 */
export async function runFleet(body: { action: FleetAction; select: FleetSelect; dryRun?: boolean }): Promise<FleetReport> {
  const r = await api<{ report: FleetReport }>("/fleet/run", { method: "POST", json: body, timeoutMs: 10 * 60_000 });
  return r.report;
}

/** 订阅 low_priority 事件（面板开着时实时刷新徽章）；signal 中止即关连接 */
export async function followLpEvents(opts: { signal: AbortSignal; onEvent: (agent: string, lp: LpState) => void }): Promise<void> {
  const res = await apiStream("/events", { signal: opts.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      const { events, rest } = drainFrames(buffer + dec.decode(value, { stream: true }));
      buffer = rest;
      for (const e of events) if (e.type === "low_priority") opts.onEvent(e.agent, e.data as unknown as LpState);
    }
  } finally {
    reader.cancel().catch(() => undefined); // 已断开的流再 cancel 会抛，这里只是善后
  }
}

/** 徽章文案：开 → 「LP→3:20am」；用完 → 「LP 已用完」；撞墙 → 「撞墙中」；其余不显示 */
export function lpBadgeText(lp: LpState | null | undefined): string | null {
  if (!lp) return null;
  if (lp.lowPriority === "on") return `LP→${lp.resetsAt ?? "?"}`;
  if (lp.lowPriority === "exhausted") return "LP 已用完";
  if (lp.walled) return "撞墙中";
  return null;
}
