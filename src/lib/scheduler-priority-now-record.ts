import { priorityNowObservations } from "./scheduler-priority-now-observation.js";
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { getFeature } from "./ledger-feature.js";
import { getEventByDedup, LedgerError } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import type { ServiceFacts } from "./scheduler-autostart.js";
import { autostartSpecPath, readSpec } from "./scheduler-autostart-deps.js";

export function recordPriorityNow(db: Database, ctx: WriteCtx, project: string, featureId: string,
  input: { key?: string; keys?: string[] }, svc: ServiceFacts, beforeWrite?: () => void) {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "now 资格记录只由调度服务写");
  return db.transaction(() => {
    beforeWrite?.();
    const f = getFeature(db, featureId), keys = input?.keys ?? (typeof input?.key === "string" ? [input.key] : null);
    if (!f || f.project !== project || !Array.isArray(keys) || keys.some((key) => typeof key !== "string" || !key)) {
      throw new LedgerError("invalid", "now 节点目标不合法");
    }
    let recorded = false;
    const rows = priorityNowObservations(db, f, svc, (id) => readSpec(autostartSpecPath(id)), ctx.now ?? Date.now(), keys);
    for (const { key, gate, why, dedupKey, mode, label } of rows) {
      if (getEventByDedup(db, dedupKey)) continue;
      appendEvent(db, { ...ctx, dedupKey }, { project, target: "", kind: "note", text: `${label}：${why}`,
        data: { namespace: "priority-now", mode, key, featureId, gate, why } });
      recorded = true;
    }
    return { ok: true, recorded, ...(rows.length === 1 ? { gate: rows[0].gate, why: rows[0].why } : {}) };
  }).immediate();
}
