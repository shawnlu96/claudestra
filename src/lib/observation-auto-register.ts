/** Automatic registration has its own scheduler-only entry; the manual configurer gate stays unchanged. */
import type { Database } from "bun:sqlite";
import { actorMayConfigure } from "./ledger-scheduler-settle.js";
import { getEventByDedup, getTask, LedgerError } from "./ledger-store.js";
import { appendEvent, type WriteCtx } from "./ledger-write.js";
import {
  autoMode, lastVerified, observationHours, OBSERVATION_PLANS_PATH, OBSERVATION_RULE_VERSION, parseTarget, targetLabel, targetState, withPlans,
  OBSERVATION_SOURCE, type ObservationPlan, type PlanPaths,
} from "./observation-plan.js";
import { automaticKeys, observationSpecPath, observationSpecReader, specDigest, type ObservationSpecReader } from "./observation-auto-register-spec.js";
import { projectPm } from "./scheduler-autostart.js";
import { postVerifyDoneKey, postVerifySection } from "./scheduler-post-verify-ledger.js";

export interface AutoRegisterOpts extends PlanPaths { readSpec?: ObservationSpecReader; active?(): void }

export async function autoRegisterObservation(db: Database, ctx: WriteCtx, taskId: string, opts: AutoRegisterOpts = {}): Promise<ObservationPlan[]> {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "规格自动登记只给调度服务");
  return withPlans(opts.plans ?? OBSERVATION_PLANS_PATH, ({ doc, save }) => {
    opts.active?.();
    const task = getTask(db, taskId);
    if (!task || autoMode(db, task.project) === "off" || task.stage !== "verified" || getEventByDedup(db, postVerifyDoneKey(taskId))) return [];
    const spec = (opts.readSpec ?? observationSpecReader)(taskId), section = postVerifySection(spec?.text);
    if (!spec || !section) return [];
    const out: ObservationPlan[] = [];
    for (const key of automaticKeys(section, task.project)) {
      try {
        const target = parseTarget(`recovery:${key}`), label = targetLabel(target);
        // A terminal registration also owns this spec/verified episode: retries must not undo cancellation or restart a judgement.
        if (doc.plans.some((p) => p.project === task.project && targetLabel(p.target) === label
          && (p.status === "active" || (p.taskId === taskId && p.verifiedAt === lastVerified(db, taskId))))) continue;
        const pm = task.pm ?? projectPm(db, task.project);
        if (!pm || !actorMayConfigure(db, pm, task.project)) throw new LedgerError("forbidden", "卡 PM 没有项目配置权");
        const hours = observationHours(undefined, section), verifiedAt = lastVerified(db, taskId), state = targetState(db, task.project, target, opts.recovery);
        if (state.diagnostic || state.mode !== "observe") throw new LedgerError("invalid", state.diagnostic ?? `${label} 现在是 ${state.mode}`);
        if (verifiedAt === null || verifiedAt > (ctx.now ?? Date.now()) || verifiedAt < state.since) throw new LedgerError("invalid", "最近 verified 不能覆盖当前 observe 世代");
        const p: ObservationPlan = { id: `obs-${++doc.seq}`, taskId, project: task.project, target, hours, startAt: verifiedAt, dueAt: verifiedAt + hours * 3600_000,
          ruleVersion: OBSERVATION_RULE_VERSION, source: OBSERVATION_SOURCE, specRev: task.specRev, verifiedAt, generation: state.generation, configRev: state.rev,
          by: pm, at: ctx.now ?? Date.now(), reason: "规格授权自动转正", status: "active", misjudged: [],
          authorization: { source: "spec", path: observationSpecPath(taskId), digest: specDigest(spec.text), pm } };
        appendEvent(db, { ...ctx, dedupKey: `observation-plan:${p.id}:register:0` }, { project: p.project, target: taskId, kind: "decision",
          text: `观察期自动登记 ${p.id}：${label}，来源 spec，授权 PM ${pm}`,
          data: { op: "observation_plan", action: "register", plan: p.id, target: label, source: p.source, authorization: p.authorization, hours, startAt: p.startAt, dueAt: p.dueAt } });
        doc.plans.push(p); out.push(p); save();
      } catch (e) {
        if (!(e instanceof LedgerError) || e.code === "busy") throw e;
        appendEvent(db, { ...ctx, dedupKey: `observation-register-skip:${JSON.stringify([taskId, key])}` }, { project: task.project, target: taskId, kind: "note",
          text: `未自动登记 ${key}：${e.message}`, data: { op: "observation_register_skip", key, reason: e.message } });
      }
    }
    return out;
  }, opts.lockMs);
}
