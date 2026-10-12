/**
 * 普通 P2 积压的命令（agents-PMAUTO1，逻辑在 lib/p2-backlog.ts）：
 * - `p2-backlog [--project <id>] [--card <卡>] [--last N]`：只读列表，谁都能看。
 * - `p2-backlog-record <卡> --review-seq <审查事件号> --mode on|observe`：调度服务在卡审查通过、发 PM 通知前调（PM / master / owner 也能手动补登）；
 *   按当前有效审查的结构化 findings 登普通 P2，项目 + 卡 + reviewSeq + findingId 唯一，重放不重复。
 * draftsDir 只给测试指向临时目录。
 */
import { LedgerError } from "../lib/ledger-store.js";
import { listP2Backlog, p2BacklogMode, recordP2Backlog } from "../lib/p2-backlog.js";
import { intFlag } from "./ledger-identity.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

export function p2BacklogCmds(draftsDir?: string): Record<string, CommandSpec> {
  return {
    "p2-backlog": {
      valued: ["project", "card", "last"], usage: "p2-backlog [--project <id>] [--card <卡>] [--last <1–999>]（只读：普通 P2 积压，新的在前）",
      run(c) {
        const task = c.p.flags.card === undefined ? null : c.task(c.p.flags.card);
        const project = task && c.p.flags.project === undefined ? task.project : c.project();
        if (task && task.project !== project) throw new LedgerError("invalid", `任务 ${task.id} 属于项目 ${task.project}，不是 ${project}`);
        const last = intFlag(c.p, "last") ?? 200;
        if (last < 1 || last > 999) throw new LedgerError("invalid", "--last 要是 1..999 的整数");
        return { ok: true, project, mode: p2BacklogMode(c.db, project), backlog: listP2Backlog(c.db, project, { ...(task ? { taskId: task.id } : {}), last }) };
      },
    },
    "p2-backlog-record": {
      valued: ["review-seq", "mode"], usage: "p2-backlog-record <卡> --review-seq <审查事件号> --mode on|observe（调度服务写口；PM / master / owner 可手动补登）",
      run(c) {
        const task = c.task(c.p.pos[1]), mode = c.need("mode"), reviewSeq = intFlag(c.p, "review-seq");
        if (mode !== "on" && mode !== "observe") throw new LedgerError("invalid", "--mode 只能是 on / observe");
        if (reviewSeq === undefined) throw new LedgerError("invalid", "要带 --review-seq <审查事件号>");
        if (c.deps.actor !== "scheduler") c.requireRealPm(task.project, "登 P2 积压");
        else c.deps.assertLease?.();
        return { ok: true, task: task.id, ...recordP2Backlog(c.db, c.ctx(), { taskId: task.id, reviewSeq, mode }, draftsDir) };
      },
    },
  };
}
