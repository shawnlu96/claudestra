import {
  assertTransactionContext, fail, id, parseTask, type V2Artifact, type V2TransactionContext,
} from "../../lib/shared-ledger-contract-v2.js";
import type { ArtifactReaders } from "./approval.js";

type SpecView = { visibility: "home_only"; label: "全文仅在主场"; summary: string; artifact: null }
  | { visibility: "approved_copy"; label: string; summary: string; artifact: V2Artifact };
/** Presentation metadata is separate from the frozen artifact DTO; a summary is never exposed as original content. */
export function readArtifactSpec(
  context: V2TransactionContext, taskId: string, readers: ArtifactReaders,
  readArtifact: (context: V2TransactionContext, artifactId: string) => V2Artifact,
): SpecView {
  assertTransactionContext(context);
  const row = readers.readTask(context, id(taskId));
  if (!row || row.id !== taskId || row.teamId !== context.scope.teamId || row.projectId !== context.scope.projectId) fail("not_found");
  const task = parseTask(row), spec = task.spec;
  if (spec.visibility === "home_only") return { visibility: "home_only", label: "全文仅在主场", summary: spec.summary, artifact: null };
  const artifact = readArtifact(context, spec.artifactId!);
  if (artifact.kind !== "spec" || artifact.taskId !== task.id || artifact.specRev !== task.specRev
    || artifact.originalDigest !== spec.originalDigest || artifact.sharedDigest !== spec.sharedDigest) fail("not_found");
  return { visibility: "approved_copy", label: artifact.originalDigest === artifact.sharedDigest ? "获准共享副本" : "获准共享副本；全文仅在主场",
    summary: spec.summary, artifact };
}
