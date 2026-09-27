/**
 * 值守（mission）：让一个 agent 在没人看着的时候一直推进一个目标，直到它自己宣告做完或到截止时间。
 * 状态在 ~/.claude-orchestrator/missions.json，manager 与 bridge 都写，持同一把锁（updateMissions）。
 * 推进在 bridge/mission.ts：每回合结束（所有 runtime 共用的 Stop → agent_status done）等一小会儿、确认仍空闲，
 * 递一句「接着推进」。这里只放状态读写与纯裁决（tests/missions.test.ts）。
 */
import { randomBytes } from "node:crypto";
import { acquireLock } from "./file-lock.js";
import { statePath } from "./paths.js";
import { readJsonLenient, writeJsonStateGuarded } from "./state-file.js";

export interface Mission {
  /** 这一代值守的 id：stop 后再 start 是新的一代。bridge 递提醒前后都比对它，旧一代的提醒 / 到点不会记到新一代头上 */
  id?: string;
  /** registry 里去掉 agent- 前缀的名字；master 就是 "master" */
  agent: string;
  goal: string;
  /** 截止时间（ISO） */
  until: string;
  createdAt: string;
  status: "active" | "done" | "stopped" | "expired";
  /** 进度记在哪（台账 / HANDOFF 路径），写进每次提醒里 */
  ledger?: string;
  nudges: number;
  lastNudgeAt?: string;
  /** 连续「提醒后很快就结束」的回合数：额度用尽 / 卡在等人拍板时会这样，靠它退避 */
  fastTurns: number;
  /** 退避到这个时刻之前不提醒 */
  resumeAt?: string;
  finishedAt?: string;
  summary?: string;
}
export type MissionMap = Record<string, Mission>;

export const MISSIONS_PATH = statePath("missions.json");
const LOCK_SUFFIX = ".lock";

export const missionKey = (agent: string): string => agent.replace(/^agent-/, "");

const isMission = (m: unknown): boolean => {
  const x = m as Partial<Mission> | null;
  return !!x && typeof x === "object" && typeof x.agent === "string" && typeof x.until === "string" && typeof x.status === "string";
};
/** 顶层是对象、每一项都像一条值守：写坏的文件读成空、写之前也拦住，别把半截数据当状态 */
const isMap = (d: unknown): boolean => !!d && typeof d === "object" && !Array.isArray(d) && Object.values(d as object).every(isMission);

/** 新开一代值守（manager 与网页共用，保证都带 id） */
export function newMission(f: { agent: string; goal: string; until: Date; ledger?: string }, now = new Date()): Mission {
  return {
    id: randomBytes(6).toString("hex"), agent: f.agent, goal: f.goal, until: f.until.toISOString(), createdAt: now.toISOString(),
    status: "active", nudges: 0, fastTurns: 0, ...(f.ledger ? { ledger: f.ledger } : {}),
  };
}

export async function readMissions(path = MISSIONS_PATH): Promise<MissionMap> {
  return readJsonLenient<MissionMap>(path, {}, { validate: isMap, who: "missions" });
}

/**
 * 加锁读改写；mutate 返回的值原样带出。拿不到锁就抛、绝不照写（manager stop 与 bridge 记账并发时，照写会把停止状态盖掉）；
 * 内容没变就不写（别的 agent 的回合结束不该碰这个文件）。
 */
export async function updateMissions<T>(mutate: (m: MissionMap) => T, path = MISSIONS_PATH, lockMs = 10_000): Promise<T> {
  const lock = await acquireLock(path + LOCK_SUFFIX, lockMs);
  if (!lock) throw new Error(`missions.json 正被别的进程占着（${Math.round(lockMs / 1000)} 秒没拿到锁），这次没改，稍后重试`);
  try {
    const all = await readMissions(path);
    const before = JSON.stringify(all);
    const out = mutate(all);
    if (JSON.stringify(all) !== before) await writeJsonStateGuarded(path, all, { validate: isMap });
    return out;
  } finally {
    lock.release();
  }
}

/**
 * 截止时间：`HH:MM`（本地时间，已过就算明天）、`+90m` / `+3h`、或 ISO。解析不了 → null。
 * 只接受未来 7 天内：值守是「今晚 / 这个周末」的事，写错成去年或明年都该被拦下。
 */
