/** One local DAG version in the contract's version shape (key / deps / fileGlobs / estimate / oneLine; bindings by local task id).
 * Shared by the import export (every version) and the source-DAG upload (current version only, team-project-N8M). */
import type { DagNode, DagVersion } from "./ledger-feature.js";
import type { SharedLedgerDag } from "./shared-ledger-contract.js";

export interface SharedLedgerDagText { reason?: string; oneLine?: (node: DagNode) => string }
export function sharedLedgerDagVersion(dag: Pick<DagVersion, "version" | "reasonText">, nodes: readonly DagNode[],
  text: SharedLedgerDagText = {}): SharedLedgerDag & { reason: string } {
  return { version: dag.version, reason: text.reason ?? dag.reasonText,
    nodes: nodes.map((n) => ({ key: n.key, deps: n.deps, fileGlobs: n.fileGlobs ?? [], estimate: n.estimate,
      oneLine: text.oneLine ? text.oneLine(n) : n.oneLine })),
    bindings: nodes.filter((n) => n.taskId).map((n) => ({ nodeKey: n.key, taskId: n.taskId! })) };
}

/** The scrub allowlist (shared-ledger-scrub.ts) knows the DAG version shape under an import manifest, not the upload's
 * `schemaVersion` / `dag` keys: scrub this view (every string of the upload, in declared shapes), then parse the original. */
export const sourceDagScrubView = (u: { projectId: unknown; featureId: unknown; sourceInstanceId: unknown; dag: unknown }) =>
  ({ projectId: u.projectId, featureId: u.featureId, sourceInstanceId: u.sourceInstanceId, manifest: { features: [{ versions: [u.dag] }] } });
