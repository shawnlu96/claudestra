/**
 * N7X1 dedicated replica writer: lands a center-published DAG version on the local ledger verbatim (same version number,
 * same nodes, no local UI acceptance node). It is the only local writer of a replica's feature row and DAG versions;
 * it skips createFeature / initDag on purpose (they add the UI node, require a PM and pass the planning gate, which is
 * closed for a replica). Replays reuse ledger-dag-write.ts applyVersion, so bound cards stay linked and their file
 * scope / locks follow the same rules as a local rewrite.
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { applyVersion } from "./ledger-dag-write.js";
import { effectiveNodes, getDagVersion, getFeature, type DagNode, type Feature } from "./ledger-feature.js";
import { buildNodes } from "./ledger-feature-write.js";
import { LedgerError } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";

export const REPLICA_ACTOR = "system:center-replica";
/** One center DAG node as the V1 detail carries it. */
export interface CenterNode { key: string; oneLine: string; deps: string[]; fileGlobs: string[]; estimate: string }
export interface ReplicaWrite {
  localFeatureId: string; localProject: string; centerFeatureId: string; title: string; version: number; nodes: readonly CenterNode[];
}

/** Writer refusal when the local id already holds a replica of a different center feature (uuid prefix collision). */
export const REPLICA_ID_CLAIMED = "本机 id 已属于别的中心 feature";

/** Center node → local buildNodes input; an empty center scope is not a local input (buildNodes wants non-empty globs). */
const input = (n: CenterNode, taskId: string | null) => ({ key: n.key, oneLine: n.oneLine, deps: n.deps, estimate: n.estimate,
  ...(n.fileGlobs.length ? { fileGlobs: n.fileGlobs } : {}), ...(taskId ? { taskId } : {}) });

/**
 * Local validation of a center DAG (title / node limits, keys, cycles; throws LedgerError) plus the local execution
 * metadata (taskId, status, inheritedFrom). The center fields are stored as the center sent them: buildNodes sorts /
 * dedupes fileGlobs and deps and drops an empty scope, so those come back from the center node verbatim.
 */
export function checkReplicaNodes(db: Database, w: Pick<ReplicaWrite, "localFeatureId" | "localProject" | "nodes">, bound: ReadonlyMap<string, string> = new Map()): DagNode[] {
  const built = buildNodes(db, { id: w.localFeatureId, project: w.localProject }, w.nodes.map((n) => input(n, bound.get(n.key) ?? null)));
  return built.map((b, i) => {
    const n = w.nodes[i]!;
    return { ...b, key: n.key, oneLine: n.oneLine, deps: [...n.deps], estimate: n.estimate, fileGlobs: [...n.fileGlobs] };
  });
}

/** Center feature id the replica rows of `featureId` were written for (last writer event); null for a non-replica. */
function replicaCenterId(db: Database, featureId: string): string | null {
  const r = db.prepare(`SELECT json_extract(data, '$.centerFeatureId') AS c FROM events WHERE target = ? AND kind = 'feature' AND actor = ?
    AND json_extract(data, '$.op') = 'center-replica' ORDER BY seq DESC LIMIT 1`).get(featureId, REPLICA_ACTOR) as { c: string | null } | null;
  return r?.c ?? null;
}

/** Node keys bound to cards in the replica's current local version. */
export function replicaBoundNodes(db: Database, f: Feature): Map<string, string> {
  const v = f.currentVersion ? getDagVersion(db, f.id, f.currentVersion) : null;
  return new Map(v ? effectiveNodes(db, v).flatMap((n) => (n.taskId ? [[n.key, n.taskId] as const] : [])) : []);
}

const sameContent = (a: readonly DagNode[], b: readonly DagNode[]) => JSON.stringify(a.map(strip)) === JSON.stringify(b.map(strip));
const strip = (n: DagNode) => ({ key: n.key, taskId: n.taskId, oneLine: n.oneLine, deps: n.deps, estimate: n.estimate, fileGlobs: n.fileGlobs ?? [] });

