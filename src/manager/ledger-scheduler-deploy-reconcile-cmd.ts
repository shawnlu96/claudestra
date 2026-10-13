/** A service-only entry; read the repository from scheduler policy, never from caller-supplied proof or a checkout flag. */
import { readSchedulerConfig } from "../lib/scheduler-config.js";
import { LedgerError } from "../lib/ledger-store.js";
import { writeDeployReconcile } from "../lib/scheduler-deploy-reconcile-write.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

export const DEPLOY_RECONCILE_CMD: CommandSpec = {
  valued: ["rev", "merge-intent", "merge-rev", "source-seq"], bools: [],
  usage: "scheduler-deploy-reconcile <task> --rev N --merge-intent ID --merge-rev N --source-seq N（调度服务补记部署）",
  async run(c) {
    if (c.deps.actor !== "scheduler" || !c.deps.assertLease) throw new LedgerError("forbidden", "部署补记只给持有效租约的调度服务");
    const task = c.task(c.p.pos[1]);
    const integer = (key: string) => {
      const value = c.need(key), n = Number(value);
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(n)) throw new LedgerError("invalid", `--${key} 要正整数`);
      return n;
    };
    const initial = readSchedulerConfig(), repoDir = initial.projects[task.project]?.repoDir;
    if (!repoDir) throw new LedgerError("forbidden", "本项目未启用调度服务");
    const active = () => {
      c.deps.assertLease!();
      const config = readSchedulerConfig();
      if (!config.enabled || config.projects[task.project]?.repoDir !== repoDir) throw new LedgerError("forbidden", "项目调度策略已变或未启用");
    };
    active();
    return writeDeployReconcile(c.db, c.ctx(), { taskId: task.id, taskRev: integer("rev"), intentId: c.need("merge-intent"),
      mergeRev: integer("merge-rev"), sourceSeq: integer("source-seq") }, { repoDir, assertActive: active, now: c.deps.now });
  },
};
