/**
 * 让锁测试共用的真 tick：lockYieldStep 对项目 p 跑一轮，manager 不起子进程、直连写侧 lockYieldWrite，本机 agent 活动为空。
 * 台账、策略端口、时刻、registry 的建立与清理都由调用方给；这里不建夹具，也不留全局状态（console spy 成功 / 异常都还原）。
 */
import { expect, spyOn } from "bun:test";
import type { Database } from "bun:sqlite";
import type { RecoveryPolicyPort } from "../../src/lib/recovery-policy.js";
import type { SchedulerConfig } from "../../src/lib/scheduler-config.js";
import { lockYieldStep } from "../../src/lib/scheduler-lock-yield-deps.js";
import { lockYieldWrite, parseLockYieldWire } from "../../src/lib/scheduler-lock-yield-write.js";

export interface LockYieldTick {
  db: Database;
  policy: RecoveryPolicyPort;
  now: number;
  /** 写侧重核要读得到 registry：调用方在自己的隔离状态目录里备好，并登记清理 */
  ensureRegistry: () => void;
}

export async function lockYieldTick({ db, policy, now, ensureRegistry }: LockYieldTick) {
  ensureRegistry();
  const manager = async (...args: string[]): Promise<Record<string, unknown>> => {
    expect(args.slice(0, 2)).toEqual(["ledger", "scheduler-lock-yield"]);
    // 写侧抛错按子命令的失败结果回给 tick，不往外抛
    try { return lockYieldWrite(db, { actor: "scheduler", now }, args[2]!, parseLockYieldWire(args[4]!), policy, new Map()); }
    catch (e) { return { ok: false, code: (e as { code?: string }).code, error: (e as Error).message }; }
  };
  const logs = spyOn(console, "log").mockImplementation(() => {}), errs = spyOn(console, "error").mockImplementation(() => {});
  try {
    return await lockYieldStep(db, { projects: { p: {} } } as unknown as SchedulerConfig, manager, async () => {}, policy, { agents: async () => new Map(), now: () => now });
  } finally { logs.mockRestore(); errs.mockRestore(); }
}
