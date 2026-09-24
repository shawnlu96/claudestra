/**
 * 在线 peer 列表的纯逻辑（bridge/peer-presence.ts 负责定时探测和落盘；tests/peer-presence.test.ts）。
 * 出站方向（我连对方）靠探测：GET 对方 /api/v1/agents；入站方向（对方连我）只能看对方最近一次来访。
 * 单向的 peer（只有对方连我，没有对方地址）online = null：不是离线，是我们没法主动探。
 */
import { classifyJoinError } from "./peer-join-hints.js";

export interface PeerPresence {
  /** true 在线 / false 探测失败 / null 没有出站地址（单向：只有对方连我） */
  online: boolean | null;
  checkedAt?: string;
  lastOnlineAt?: string;
  latencyMs?: number;
  /** 对方开放给我的 agent（探测成功时刷新；离线时保留上次看到的） */
  remoteAgents?: { name: string; status?: string }[];
  /** 离线原因：timeout（多半对方机器离线 / 没共享给我）、refused（端口没对外）、http 401 等 */
  error?: string;
  /** 对方最近一次调我的 API（入站） */
  lastInboundAt?: string;
}

export type ProbeResult =
  | { ok: true; latencyMs: number; agents: { name: string; status?: string }[] }
  | { ok: false; error: string };

/** 把一次探测结果并进旧状态：失败时保留「上次在线时间」和「上次看到的 agent」，别把有用的信息清掉 */
export function mergeProbe(prev: PeerPresence | undefined, r: ProbeResult | null, now: string): PeerPresence {
  const base: PeerPresence = { ...(prev ?? { online: null }), checkedAt: now };
  if (!r) return { ...base, online: null, error: undefined, latencyMs: undefined };
  if (r.ok) return { ...base, online: true, lastOnlineAt: now, latencyMs: r.latencyMs, remoteAgents: r.agents, error: undefined };
  return { ...base, online: false, error: r.error, latencyMs: undefined };
}

/** fetch 抛出的错误 → 一个短词（给人看，也给 agent 判断「要不要等一会儿再发」） */
export function probeErrorOf(e: unknown): string {
  const kind = classifyJoinError((e ?? {}) as { name?: string; code?: unknown; message?: string });
  return kind === "other" ? String((e as Error)?.message || e).slice(0, 80) : kind;
}

/** 对方 GET /api/v1/agents 的响应 → 探测结果（非 2xx 也算离线：token 被吊销时对方其实在线，但我们用不了） */
export function probeResultOf(status: number, body: unknown, latencyMs: number): ProbeResult {
  if (status < 200 || status >= 300) return { ok: false, error: `http ${status}` };
  const list = (body as { agents?: unknown } | null)?.agents;
  const agents = Array.isArray(list)
    ? list.filter((a) => a && typeof (a as { name?: unknown }).name === "string")
      .map((a) => ({ name: (a as { name: string }).name, status: (a as { status?: string }).status }))
    : [];
  return { ok: true, latencyMs, agents };
}
