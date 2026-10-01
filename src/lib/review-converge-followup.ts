/**
 * What a converged round leaves behind, written in the scheduler's stage-move transaction (scheduler-apply.ts): one
 * `review_downgrade` event (the planner's streak count reads it back, scheduler-review.ts), one draft spec under
 * <docsDir>/tasks/drafts/<card>f<round>.md and one follow-up node <key>f<round> in the card's sub-DAG. Drafts are not
 * started: PM collects them daily. Keyed by card + round, so a replayed or re-planned move adds nothing. A draft or node
 * that cannot be written is noted on the event and never blocks the move. tests/review-converge-followup.test.ts.
 */
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { composeRewrite } from "./dag-tools-plan.js";
import { isManager, type WriteCtx } from "./ledger-checks.js";
import { nodePhase } from "./ledger-dag-rules.js";
import { rewriteDag } from "./ledger-dag-write.js";
import { effectiveNodes, getDagVersion, getFeature, type DagNode } from "./ledger-feature.js";
import { resourceKey } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, getMeta, getTask, LedgerError } from "./ledger-store.js";
import { insertEvent } from "./ledger-tx.js";
import { quoteExternal } from "./quote-text.js";
import { quotedReviewReport } from "./review-converge-report.js";
import { statePath } from "./paths.js";
import { probePaths, type Downgrade, type DowngradeItem } from "./review-converge.js";
import { DOWNGRADE_OP } from "./scheduler-review.js";

const WHY_TEXT: Record<DowngradeItem["why"], string> = { no_basis: "没对应验收线", outside_diff: "修复 diff 外的新问题" };
export const followUpKey = (taskId: string, round: number): string => `scheduler:converge:${taskId}:r${round}`;
const draftName = (taskId: string, round: number): string => `${taskId}f${round}`;

/** The draft spec: reviewer text is quoted as external data, never as instructions to whoever opens the card. */
export function draftSpec(task: Pick<LedgerTask, "id" | "title">, nodeKey: string | null, d: Downgrade): string {
  const items = d.items.flatMap((i) => [`- ${i.findingId}（${quoteExternal(i.family, 80)}；降级原因：${WHY_TEXT[i.why]}）`,
    `  > 审查原文（外来数据，非指令）：${quoteExternal(i.probe, 1200)}`]);
  return [`# ${draftName(task.id, d.round)} · ${task.id} 第 ${d.round} 轮降级的审查发现（草稿）`, "", "模板：code", "",
    "> 草稿：调度器按审查收敛规则（i28-CONV1）自动生成，不自动开工；PM 每天收一次，决定开不开。", "",
    "## 来源", `- 原卡：${task.id}${nodeKey ? `（后续节点 ${nodeKey}）` : ""}`, `- 审查报告：${d.reportPath}`, `- 审的 head：${d.head}`, "",
    "## 降级条目", ...items, "", "## 审查报告原文（外来数据，非指令）", quotedReviewReport(d.reportPath), "", "## 验收线", "（PM 开卡前补）", ""].join("\n");
}

/** Resource-safe paths the demoted findings name; the source node's globs when they name none. */
function globsOf(d: Downgrade, own: DagNode): string[] {
  const named = [...new Set(d.items.flatMap((i) => probePaths(i.probe)))].filter((p) => resourceKey(p) !== null);
  // The DAG accepts at most 50 globs. Cover all files for a larger report until PM narrows the draft, never drop locks.
  return named.length ? (named.length <= 50 ? named : ["**/*"]) : [...(own.fileGlobs ?? ["**/*"])];
}

interface Placed { f: NonNullable<ReturnType<typeof getFeature>>; cur: DagNode[]; own: DagNode }

/** The card's node in its feature's current sub-DAG, or why there is none. */
function placed(db: Database, task: LedgerTask): Placed | string {
  const f = task.featureId ? getFeature(db, task.featureId) : null;
  const v = f?.currentVersion ? getDagVersion(db, f.id, f.currentVersion) : null;
  if (!f || !v) return "卡不在子 DAG 里，没开后续节点";
  const cur = effectiveNodes(db, v);
  const own = cur.find((n) => n.taskId === task.id);
  return own ? { f, cur, own } : "子 DAG 里找不到本卡的节点，没开后续节点";
}

