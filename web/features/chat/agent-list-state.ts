/**
 * 会话列表（GET /agents）的加载状态与退避（纯逻辑，tests/web-agent-list-state.test.ts）。
 * 只有「本数据源拿到过成功响应」才算知道列表长什么样：未请求 / 首拉中 / 首拉慢 / 首拉失败都不是「暂无会话」，
 * 拉成功过之后的失败保留最后一次成功的列表，只在列表上方挂一条提示。计时 / 在途 / 换源见 agent-list-loader.ts。
 */

export interface AgentListStatus {
  /** idle = 本数据源还没发过请求；loading = 有请求在途；ok / failed = 最近一次请求的结果 */
  phase: "idle" | "loading" | "ok" | "failed";
  /** 本数据源拿到过成功响应（换机器清零）——空态只在这之后才可信 */
  loaded: boolean;
  /** 在途请求超过 SLOW_MS 还没回来 */
  slow: boolean;
  /** 连续失败次数（成功清零） */
  failures: number;
  /** 下一次自动重试的时刻（ms epoch）；null = 没排 */
  retryAt: number | null;
  /** 在途的是用户点的「重试」 */
  manual: boolean;
  /** 401 / 403：凭据或权限问题，不自动重试（重新配对由 MachineGate 横幅引导） */
  denied: boolean;
}

export const INITIAL_AGENT_LIST: AgentListStatus = {
  phase: "idle", loaded: false, slow: false, failures: 0, retryAt: null, manual: false, denied: false,
};

/** 单次请求上限：原 5s 在 bridge 重启 / 弱网时首拉必超时；再长就让「重试」等太久 */
export const AGENT_LIST_TIMEOUT_MS = 12_000;
/** 在途超过这个时长就提示「较慢」 */
export const SLOW_MS = 3_000;
const BACKOFF_BASE_MS = 2_000;
/** 退避封顶：断网期间至多每 30s 试一次，不会越拖越久 */
export const BACKOFF_CAP_MS = 30_000;

/** 第 failures 次连续失败后的等待：指数退避封顶，jitter 取 [一半, 全额]，多个标签页 / 设备不会同拍砸回来 */
export function backoffMs(failures: number, rand: number): number {
  const full = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
  return Math.round(full / 2 + (full / 2) * Math.min(1, Math.max(0, rand)));
}

/** 401 / 403 不值得自动重试：再试也是同一个答案，还会刷爆 client.log */
export function isDeniedError(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  return status === 401 || status === 403;
}

/** 请求理由：poll = 15s 轮询（失败退避期内不插队）；event = 联网 / 回前台（可提前重试）；manual = 用户点重试；action = 操作后拉真值 */
export type AgentListReason = "poll" | "event" | "manual" | "action";

/** 这次请求要不要真的发出（在途时一律合流到在途那一个，由 loader 处理） */
export function shouldRequest(s: AgentListStatus, reason: AgentListReason, now: number): boolean {
  if (reason === "manual" || reason === "action") return true;
  if (s.denied) return false; // 凭据问题只等用户动手
  if (reason === "event") return true;
  return s.retryAt === null || now >= s.retryAt;
}

export const startRequest = (s: AgentListStatus, reason: AgentListReason): AgentListStatus =>
  ({ ...s, phase: "loading", slow: false, retryAt: null, manual: reason === "manual" });

export const markSlow = (s: AgentListStatus): AgentListStatus => (s.phase === "loading" ? { ...s, slow: true } : s);

export const succeed = (s: AgentListStatus): AgentListStatus =>
  ({ ...s, phase: "ok", loaded: true, slow: false, failures: 0, retryAt: null, manual: false, denied: false });

/** 失败：denied 不排重试；其它按退避排下一次 */
export function fail(s: AgentListStatus, e: unknown, now: number, rand: number): AgentListStatus {
  const failures = s.failures + 1;
  const denied = isDeniedError(e);
  return { ...s, phase: "failed", slow: false, manual: false, failures, denied, retryAt: denied ? null : now + backoffMs(failures, rand) };
}

/**
 * 侧栏 / 启动页该显示什么：
 * - waiting：还没拿到过列表、请求在途且不慢（或还没发）→「加载中…」
 * - slow：首拉在途超过 SLOW_MS →「加载较慢，仍在连接…」
 * - retrying：首拉失败、已排自动重试；denied：首拉被拒、不自动重试
 * - empty：拿到过成功响应、最近一次也成功，且列表真的是空的 →「暂无会话」
 * - list：正常列表；stale：有过列表但最近刷新失败 → 列表照旧 + 顶部一条提示
 */
export type AgentListView = "waiting" | "slow" | "retrying" | "denied" | "empty" | "list" | "stale";

export function agentListView(s: AgentListStatus, count: number): AgentListView {
  if (!s.loaded) {
    if (s.phase === "failed") return s.denied ? "denied" : "retrying";
    // 失败后点「重试」：在途期间仍按失败语义显示（按钮转圈），不退回「加载中」
    if (s.phase === "loading" && s.failures > 0) return s.denied ? "denied" : "retrying";
    return s.slow ? "slow" : "waiting";
  }
  if (s.failures > 0) return "stale";
  return count === 0 ? "empty" : "list";
}

/** 交互期冻结顺序：字段用新的，顺序按旧列表；新增成员排尾（chat-store applyAgents） */
export function keepRosterOrder<A extends { name: string }>(prev: readonly A[], next: readonly A[]): A[] {
  const pos = new Map(prev.map((x, i) => [x.name, i] as const));
  return [...next].sort((x, y) => (pos.get(x.name) ?? 1e9) - (pos.get(y.name) ?? 1e9));
}
