/**
 * ACP 宿主的回合心跳（i28-S1b 写、agent-supervisor-activity.ts 读）：回合开始、收到 session/update / 权限请求、回合结束时
 * 写 state/acp-activity/<agent>.json，监护拿它判「回合在跑但 stuckMin 没有任何动静」。
 * 节流：busy 变化（开一轮 / 收尾）立即写；回合中的动静最多每 UPDATE_GAP_MS 写一次，没有补写定时器——落盘的 updateAt
 * 最多比实际旧 UPDATE_GAP_MS，远小于 stuckMin（最小 5 分钟），只会让卡住早判这么一点，换来写盘次数有上限、收尾后不再有异步写。
 * 写失败只记日志（换状态才记，不刷屏），绝不抛进宿主的回合路径。tests/acp-host-heartbeat.test.ts。
 */
import { activityPath, safeName, type ActivityRecord } from "../agent-supervisor-activity.js";
import { writeJsonAtomicSync } from "../state-file.js";

/** 回合中动静的落盘间隔上限 */
export const UPDATE_GAP_MS = 15_000;

export interface HeartbeatOpts {
  dir?: string;
  now?: () => number;
  gapMs?: number;
  /** 单测注入：数写盘次数 / 模拟写盘抛错 */
  write?: (path: string, rec: ActivityRecord) => void;
}

export class HostHeartbeat {
  private busy = false;
  private turnAt = 0;
  private updateAt = 0;
  private lastWrite = -Infinity;
  private failing = false;

  /** who 每次现取：/clear 换会话后自然写新的 sessionId */
  constructor(private readonly who: () => { agent: string; sessionId: string }, private readonly log: (m: string) => void, private readonly opts: HeartbeatOpts = {}) {}

  /** 开一轮（宿主自己的 prompt，或适配器自发的一轮） */
  turn(): void {
    this.busy = true;
    this.turnAt = this.updateAt = this.now();
    this.write();
  }

  /** 收到 session/update 或权限请求 */
  update(): void {
    this.updateAt = this.now();
    if (this.updateAt - this.lastWrite >= (this.opts.gapMs ?? UPDATE_GAP_MS)) this.write();
  }

  /** 回合收尾（Stop / StopFailure）。queued = 还有排着 / 在跑的槽（如适配器自发的一轮），按「含排队没开的」仍算 busy */
  end(queued = false): void {
    if (queued) return this.update();
    this.busy = false;
    this.write();
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private write(): void {
    try {
      const { agent, sessionId } = this.who();
      if (!safeName(agent)) throw new Error(`agent 名不安全：${JSON.stringify(agent)}`);
      const writtenAt = this.now();
      const rec: ActivityRecord = { v: 1, agent, sessionId, hostPid: process.pid, busy: this.busy, turnAt: this.turnAt, updateAt: this.updateAt, writtenAt };
      (this.opts.write ?? writeJsonAtomicSync)(activityPath(agent, this.opts.dir), rec);
      this.lastWrite = writtenAt;
      if (this.failing) this.safeLog("回合心跳恢复写盘");
      this.failing = false;
    } catch (e) {
      // 失败也算写过一次：节流照旧，坏盘不会让每条 update 都去撞一次
      this.lastWrite = this.now();
      if (!this.failing) this.safeLog(`⚠️ 回合心跳写不进去（监护判不了卡住，回合照常）：${e instanceof Error ? e.message : String(e)}`);
      this.failing = true;
    }
  }

  private safeLog(m: string): void {
    try {
      this.log(m);
    } catch {
      /* 日志出口坏了也不能抛进回合路径 */
    }
  }
}
