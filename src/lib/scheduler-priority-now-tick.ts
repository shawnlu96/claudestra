import { pendingPriorityNowKeys } from "./scheduler-priority-now-observation.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { notifyAutostartQuotaWait } from "./scheduler-autostart-quota.js";
import { localAutostartNode, localAuthorRuntime } from "./scheduler-local-runtime-start.js";
/** now gets a normal-tick opportunity before the ordinary candidate budget. Existing openCard owns all effects. */
import { featureLanes } from "./dag-tools-lanes.js";
import { readPriorityModes } from "./ledger-priority-read.js";
import { activeFeatures, currentViews, featureGate, isStop, nodeCandidate, type Candidate } from "./scheduler-autostart.js";
import type { StartTickEnv } from "./scheduler-autostart-run.js";
import { priorityNowNode } from "./scheduler-priority-now.js";
import { schedulerV2SkipFeature } from "./scheduler-v2-skip-card.js";
import { wipGateNode } from "./scheduler-wip-gate.js";

interface NowPick { cand: Candidate; maxWorkers: number }

const attempts = new WeakMap<StartTickEnv["db"], Set<string>>();

export function priorityNowAttempted(env: Pick<StartTickEnv, "db">, featureId: string, key: string): boolean {
  return attempts.get(env.db)?.has(`${featureId}/${key}`) ?? false;
}

export function pickPriorityNow(env: Pick<StartTickEnv, "db" | "svc" | "readSpec" | "now">, exclude = new Set<string>()): NowPick | null {
  for (const project of [...env.svc.projects].sort()) {
    if (readPriorityModes(env.db, project).priorityNowStart.mode !== "on") continue;
    for (const f of activeFeatures(env.db, project)) {
      if (schedulerV2SkipFeature(env.db, f.id)) continue;
      const views = currentViews(env.db, f), lanes = featureLanes(env.db, f);
      for (const key of lanes?.startNow ?? []) {
        if (exclude.has(`${f.id}/${key}`) || !priorityNowNode(env.db, f, key) || featureGate(env.db, f, env.svc, key)) continue;
        const c = nodeCandidate(env.db, f, key, lanes, views, env.readSpec, env.now());
        if (!isStop(c) && !wipGateNode(env.db, project, c.taskId)) return { cand: c, maxWorkers: env.svc.maxWorkers(project) };
      }
    }
  }
  return null;
}

/** No writer is opened on the scheduler reader, and off does not inspect nodes/specs. */
async function recordNowWaiting(env: StartTickEnv, failed: { taskId: string; error: string }[]): Promise<void> {
  for (const project of env.svc.projects) {
    if (readPriorityModes(env.db, project).priorityNowStart.mode === "off") continue;
    for (const f of activeFeatures(env.db, project)) {
      if (schedulerV2SkipFeature(env.db, f.id)) continue;
      try {
        const keys = pendingPriorityNowKeys(env.db, f, env.svc, env.readSpec, env.now());
        if (!keys.length) continue;
        const r = await env.ledger("ledger", "scheduler-priority-now", f.id, "--project", project,
          "--data", JSON.stringify({ keys }), "--dedup", `priority-now-check:${crypto.randomUUID()}`);
        if (!r.ok) throw new Error(String(r.error ?? "now 等待记录失败"));
      } catch (e) {
        if (e instanceof SchedulerStopped) throw e;
        failed.push({ taskId: f.id, error: `now 等待记录：${String(e)}` });
      }
    }
  }
}

/** A fresh pick after each open permits every ready now node to start, up to real capacity, in this normal tick. */
interface StartPorts {
  openCard(env: StartTickEnv, pick: NowPick, failed: { taskId: string; error: string }[]): Promise<void>;
  inFlight<T>(db: StartTickEnv["db"], featureId: string, key: string, run: () => Promise<T>): Promise<T>;
  quotaBlocked(env: StartTickEnv, project: string, failed: { taskId: string; error: string }[]): Promise<boolean>;
}
export async function priorityNowStarts(env: StartTickEnv, failed: { taskId: string; error: string }[], ports: StartPorts): Promise<void> {
  const attempted = new Set<string>();
  attempts.set(env.db, attempted);
  await recordNowWaiting(env, failed);
  for (;;) {
    const pick = pickPriorityNow(env, attempted);
    if (!pick || attempted.has(`${pick.cand.f.id}/${pick.cand.key}`)) return;
    attempted.add(`${pick.cand.f.id}/${pick.cand.key}`);
    if (localAuthorRuntime(pick.cand.f.project) === "claude" && await ports.quotaBlocked(env, pick.cand.f.project, failed)) continue;
    const wait = await ports.inFlight(env.db, pick.cand.f.id, pick.cand.key,
      () => localAutostartNode(env, pick.cand, (next) => ports.openCard(next, pick, failed)));
    await notifyAutostartQuotaWait(env, pick.cand.f.project, wait);
  }
}
