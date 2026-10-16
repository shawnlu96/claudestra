/**
 * main-red-fix's ledger writes, run only inside `ledger scheduler-main-red-fix` (main-red-fix-cmds.ts, scheduler identity + lease):
 * - observe: one recovery note per main SHA + workflow + would-be action (recordObserved);
 * - rerun claim: the run's single known-flaky rerun, a UNIQUE dedup key per run id, written before `gh run rerun`;
 * - fix: per run id + attempt once (handled event), skip when the PM already bound the same fault or the same workflow has an
 *   unverified fix node of this mechanism with the same failed checks (one note on that card instead); else the node through
 *   composeRewrite / rewriteDag (the review-converge-followup.ts way: feature PM as the writer, dedup per run) and the spec file;
 * - untriaged: a log too long to read whole that still names no failed test: no node (a scope from it would be a guess), the attempt
 *   handled and one PM todo per run with the run link and failed checks, for the PM to decide;
 * - bind: mainRedRepairBind, only for a card this mechanism wrote and the same faultKey.
 * Results reach the PM through recordPmTodo (pull); only an unplaceable node or a fault whose fixes failed twice returns a notice.
 */
import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { composeRewrite } from "./dag-tools-plan.js";
import { dagWriteRefused } from "./dag-write-scrub.js";
import { isManager, type WriteCtx } from "./ledger-checks.js";
import { nodePhase } from "./ledger-dag-rules.js";
import { rewriteDag } from "./ledger-dag-write.js";
import { effectiveNodes, getDagVersion, getFeature, type DagNode } from "./ledger-feature.js";
import { getEventByDedup, getTask, LedgerError } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { dagKey, faultSet, handledKey, HANDLED_OP, MAIN_RED_FAIL_LIMIT, nodeKey, NODE_OP, rerunKey, RERUN_OP, SOURCE, todoKey, workflowOf,
  type MainRedFacts, type MainRedWorkflow } from "./main-red-fix.js";
