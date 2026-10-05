/** `ledger scheduler-converge-notice`: scheduler-only record that PM got a failed follow-up notice (lib/review-converge-notice-write.ts). */
import { recordFollowUpInformed } from "../lib/review-converge-notice-write.js";
import { LedgerError } from "../lib/ledger-store.js";
import { intFlag } from "./ledger-identity.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

export const CONVERGE_NOTICE_CMDS: Record<string, CommandSpec> = {
  "scheduler-converge-notice": {
    valued: ["downgrade-seq", "round", "head"], bools: [],
    usage: "scheduler-converge-notice <task> --downgrade-seq N --round N --head <SHA>（调度服务专用：后续节点未建成的通知已交给 PM，记一次；按卡 + 降级事件去重）",
    run(c) {
      const seq = intFlag(c.p, "downgrade-seq"), round = intFlag(c.p, "round");
      if (seq === undefined || seq < 1 || round === undefined || round < 0) throw new LedgerError("invalid", "要带 --downgrade-seq 正整数与 --round 非负整数");
      return recordFollowUpInformed(c.db, c.ctx(), { taskId: c.p.pos[1] ?? "", downgradeSeq: seq, round, head: c.need("head") },
        () => c.deps.assertLease?.());
    },
  },
};