export type ReplicaWriteOutcome = { kind: "created" | "replayed" | "unchanged"; version: number; rev: number };

/** Creates the replica feature at the center version, or replays a newer center version onto it. One transaction. */
export function writeCenterReplica(db: Database, ctx: WriteCtx, w: ReplicaWrite): ReplicaWriteOutcome {
  return tx(db, () => {
    const now = ctx.now ?? Date.now();
    const f = getFeature(db, w.localFeatureId);
    const key = { project: w.localProject, target: w.localFeatureId, kind: "feature" as const };
    if (!f) {
      const clash = db.prepare("SELECT id FROM features WHERE project = ? AND title = ?").get(w.localProject, w.title) as { id: string } | null;
      if (clash) throw new LedgerError("conflict", "本机项目里已有同名 feature");
      db.prepare("INSERT INTO features (id, project, title, ownerWords, status, currentVersion, rev, createdBy, createdAt, updatedAt) VALUES (?, ?, ?, '', 'active', ?, 1, ?, ?, ?)")
        .run(w.localFeatureId, w.localProject, w.title, w.version, ctx.actor, now, now);
      const nodes = checkReplicaNodes(db, w);
      db.prepare(`INSERT INTO dag_versions (featureId, version, reasonKind, reasonText, proposedBy, approvedBy, createdAt, nodes, cancels, scopeChange, askId)
        VALUES (?, ?, ?, ?, ?, 'center', ?, ?, '[]', 0, NULL)`).run(w.localFeatureId, w.version, w.version === 1 ? "initial" : "requirement_change",
        `中心 v${w.version}`, ctx.actor, now, JSON.stringify(nodes));
      insertEvent(db, ctx, { ...key, text: w.title, data: { op: "center-replica", centerFeatureId: w.centerFeatureId, version: w.version, rev: 1 } }, true);
      return { kind: "created", version: w.version, rev: 1 };
    }
    if (replicaCenterId(db, f.id) !== w.centerFeatureId) throw new LedgerError("conflict", REPLICA_ID_CLAIMED);
    if (f.project !== w.localProject) throw new LedgerError("conflict", "副本所在的本机项目变了");
    if (w.version < f.currentVersion) throw new LedgerError("conflict", "中心版本比本机副本旧");
    const bound = replicaBoundNodes(db, f);
    const missing = [...bound.keys()].filter((k) => !w.nodes.some((n) => n.key === k));
    if (missing.length) throw new LedgerError("conflict", "中心新版本移出了本机已绑卡的节点");
    const nodes = checkReplicaNodes(db, w, bound);
    if (w.version === f.currentVersion) {
      const cur = getDagVersion(db, f.id, f.currentVersion);
      if (!cur || !sameContent(effectiveNodes(db, cur), nodes) || f.title !== w.title) throw new LedgerError("conflict", "中心同一版本的内容与本机副本不一致");
      return { kind: "unchanged", version: f.currentVersion, rev: f.rev };
    }
    // Bound cards are carried by node taskId (no dag_bindings row on the new version); applyVersion keeps them linked.
    let rev = applyVersion(db, ctx, f, { featureId: f.id, version: w.version, baseVersion: f.currentVersion, reasonKind: "requirement_change",
      reasonText: `中心 v${w.version}`, nodes, cancels: [], scopeChange: false }, { proposedBy: ctx.actor, approvedBy: "center", askId: null });
    if (f.title !== w.title) {
      const clash = db.prepare("SELECT id FROM features WHERE project = ? AND title = ? AND id != ?").get(f.project, w.title, f.id) as { id: string } | null;
      if (clash) throw new LedgerError("conflict", "本机项目里已有同名 feature");
      rev += 1;
      db.prepare("UPDATE features SET title = ?, rev = ?, updatedAt = ? WHERE id = ?").run(w.title, rev, now, f.id);
    }
    insertEvent(db, ctx, { ...key, data: { op: "center-replica", centerFeatureId: w.centerFeatureId, version: w.version, rev } }, true);
    return { kind: "replayed", version: w.version, rev };
  });
}
