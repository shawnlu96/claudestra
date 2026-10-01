import {
  SharedLedgerError, SHARED_LEDGER_COMMANDS, SHARED_LEDGER_DISABLED_ACTIONS,
  type SharedLedgerCommand, type SharedLedgerNode, type SharedLedgerDag, type SharedLedgerFeatureDetail,
  type SharedLedgerEnvelope,
} from "./shared-ledger-contract.js";
import { array, id, integer, invalid, nonce, object, optional, positive, record, relativeGlob, text, unique, type Schema } from "./shared-ledger-contract-schema.js";

export const nodeSchema: Schema<SharedLedgerNode> = object({
  key: id, oneLine: text(2000, 1), deps: array(id), fileGlobs: array(relativeGlob), estimate: text(200),
});
export const dagSchema: Schema<SharedLedgerDag> = object({
  version: integer, nodes: array(nodeSchema), bindings: array(object({ nodeKey: id, taskId: id })),
});

/** Kahn traversal avoids recursive stack exhaustion on long imported graphs. */
function validateNodes(nodes: SharedLedgerNode[]): void {
  unique(nodes.map((n) => n.key));
  const indegree = new Map(nodes.map((n) => [n.key, n.deps.length]));
  const outgoing = new Map(nodes.map((n) => [n.key, [] as string[]]));
  for (const n of nodes) {
    unique(n.deps);
    unique(n.fileGlobs);
    for (const dep of n.deps) {
      if (!outgoing.has(dep)) invalid();
      outgoing.get(dep)!.push(n.key);
    }
  }
  const ready = nodes.filter((n) => n.deps.length === 0).map((n) => n.key);
  for (let i = 0; i < ready.length; i++) {
    for (const next of outgoing.get(ready[i])!) {
      const left = indegree.get(next)! - 1;
      indegree.set(next, left);
      if (!left) ready.push(next);
    }
  }
  if (ready.length !== nodes.length) invalid();
}

export function validateDag(dag: SharedLedgerDag): void {
  validateNodes(dag.nodes);
  unique(dag.bindings.map((b) => b.nodeKey));
  unique(dag.bindings.map((b) => b.taskId));
  const keys = new Set(dag.nodes.map((n) => n.key));
  if (dag.bindings.some((b) => !keys.has(b.nodeKey))) invalid();
  if (dag.version === 0 && (dag.nodes.length || dag.bindings.length)) invalid();
}

const common = { requestId: id, projectId: id };
const mutation = { ...common, featureId: id, expectedRev: positive };
const schemas = {
  "feature.new": object({ ...common, type: text(20), title: text(300, 1), description: text(16000), homeInstanceId: id }),
  "feature.set": object({ ...mutation, type: text(20), patch: object({ title: optional(text(300, 1)), description: optional(text(16000)) }) }),
  dag: object({ ...mutation, type: text(20), baseVersion: integer, nodes: array(nodeSchema), reason: text(2000, 1) }),
};

/** No arbitrary field forwarding, even for actor/role/owner. Their presence is an input error. */
export function parseSharedLedgerCommand(value: unknown): SharedLedgerCommand {
  const raw = record(value);
  const type = raw.type;
  const disabled = [...SHARED_LEDGER_DISABLED_ACTIONS, "task.set", "task.start", "task.stage", "dag.approve", "dag.scopeChange", "start_node"];
  if (disabled.includes(type as string) || Object.hasOwn(raw, "scopeChange")) throw new SharedLedgerError("execution_not_shared");
  if (!SHARED_LEDGER_COMMANDS.includes(type as typeof SHARED_LEDGER_COMMANDS[number])) return invalid();
  const command = (type === "feature.new" ? schemas["feature.new"](value)
    : type === "feature.set" ? schemas["feature.set"](value) : schemas.dag(value)) as SharedLedgerCommand;
  if (command.type === "feature.set" && !Object.keys(command.patch).length) invalid();
  if (command.type === "dag.init" || command.type === "dag.rewrite") {
    if ((command.type === "dag.init") !== (command.baseVersion === 0)) invalid();
    validateNodes(command.nodes);
  }
  return command;
}

export function parseSharedLedgerEnvelope<T>(value: unknown, payload: Schema<T>): SharedLedgerEnvelope<T> {
  return object({ attemptNonce: nonce, payload })(value);
}

/** C2 calls after authorization, inside its CAS transaction with current bindings/proposal state.
 * Bindings are server-owned: commands contain planning nodes only and cannot add/remove a binding.
 */
export function assertSharedLedgerMutation(command: SharedLedgerCommand, current: SharedLedgerFeatureDetail, pendingProposal: boolean): void {
  if (command.type === "feature.new") return invalid();
  const f = current.feature;
  if (command.projectId !== f.projectId || command.featureId !== f.id) throw new SharedLedgerError("forbidden");
  if (f.authorityMode !== "planning") throw new SharedLedgerError("execution_not_shared");
  if (pendingProposal) throw new SharedLedgerError("pending_proposal");
  if (command.expectedRev !== f.rev) throw new SharedLedgerError("conflict");
  if (command.type === "feature.set") return;
  if (command.baseVersion !== f.version) throw new SharedLedgerError("conflict");
  const next = new Map(command.nodes.map((n) => [n.key, n]));
  for (const binding of current.dag.bindings) {
    const before = current.dag.nodes.find((n) => n.key === binding.nodeKey);
    const after = next.get(binding.nodeKey);
    if (!before || !after || !sameNode(before, after)) throw new SharedLedgerError("execution_not_shared");
  }
}

function sameNode(a: SharedLedgerNode, b: SharedLedgerNode): boolean {
  const sorted = (items: string[]) => JSON.stringify([...items].sort());
  return a.key === b.key && a.oneLine === b.oneLine && a.estimate === b.estimate
    && sorted(a.deps) === sorted(b.deps) && sorted(a.fileGlobs) === sorted(b.fileGlobs);
}
