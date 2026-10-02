/**
 * ACP 宿主的回合心跳（i28-S1 读、S1b 写）：判「卡住」只能以宿主收到的 session/update 为准。思考（agent_thought_chunk）不转给 bridge、
 * 正文攒到换消息才吐，bridge 那头的条目会在想得久的回合里停很久，拿它判卡住就会误杀，所以绝不拿 bridge 的条目凑数。
 * 宿主节流写 state/acp-activity/<agent>.json（回合在不在跑、最近一次 update 的时刻），监护读它；文件没有（S1b 接入前就是这样）、
 * session 对不上、回合没在跑，一律当「不知道」，这一类直接不判。tests/agent-supervisor-activity.test.ts。
 */
import { statePath } from "./paths.js";
import { readJsonStateSync } from "./state-file.js";

export interface ActivityRecord {
  v: 1;
  agent: string;
  sessionId: string;
  hostPid: number;
  /** 回合在跑（含排队没开的）：宿主开一轮时置真，上报 Stop / StopFailure 时置假 */
  busy: boolean;
  /** 这一轮开始的时刻（busy 为假时是上一轮的） */
  turnAt: number;
  /** 最近一次 session/update（任何种类）或权限请求的时刻 */
  updateAt: number;
  writtenAt: number;
}

/** 名字只来自 registry（已校验过），这里再挡一次路径分隔与控制字符：坏名字不写也不读 */
export const safeName = (agent: string): boolean => !!agent && agent.length <= 120 && !/[/\\\0]|^\.\.?$|[\p{Cc}]/u.test(agent);

export const activityPath = (agent: string, dir = statePath("acp-activity")): string => `${dir}/${agent}.json`;

const isRecord = (d: unknown): boolean => {
  const r = d as Partial<ActivityRecord> | null;
  return !!r && r.v === 1 && typeof r.agent === "string" && typeof r.sessionId === "string" && typeof r.busy === "boolean" &&
    Number.isFinite(r.turnAt) && Number.isFinite(r.updateAt) && Number.isFinite(r.writtenAt) && Number.isInteger(r.hostPid);
};

export function readActivity(agent: string, dir?: string): ActivityRecord | null {
  if (!safeName(agent)) return null;
  const r = readJsonStateSync(activityPath(agent, dir), isRecord);
  return r.status === "ok" ? (r.data as ActivityRecord) : null;
}

/**
 * 这一轮算不算「回合在跑、但 stuckMs 没有任何动静」：返回最近一次动静的时刻（两次观察要一样才确认，见 agent-supervisor-judge.ts），否则 null。
 * session 对不上（换了会话、记录是别的会话留下的）、回合没在跑、记录比宿主进程的这一轮还旧，都给 null。
 */
export function stuckSince(rec: ActivityRecord | null, sessionId: string, now: number, stuckMs: number): number | null {
  if (!rec || rec.sessionId !== sessionId || !rec.busy) return null;
  const last = Math.max(rec.updateAt, rec.turnAt);
  return now - last >= stuckMs ? last : null;
}
