/**
 * The auto tick's side of a localMerge project (ONB-2, docs/architecture/local-merge.md): where a PR project would plan its merge
 * intent, the card gets one `local_merge_ready` record and the PM is told once to run `ledger local-merge`. No merge intent, no merge
 * slot, no GitHub read. A card already marked ready reads the ledger only, so waiting costs no CLI call per pass.
 */
import type { HandoffCard } from "./scheduler-merge-handoff-tick.js";
import { localReadyState } from "./local-merge.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { fallbackNotice } from "./scheduler-review-fallback.js";

export async function driveLocalReady<O>(c: HandoffCard<O>): Promise<O> {
  const { task } = c, head = task.headSHA;
  if (!head) return c.escalate("本地合并：卡上没有 head");
  const wait = `审查通过，等 PM 跑 ledger local-merge ${task.id} --head ${head}${fallbackNotice(c.db, task)}`; // RVF-1: a same-family verdict says so
  const record = (...flag: string[]) => c.deps.manager("ledger", "scheduler-local-merge-ready", task.id, "--head", head, ...flag);
  const state = localReadyState(c.db, task);
  if (state === "notified") return c.out("waiting", wait);
  if (state === "none") {
    const r = await record();
    if (r.ok !== true) return c.out("held", `本地合并就绪没记上：${String(r.error)}`);
  }
  // claim before send: the PM is told at most once (a crash after the claim loses the notice, never doubles it); only a send that
  // provably never left (sent=false) closes the claim, so the next pass (or a restart) claims again, re-checking the merge gate
  const claim = await record("--notice");
  if (claim.ok !== true) return c.out("held", `本地合并通知没认领上：${String(claim.error)}`);
  if (claim.duplicate === true) return c.out("waiting", wait);
  try {
    await c.deps.notifyPm(task, `[调度引擎] ${task.id} ${wait}（本地合并项目，没有 PR）`, "action"); // the PM has to run local-merge
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    const why = (e as Error | undefined)?.message;
    if ((e as { sent?: unknown } | undefined)?.sent !== false) { // timeout / dropped after the frame left: the bridge may have delivered
      console.error(`⚠️ [scheduler] ${task.id} 本地合并就绪通知结果不明，不重发，PM 看 local_merge_ready 记录：${why}`);
    } else {
      const f = await record("--notice-failed");
      console.error(`⚠️ [scheduler] ${task.id} 本地合并就绪通知没发出去（${f.ok === true ? "下轮重发" : `失败没记上，不再重发：${String(f.error)}`}）：${why}`);
    }
  }
  return c.out("local_ready", wait);
}
