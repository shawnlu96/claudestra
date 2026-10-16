/**
 * mainRedGreenRetire: main went green again before a fix node this mechanism wrote was started. The tick (main-red-fix-tick.ts) lists
 * the candidates from a green run of the same workflow on a newer main SHA (greenRetirable); the write runs only inside
 * `ledger scheduler-main-red-fix --op retire` (main-red-fix-cmds.ts) and re-reads the node in its own transaction:
 * - still planned (no card): removed from the sub-DAG by the feature PM's rewrite, reason『main 已在 <sha> 转绿』, one info notice;
 * - already a card: left alone, one PM todo per node;
 * - a node of another mechanism or the PM is never a candidate (only main_red_fix_node events of this mechanism count).
 * off = nothing read or written (the tick does not call it); observe = one note per node. tests/main-red-fix-retire.test.ts.
 */
import type { Database } from "bun:sqlite";
import { composeRewrite } from "./dag-tools-plan.js";
import { dagWriteRefused } from "./dag-write-scrub.js";
import { isManager, type WriteCtx } from "./ledger-checks.js";
import { nodePhase } from "./ledger-dag-rules.js";
import { rewriteDag } from "./ledger-dag-write.js";
import { effectiveNodes, getDagVersion, getFeature, type DagNode } from "./ledger-feature.js";
import { getEventByDedup, getTask, LedgerError } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { workflowOf, type MainRedRun, type MainRedWorkflow } from "./main-red-fix.js";
import { mainRedNodes, nodeState } from "./main-red-fix-place.js";
import { recordPmTodo } from "./pm-todo-note.js";
import { observeDedupKey, recordObserved, recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import { featurePm } from "./scheduler-autostart.js";

const RETIRE_KEY = "mainRedGreenRetire";
const RETIRED_OP = "main_red_fix_retired";
const PM_TODO_KIND = "main_red_fix";
const retireKey = (project: string, featureId: string, key: string) => `main-red-fix:retire:${project}:${featureId}:${key}`;
const todoKey = (project: string, featureId: string, key: string, what: string) => `main-red-fix:retire-${what}:${project}:${featureId}:${key}`;
const observeKey = (project: string, featureId: string, key: string) =>
  observeDedupKey({ project, mechanism: RETIRE_KEY, target: "", actionKey: `main-red:retire:${featureId}:${key}` });

export interface RetireInput { workflow: MainRedWorkflow; featureId: string; key: string; greenSha: string; greenRunId: number; url: string }
export interface RetireResult { outcome: "retired" | "bound" | "observed" | "off" | "refused" | "gone" | "duplicate"; text: string; notify: string | null }

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
    return ![retireKey(project, n.featureId, n.key), todoKey(project, n.featureId, n.key, what), ...observing ? [observeKey(project, n.featureId, n.key)] : []]
      .some((k) => getEventByDedup(db, k));
  }).map((n) => ({ workflow, featureId: n.featureId, key: n.key, greenSha: green.headSha, greenRunId: green.id, url: green.url }));
}

/** The feature PM's rewrite without the node; null = written, else why not. */
function removeNode(db: Database, ctx: WriteCtx, project: string, i: RetireInput, why: string): string | null {
  const f = getFeature(db, i.featureId), pm = featurePm(db, i.featureId);
  if (!f) return `feature ${i.featureId} 不见了`;
  if (!pm || !isManager(db, pm, { project, agent: null })) return `feature ${f.id} 没有能代记的 PM`;
  const v = f.currentVersion ? getDagVersion(db, f.id, f.currentVersion) : null, cur = v ? effectiveNodes(db, v) : [];
  const phase = (n: DagNode) => nodePhase(n.taskId, n.taskId ? (getTask(db, n.taskId)?.stage ?? null) : null);
  const next = composeRewrite(cur, { add: [], remove: [i.key], update: [], cancel: {} }, phase);
  if (!next.ok) return `节点没移出：${next.error}`;
  try {
    const r = rewriteDag(db, { ...ctx, actor: pm, dedupKey: retireKey(project, f.id, i.key) }, { id: f.id, rev: f.rev, nodes: next.value,
      reasonKind: "requirement_change", cancel: new Map(), scopeChange: false, reasonText: why, askFrom: { agent: pm, channelId: null } });
    return r.row.version ? null : "改版要 owner 批，节点没直接移出";
  } catch (e) {
    if (e instanceof LedgerError || dagWriteRefused(e)) return `节点没移出：${(e as Error).message}`;
    throw e;
  }
}

