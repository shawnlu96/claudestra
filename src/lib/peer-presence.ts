/**
 * 在线 peer 列表的纯逻辑（bridge/peer-presence.ts 负责定时探测和落盘；tests/peer-presence.test.ts）。
 * 出站方向（我连对方）靠探测：GET 对方 /api/v1/agents；入站方向（对方连我）只能看对方最近一次来访。
 * 单向的 peer（只有对方连我，没有对方地址）online = null：不是离线，是我们没法主动探。
 */
import { join } from "node:path";
import { classifyJoinError } from "./peer-join-hints.js";
import { STATE_DIR } from "./paths.js";
import { parseInstanceInfo, type PeerInstanceInfo } from "./peer-instance-info.js";

/** bridge 落盘的在线列表（bridge/peer-presence.ts 写，manager peer-info 读） */
export const PEER_PRESENCE_PATH = join(STATE_DIR, "peer-presence.json");

export interface PeerPresence {
  /** true 在线 / false 探测失败 / null 没有出站地址（单向：只有对方连我） */
  online: boolean | null;
  checkedAt?: string;
  lastOnlineAt?: string;
  latencyMs?: number;
  /** 对方开放给我的 agent（探测成功时刷新；网络失败保留上次看到的；401 / 403 清空） */
  remoteAgents?: RemoteAgent[];
  /** remoteAgents 最近一次刷新（只在探测成功时写）。checkedAt 失败也刷新、中继 peer 的 online 又被中继覆盖，判忙闲新鲜度只能看它 */
  agentsAt?: string;
  /** 最近一次探测被对方拒绝（401 / 403）：凭据失效，与「对方没开放 agent」是两回事。中继覆盖 online / error 时它不动 */
  authRejected?: boolean;
  /** 离线原因：timeout（多半对方机器离线 / 没共享给我）、refused（端口没对外）、http 401 等 */
  error?: string;
  /** 对方最近一次调我的 API（入站） */
  lastInboundAt?: string;
  /** 对方回包里的 instance（版本 / 提交 / 通道 / 协作开关档位，lib/peer-instance-info.ts）。对方没升级或没开 = 没有这个字段 */
  instance?: PeerInstanceInfo;
  /** instance 是哪次探测取到的（探测成功且带 instance 时写） */
  instanceAt?: string;
}

/** busy 只在对方回了布尔值时才有：老版本对方不返回，界面显示「—」，不拿 status（active / stopped）冒充忙闲 */
interface RemoteAgent { name: string; status?: string; busy?: boolean }

export type ProbeResult =
  | { ok: true; latencyMs: number; agents: RemoteAgent[]; instance?: PeerInstanceInfo }
  | { ok: false; error: string };

/** token 被对方吊销 / 拒绝：对方开放的 agent 已不再属于我们，候选和缓存都要清 */
const isAuthRejected = (error: string) => error === "http 401" || error === "http 403";

/** 把一次探测结果并进旧状态：网络失败时保留「上次在线时间」和「上次看到的 agent」；被拒（401 / 403）时清掉 agent 列表 */
export function mergeProbe(prev: PeerPresence | undefined, r: ProbeResult | null, now: string): PeerPresence {
  const base: PeerPresence = { ...(prev ?? { online: null }), checkedAt: now };
  if (!r) return { ...base, online: null, error: undefined, latencyMs: undefined };
  if (r.ok) {
    const on: PeerPresence = { ...base, online: true, lastOnlineAt: now, latencyMs: r.latencyMs, remoteAgents: r.agents, agentsAt: now, authRejected: false, error: undefined };
    if (r.instance) return { ...on, instance: r.instance, instanceAt: now };
    delete on.instance; // 对方这次没带（降级 / 切 off）：不留旧的冒充现状
    delete on.instanceAt;
    return on;
  }
  const off: PeerPresence = { ...base, online: false, error: r.error, latencyMs: undefined };
  if (!isAuthRejected(r.error)) return off;
  delete off.remoteAgents;
  delete off.agentsAt;
  delete off.instance;
  delete off.instanceAt;
  return { ...off, authRejected: true };
}

/** fetch 抛出的错误 → 一个短词（给人看，也给 agent 判断「要不要等一会儿再发」） */
export function probeErrorOf(e: unknown): string {
  const kind = classifyJoinError((e ?? {}) as { name?: string; code?: unknown; message?: string });
  return kind === "other" ? String((e as Error)?.message || e).slice(0, 80) : kind;
}

/**
 * 对方 GET /api/v1/agents 的响应 → 探测结果（非 2xx 也算离线：token 被吊销时对方其实在线，但我们用不了）。
 * instance 形状不对：整块丢、记一行日志，在线判断和 agent 列表照常。
 */
export function probeResultOf(status: number, body: unknown, latencyMs: number, log: (line: string) => void = console.warn): ProbeResult {
  if (status < 200 || status >= 300) return { ok: false, error: `http ${status}` };
  const list = (body as { agents?: unknown } | null)?.agents;
  const agents = Array.isArray(list)
    ? list.filter((a) => a && typeof (a as { name?: unknown }).name === "string")
      .map((a) => remoteAgentOf(a as { name: string; status?: unknown; busy?: unknown }))
    : [];
  const raw = (body as { instance?: unknown } | null)?.instance;
  if (raw === undefined) return { ok: true, latencyMs, agents };
  const instance = parseInstanceInfo(raw);
  if (!instance) {
    log("⚠️ [peer-presence] 对方回包的 instance 形状不对，整块丢掉（在线判断照常）");
    return { ok: true, latencyMs, agents };
  }
  return { ok: true, latencyMs, agents, instance };
}

function remoteAgentOf(a: { name: string; status?: unknown; busy?: unknown }): RemoteAgent {
  const out: RemoteAgent = { name: a.name, status: typeof a.status === "string" ? a.status : undefined };
  if (typeof a.busy === "boolean") out.busy = a.busy;
  return out;
}
