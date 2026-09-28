/**
 * Autopilot 的运行日志：每条 mission 一个追加式 jsonl（~/.claude-orchestrator/autopilot/<missionId>.jsonl），每个 run 一行，
 * 没推进也记一行并写明原因——回答「查 / 推进了没有、发现了什么、为什么没执行」。
 * 不进 missions.json：主文件每次推进都要读改写，日志放进去会越写越大。
 * 第一期不写内置台账：台账事件要挂在事项 / 任务上，mission 还没绑定台账任务（绑定后再镜像成 note 事件）。
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunEvidence, RunOutcome } from "./autopilot-run.js";
import { statePath } from "./paths.js";
import type { ActiveRun, Wake, WakeSource } from "./autopilot-wake.js";

const AUTOPILOT_LOG_DIR = statePath("autopilot");

/** skipped = 该推进的时候没推进（让位太久、agent 不在线），reason 写为什么 */
type LogOutcome = RunOutcome | "skipped";

export interface RunLogLine {
  ts: string;
  missionId: string;
  agent: string;
  outcome: LogOutcome;
  reason: string;
  runId?: string;
  trigger?: { source: WakeSource; seq: number; merged: number };
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  evidence?: RunEvidence;
  /** 下一次最早什么时候醒，和为什么是这个时间 */
  nextWakeAt?: string;
  why?: string;
}

/** missionId 是 newMission 生成的 hex；旧数据没有 id 的、或者形状不对的，都落到 unknown，不拼进路径 */
const fileOf = (missionId: string, dir: string) => join(dir, `${/^[\w-]{1,64}$/.test(missionId) ? missionId : "unknown"}.jsonl`);

/** 追加一行；写失败只打日志不抛——日志缺一行不该让推进本身失败 */
export function appendRunLog(line: RunLogLine, dir = AUTOPILOT_LOG_DIR): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(fileOf(line.missionId, dir), JSON.stringify(line) + "\n");
    return true;
  } catch (e) {
    console.error(`⏱ Autopilot 日志写入失败（${line.missionId}）:`, (e as Error).message);
    return false;
  }
}

/** 最近 limit 行（旧 → 新）；文件不存在 = 空；坏行跳过 */
export function readRunLog(missionId: string, limit = 50, dir = AUTOPILOT_LOG_DIR): RunLogLine[] {
  let raw: string;
  try {
    raw = readFileSync(fileOf(missionId, dir), "utf8");
  } catch {
    return []; // 还没有任何 run：文件不存在，空日志就是正确答案
  }
  const out: RunLogLine[] = [];
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    try {
      const x = JSON.parse(l) as RunLogLine;
      if (x && typeof x.outcome === "string" && typeof x.ts === "string") out.push(x);
    } catch {
      // 进程被杀时可能留下半行：跳过这一行，其余照读
    }
  }
  return out.slice(-limit);
}

/** 一个 run 收尾时的那一行；next 为空 = 不再排下一次（mission 已结束） */
export function runLogLine(p: {
  missionId: string; agent: string; run: ActiveRun; outcome: RunOutcome; reason: string; evidence: RunEvidence; now: number;
  next?: { at: number; why: string };
}): RunLogLine {
  const start = Date.parse(p.run.deliveredAt ?? p.run.claimedAt);
  return {
    ts: new Date(p.now).toISOString(), missionId: p.missionId, agent: p.agent, outcome: p.outcome, reason: p.reason, runId: p.run.runId,
    trigger: { source: p.run.source, seq: p.run.seq, merged: p.run.merged },
    startedAt: new Date(start).toISOString(), endedAt: new Date(p.now).toISOString(), durationMs: Math.max(0, p.now - start), evidence: p.evidence,
    ...(p.next ? { nextWakeAt: new Date(p.next.at).toISOString(), why: p.next.why } : {}),
  };
}

/** 该推进却没推进的那一行（让位太久、agent 不在线） */
export function skippedLogLine(p: { missionId: string; agent: string; wake: Wake; reason: string; now: number }): RunLogLine {
  const waited = Math.round((p.now - Date.parse(p.wake.firstAt)) / 60_000);
  return {
    ts: new Date(p.now).toISOString(), missionId: p.missionId, agent: p.agent, outcome: "skipped",
    reason: `排队 ${waited} 分钟没推进：${p.reason}`, trigger: { source: p.wake.source, seq: p.wake.seq, merged: p.wake.merged },
  };
}

const hhmm = (s?: string) => (s ? new Date(s).toTimeString().slice(0, 5) : "--:--");

/** 给人看的一行：「03:41 action_taken 12 分钟 · 调了 8 个工具… · 下次 03:42（接着推）」 */
export function formatRunLine(l: RunLogLine): string {
  const dur = l.durationMs !== undefined ? ` ${Math.max(1, Math.round(l.durationMs / 60_000))} 分钟` : "";
  const flags = [l.evidence?.humanInterleaved ? "中途有人插话" : "", l.evidence?.evidenceLost ? "bridge 重启过、证据不全" : ""].filter(Boolean);
  const next = l.nextWakeAt ? ` · 下次 ${hhmm(l.nextWakeAt)}${l.why ? `（${l.why}）` : ""}` : "";
  return `${hhmm(l.startedAt ?? l.ts)} ${l.outcome}${dur} · ${l.reason}${flags.length ? `（${flags.join("，")}）` : ""}${next}`;
}
