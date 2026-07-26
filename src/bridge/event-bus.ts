/**
 * v2.6.0+ 进程内事件总线（多前端架构的只读地基）。
 *
 * 设计见 docs/design-multi-frontend.md §4。要点：
 * - 旁路镜像：jsonl-watcher / bridge 在既有分支里加一行 emit()，Discord 渲染
 *   管线一字不动。事件流是镜像不是管线上游 —— 新前端（Web/Telegram）订阅
 *   这里自行渲染，不复用 Discord 的 debounce/edit 逻辑。
 * - 无持久化：权威历史在 jsonl（lib/agent-stats、lib/jsonl-cost 可查），这里
 *   只做实时 + 环形缓冲补发。bridge 重启即清零（已知限制 R6）。
 * - schema additive-only：BridgeEvent 只加字段不删不改语义（对前端作者的
 *   兼容承诺，设计 D7）。
 */

export type BridgeEventType =
  | "tool_start"
  | "tool_done"
  | "assistant_text"
  | "turn_duration"
  | "agent_status"
  | "auto_deny"
  | "question"
  // AUQ 已应答/取消（Discord 按钮或 /api/v1 answer 端点触发），web 前端
  // 收到后收起交互卡。additive-only 合同允许加类型；upstream 落地同类事件后切换。
  | "question_cleared"
  | "chat_message"
  // 上下文压缩完成（CC 在 jsonl 落 system/compact_boundary 时发出）。web 端据此
  // 插分隔线、让 ctx 徽章即时回落。jsonl-watcher 一直在发，但漏了在这里声明 ——
  // 加类型检查后才暴露出来。
  | "compact_done"
  // v2.7+ 会话对账异常：bg 分身出现 / 链路掉线 / 收编与清理结果（agents 模式适配）
  | "session_anomaly"
  // v2.8+ bg 活动生命周期（subagent / 后台 shell 任务），data.kind 区分
  | "bg_task_started"
  | "bg_task_update"
  | "bg_task_completed"
  // v2.15+ 思考遥测:回合进行中 TUI 状态行采样(耗时/输出 token/effort),
  // transient 发布——不进 ring(过期即废,还会把 replay 窗口挤爆)。
  // 任务清单不走事件:web 已有文件真源面板(~/.claude/tasks + /agents/:name/tasks)
  | "thinking_telemetry";

export interface BridgeEvent {
  /** 进程内单调递增，SSE 的 id / Last-Event-ID 补发锚点 */
  seq: number;
  /** ISO 时间戳 */
  ts: string;
  /** registry 里的 agent 名（master 用 "master"） */
  agent: string;
  /** 该 agent 的主会话地址（统一 keyspace，裸 id = discord） */
  chatId: string;
  type: BridgeEventType;
  /** 按 type 各自的负载，见设计 §4.1（additive-only） */
  data: Record<string, unknown>;
}

export type EventFilter = {
  /** 只要这个 agent 的事件；省略 = 全部 */
  agent?: string;
  /** 只要这些 agent 的事件（token scope 过滤用）；省略 = 不限 */
  agents?: string[];
};

type Subscriber = {
  filter: EventFilter;
  cb: (evt: BridgeEvent) => void;
};

/** 每个 agent 的环形缓冲上限（补发窗口） */
export const RING_LIMIT = 500;

/**
 * seq 起点用启动时刻的毫秒数，而不是 1。
 *
 * 原来每次 bridge 启动都从 1 重新数，于是重启后：客户端拿着上个实例的
 * `Last-Event-ID: 4321` 回来，replayEventsSince 里 `evt.seq > 4321` 对新实例的
 * 1、2、3… 全不成立 —— **静默返回零条**，客户端以为"没有新事件"，实际是补发窗口
 * 整个失效了；而且之后 seq 一路倒退，下一次断线重连又会把整个 ring 当新事件重放
 * 一遍（重复消息）。
 * 用启动时刻打底后，新实例的 seq 一定大于任何旧实例发过的值，旧 id 回来就退化成
 * "把 ring 里现有的补给你"，这正是补发该有的行为。
 */
