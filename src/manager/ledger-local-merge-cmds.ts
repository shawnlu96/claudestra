/**
 * Local merge CLI (ONB-2, docs/architecture/local-merge.md), logic in lib/local-merge.ts + lib/local-merge-run.ts:
 * - `local-merge <task> --head <sha>`: the PM (not the dispatcher) / master / owner merges a reviewed card of a localMerge project
 *   into local main and moves it to live; running it is the PM's confirmation. A rerun returns the first record.
 * - `scheduler-local-merge-ready <task> --head <sha> [--notice | --notice-failed]`: scheduler identity only
 *   (lib/shared-ledger-gate-cli-services.ts); `--notice` claims the PM notice before it is sent, `--notice-failed` closes a send that threw.
 */
import { recordLocalReady } from "../lib/local-merge.js";
import { runLocalMerge } from "../lib/local-merge-run.js";
import { LedgerError } from "../lib/ledger-store.js";
import { localMergeOf } from "../lib/scheduler-config.js";
import type { LedgerCli } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

const MERGE_USAGE = "local-merge <task> --head <完整 sha>";

const taskId = (c: LedgerCli, usage: string): string => {
  const [, id, ...extra] = c.p.pos;
  if (!id || extra.length) throw new LedgerError("invalid", usage);
  return c.task(id).id;
};

export const LOCAL_MERGE_CMDS: Record<string, CommandSpec> = {
  "local-merge": {
    valued: ["head"], bools: [],
    usage: `${MERGE_USAGE}（localMerge 项目：PM 把审查通过的卡合进本地 main 并进 live；快进或干净合并提交，临时 worktree 跑本项目检查，主目录 ff-only）`,
    async run(c) {
      const id = taskId(c, MERGE_USAGE);
      return { ...await runLocalMerge(c.db, c.ctx(), localMergeOf(c.task(id).project), { taskId: id, head: c.need("head") }) };
    },
  },
  "scheduler-local-merge-ready": {
    valued: ["head"], bools: ["notice", "notice-failed"],
    usage: "scheduler-local-merge-ready <task> --head <sha> [--notice | --notice-failed]（调度服务专用：localMerge 卡审查通过等 PM；--notice 发通知前认领，--notice-failed 通知没发出去）",
    run(c) {
      const id = taskId(c, "scheduler-local-merge-ready <task> --head <sha> [--notice | --notice-failed]");
      const steps = (["notice", "notice-failed"] as const).filter((b) => c.p.bools.has(b));
      if (steps.length > 1) throw new LedgerError("invalid", "--notice 和 --notice-failed 只能给一个");
      const r = recordLocalReady(c.db, c.ctx(), { taskId: id, head: c.need("head"), step: steps[0] ?? "ready" });
      return { ok: true, seq: r.event.seq, duplicate: r.duplicate };
    },
  },
};
