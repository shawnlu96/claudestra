import { schedulerV2SkipFeature } from "./scheduler-v2-skip-card.js";
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { featureLanes } from "./dag-tools-lanes.js";
import { getFeature } from "./ledger-feature.js";
import { readPriorityModes } from "./ledger-priority-read.js";
import { getEventByDedup, LedgerError } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import { priorityNowNode } from "./scheduler-priority-now.js";
import { currentViews, featureGate, isStop, nodeCandidate, type ServiceFacts } from "./scheduler-autostart.js";
import { autostartSpecPath, readSpec } from "./scheduler-autostart-deps.js";

export function recordPriorityNow(db: Database, ctx: WriteCtx, project: string, featureId: string, input: { key: string }, svc: ServiceFacts, beforeWrite?: () => void) {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "now 资格记录只由调度服务写");
  return db.transaction(() => {
    beforeWrite?.();
    const f = getFeature(db, featureId), m = readPriorityModes(db, project).priorityNowStart;
    if (!f || f.project !== project || typeof input?.key !== "string") throw new LedgerError("invalid", "now 节点目标不合法");
    if (schedulerV2SkipFeature(db, featureId) || m.mode === "off" || !priorityNowNode(db, f, input.key)) return { ok: true, recorded: false };
    const views = currentViews(db, f), node = views.find((n) => n.key === input.key);
    if (!node || node.taskId) return { ok: true, recorded: false };
    const r = featureGate(db, f, svc, input.key, m.mode === "observe")
      ?? nodeCandidate(db, f, input.key, featureLanes(db, f), views, (id) => readSpec(autostartSpecPath(id)), ctx.now ?? Date.now());
    const gate = isStop(r) ? r.gate : null, why = isStop(r) ? r.why : "依赖及所有资格已满足，下一次正常 tick 开工";
    const dedupKey = `priority-now:${project}:${f.id}:${input.key}:${m.rev}:${JSON.stringify([gate, why])}`;
    if (getEventByDedup(db, dedupKey)) return { ok: true, recorded: false, gate, why };
    appendEvent(db, { ...ctx, dedupKey }, { project, target: "", kind: "note", text: `${m.mode === "observe" ? "本会开工" : "now 等待"}：${why}`,
      data: { namespace: "priority-now", mode: m.mode, key: input.key, featureId, gate, why } });
    return { ok: true, recorded: true, gate, why };
  }).immediate();
}