export function parseUntil(raw: string, now = new Date()): Date | null {
  const s = raw.trim();
  let d: Date | null = null;
  const hm = /^(\d{1,2}):(\d{2})$/.exec(s);
  const rel = /^\+(\d+(?:\.\d+)?)\s*(m|min|h|hr)$/i.exec(s);
  if (hm) {
    const h = Number(hm[1]);
    const m = Number(hm[2]);
    if (h > 23 || m > 59) return null;
    d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  } else if (rel) {
    const n = Number(rel[1]) * (rel[2].toLowerCase().startsWith("h") ? 3_600_000 : 60_000);
    d = new Date(now.getTime() + n);
  } else if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    d = new Date(s);
  }
  if (!d || Number.isNaN(d.getTime())) return null;
  const ahead = d.getTime() - now.getTime();
  return ahead > 0 && ahead <= 7 * 86_400_000 ? d : null;
}

/** 提醒后多久内结束的回合算「很快」：正常干活一轮远不止这点时间 */
export const FAST_TURN_MS = 90_000;
/** 连续很快结束几次开始退避：一次可能是正好收尾，两次就是在空转 */
const FAST_TURNS_BEFORE_BACKOFF = 2;
const BACKOFF_STEPS_MS = [5, 15, 30, 60].map((m) => m * 60_000);

/** 连续空转 n 次后的等待：前两次不等，之后 5 → 15 → 30 → 60 分钟封顶（额度多半一小时内会重置） */
export function backoffMs(fastTurns: number): number {
  if (fastTurns < FAST_TURNS_BEFORE_BACKOFF) return 0;
  return BACKOFF_STEPS_MS[Math.min(fastTurns - FAST_TURNS_BEFORE_BACKOFF, BACKOFF_STEPS_MS.length - 1)];
}

/** 回合结束时更新空转计数：这回合离上次提醒很近就 +1，否则清零 */
export function nextFastTurns(m: Mission, now: number): number {
  const last = m.lastNudgeAt ? Date.parse(m.lastNudgeAt) : NaN;
  return Number.isFinite(last) && now - last < FAST_TURN_MS ? m.fastTurns + 1 : 0;
}

/** 上下文占比到这条线，提醒改成「先存档再压缩」——比 bridge 自动 save-compact 的常规线（85%）早，留出这一轮的余量 */
export const COMPACT_HINT_RATIO = 0.75;

export type NudgeKind = "continue" | "compact" | "deadline";

export function nudgeKind(m: Mission, now: number, ctxRatio: number | null): NudgeKind {
  if (now >= Date.parse(m.until)) return "deadline";
  return ctxRatio !== null && ctxRatio >= COMPACT_HINT_RATIO ? "compact" : "continue";
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function left(iso: string, now: number): string {
  const min = Math.max(0, Math.round((Date.parse(iso) - now) / 60_000));
  return min >= 60 ? `${Math.floor(min / 60)} 小时 ${min % 60} 分` : `${min} 分钟`;
}

/** 递给 agent 的话。done 命令写全路径：agent 的 cwd 不一定是本仓库，runtime 也不一定是 Claude Code */
export function nudgeText(m: Mission, kind: NudgeKind, now: number, doneCmd: string): string {
  if (kind === "deadline") {
    return [
      `[⏱ 值守 · 到点] 截止时间 ${hhmm(m.until)} 到了，值守已关闭。`,
      `停止开新工作：把进度、结论和需要人拍板的事写进${m.ledger ? ` ${m.ledger}` : "台账 / HANDOFF"}，给 owner 发一条总结，然后结束。`,
    ].join("\n");
  }
  const lines = [
    `[⏱ 值守] 目标：${m.goal}`,
    `截止 ${hhmm(m.until)}（还剩 ${left(m.until, now)}）。这一轮结束了，接着推进下一件${m.ledger ? `；进度记在 ${m.ledger}` : ""}。`,
  ];
  if (kind === "compact") lines.push("⚠ 上下文快满了：这一轮先存档再压缩（Claude Code 用 /save-compact；其它 runtime 先把进度写进台账），然后再继续。");
  lines.push(
    "- 需要人拍板的事记下来、先跳过，别停在那里等。",
    `- 全部做完时执行 \`${doneCmd} "<一句话总结>"\`，值守就此结束。`,
  );
  return lines.join("\n");
}
