import { requireLocalSharedLedgerSplit } from "./shared-ledger-gate-split.js";
import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { vacuumBackup } from "./ledger-backup.js";
import { type WriteCtx } from "./ledger-checks.js";
import { guardDagWrite } from "./dag-write-scrub.js";
import { changeFeatureDep } from "./ledger-feature-deps-write.js";
import { createFeature, requireManager } from "./ledger-feature-write.js";
import { planFeatureSplit, type SplitGroup, type SplitMap } from "./ledger-feature-split-plan.js";
import { mustFeature } from "./ledger-feature-write.js";
import { getTask, LedgerError } from "./ledger-store.js";
import { readSwitch } from "./scheduler-autostart.js";
import { setAutostartSwitch } from "./ledger-autostart.js";
import { insertEvent, replay, tx } from "./ledger-tx.js";

function splitHash(map: SplitMap): string {
  const targets = map.targets.map((t) => ({ slug: t.slug, id: t.id, title: t.title.trim(), words: t.words ?? "", nodes: [...t.nodes].sort() }))
    .sort((a, b) => (a.id ?? a.slug!).localeCompare(b.id ?? b.slug!));
  const deps = map.deps.map((d) => ({ from: d.from, to: d.to, note: d.note ?? "" }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash("sha256").update(JSON.stringify({ targets, deps })).digest("hex");
}

function appendVersion(db: Database, ctx: WriteCtx, group: SplitGroup, reason: string): void {
  const f = mustFeature(db, group.id), version = f.currentVersion + 1, now = ctx.now ?? Date.now();
  const scrub = guardDagWrite(db, f, { version, reasonText: reason, nodes: group.nodes }); // N8B8: what the source-mirror push would refuse
  db.prepare(`INSERT INTO dag_versions
    (featureId,version,reasonKind,reasonText,proposedBy,approvedBy,createdAt,nodes,cancels,scopeChange,askId)
    VALUES (?,?,?,?,?,?, ?,?,'[]',0,NULL)`)
    .run(f.id, version, version === 1 ? "initial" : "requirement_change", reason, ctx.actor, ctx.actor, now, JSON.stringify(group.nodes));
  db.prepare("UPDATE features SET currentVersion=?,rev=?,updatedAt=? WHERE id=?").run(version, f.rev + 1, now, f.id);
  insertEvent(db, ctx, { project: f.project, target: f.id, kind: "feature", text: reason,
    data: { op: "feature-split-version", version, previousVersion: f.currentVersion, nodes: group.nodes, rev: f.rev + 1, ...scrub } }, false);
}

function moveCards(db: Database, ctx: WriteCtx, group: SplitGroup, sourceId: string): void {
  for (const n of group.nodes) {
    if (!group.target?.nodes.includes(n.key) || !n.taskId) continue;
    const t = getTask(db, n.taskId);
    if (!t || t.project !== mustFeature(db, sourceId).project || (t.featureId && t.featureId !== sourceId)) {
      throw new LedgerError("conflict", `迁移节点 ${n.key} 的任务归属不一致`);
    }
    db.prepare("UPDATE tasks SET featureId=?,rev=?,updatedAt=? WHERE id=?").run(group.id, t.rev + 1, ctx.now ?? Date.now(), t.id);
    insertEvent(db, ctx, { project: t.project, target: t.id, kind: "task",
      data: { op: "set", patch: { featureId: group.id }, previousFeatureId: t.featureId, rev: t.rev + 1, splitSource: sourceId } }, false);
  }
}

export function applyFeatureSplit(db: Database, ctx: WriteCtx, sourceId: string, map: SplitMap,
  backup: () => string | null = () => db.filename === ":memory:" ? null
    : vacuumBackup(db, `${db.filename}.pre-feature-split-${Date.now()}-${randomUUID()}`, "feature-split 备份失败", "没有写入", false)) {
  const source = mustFeature(db, sourceId), hash = splitHash(map);
  requireManager(db, ctx.actor, source.project);
  const duplicate = () => replay(db, ctx, { project: source.project, target: sourceId, kind: "feature" }, () => null,
    (e) => e.data.op === "feature-split" && e.data.hash === hash);
  const prior = duplicate();
  if (prior) return { duplicate: true, backup: null, event: prior.event };
  const before = planFeatureSplit(db, sourceId, map);
  if (before.rejected.length) throw new LedgerError("conflict", before.rejected.join("；"), { rejected: before.rejected });
  const saved = backup();
  return tx(db, () => {
    const prior = duplicate();
    if (prior) return { duplicate: true, backup: saved, event: prior.event };
    const plan = planFeatureSplit(db, sourceId, map);
    requireLocalSharedLedgerSplit(plan);
    if (plan.rejected.length) throw new LedgerError("conflict", plan.rejected.join("；"), { rejected: plan.rejected });
    const secondary = { ...ctx, dedupKey: undefined };
    const reason = plan.groups.slice(1).flatMap((g) => g.target!.nodes.map((key) => `feature-split：${key} → ${g.id}`)).join("\n");
    const sw = readSwitch(db, source.project).features?.[sourceId];
    for (const g of plan.groups.slice(1)) {
      if (g.target?.slug) {
        createFeature(db, secondary, { project: source.project, slug: g.target.slug, title: g.title, ownerWords: g.target.words });
        if (sw) setAutostartSwitch(db, secondary, { project: source.project, featureId: g.id, on: !sw.off, reason: `feature-split 继承 ${sourceId}` });
      }
      moveCards(db, secondary, g, sourceId);
    }
    for (const g of plan.groups) appendVersion(db, secondary, g, reason);
    for (const d of plan.deps) changeFeatureDep(db, secondary, d.from, d.to, false, d.note);
    const event = insertEvent(db, ctx, { project: source.project, target: sourceId, kind: "feature", text: reason,
      data: { op: "feature-split", hash, sourceVersion: plan.source.currentVersion, targets: plan.groups.slice(1).map((g) => g.id), backup: saved } }, true);
    return { duplicate: false, backup: saved, event, plan };
  });
}
