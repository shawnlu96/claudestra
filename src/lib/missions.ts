/**
 * Autopilot（原名「值守」，数据和命令仍叫 mission）：让一个 agent 在没人看着的时候一直推进一个目标，直到它自己宣告做完或到截止时间。
 * 状态在 ~/.claude-orchestrator/missions.json，manager 与 bridge 都写，持同一把锁（updateMissions）；唤醒队列和进行中的 run
 * 也挂在这条记录上（lib/autopilot-wake.ts）。推进在 bridge/mission.ts。这里只放状态读写与纯裁决（tests/missions.test.ts）。
 */
import { randomBytes } from "node:crypto";
import type { AutopilotFields } from "./autopilot-wake.js";
import { acquireLock } from "./file-lock.js";
import { statePath } from "./paths.js";
import { readJsonLenient, writeJsonStateGuarded } from "./state-file.js";

export interface Mission extends AutopilotFields {
  /** 这一代的 id：stop 后再 start 是新的一代。bridge 递提醒前后都比对它，旧一代的提醒 / 到点不会记到新一代头上 */
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
  /** 旧版「提醒后很快结束」的计数，已由 run 结果分类取代（lib/autopilot-run.ts）；旧数据里还有，不再读写 */
  fastTurns?: number;
  /** 下一次唤醒被挡到这个时刻（额度 / 等人 / 待命 / 失败退避）：只给网页显示「等到 …」，调度看 wake.dueAt */
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
/** 顶层是对象、每一项都像一条 mission：写坏的文件读成空、写之前也拦住，别把半截数据当状态 */
const isMap = (d: unknown): boolean => !!d && typeof d === "object" && !Array.isArray(d) && Object.values(d as object).every(isMission);

/** 新开一代 mission（manager 与网页共用，保证都带 id） */
export function newMission(f: { agent: string; goal: string; until: Date; ledger?: string }, now = new Date()): Mission {
  return {
    id: randomBytes(6).toString("hex"), agent: f.agent, goal: f.goal, until: f.until.toISOString(), createdAt: now.toISOString(),
    status: "active", nudges: 0, ...(f.ledger ? { ledger: f.ledger } : {}),
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
 * 只接受未来 7 天内：Autopilot 是「今晚 / 这个周末」的事，写错成去年或明年都该被拦下。
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
      `[⏱ Autopilot · 到点] 截止时间 ${hhmm(m.until)} 到了，Autopilot 已关闭。`,
      `停止开新工作：把进度、结论和需要人拍板的事写进${m.ledger ? ` ${m.ledger}` : "台账 / HANDOFF"}，给 owner 发一条总结，然后结束。`,
    ].join("\n");
  }
  const lines = [
    `[⏱ Autopilot] 目标：${m.goal}`,
    `截止 ${hhmm(m.until)}（还剩 ${left(m.until, now)}）。这一轮结束了，接着推进下一件${m.ledger ? `；进度记在 ${m.ledger}` : ""}。`,
  ];
  if (kind === "compact") lines.push("⚠ 上下文快满了：这一轮先存档再压缩（Claude Code 用 /save-compact；其它 runtime 先把进度写进台账），然后再继续。");
  lines.push(
    "- 需要人拍板的事记下来、先跳过，别停在那里等。",
    `- 全部做完时执行 \`${doneCmd} "<一句话总结>"\`，Autopilot 就此结束。`,
  );
  return lines.join("\n");
}
