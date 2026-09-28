/**
 * 批量管理（bridge/local-api/fleet.ts、bridge/fleet/）：GET /fleet/state、POST /fleet/run，以及 SSE 的 low_priority 事件。
 * 只有 owner 本人的全 scope manage 凭据能用，其余 403（面板直接显示错误）。
 */
import { api, ApiError } from "./client";
import { followEventStream } from "./ledger";

export type LpMode = "on" | "off" | "exhausted" | "unknown";
/** bridge/fleet/lp-monitor.ts 的 LpSnapshot 在网页这边的形状（web 与 src 互不 import）：walled = 撞墙等待，offer = 现在能开 */
export type LpState = { lowPriority: LpMode; walled: boolean; offer: boolean; at: number } & Partial<{ resetsAt: string; allowancePct: number; reason: string }>;

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

/**
 * 顶栏上下文徽章、输入框警示条的「存记忆 + Compact」：只对这一个 agent 发 save-compact，执行者由 bridge 改成 compact
 * （它的 save-compact 会盖掉 PM 的 HANDOFF）。返回按钮上显示的一句话；ok=false 时按钮可以再点。
 */
export async function requestCompact(agent: string): Promise<{ ok: boolean; text: string }> {
  try {
    const r = await runFleet({ action: { kind: "save-compact" }, select: { agents: [agent] } });
    const x = r.results[0];
    if (!x) return { ok: false, text: r.excluded[0]?.reason ?? r.summary };
    return { ok: x.outcome === "done" || x.outcome === "queued", text: x.detail };
  } catch (e) {
    const denied = e instanceof ApiError && e.status === 403;
    return { ok: false, text: denied ? "只有 owner 本机的管理设备能直接压缩" : (e as Error).message };
  }
}

/** 订阅 low_priority 事件（面板开着时实时刷新徽章）；signal 中止即关连接 */
export function followLpEvents(opts: { signal: AbortSignal; onEvent: (agent: string, lp: LpState) => void }): Promise<void> {
  return followEventStream("/events?types=low_priority", {
    signal: opts.signal,
    onEvent: (e) => e.type === "low_priority" && opts.onEvent(e.agent, e.data as unknown as LpState),
  });
}

/** 徽章文案：开 → 「LP→3:20am」；用完 → 「LP 已用完」；撞墙 → 「撞墙中」；其余不显示 */
export function lpBadgeText(lp: LpState | null | undefined): string | null {
  if (!lp) return null;
  if (lp.lowPriority === "on") return `LP→${lp.resetsAt ?? "?"}`;
  if (lp.lowPriority === "exhausted") return "LP 已用完";
  if (lp.walled) return "撞墙中";
  return null;
}
