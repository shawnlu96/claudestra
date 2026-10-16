/**
 * mainRedGreenRetire: main went green again before a fix node this mechanism wrote was started. The tick (main-red-fix-tick.ts) lists
 * the candidates from a green run of the same workflow on a newer main SHA (greenRetirable); the write (retireMainRedNode,
 * in main-red-fix-write.ts with the other ledger writes) runs only inside `ledger scheduler-main-red-fix --op retire`
 * (main-red-fix-cmds.ts) and re-reads the node in its own transaction:
 * - still planned (no card): removed from the sub-DAG by the feature PM's rewrite, reason『main 已在 <sha> 转绿』, one info notice;
 * - already a card: left alone, one PM todo per node;
 * - a node of another mechanism or the PM is never a candidate (only main_red_fix_node events of this mechanism count).
 * off = nothing read or written (the tick does not call it); observe = one note per node. tests/main-red-fix-retire.test.ts.
 */
import type { Database } from "bun:sqlite";
import { getEventByDedup } from "./ledger-store.js";
import type { MainRedRun, MainRedWorkflow } from "./main-red-fix.js";
import { mainRedNodes, nodeState } from "./main-red-fix-place.js";
import { retireKey, retireObserveKey, retireTodoKey, type RetireInput } from "./main-red-fix-write.js";

export { retireMainRedNode } from "./main-red-fix-write.js";

/**
 * This mechanism's open fix nodes of `workflow` that `green` covers: written for an older run on another main SHA. Ones whose answer
 * is already in the ledger (removed, the card todo, a refusal; the observe note only while observing, so on still acts) are left out.
 */
export function greenRetirable(db: Database, project: string, workflow: MainRedWorkflow, green: MainRedRun, observing: boolean): RetireInput[] {
  return mainRedNodes(db, project).filter((n) => {
    const sha = (n as { mainSha?: unknown }).mainSha;
    if (n.workflow !== workflow || n.runId >= green.id || typeof sha !== "string" || sha.toLowerCase() === green.headSha) return false;
    const s = nodeState(db, n);
    if (s.state !== "open") return false;
    const what = s.node?.taskId ? "bound" : "refused";
    return ![retireKey(project, n.featureId, n.key), retireTodoKey(project, n.featureId, n.key, what), ...observing ? [retireObserveKey(project, n.featureId, n.key)] : []]
      .some((k) => getEventByDedup(db, k));
  }).map((n) => ({ workflow, featureId: n.featureId, key: n.key, greenSha: green.headSha, greenRunId: green.id, url: green.url }));
}
