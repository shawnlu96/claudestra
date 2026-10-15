/**
 * main-red-fix's ledger reads, shared by the tick (query_only) and the writer's transaction: the mechanism's own fix nodes and their
 * state, and where a new fix node goes and what it says: the responsible card's feature first, else the fallback feature; the node
 * key, the card id, the globs and the spec, with every check the spec must pass before it is written (spec lint, card id gate, the
 * dag-write scrub's text check). tests/main-red-fix-tick.test.ts.
 */
import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { effectiveNodes, getDagVersion, getFeature, getPendingProposal, type DagNode, type Feature } from "./ledger-feature.js";
import { cardNames } from "./ledger-card-names.js";
import { storedOrigin } from "./ledger-origin.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getTask } from "./ledger-store.js";
import { MAIN_RED_FALLBACK_FEATURE, fixGlobs, fixSpec, keyBase, nextKey, NODE_OP, workflowOf, type MainRedFacts, type MainRedWorkflow } from "./main-red-fix.js";
import { parseSpecHead } from "./scheduler-autostart.js";
import { cardIdGate } from "./shared-ledger-mirror-skip-id.js";
import { sharedLedgerValueBlocked, type SharedLedgerScrubContext } from "./shared-ledger-scrub.js";
import { lintUiSpec } from "./spec-lint.js";
import { lintObservation } from "./spec-lint-observation.js";

interface NodeFact { seq: number; workflow: MainRedWorkflow; checks: string; featureId: string; key: string; taskId: string; faultKey: string | null; runId: number }

/** Every fix node this mechanism wrote in the project, oldest first. */
export function mainRedNodes(db: Database, project: string): NodeFact[] {
  return (db.query(`SELECT seq, data FROM events WHERE project = ? AND kind = 'scheduler' AND json_extract(data, '$.op') = ? ORDER BY seq`)
    .all(project, NODE_OP) as { seq: number; data: string }[]).map((r) => ({ seq: r.seq, ...JSON.parse(r.data) }) as NodeFact);
}

/** open = still to be fixed (planned or a live card); ended = verified / done; failed = cancelled or gone from the DAG. */
export function nodeState(db: Database, n: Pick<NodeFact, "featureId" | "key">): { state: "open" | "ended" | "failed"; node: DagNode | null } {
  const f = getFeature(db, n.featureId), v = f?.currentVersion ? getDagVersion(db, f.id, f.currentVersion) : null;
  const node = v ? effectiveNodes(db, v).find((x) => x.key === n.key) ?? null : null;
  if (!node) return { state: "failed", node };
  const stage = node.taskId ? getTask(db, node.taskId)?.stage : null;
  if (stage === "cancelled") return { state: "failed", node };
  return { state: stage === "verified" || stage === "done" ? "ended" : "open", node };
}

/** scheduler-autostart-deps.ts specPathIn's spelling (importing it would close a cycle through the autostart tick that runs this). */
const specPathIn = (ledgerDir: string, taskId: string) => resolve(ledgerDir, "docs", "tasks", `${taskId}.md`);

export interface PlaceDeps { ledgerDir: string; scrub: SharedLedgerScrubContext; exists: (path: string) => boolean; fallback?: string }
export interface Placement { f: Feature; cur: DagNode[]; key: string; taskId: string; globs: string[]; spec: string; specPath: string; oneLine: string }
/** content = the spec itself cannot be written (another feature would not help); otherwise the feature cannot take the node. */
type PlaceMiss = { why: string; content: boolean };

/** The responsible card's node anywhere in its feature's current DAG (its globs feed the fix node's scope). */
function ownNode(db: Database, task: LedgerTask | null): DagNode | null {
  const f = task?.featureId ? getFeature(db, task.featureId) : null;
  const v = f?.currentVersion ? getDagVersion(db, f.id, f.currentVersion) : null;
  return (v && effectiveNodes(db, v).find((n) => n.taskId === task!.id)) || null;
}

/** The spec's own checks, in the order a PM would fix them; null = it may be written. */
export function specRefusal(spec: string, scrub: SharedLedgerScrubContext): string | null {
  const head = parseSpecHead(spec).template;
  return lintObservation(spec) ?? lintUiSpec(spec, () => false) ?? (head.ok && head.template === "code" ? null : "规格卡首模板不是 code")
    ?? (sharedLedgerValueBlocked(spec, scrub) ? "规格含不能外发的内容（本地路径 / 主机名 / 敏感串），没写" : null);
}

function placeIn(db: Database, project: string, featureId: string, facts: MainRedFacts, responsible: LedgerTask | null, own: DagNode | null,
  deps: PlaceDeps): Placement | PlaceMiss {
  const miss = (why: string, content = false): PlaceMiss => ({ why, content });
  const origin = storedOrigin(db), f = getFeature(db, featureId) ?? (origin ? getFeature(db, `${origin}-${featureId}`) : null);
  if (!f || f.project !== project) return miss(`项目里没有 feature ${featureId}`);
  if (f.status !== "active") return miss(`feature ${f.id} 是 ${f.status}`);
  const v = f.currentVersion ? getDagVersion(db, f.id, f.currentVersion) : null;
  if (!v) return miss(`feature ${f.id} 还没建 DAG`);
  if (getPendingProposal(db, f.id)) return miss(`feature ${f.id} 有待 owner 批的改版，写不进`);
  const cur = effectiveNodes(db, v);
  const idOf = (key: string) => cardNames(db, f, key).taskId;
  const key = nextKey(keyBase(facts.workflow, f.id === responsible?.featureId ? own?.key ?? null : null), (k) => cur.some((n) => n.key === k) ||
    !!getTask(db, idOf(k)) || deps.exists(specPathIn(deps.ledgerDir, idOf(k))));
  if (!key) return miss(`feature ${f.id} 的修复节点键已用满`);
  const taskId = idOf(key), globs = fixGlobs(facts.files, own?.fileGlobs ?? [], workflowOf(facts.workflow).file);
  const gate = cardIdGate(taskId, deps.scrub);
  if (gate) return miss(gate, true);
  const spec = fixSpec({ taskId, facts, globs, responsible: responsible?.id ?? null, featureId: f.id });
  const refusal = specRefusal(spec, deps.scrub);
  if (refusal) return miss(`规格没过检查：${refusal}`, true);
  const label = workflowOf(facts.workflow).label;
  return { f, cur, key, taskId, globs, spec, specPath: specPathIn(deps.ledgerDir, taskId), oneLine: `main ${label} 红修复（run ${facts.runId}）`.slice(0, 120) };
}

/** Responsible feature first (push only), then the fallback, minus `skip` (features whose write already failed); every miss is kept. */
export function placeFix(db: Database, project: string, facts: MainRedFacts, deps: PlaceDeps, skip: ReadonlySet<string> = new Set()):
  { placed: Placement | null; misses: string[]; content: boolean } {
  const responsible = facts.responsibleTask ? getTask(db, facts.responsibleTask) : null;
  const own = ownNode(db, responsible && responsible.project === project ? responsible : null);
  const fallback = deps.fallback ?? MAIN_RED_FALLBACK_FEATURE;
  const order = [...new Set([...(facts.workflow === "push" && responsible?.featureId ? [responsible.featureId] : []), fallback])];
  const misses: string[] = [];
  for (const id of order) {
    const p = placeIn(db, project, id, facts, responsible, own, deps);
    if (!("why" in p) && skip.has(p.f.id)) continue;
    if (!("why" in p)) return { placed: p, misses, content: false };
    misses.push(p.why);
    if (p.content) return { placed: null, misses, content: true };
  }
  return { placed: null, misses, content: false };
}
