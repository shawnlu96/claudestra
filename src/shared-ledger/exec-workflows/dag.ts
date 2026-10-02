import {
  fail, parseDag, type V2Feature, type V2TransactionContext,
} from "../../lib/shared-ledger-contract-v2.js";
import { authorizeWorkflow, featureGate, loadTask, nextFeature, type DagCommand, type WorkflowsDependencies } from "./policy.js";

type Dag = ReturnType<typeof parseDag>;
type DagNode = Dag["nodes"][number];
type Binding = Dag["bindings"][number];

export function readDag(ctx: V2TransactionContext, featureId: string, version: number): Dag {
  const bindings = ctx.all("xw.binding.list", { featureId, version }) as Binding[];
  if (version === 0) return parseDag({ version, nodes: [], bindings });
  const row = ctx.all("xw.dag.get", { featureId, version })[0] as { nodes: string } | undefined;
  return parseDag({ version, nodes: row ? JSON.parse(row.nodes) : fail("not_found"), bindings });
}
function sameNode(a: DagNode, b: DagNode): boolean {
  const sorted = (items: string[]) => JSON.stringify([...items].sort());
  return a.key === b.key && a.oneLine === b.oneLine && a.estimate === b.estimate
    && sorted(a.deps) === sorted(b.deps) && sorted(a.fileGlobs) === sorted(b.fileGlobs);
}
/** Next DAG version. Bound nodes are server-owned: a completed node (stage done) keeps its node, card id and
 * task row untouched and can never be cancelled; other bound nodes stay unchanged unless explicitly cancelled
 * (X12 then cancels that card in the same transaction). Acyclicity and node references are checked by parseDag.
 */
export function applyDagVersion(
  ctx: V2TransactionContext, deps: WorkflowsDependencies, feature: V2Feature, nodes: DagNode[], cancels: readonly string[],
): { feature: V2Feature; dag: Dag } {
  const current = readDag(ctx, feature.id, feature.currentVersion), next = new Map(nodes.map(n => [n.key, n]));
  const kept: Binding[] = [];
  for (const key of cancels) if (!current.bindings.some(b => b.nodeKey === key)) fail();
  for (const binding of current.bindings) {
    const task = loadTask(ctx, deps, binding.taskId);
    if (task.featureId !== feature.id) fail("conflict");
    const before = current.nodes.find(n => n.key === binding.nodeKey), after = next.get(binding.nodeKey);
    if (cancels.includes(binding.nodeKey)) {
      if (task.stage === "done") fail("conflict");
      if (ctx.run("xw.binding.delete", { featureId: feature.id, ...binding }) !== 1) fail("conflict");
      continue;
    }
    if (!before || !after || !sameNode(before, after)) fail("conflict");
    kept.push(binding);
  }
  const dag = parseDag({ version: feature.currentVersion + 1, nodes, bindings: kept });
  ctx.run("xw.dag.insert", { featureId: feature.id, version: dag.version, nodes: JSON.stringify(dag.nodes) });
  for (const binding of kept) ctx.run("xw.binding.snapshot", { featureId: feature.id, version: dag.version, ...binding });
  const saved = nextFeature(ctx, feature, { currentVersion: dag.version });
  deps.saveFeature(ctx, saved, feature.rev);
  return { feature: saved, dag };
}
function sortedBindings(bindings: readonly Binding[]): string {
  return JSON.stringify([...bindings].map(b => [b.nodeKey, b.taskId]).sort());
}
function bindNode(ctx: V2TransactionContext, deps: WorkflowsDependencies, command: Extract<DagCommand, { type: "dag.bind" }>, feature: V2Feature) {
  const p = command.payload, dag = readDag(ctx, feature.id, feature.currentVersion);
  if (!dag.nodes.some(n => n.key === p.nodeKey) || dag.bindings.some(b => b.nodeKey === p.nodeKey)) fail("conflict");
  if (ctx.all("xw.binding.byTask", { taskId: p.taskId }).length) fail("conflict");
  const task = loadTask(ctx, deps, p.taskId);
  // Same project is enforced by loadTask scope; the card must also belong to this feature and its home.
  if (task.featureId !== feature.id || task.homeInstanceId !== feature.homeInstanceId) fail("conflict");
  if (task.rev !== p.expectedTaskRev) fail("conflict");
  authorizeWorkflow(ctx, deps, command, task);
  const saved = nextFeature(ctx, feature);
  deps.saveFeature(ctx, saved, feature.rev);
  deps.saveTask(ctx, { ...task, rev: task.rev + 1, updatedAt: ctx.scope.now }, task.rev);
  ctx.run("xw.binding.insert", { featureId: feature.id, nodeKey: p.nodeKey, taskId: task.id, boundVersion: dag.version });
  ctx.run("xw.binding.snapshot", { featureId: feature.id, version: dag.version, nodeKey: p.nodeKey, taskId: task.id });
  return { feature: saved, version: dag.version };
}
export function applyDag(ctx: V2TransactionContext, deps: WorkflowsDependencies, command: DagCommand): { feature: V2Feature; version: number } {
  const p = command.payload, feature = featureGate(ctx, deps, p.featureId);
  if (feature.rev !== p.expectedRev || feature.currentVersion !== p.baseVersion) fail("conflict");
  if (command.type === "dag.bind") return bindNode(ctx, deps, command, feature);
  authorizeWorkflow(ctx, deps, command, null);
  const nodes = command.type === "dag.init" ? command.payload.nodes : command.payload.dag.nodes;
  const result = applyDagVersion(ctx, deps, feature, nodes, []);
  // A rewrite may restate the server-owned bindings but can never add, move or drop one.
  if (command.type === "dag.rewrite" && sortedBindings(command.payload.dag.bindings) !== sortedBindings(result.dag.bindings)) fail("conflict");
  return { feature: result.feature, version: result.dag.version };
}
