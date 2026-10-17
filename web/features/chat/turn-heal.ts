/**
 * 回合锁的自愈判定(纯逻辑,tests/web-turn-heal.test.ts)。chat-store 只在三处调用:收到 done 记时刻、
 * /agents 落地时的补锁、轮询节拍上的反向对齐。
 *
 * 2026-10-17 agents-TURNSTUCK1(peer 小孟:回合结束后对话区一直「思考中」、侧栏一直「工作中」,切会话才好):
 * - 反向对齐判定成立后走的是不带参数的 maybeReconnect → 流健康只布判活探针,streaming 没人清,每 60s 空转一次
 *   (client.log 48 分钟约 40 条 realign、没有一条 reconnect)。改为全量对齐(force,和 openAgent(same) 同一条路)。
 * - 15s 轮询的 busy 若在 Stop 之前就算好了、done 之后才落地,会把刚解开的锁再锁上,服务端不会再推 done。
 *   /agents 不带生成时刻,用「请求最晚在落地前 AGENT_LIST_TIMEOUT_MS 发出」做保守近似:落地距 done 不足这一窗口
 *   的,请求可能在 done 之前发出,一律不拿来补锁。
 * - 由补锁锁上的 streaming,之后连续两拍服务端空闲且流里没来过任何事件,直接解锁,不等 60s 节流。
 */
import { AGENT_LIST_TIMEOUT_MS } from "./agent-list-state";

/** 反向对齐的节流:同一卡死态至多每 60s 全量对齐一次 */
export const REALIGN_THROTTLE_MS = 60_000;

export interface TurnHealState {
  /** 本地最后一次收到 done 的时刻;0 = 还没收到过 */
  doneAt: number;
  /** 当前的锁是补锁上的:补锁时刻、会话、当时的流事件序号(之后序号没动 = 流里没来过回合内容) */
  healLock: { at: number; agent: string; seq: number } | null;
  /** UI streaming 但服务端空闲的连续轮询拍数 */
  strikes: number;
  lastForcedAlign: number;
}

/** 一拍的输入:本地状态 + 本次 /agents 里当前会话的条目 */
export interface HealView {
  now: number;
  agent: string;
  streaming: boolean;
  browsing: boolean;
  cur?: { status?: string; busy?: boolean };
  /** 流上最后一个 bridge 事件的序号(心跳不带,不算) */
  eventSeq: number;
}

export interface HealVerdict<K extends string> {
  kind: K;
  /** 要记进 client.log 的一行(没有就不记) */
  log?: string;
}

export const newTurnHeal = (): TurnHealState => ({ doneAt: 0, healLock: null, strikes: 0, lastForcedAlign: 0 });

const heals = new WeakMap<object, TurnHealState>();
/** 每个 store 一份自愈状态(挂在 store 对象上,store 不必另开字段) */
export function turnHealOf(owner: object): TurnHealState {
  let h = heals.get(owner);
  if (!h) heals.set(owner, (h = newTurnHeal()));
  return h;
}

export function healView(
  s: { activeAgent: string; streaming: boolean; browsing?: unknown },
  cur: HealView["cur"],
  eventSeq: number,
  now = Date.now(),
): HealView {
  return { now, agent: s.activeAgent, streaming: s.streaming, browsing: !!s.browsing, cur, eventSeq };
}

const iso = (ms: number) => (ms ? new Date(ms).toISOString() : "-");

/** 收到 done:记时刻;回合已结束,之前的补锁作废 */
export function noteTurnDone(h: TurnHealState, now = Date.now()): void {
  h.doneAt = now;
  h.healLock = null;
  h.strikes = 0;
}

/** /agents 落地:服务端说活跃会话 busy 而本地没锁 → 补锁;落地离 done 太近(请求可能早于 done)→ 拒绝 */
export function healRelock(h: TurnHealState, v: HealView): HealVerdict<"lock" | "late" | "none"> {
  if (!(v.cur?.status === "active" && v.cur.busy && !v.streaming && !v.browsing)) return { kind: "none" };
  if (h.doneAt && v.now - h.doneAt < AGENT_LIST_TIMEOUT_MS) {
    return { kind: "late", log: `heal: 补锁被拒(轮询可能早于 done) agent=${v.agent} 落地=${iso(v.now)} done=${iso(h.doneAt)}` };
  }
  h.healLock = { at: v.now, agent: v.agent, seq: v.eventSeq };
  h.strikes = 0;
  return { kind: "lock", log: `heal: 补锁 agent=${v.agent} 落地=${iso(v.now)} done=${iso(h.doneAt)}` };
}

/**
 * 轮询 / 回前台节拍(操作后的拉取不算一拍)。UI streaming 而服务端连续两拍空闲:
 * - 锁是补锁上的、期间流里没来过事件 → 直接解锁(不受节流);
 * - 否则漏收 done 实锤 → 全量对齐(重拉历史 + 重连流;重连先解锁,对齐后服务端若仍在跑由流重新锁上)。
 * 单拍不动——刚起步的回合会瞬时 busy=false,下一拍即清零。
 */
export function healTick(h: TurnHealState, v: HealView): HealVerdict<"unlock" | "realign" | "none"> {
  if (h.healLock && (!v.streaming || h.healLock.agent !== v.agent)) h.healLock = null;
  if (!(v.streaming && v.cur?.status === "active" && v.cur.busy === false)) {
    h.strikes = 0;
    return { kind: "none" };
  }
  if (++h.strikes < 2) return { kind: "none" };
  const lock = h.healLock;
  if (lock && lock.seq === v.eventSeq) {
    h.strikes = 0;
    h.healLock = null;
    return { kind: "unlock", log: `heal: 补锁后自动解开 agent=${v.agent} 补锁=${iso(lock.at)} 现在=${iso(v.now)}` };
  }
  if (v.now - h.lastForcedAlign <= REALIGN_THROTTLE_MS) return { kind: "none" };
  h.strikes = 0;
  h.lastForcedAlign = v.now;
  return { kind: "realign", log: `realign: UI streaming 但服务端连续两拍空闲,强制对齐(full) agent=${v.agent}` };
}
