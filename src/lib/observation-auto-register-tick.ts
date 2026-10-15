/** Read-only scheduler prefilter; all registration and skip notes go through the leased CLI. */
import { getEventByDedup, listTasks } from "./ledger-store.js";
import { automaticKeys } from "./observation-auto-register-spec.js";
import { autoMode, lastVerified, OBSERVATION_PLANS_PATH, readPlans, targetLabel } from "./observation-plan.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { postVerifyDoneKey, postVerifySection } from "./scheduler-post-verify-ledger.js";
import type { SpecWaitEnv } from "./scheduler-spec-wait.js";

/** Index the snapshot once; terminal plans still own their task's verified generation. */
function coveredTargets(path: string): Set<string> {
  const covered = new Set<string>();
  for (const p of readPlans(path).plans) {
    const label = targetLabel(p.target);
    covered.add(JSON.stringify([p.project, p.taskId, p.verifiedAt, label]));
    if (p.status === "active") covered.add(JSON.stringify([p.project, label]));
  }
  return covered;
}

export const observationAutoRegisterTickAt = (path: string) => async (env: SpecWaitEnv): Promise<{ taskId: string; error: string }[]> => {
  const failed: { taskId: string; error: string }[] = [];
  try {
    let covered: Set<string> | undefined;
    for (const project of env.svc.projects) {
      if (autoMode(env.db, project) === "off") continue;
      for (const task of listTasks(env.db, project)) {
        if (task.stage !== "verified" || getEventByDedup(env.db, postVerifyDoneKey(task.id))) continue;
        const section = postVerifySection(env.readSpec(task.id)?.text);
        const keys = automaticKeys(section ?? "", project);
        if (!keys.length) continue;
        covered ??= coveredTargets(path);
        const verifiedAt = lastVerified(env.db, task.id);
        if (keys.every((key) => {
          const label = `recovery:${key}`, skip = getEventByDedup(env.db, `observation-register-skip:${JSON.stringify([task.id, key])}`);
          return covered!.has(JSON.stringify([project, label])) || covered!.has(JSON.stringify([project, task.id, verifiedAt, label]))
            || (skip?.data.op === "observation_register_skip" && skip.ts >= (verifiedAt ?? 0));
        })) continue;
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
};

export const observationAutoRegisterTick = observationAutoRegisterTickAt(OBSERVATION_PLANS_PATH);
