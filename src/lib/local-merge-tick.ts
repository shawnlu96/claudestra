/**
 * The auto tick's side of a localMerge project (ONB-2, docs/architecture/local-merge.md): where a PR project would plan its merge
 * intent, the card gets one `local_merge_ready` record and the PM is told once to run `ledger local-merge`. No merge intent, no merge
 * slot, no GitHub read. A card already marked ready reads the ledger only, so waiting costs no CLI call per pass.
 */
import type { HandoffCard } from "./scheduler-merge-handoff-tick.js";
import { localReadyState } from "./local-merge.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";

export async function driveLocalReady<O>(c: HandoffCard<O>): Promise<O> {
  const { task } = c, head = task.headSHA;
  if (!head) return c.escalate("本地合并：卡上没有 head");
  const wait = `审查通过，等 PM 跑 ledger local-merge ${task.id} --head ${head}`;
  const record = (...flag: string[]) => c.deps.manager("ledger", "scheduler-local-merge-ready", task.id, "--head", head, ...flag);
  const state = localReadyState(c.db, task);
  if (state === "notified") return c.out("waiting", wait);
  if (state === "none") {
    const r = await record();
    if (r.ok !== true) return c.out("held", `本地合并就绪没记上：${String(r.error)}`);
  }
  // only a notice that went out gets its receipt: a failed one (or a lost receipt) is sent again next pass, also after a restart
  try {
    await c.deps.notifyPm(task, `[调度引擎] ${task.id} ${wait}（本地合并项目，没有 PR）`);
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    console.error(`⚠️ [scheduler] ${task.id} 本地合并就绪通知没发出去（就绪已记，下轮重发）：${(e as Error).message}`);
    return c.out("local_ready", wait);
  }
  const n = await record("--notified");
  if (n.ok !== true) console.error(`⚠️ [scheduler] ${task.id} 本地合并通知回执没记上（下轮会再通知一次）：${String(n.error)}`);
  return c.out("local_ready", wait);
}
