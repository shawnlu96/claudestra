import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { findPath } from "./ledger-deps.js";
import { featureDeps } from "./ledger-feature-deps.js";
import { mustFeature, requireManager } from "./ledger-feature-write.js";
import { LedgerError } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";

export function changeFeatureDep(db: Database, ctx: WriteCtx, from: string, to: string, remove = false, note = "") {
  return tx(db, () => {
    const a = mustFeature(db, from), b = mustFeature(db, to);
    requireManager(db, ctx.actor, a.project);
    if (a.project !== b.project) throw new LedgerError("invalid", "feature 依赖只能连同一个项目");
    if (typeof note !== "string" || [...note].length > 60 || /[\u0000-\u001f\u007f]/.test(note)) throw new LedgerError("invalid", "note 要是 ≤60 字的一行文字");
    const deps = featureDeps(db, a.project);
    const prev = deps.find((d) => d.from === from && d.to === to);
    if (remove && !prev) throw new LedgerError("not_found", `没有 feature 依赖 ${from} → ${to}`);
    if (!remove && prev) return { ok: true, duplicate: true, dep: prev };
    if (!remove) {
      const path = findPath(deps, to, from);
      if (path) throw new LedgerError("invalid", `feature 依赖成环：${[from, ...path].join(" → ")}`);
      db.prepare("INSERT INTO feature_deps (project,fromFeature,toFeature,note,createdBy,createdAt) VALUES (?,?,?,?,?,?)")
        .run(a.project, from, to, note, ctx.actor, ctx.now ?? Date.now());
    } else db.prepare("DELETE FROM feature_deps WHERE fromFeature=? AND toFeature=?").run(from, to);
    const event = insertEvent(db, ctx, { project: a.project, target: to, kind: "feature", data: { op: remove ? "dep-rm" : "dep-add", from, to, note } }, false);
    return { ok: true, duplicate: false, event };
  });
}
