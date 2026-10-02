/**
 * `ledger scheduler-merge-train <project> on|observe|off --reason`：合并列车开关（i28-MT1sw），只改 scheduler.json 里该项目的 mergeTrain。
 * `ledger merge-train-observe <project> [--last N]`：只读，observe 模式最近 N 次「本可组车」的成员与预计省下的 CI 次数。
 * 写入、锁、校验、审计在 lib/scheduler-merge-train-switch.ts → scheduler-config-write.ts。path / dir 参数只给测试指向临时文件。
 */
import { LedgerError } from "../lib/ledger-store.js";
import { SCHEDULER_CONFIG_PATH } from "../lib/scheduler-config.js";
import { observeSummary, setMergeTrainMode, trainMode } from "../lib/scheduler-merge-train-switch.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

export function mergeTrainSwitchCmds(path = SCHEDULER_CONFIG_PATH, dir?: string): Record<string, CommandSpec> {
  return {
    "scheduler-merge-train": {
      valued: ["reason", "dedup"],
      usage: "scheduler-merge-train <project> on|observe|off --reason <为什么>（只改 scheduler.json 里该项目的 mergeTrain；PM / master / owner）",
      async run(c) {
        const [, project, mode, ...extra] = c.p.pos;
        if (!project || !mode || extra.length) throw new LedgerError("invalid", "用法：scheduler-merge-train <project> on|observe|off --reason <为什么>");
        const r = await setMergeTrainMode(c.db, c.ctx(), { project, mode, reason: c.need("reason") }, { path });
        return {
          ok: true, project, mode, from: r.from ?? "on", changed: r.changed, path: r.path, event: r.event, ...(r.duplicate ? { duplicate: true } : {}),
          effective: `调度器下一轮（≤ ${r.pollMs ?? "pollMs"} 毫秒）生效` + (mode === "on" ? "" : "；在跑的列车按「列车已关闭」作废，成员回串行合并"),
        };
      },
    },
    "merge-train-observe": {
      valued: ["last"],
      usage: "merge-train-observe <project> [--last N]（只读：observe 模式最近 N 次本可组车的成员、预计省下的 CI 次数；缺省 20）",
      run(c) {
        const [, project, ...extra] = c.p.pos;
        if (!project || extra.length) throw new LedgerError("invalid", "用法：merge-train-observe <project> [--last N]");
        const last = c.p.flags.last ?? "20";
        if (!/^\d{1,3}$/.test(last) || Number(last) < 1) throw new LedgerError("invalid", `--last 要是 1..999 的整数，收到 ${last}`);
        return { ok: true, mode: trainMode(project, path), ...observeSummary(project, Number(last), dir) };
      },
    },
  };
}

export const MERGE_TRAIN_SWITCH_CMDS = mergeTrainSwitchCmds();
