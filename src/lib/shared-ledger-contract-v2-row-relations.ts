/** Pure set-level relations shared by every V2 row collection (feature view, snapshot, migration manifest).
 * Body-knowable only: live owner / lease authorization stays in the owning transaction, never in these parsers.
 */
import { parseDag } from "./shared-ledger-contract-v2-dag.js";
import { distinct, fail } from "./shared-ledger-contract-v2-validation.js";

interface RelationRows {
  tasks: readonly { id: string; title: string }[];
  dependencies: readonly { fromTask: string; toTask: string }[];
  intents: readonly { operationId: string }[];
}
/** Task dependencies form a DAG (the one Kahn pass behind parseDag) and one operation maps to exactly one center intent:
 * the home keys its projected intent by operationId, so a second row under another id would overwrite the first.
 */
export function assertRowRelations(rows: RelationRows): void {
  parseDag({ version: 1, nodes: rows.tasks.map(t => ({ key: t.id, oneLine: t.title,
    deps: rows.dependencies.filter(d => d.toTask === t.id).map(d => d.fromTask), fileGlobs: [], estimate: "" })), bindings: [] });
  if (!distinct(rows.intents, i => i.operationId)) fail();
}

interface SpecTask {
  id: string; specRev: number;
  spec: { artifactId: string | null; originalDigest: string; sharedDigest: string | null };
}
interface SpecArtifact { artifactId: string; kind: string; taskId: string; specRev: number | null; originalDigest: string; sharedDigest: string }
/** A task's spec reference resolves to a spec artifact of that task and revision carrying both of its digests. */
export function assertSpecArtifacts(tasks: readonly SpecTask[], artifacts: readonly SpecArtifact[]): void {
  const byId = new Map(artifacts.map(a => [a.artifactId, a]));
  for (const task of tasks) if (task.spec.artifactId !== null) {
    const a = byId.get(task.spec.artifactId);
    if (!a || a.kind !== "spec" || a.taskId !== task.id || a.specRev !== task.specRev
      || a.originalDigest !== task.spec.originalDigest || a.sharedDigest !== task.spec.sharedDigest) fail();
  }
}
