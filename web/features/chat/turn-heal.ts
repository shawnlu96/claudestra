/**
 * 回合锁的自愈判定(纯逻辑,tests/web-turn-heal.test.ts)。chat-store 只在几处调用:收到 done 记时刻、
 * /agents 发请求时记发出时刻、/agents 落地时的补锁、轮询节拍上的反向对齐。
 * - 反向对齐:UI streaming 而服务端连续两拍空闲 = 漏收 done,走全量对齐(force,和 openAgent(same) 同一条路);
 *   只布判活探针没用——流健康时探针看到字节就退出,streaming 没人清。
 * - 补锁:请求在本会话最后一次 done 之前(含同时)发出的 busy 不补锁——它可能是 Stop 之前算好的,
 *   服务端不会再推 done,补上就再也解不开。拿不到发出时刻时退回「落地距 done 不足请求超时窗口」的保守近似。
 * - 由补锁锁上的 streaming,之后连续两拍服务端空闲且主回合没来过内容,直接解锁,不等 60s 节流。
 *   「主回合内容」看对话区消息(turnMark),后台子 agent / bg shell 事件只进 bgTasks,不算。
 */
import { AGENT_LIST_TIMEOUT_MS } from "./agent-list-state";
import type { ChatMessage } from "./type";

/** 反向对齐的节流:同一卡死态至多每 60s 全量对齐一次 */
export const REALIGN_THROTTLE_MS = 60_000;

export interface TurnHealState {
  /** 每个会话本地最后一次收到 done 的时刻 */
  doneAt: Map<string, number>;
  /** 最近一次 /agents 请求的发出时刻(单 flight:落地的就是这一次);0 = 不知道 */
  listRequestAt: number;
  /** 当前的锁是补锁上的:补锁时刻、会话、当时的主回合内容标记(之后标记没变 = 主回合没来过内容) */
  healLock: { at: number; agent: string; mark: string } | null;
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
  /** 主回合内容标记(turnMark):对话区消息有增长或末条在长就会变 */
  mark: string;
}

export interface HealVerdict<K extends string> {
  kind: K;
  /** 要记进 client.log 的一行(没有就不记) */
  log?: string;
}

export const newTurnHeal = (): TurnHealState => ({ doneAt: new Map(), listRequestAt: 0, healLock: null, strikes: 0, lastForcedAlign: 0 });

const heals = new WeakMap<object, TurnHealState>();
/** 每个 store 一份自愈状态(挂在 store 对象上,store 不必另开字段) */
export function turnHealOf(owner: object): TurnHealState {
  let h = heals.get(owner);
  if (!h) heals.set(owner, (h = newTurnHeal()));
  return h;
}

/** 主回合内容标记:条数 + 末条的正文 / 回复 / 工具 / 段数。后台事件不碰 messages,标记不动 */
export function turnMark(messages: readonly ChatMessage[]): string {
  const m = messages[messages.length - 1];
  if (!m) return "0";
  return [messages.length, m.role, m.content.length, m.replyText?.length ?? 0, m.toolCalls?.length ?? 0, m.segments?.length ?? 0].join(":");
}

export function healView(
  s: { activeAgent: string; streaming: boolean; browsing?: unknown; messages: readonly ChatMessage[] },
  cur: HealView["cur"],
  now = Date.now(),
): HealView {
  return { now, agent: s.activeAgent, streaming: s.streaming, browsing: !!s.browsing, cur, mark: turnMark(s.messages) };
}

const iso = (ms: number) => (ms ? new Date(ms).toISOString() : "-");

/** /agents 发请求:记发出时刻(落地时据此判迟到) */
export function noteListRequest(h: TurnHealState, now = Date.now()): void {
  h.listRequestAt = now;
}

/** 收到 done:记本会话的时刻;回合已结束,之前的补锁作废 */
export function noteTurnDone(h: TurnHealState, agent: string, now = Date.now()): void {
  h.doneAt.set(agent, now);
  h.healLock = null;
  h.strikes = 0;
}

/** /agents 落地:服务端说活跃会话 busy 而本地没锁 → 补锁;请求不晚于本会话的 done 发出(迟到)→ 拒绝 */
export function healRelock(h: TurnHealState, v: HealView): HealVerdict<"lock" | "late" | "none"> {
  if (!(v.cur?.status === "active" && v.cur.busy && !v.streaming && !v.browsing)) return { kind: "none" };
  const doneAt = h.doneAt.get(v.agent) ?? 0;
  const sent = h.listRequestAt;
  const late = doneAt > 0 && (sent ? sent <= doneAt : v.now - doneAt < AGENT_LIST_TIMEOUT_MS);
  const times = `发出=${iso(sent)} 落地=${iso(v.now)} done=${iso(doneAt)}`;
  if (late) return { kind: "late", log: `heal: 补锁被拒(轮询早于 done) agent=${v.agent} ${times}` };
  h.healLock = { at: v.now, agent: v.agent, mark: v.mark };
  h.strikes = 0;
  return { kind: "lock", log: `heal: 补锁 agent=${v.agent} ${times}` };
}

/**
 * 轮询 / 回前台节拍(操作后的拉取不算一拍)。UI streaming 而服务端连续两拍空闲:
 * - 锁是补锁上的、期间主回合没来过内容 → 直接解锁(不受节流);
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
  if (lock && lock.mark === v.mark) {
    h.strikes = 0;
    h.healLock = null;
    return { kind: "unlock", log: `heal: 补锁后自动解开 agent=${v.agent} 补锁=${iso(lock.at)} 现在=${iso(v.now)}` };
  }
  if (v.now - h.lastForcedAlign <= REALIGN_THROTTLE_MS) return { kind: "none" };
  h.strikes = 0;
  h.lastForcedAlign = v.now;
  return { kind: "realign", log: `realign: UI streaming 但服务端连续两拍空闲,强制对齐(full) agent=${v.agent}` };
}