import { mainRedNodes, nodeState, placeFix, type PlaceDeps, type Placement } from "./main-red-fix-place.js";
import { recordPmTodo } from "./pm-todo-note.js";
import { quoteExternal } from "./quote-text.js";
import { observeDedupKey, recordObserved, recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import { featurePm } from "./scheduler-autostart.js";
import { mainCiApprovals, REVOKE_OP } from "./scheduler-main-ci-wiring-store.js";
import { recordMainRedRepair } from "./scheduler-main-ci-wiring-write.js";

export interface MainRedWriteDeps extends PlaceDeps { repo: string; policy?: RecoveryPolicyPort; now: number }
export interface MainRedFixResult { outcome: "duplicate" | "node" | "same" | "bound" | "refused" | "unplaced" | "untriaged"; text: string; notify: string | null; node?: string }

const PM_TODO_KIND = "main_red_fix";
const mustOn = (policy: RecoveryPolicyPort, project: string) => {
  const p = policy(project, "mainRedFix");
  if (p.mode !== "on") throw new LedgerError("forbidden", `mainRedFix 是 ${p.mode}：不重跑、不写节点`);
};

/** The would-be action under observe: one note per main SHA + workflow + action, whatever the run attempt. */
export function recordMainRedObserve(db: Database, project: string, input: { workflow: MainRedWorkflow; mainSha: string; action: "rerun" | "node" | "bind"; text: string;
  target?: string; data?: Record<string, unknown> }, now: number) {
  return recordObserved(db, { project, mechanism: input.action === "bind" ? "mainRedRepairBind" : "mainRedFix", target: input.target ?? "",
    actionKey: `main-red:${input.workflow}:${input.mainSha}:${input.action}`, action: input.text, data: input.data }, now);
}

/** The run's single rerun: true = this call claimed it (the tick then runs `gh run rerun --failed`). */
export function claimMainRedRerun(db: Database, ctx: WriteCtx, project: string, f: Pick<MainRedFacts, "workflow" | "runId" | "attempt" | "mainSha" | "url" | "files">,
  policy: RecoveryPolicyPort = recoveryPolicy): boolean {
  mustOn(policy, project);
  return tx(db, () => {
    if (getEventByDedup(db, rerunKey(project, f.runId))) return false;
    insertEvent(db, { ...ctx, dedupKey: rerunKey(project, f.runId) }, { project, target: "", kind: "scheduler",
      text: `main ${workflowOf(f.workflow).label} 红只在已知偶发：重跑一次失败的 job ${f.url}`,
      data: { op: RERUN_OP, workflow: f.workflow, runId: f.runId, attempt: f.attempt, mainSha: f.mainSha, url: f.url, files: f.files } }, true);
    return true;
  });
}

/** The rerun's outcome, once per run, as a PM todo (green: nothing else is written for this run). */
export function recordMainRedRerunResult(db: Database, ctx: WriteCtx, project: string, f: Pick<MainRedFacts, "workflow" | "runId" | "url">, green: boolean) {
  const label = workflowOf(f.workflow).label;
  return recordPmTodo(db, ctx, { project, target: "", kind: PM_TODO_KIND, dedupKey: todoKey(project, f.runId, green ? "rerun-green" : "rerun-failed"),
    text: green ? `main ${label} 已知偶发重跑转绿，没写修复节点：${f.url}` : `main ${label} 已知偶发重跑没发出去，按非偶发写修复节点：${f.url}` });
}

function handled(db: Database, ctx: WriteCtx, project: string, f: MainRedFacts, outcome: MainRedFixResult["outcome"], text: string, extra: Record<string, unknown> = {}) {
  insertEvent(db, { ...ctx, dedupKey: handledKey(project, f.runId, f.attempt) }, { project, target: "", kind: "scheduler", text,
    data: { op: HANDLED_OP, outcome, workflow: f.workflow, runId: f.runId, attempt: f.attempt, mainSha: f.mainSha, checks: f.checks, ...extra } }, true);
  recordPmTodo(db, ctx, { project, target: "", kind: PM_TODO_KIND, text, dedupKey: todoKey(project, f.runId, `a${f.attempt}`) });
}

export interface MainRedUntriaged extends Pick<MainRedFacts, "workflow" | "runId" | "attempt" | "mainSha" | "url" | "checks"> { why: string }

/** A truncated log naming no failed test: the attempt handled without a node, one PM todo per run whatever the attempt. */
export function recordMainRedUntriaged(db: Database, ctx: WriteCtx, project: string, f: MainRedUntriaged, policy: RecoveryPolicyPort = recoveryPolicy): MainRedFixResult {
  mustOn(policy, project);
  return tx(db, () => {
    const prior = getEventByDedup(db, handledKey(project, f.runId, f.attempt));
    if (prior) return { outcome: "duplicate", text: prior.text, notify: null };
    const checks = f.checks.map((c) => quoteExternal(c, 120)).join("、") || "（未列出）";
    const text = `main ${workflowOf(f.workflow).label} 红（run ${f.runId}）认不出失败测试，没写修复节点，请 PM 定：${quoteExternal(f.why, 300)}；失败 check：${checks}；${f.url}`;
    insertEvent(db, { ...ctx, dedupKey: handledKey(project, f.runId, f.attempt) }, { project, target: "", kind: "scheduler", text,
      data: { op: HANDLED_OP, outcome: "untriaged", workflow: f.workflow, runId: f.runId, attempt: f.attempt, mainSha: f.mainSha, checks: f.checks } }, true);
    recordPmTodo(db, ctx, { project, target: "", kind: PM_TODO_KIND, text, dedupKey: todoKey(project, f.runId, "untriaged") });
    return { outcome: "untriaged", text, notify: null };
  });
}

/** The node through the converge follow-up's write path; a refused or failed write is a miss, never a throw. */
function writeNode(db: Database, ctx: WriteCtx, project: string, f: MainRedFacts, p: Placement): string | null {
  const pm = featurePm(db, p.f.id);
  if (!pm || !isManager(db, pm, { project, agent: null })) return `feature ${p.f.id} 没有能代记的 PM`;
  const node = { key: p.key, oneLine: p.oneLine, deps: [], estimate: "", fileGlobs: p.globs };
  const phase = (n: DagNode) => nodePhase(n.taskId, n.taskId ? (getTask(db, n.taskId)?.stage ?? null) : null);
  const next = composeRewrite(p.cur, { add: [node], remove: [], update: [], cancel: {} }, phase);
  if (!next.ok) return `节点没写成：${next.error}`;
  try {
    const r = rewriteDag(db, { ...ctx, actor: pm, dedupKey: dagKey(project, f.runId, f.attempt) }, { id: p.f.id, rev: p.f.rev, nodes: next.value, reasonKind: "new_issue",
      cancel: new Map(), scopeChange: false, reasonText: `调度代记：main ${workflowOf(f.workflow).label} 红（run ${f.runId}）的修复节点 ${p.key}`, askFrom: { agent: pm, channelId: null } });
    return r.row.version ? null : "改版要 owner 批，节点没直接生效";
  } catch (e) {
    if (e instanceof LedgerError || dagWriteRefused(e)) return `节点没写成：${(e as Error).message}`;
    throw e;
  }
}

/** A feature that took the placement but refused the write (no PM, a refused rewrite) hands the node on to the next one. */
function placeAndWrite(db: Database, ctx: WriteCtx, project: string, f: MainRedFacts, deps: PlaceDeps): { placed: Placement | null; misses: string[]; content: boolean } {
  const misses = new Set<string>(), skip = new Set<string>();
  for (;;) {
    const p = placeFix(db, project, f, deps, skip);
    for (const m of p.misses) misses.add(m);
    if (!p.placed) return { placed: null, misses: [...misses], content: p.content };
    const why = writeNode(db, ctx, project, f, p.placed);
    if (!why) return { placed: p.placed, misses: [...misses], content: false };
    misses.add(why);
    skip.add(p.placed.f.id);
  }
}

/** One red run: the fix node and its spec, or the reason there is none. */
export function writeMainRedFix(db: Database, ctx: WriteCtx, project: string, f: MainRedFacts, deps: MainRedWriteDeps): MainRedFixResult {
  mustOn(deps.policy ?? recoveryPolicy, project);
  try { return writeInTx(db, ctx, project, f, deps); }
  catch (e) {
    // the spec file write failed and the transaction rolled back: the reason still reaches pm-todo (once per attempt); the run stays
    // unhandled, so the next round tries again (a full disk or a permission fault can clear up)
    const { code, syscall } = e as NodeJS.ErrnoException;
    if (typeof code === "string" && /^E[A-Z]+$/.test(code)) {
      const why = syscall ? `${code} ${syscall}` : code;
      recordPmTodo(db, ctx, { project, target: "", kind: PM_TODO_KIND, dedupKey: todoKey(project, f.runId, `a${f.attempt}-write-error`),
        text: `main ${workflowOf(f.workflow).label} 红（run ${f.runId}）的修复规格没写成（${why}），节点已回滚，下一轮重试：${f.url}` });
    }
    throw e;
  }
}

function writeInTx(db: Database, ctx: WriteCtx, project: string, f: MainRedFacts, deps: MainRedWriteDeps): MainRedFixResult {
  return tx(db, () => {
    const prior = getEventByDedup(db, handledKey(project, f.runId, f.attempt));
    if (prior) return { outcome: "duplicate", text: prior.text, notify: null };
    const label = workflowOf(f.workflow).label, set = faultSet(f.checks);
    if (f.faultKey && mainCiApprovals(db, project, deps.repo).some((a) => a.binding.faultKey === f.faultKey)) {
      const text = `main ${label} 红（run ${f.runId}）：PM 已为同一故障绑定修复卡，不再写节点`;
      handled(db, ctx, project, f, "bound", text);
      return { outcome: "bound", text, notify: null };
    }
    const same = mainRedNodes(db, project).filter((n) => n.workflow === f.workflow && n.checks === set);
    const open = same.find((n) => nodeState(db, n).state === "open");
    if (open) {
      const card = nodeState(db, open).node?.taskId ?? null, text = `main ${label} 又红（run ${f.runId}），失败的 check 与修复节点 ${open.featureId}/${open.key} 相同，没写新节点`;
      insertEvent(db, { ...ctx, dedupKey: `main-red-fix:same:${project}:${f.runId}:${f.attempt}` }, { project, target: card ?? "", kind: "note", text,
        data: { op: "main_red_fix_same", featureId: open.featureId, key: open.key, runId: f.runId, url: f.url } }, true);
      handled(db, ctx, project, f, "same", text, { featureId: open.featureId, key: open.key });
      return { outcome: "same", text, notify: null };
    }
    // the same fault's failed fixes: newest first, cancelled / gone ones written since main was last green, until one that ended verified
    let failedBefore = 0;
    for (const n of same.filter((x) => x.runId > f.greenBefore).reverse()) {
      if (nodeState(db, n).state !== "failed") break;
      failedBefore++;
    }
    const { placed, misses: miss, content } = placeAndWrite(db, ctx, project, f, deps);
    if (placed) {
      insertEvent(db, { ...ctx, dedupKey: nodeKey(project, f.runId, f.attempt) }, { project, target: "", kind: "scheduler",
        text: `main ${label} 红：写了修复节点 ${placed.f.id}/${placed.key} 和规格 ${placed.taskId}`, data: { op: NODE_OP, source: SOURCE, workflow: f.workflow,
          checks: set, featureId: placed.f.id, key: placed.key, taskId: placed.taskId, faultKey: f.faultKey, runId: f.runId, mainSha: f.mainSha } }, true);
      const text = `main ${label} 红（run ${f.runId}）：写了修复节点 ${placed.f.id}/${placed.key}，规格 docs/tasks/${placed.taskId}.md 交自动开卡`;
      handled(db, ctx, project, f, "node", text, { featureId: placed.f.id, key: placed.key });
      // the spec file last: every ledger write above has gone through, so a failed transaction never leaves an orphan spec behind
      mkdirSync(dirname(placed.specPath), { recursive: true });
      writeFileSync(placed.specPath, placed.spec, { flag: "wx" });
      const notify = failedBefore >= MAIN_RED_FAIL_LIMIT ? `[main 红] ${project} 的 ${label} 同一故障修复卡已失败 ${failedBefore} 次，又写了 ${placed.f.id}/${placed.key}：请 PM 看一下 ${f.url}` : null;
      return { outcome: "node", text, notify, node: `${placed.f.id}/${placed.key}` };
    }
    const text = `main ${label} 红（run ${f.runId}）没写修复节点：${miss.join("；")}`;
    handled(db, ctx, project, f, content ? "refused" : "unplaced", text);
    return { outcome: content ? "refused" : "unplaced", text, notify: content ? null : `[main 红] ${project} 的 ${label} 修复节点兜底 feature 也写不进：${miss.join("；")} ${f.url}` };
  });
}

/**
 * mainRedRepairBind: a card this mechanism wrote, now at merge, main still the same fault. on = the same binding `ledger main-ci-repair`
 * writes (so `--revoke` undoes it), recorded for the feature PM and marked source=mainRedFix; observe = one note; off = nothing.
 */
export function bindMainRedRepair(db: Database, ctx: WriteCtx, input: { project: string; taskId: string; head: string; mainSha: string; faultKey: string },
  policy: RecoveryPolicyPort = recoveryPolicy): "bound" | "observed" | "off" {
  return tx(db, () => {
    const task = getTask(db, input.taskId);
    if (!task || task.project !== input.project || task.stage !== "merge") throw new LedgerError("conflict", `${input.taskId} 不在 merge`);
    if (task.headSHA?.toLowerCase() !== input.head.toLowerCase()) throw new LedgerError("conflict", `${task.id} 当前 head 不是 ${input.head}`);
    const mine = mainRedNodes(db, input.project).find((n) => n.featureId === task.featureId && nodeState(db, n).node?.taskId === task.id);
    if (!mine) throw new LedgerError("forbidden", `${task.id} 不是 mainRedFix 写的修复卡，不自动绑定`);
    if (db.query(`SELECT 1 FROM events WHERE project = ? AND target = ? AND kind = 'decision' AND json_extract(data, '$.op') = ? LIMIT 1`)
      .get(input.project, task.id, REVOKE_OP)) throw new LedgerError("conflict", `PM 撤销过 ${task.id} 的修复绑定，不再自动绑定`);
    if (!mine.faultKey || mine.faultKey !== input.faultKey) throw new LedgerError("conflict", `main 现在的故障与 ${task.id} 写节点时不同，不自动绑定`);
    const mode = policy(input.project, "mainRedRepairBind").mode;
    if (mode === "off") return "off";
    if (mode === "observe") {
      recordMainRedObserve(db, input.project, { workflow: "push", mainSha: input.mainSha, action: "bind", target: task.id,
        text: `为 mainRedFix 写的修复卡 ${task.id} 绑定主线 CI 修复（head ${input.head.slice(0, 12)}）`, data: { head: input.head, faultKey: input.faultKey } }, ctx.now ?? Date.now());
      return "observed";
    }
    const pm = featurePm(db, mine.featureId);
    if (!pm) throw new LedgerError("conflict", `feature ${mine.featureId} 没有能代记的 PM`);
    recordMainRedRepair(db, ctx, { project: input.project, taskId: task.id, head: input.head, mainSha: input.mainSha, faultKey: input.faultKey, pm, source: SOURCE,
      reason: `mainRedFix 写的修复卡，main 仍是写节点时的同一故障` });
    return "bound";
  });
}

// mainRedGreenRetire (main-red-fix-retire.ts lists the candidates): the planned node out of the sub-DAG, a bound card only a todo.
const RETIRE_KEY = "mainRedGreenRetire";
const RETIRED_OP = "main_red_fix_retired";
export const retireKey = (project: string, featureId: string, key: string) => `main-red-fix:retire:${project}:${featureId}:${key}`;
export const retireTodoKey = (project: string, featureId: string, key: string, what: string) => `main-red-fix:retire-${what}:${project}:${featureId}:${key}`;
export const retireObserveKey = (project: string, featureId: string, key: string) =>
  observeDedupKey({ project, mechanism: RETIRE_KEY, target: "", actionKey: `main-red:retire:${featureId}:${key}` });

export interface RetireInput { workflow: MainRedWorkflow; featureId: string; key: string; greenSha: string; greenRunId: number; url: string }
export interface RetireResult { outcome: "retired" | "bound" | "observed" | "off" | "refused" | "gone" | "duplicate"; text: string; notify: string | null }

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
      recordPmTodo(db, ctx, { project, target: s.node.taskId, kind: PM_TODO_KIND, text, dedupKey: retireTodoKey(project, i.featureId, i.key, "bound") });
      return { outcome: "bound", text, notify: null };
    }
    const why = `${green}：撤掉 mainRedFix 没开工的 main ${label} 修复节点 ${i.key}`;
    const miss = removeNode(db, ctx, project, i, why);
    if (miss) {
      const text = `main ${label} 修复节点 ${i.featureId}/${i.key}：${green}，但${miss}（${i.url}）`;
      recordPmTodo(db, ctx, { project, target: "", kind: PM_TODO_KIND, text, dedupKey: retireTodoKey(project, i.featureId, i.key, "refused") });
      return { outcome: "refused", text, notify: null };
    }
    const text = `[main 转绿] 从 ${i.featureId} 子 DAG 移出没开工的修复节点 ${i.key}：${green}（${i.url}）`;
    insertEvent(db, { ...ctx, dedupKey: `main-red-fix:retired:${project}:${i.featureId}:${i.key}` }, { project, target: "", kind: "scheduler", text,
      data: { op: RETIRED_OP, workflow: i.workflow, featureId: i.featureId, key: i.key, greenSha: i.greenSha, greenRunId: i.greenRunId, reason: why } }, true);
    return { outcome: "retired", text, notify: text };
  });
}