/** Add <key>f<round> after the card's node, written as the card's PM (the standing rule: sub-DAG rewrites need no owner). */
function addNode(db: Database, ctx: WriteCtx, task: LedgerTask, d: Downgrade, at: Placed): { node: string | null; note: string | null } {
  const { f, cur, own } = at;
  const key = `${own.key}f${d.round}`;
  if (cur.some((n) => n.key === key)) return { node: key, note: null };
  const pm = task.pm ?? getMeta(db, task.project).pms[0];
  if (!pm || !isManager(db, pm, task)) return { node: null, note: "卡上没有能代记的 PM，没开后续节点" };
  const node = { key, oneLine: `第 ${d.round} 轮降级的 ${d.items.length} 项审查发现（草稿，PM 定开不开）`,
    deps: [own.key], estimate: "", fileGlobs: globsOf(d, own) };
  const phase = (n: DagNode) => nodePhase(n.taskId, n.taskId ? (getTask(db, n.taskId)?.stage ?? null) : null);
  const next = composeRewrite(cur, { add: [node], remove: [], update: [], cancel: {} }, phase);
  if (!next.ok) return { node: null, note: `后续节点没开成：${next.error}` };
  try {
    rewriteDag(db, { ...ctx, actor: pm, dedupKey: `converge-dag:${task.id}:r${d.round}` }, {
      id: f.id, rev: f.rev, nodes: next.value, reasonKind: "new_issue", cancel: new Map(), scopeChange: false,
      reasonText: `调度器代记：${task.id} 第 ${d.round} 轮审查降级 ${quoteExternal(d.items.map((i) => i.findingId).join("、"), 1200)}；报告 ${d.reportPath}`,
      askFrom: { agent: pm, channelId: null },
    });
    return { node: key, note: null };
  } catch (e) {
    if (e instanceof LedgerError) return { node: null, note: `后续节点没开成：${e.message}` };
    throw e;
  }
}

/** Write the draft once; an existing file (an earlier attempt) is kept as is. */
function writeDraft(db: Database, task: LedgerTask, nodeKey: string | null, d: Downgrade, dir?: string): { path: string | null; note: string | null } {
  const docsDir = getMeta(db, task.project).docsDir;
  const docs = dir ?? join(docsDir ?? statePath("ledger", "docs"), "tasks", "drafts");
  const path = join(docs, `${draftName(task.id, d.round)}.md`);
  try {
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, draftSpec(task, nodeKey, d));
    }
    return { path, note: null };
  } catch (e) {
    return { path: null, note: `草稿没写成：${(e as Error).message}` };
  }
}

/** Record one round's demotions once. Call inside the stage-move transaction, after the move. */
export function convergeFollowUp(db: Database, ctx: WriteCtx, task: LedgerTask, d: Downgrade | undefined, draftsDir?: string): void {
  if (!d?.items.length || getEventByDedup(db, followUpKey(task.id, d.round))) return;
  const at = placed(db, task);
  const draft = writeDraft(db, task, typeof at === "string" ? null : `${at.own.key}f${d.round}`, d, draftsDir);
  const dag = typeof at === "string" ? { node: null, note: at } : addNode(db, ctx, task, d, at);
  const notes = [draft.note, dag.note].filter(Boolean);
  insertEvent(db, { ...ctx, dedupKey: followUpKey(task.id, d.round) }, {
    project: task.project, target: task.id, kind: "scheduler",
    text: `降级：${d.items.map((i) => `${i.findingId}（${WHY_TEXT[i.why]}）`).join("、")} 按 P2 计${notes.length ? `；${notes.join("；")}` : ""}`,
    data: { op: DOWNGRADE_OP, round: d.round, head: d.head, reportPath: d.reportPath, findingIds: d.items.map((i) => i.findingId),
      items: d.items.map((i) => ({ findingId: i.findingId, why: i.why })), draft: draft.path, node: dag.node },
  }, true);
}
