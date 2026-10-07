/**
 * `ledger scheduler-lock-yield <task> --data {...}`（RLOCK2）：调度服务专用。写事务里重核停滞再让锁 / 记「本可让锁」，或记恢复后拿不回锁的通知。
 * 逻辑在 lib/scheduler-lock-yield-write.ts；模式只认恢复策略键 lockYield（`ledger scheduler-recovery <project> on|observe|off --key lockYield`，缺省 observe）。
 * yield 先自己重读绑定 agent 的活动（不信 tick 的观察），再进写事务。
 */
import type { RecoveryPolicyPort } from "../lib/recovery-policy.js";
import { localAgents, type AgentsOf } from "../lib/scheduler-lock-yield-agents.js";
import { lockYieldPolicy } from "../lib/scheduler-lock-yield-policy.js";
import { lockYieldWrite, parseLockYieldWire } from "../lib/scheduler-lock-yield-write.js";
import { LedgerError } from "../lib/ledger-store.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

/** 调度服务身份能跑的子命令（manager/ledger.ts 与 shared-ledger-gate-cli-services.ts 一起读） */
export const LOCK_YIELD_SERVICE_COMMANDS: ReadonlySet<string> = new Set(["scheduler-lock-yield"]);

function lockYieldCmds(policy: RecoveryPolicyPort = lockYieldPolicy, agentsOf: AgentsOf = localAgents): Record<string, CommandSpec> {
  return {
    "scheduler-lock-yield": {
      valued: ["data"], bools: [],
      usage: "scheduler-lock-yield <task> --data '{\"v\":1,\"phase\":\"yield|contend|contend-sent\",...}'（调度服务专用：停滞卡让锁 / 拿不回锁通知）",
      async run(c) {
        const [, task, ...extra] = c.p.pos;
        if (!task || extra.length) throw new LedgerError("invalid", "只接受一个 task");
        const id = c.task(task).id, wire = parseLockYieldWire(c.need("data")), ctx = c.ctx();
        const fresh = wire.phase === "yield" ? await agentsOf(c.db, ctx.now ?? Date.now(), wire.recentMs) : null;
        return lockYieldWrite(c.db, ctx, id, wire, policy, fresh);
      },
    },
  };
}

export const LOCK_YIELD_CMDS = lockYieldCmds();
