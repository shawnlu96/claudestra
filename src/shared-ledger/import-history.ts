import { SharedLedgerError, type SharedLedgerFeature, type SharedLedgerFeatureDetail, type SharedLedgerImportManifest } from "../lib/shared-ledger-contract.js";
import { assertSharedLedgerMutation, validateDag } from "../lib/shared-ledger-contract-validation.js";

type ImportedDag = SharedLedgerImportManifest["features"][number]["versions"][number];

/** One step of historical replay, previous → next.
 * A source-authority feature replays what its home already approved, so bound nodes may carry their recorded revisions
 * (oneLine/estimate/fileGlobs/deps). Planning-authority imports keep the online dag.rewrite rule, which forbids that.
 * Either way a binding, once recorded, must survive with the same nodeKey and taskId.
 */
export function assertImportedDagStep(previous: ImportedDag, next: ImportedDag, f: SharedLedgerFeature,
  meta: Omit<SharedLedgerFeatureDetail, "feature" | "dag" | "tasks">, requestId: string): void {
  if (f.authorityMode === "source") {
    if (next.version !== previous.version + 1) throw new SharedLedgerError("invalid_field", "Historical version out of order");
    validateDag(next);
  } else {
    assertSharedLedgerMutation({ type: "dag.rewrite", requestId, projectId: f.projectId, featureId: f.id,
      expectedRev: f.rev, baseVersion: previous.version, nodes: next.nodes, reason: next.reason || "import" },
    { ...meta, feature: { ...f, authorityMode: "planning", version: previous.version }, dag: previous, tasks: [] }, false);
  }
  if (previous.bindings.some((b) => !next.bindings.some((n) => n.nodeKey === b.nodeKey && n.taskId === b.taskId))) {
    throw new SharedLedgerError("invalid_field", "Historical binding removed");
  }
}
