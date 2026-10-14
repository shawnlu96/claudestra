/**
 * 名册回包（GET 名册读口）的浏览器侧类型，照 ROSTER1 规格「PM 定 3」手抄，字段名与 bridge 一致；两边一致性由 ROSTER4 的契约测试核对。
 * 纯类型，不 import react / next / 任何 hook。解析见 roster-model.ts parseRosterWire。
 */

export type RosterFamily = "claude" | "codex";
export const ROSTER_FAMILIES: readonly RosterFamily[] = ["claude", "codex"];

/** bridge 给的心跳态：running = 心跳新鲜；silent = 心跳超过 60 秒；no_beat = 已领单还没心跳；unknown = 结果不明。网页不重算 */
export type RosterWorkerState = "running" | "silent" | "no_beat" | "unknown";
/** author = 在写 / 修；reviewer = 在审 */
export type RosterWorkerRole = "author" | "reviewer";

/** 本项目在这台机器上的一个 worker */
export interface RosterWorker {
  id: string;
  name: string;
  family: RosterFamily;
  role: RosterWorkerRole;
  state: RosterWorkerState;
  card: string | null;
  step: string | null;
  round: number | null;
  since: number | null;
}

/** 一个家族的位子：busy = 本机看到的占用；reportedBusy = 对方自报占用（本机为 null）；held = 额度到线不派 */
export interface RosterSlot { total: number; busy: number; reportedBusy: number | null; held: boolean }

/** 额度观测：stopPct 为 null = 对方机器（不知道停派线）；observedAt 为 null = 没观测过 */
export interface RosterQuota { usedPct: number; stopPct: number | null; observedAt: number | null }

/** 这台机器上本项目的卡号：active = 写 / 审 / 修中，merge = 等合并 */
export interface RosterCards { active: string[]; merge: string[] }

/** 交付日桶（bridge 的本地日），最后一格是今天 */
export interface RosterOutputDay { day: string; delivered: number }

export interface RosterMachine {
  /** "local" = 本机；peer 机器为 peer id */
  key: string;
  name: string;
  instanceId: string | null;
  /** null = 读不到在线状态 */
  online: boolean | null;
  slots: Record<RosterFamily, RosterSlot | null>;
  quota: Record<RosterFamily, RosterQuota | null>;
  workers: RosterWorker[];
  cards: RosterCards;
  output: RosterOutputDay[];
}

export interface RosterWire {
  generatedAt: number;
  self: { instanceId: string | null };
  machines: RosterMachine[];
  /** 归不到任何机器的卡 */
  unattributed: { merge: string[] };
}

/** 解析后的名册：dropped = 因形状 / 数值不对整台丢弃的机器数 */
export interface Roster extends RosterWire { dropped: number }

export const LOCAL_MACHINE_KEY = "local";