let nextSeq = Date.now();
const subscribers = new Set<Subscriber>();
/** agent → 该 agent 最近 RING_LIMIT 条事件（seq 升序） */
const rings = new Map<string, BridgeEvent[]>();
/**
 * agent → 最近一次 agent_status（"thinking"=回合进行中 / "done"=已收尾）。
 * O(1) 查询「该 agent 此刻是否在回合中」，供刷新/迟到订阅者（web composer 的
 * 暂停态、SSE 连流时补拉）判断——不必扫 ring（status 事件稀疏但仍可能被挤出）。
 * bridge 重启清零（同 ring 的 R6 限制：权威回合边界靠 Stop hook 的 done 事件）。
 */
const agentStatuses = new Map<string, "thinking" | "done">();

function matches(evt: BridgeEvent, filter: EventFilter): boolean {
  if (filter.agent && evt.agent !== filter.agent) return false;
  if (filter.agents && !filter.agents.includes(evt.agent)) return false;
  return true;
}

/**
 * 发布一条事件。seq/ts 由总线补齐。订阅者回调异常只 log 不传播 ——
 * 事件流是旁路，任何情况下不能影响主流程。
 *
 * opts.transient：只发给实时订阅者，不进环形缓冲。给高频瞬态流
 * （thinking_telemetry 每 3s 一条）用——补发陈旧遥测毫无意义，而且
 * 一次长思考就能把 ring 里真正值得补发的工具/文本事件全挤出去。
 */
export function emitEvent(
  evt: Omit<BridgeEvent, "seq" | "ts"> & { ts?: string },
  opts?: { transient?: boolean },
): BridgeEvent {
  const full: BridgeEvent = {
    seq: nextSeq++,
    ts: evt.ts ?? new Date().toISOString(),
    agent: evt.agent,
    chatId: evt.chatId,
    type: evt.type,
    data: evt.data,
  };
  if (!opts?.transient) {
    let ring = rings.get(full.agent);
    if (!ring) {
      ring = [];
      rings.set(full.agent, ring);
    }
    ring.push(full);
    if (ring.length > RING_LIMIT) ring.splice(0, ring.length - RING_LIMIT);
  }

  // 追踪回合进行态（O(1) 查询锚点）。
  if (full.type === "agent_status") {
    const st = (full.data as { status?: unknown }).status;
    if (st === "thinking" || st === "done") agentStatuses.set(full.agent, st);
  }

  for (const sub of subscribers) {
    if (!matches(full, sub.filter)) continue;
    try {
      sub.cb(full);
    } catch (e) {
      console.error("event-bus 订阅者回调异常（忽略）:", (e as Error).message);
    }
  }
  return full;
}

/** 订阅实时事件。返回取消函数。 */
export function subscribeEvents(
  filter: EventFilter,
  cb: (evt: BridgeEvent) => void,
): () => void {
  const sub: Subscriber = { filter, cb };
  subscribers.add(sub);
  return () => {
    subscribers.delete(sub);
  };
}

/**
 * 补发：返回 seq > since 的缓冲事件（跨 agent 合并后按 seq 升序）。
 * since=0 表示"从缓冲最早处开始"。
 */
/**
 * 丢弃某个 agent 的事件环 + 状态。agent 被 kill 之后它的 ring 不会再有人订阅，
 * 却会连同里面最多 RING_LIMIT 条事件（含未截断的 assistant_text）一直留在内存里 ——
 * 长期运行的 bridge 上，建了又删的 agent 会一直堆积。
 */
export function forgetAgent(agent: string): void {
  rings.delete(agent);
  agentStatuses.delete(agent);
}

export function replayEventsSince(
  since: number,
  filter: EventFilter = {},
): BridgeEvent[] {
  const out: BridgeEvent[] = [];
  for (const ring of rings.values()) {
    for (const evt of ring) {
      if (evt.seq > since && matches(evt, filter)) out.push(evt);
    }
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

/** 当前订阅者数量（测试/诊断用） */
export function subscriberCount(): number {
  return subscribers.size;
}

/**
 * 该 agent 当前的回合态（最近一次 agent_status）。undefined = bridge 启动后
 * 该 agent 尚无任何 status 事件（视为空闲）。用于 web composer 刷新后同步暂停态。
 */
export function getAgentStatus(agent: string): "thinking" | "done" | undefined {
  return agentStatuses.get(agent);
}

/** 测试专用：清空总线状态 */
export function __resetEventBusForTest(): void {
  nextSeq = 1;
  subscribers.clear();
  rings.clear();
  agentStatuses.clear();
}
