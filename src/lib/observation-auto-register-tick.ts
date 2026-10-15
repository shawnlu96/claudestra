/** Read-only scheduler prefilter; all registration and skip notes go through the leased CLI. */
import { getEventByDedup, listTasks } from "./ledger-store.js";
import { automaticKeys } from "./observation-auto-register-spec.js";
import { autoMode } from "./observation-plan.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { postVerifyDoneKey, postVerifySection } from "./scheduler-post-verify-ledger.js";
import type { SpecWaitEnv } from "./scheduler-spec-wait.js";

export async function observationAutoRegisterTick(env: SpecWaitEnv): Promise<{ taskId: string; error: string }[]> {
  const failed: { taskId: string; error: string }[] = [];
  try {
    for (const project of env.svc.projects) {
      if (autoMode(env.db, project) === "off") continue;
      for (const task of listTasks(env.db, project)) {
        if (task.stage !== "verified" || getEventByDedup(env.db, postVerifyDoneKey(task.id))) continue;
        const section = postVerifySection(env.readSpec(task.id)?.text);
        if (!section || !automaticKeys(section, project).length) continue;
        const r = await env.ledger("ledger", "scheduler-observation-register", task.id);
        if (r.code === "lease-lost") throw new SchedulerStopped(String(r.error));
        if (r.ok !== true) failed.push({ taskId: task.id, error: `自动登记失败：${String(r.error ?? r.code)}` });
      }
    }
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    failed.push({ taskId: "observation-register", error: (e as Error).message });
  }
  return failed;
}