/** One node: re-read in the transaction, then removed / left with a todo / noted, as the key's mode says. */
export function retireMainRedNode(db: Database, ctx: WriteCtx, project: string, i: RetireInput, policy: RecoveryPolicyPort = recoveryPolicy): RetireResult {
  const mode = policy(project, RETIRE_KEY).mode;
  if (mode === "off") return { outcome: "off", text: `${RETIRE_KEY} 是 off`, notify: null };
  return tx(db, () => {
    const prior = getEventByDedup(db, retireKey(project, i.featureId, i.key));
    if (prior) return { outcome: "duplicate", text: prior.text, notify: null };
    const mine = mainRedNodes(db, project).find((n) => n.featureId === i.featureId && n.key === i.key && n.workflow === i.workflow);
    if (!mine) throw new LedgerError("forbidden", `${i.featureId}/${i.key} 不是 mainRedFix 写的修复节点，不移出`);
    if (mine.runId >= i.greenRunId) throw new LedgerError("conflict", `run ${i.greenRunId} 不比写 ${i.key} 的 run ${mine.runId} 新`);
    const s = nodeState(db, mine), label = workflowOf(i.workflow).label, green = `main 已在 ${i.greenSha} 转绿`;
    if (s.state !== "open") return { outcome: "gone", text: `${i.featureId}/${i.key} 已不在计划中`, notify: null };
    if (mode === "observe") {
      recordObserved(db, { project, mechanism: RETIRE_KEY, target: "", actionKey: `main-red:retire:${i.featureId}:${i.key}`,
        action: s.node?.taskId ? `记待办：${green}，修复卡 ${s.node.taskId} 已开，不动` : `从子 DAG 移出修复节点 ${i.featureId}/${i.key}（${green}）`,
        data: { featureId: i.featureId, key: i.key, greenSha: i.greenSha, greenRunId: i.greenRunId } }, ctx.now ?? Date.now());
      return { outcome: "observed", text: `observe：${i.featureId}/${i.key}`, notify: null };
    }
    if (s.node?.taskId) {
      const text = `main ${label} 修复节点 ${i.featureId}/${i.key} 已开卡 ${s.node.taskId}，${green}（${i.url}），没动它：请 PM 定是否取消`;
      recordPmTodo(db, ctx, { project, target: s.node.taskId, kind: PM_TODO_KIND, text, dedupKey: todoKey(project, i.featureId, i.key, "bound") });
      return { outcome: "bound", text, notify: null };
    }
    const why = `${green}：撤掉 mainRedFix 没开工的 main ${label} 修复节点 ${i.key}`;
    const miss = removeNode(db, ctx, project, i, why);
    if (miss) {
      const text = `main ${label} 修复节点 ${i.featureId}/${i.key}：${green}，但${miss}（${i.url}）`;
      recordPmTodo(db, ctx, { project, target: "", kind: PM_TODO_KIND, text, dedupKey: todoKey(project, i.featureId, i.key, "refused") });
      return { outcome: "refused", text, notify: null };
    }
    const text = `[main 转绿] 从 ${i.featureId} 子 DAG 移出没开工的修复节点 ${i.key}：${green}（${i.url}）`;
    insertEvent(db, { ...ctx, dedupKey: `main-red-fix:retired:${project}:${i.featureId}:${i.key}` }, { project, target: "", kind: "scheduler", text,
      data: { op: RETIRED_OP, workflow: i.workflow, featureId: i.featureId, key: i.key, greenSha: i.greenSha, greenRunId: i.greenRunId, reason: why } }, true);
    return { outcome: "retired", text, notify: text };
  });
}
