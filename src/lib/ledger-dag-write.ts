/**
 * 子 DAG 的重写、审批与绑卡（T89 = 阶段 1 L2，设计稿 docs/design/feature-dag.md）。规则判定在 ledger-dag-rules.ts（纯函数）。
 * 不带 scopeChange 的重写（含改 / 取消进行中的节点）：直接写成新版本，结果里带一句 inform 给发起的 PM 看，不通知 owner；台账版本与事件照常可查。
 * 声明改 feature 范围或大改机制（scopeChange）：写成 pending 提案，开一张 owner 的 authorize ask，bind 到 {feature, version, 快照 sha256}；
 * dag-approve 核对 owner 本人批准、哈希按库里的提案行重算、四条规矩按那一刻的卡状态重判，全过才写版本；否则提案作废（这一笔照常提交）。
 * 审批 ask 的 fromAgent 是发起的 PM：owner 作答后 bridge 把答复投回它，由它跑 dag-approve。
 */
import { reasonOf } from "./shared-ledger-gate-reason.js";
import { requireLocalSharedLedgerPlanning } from "./shared-ledger-gate.js";
import type { Database } from "bun:sqlite";
import { bindHash, checkAsk } from "./ask-bind.js";
import { getAsk, openAskFull, ownerAnswered, type Ask } from "./ledger-asks.js";
import { mustTask, type WriteCtx, type WriteResult } from "./ledger-checks.js";
import { autostartGrant } from "./ledger-autostart-grant.js";
import { cardContext } from "./ledger-card-names.js";
import { diffNodes, nodePhase, proposalSha, type DagCancel, type ProposalContent } from "./ledger-dag-rules.js";
import {
  effectiveNodes, getDagVersion, getPendingProposal, getProposal, type DagNode, type DagProposal, type DagVersion, type Feature,
} from "./ledger-feature.js";
import { buildNodes, linkTasks, mustFeature, nodeTask, requireManager } from "./ledger-feature-write.js";
import type { LedgerEvent } from "./ledger-stages.js";
import { getTask, LedgerError } from "./ledger-store.js";
import { dropPageCheck, planPageRewrite, withPageCheck } from "./ui-acceptance.js";
import { insertEvent, replay, tx } from "./ledger-tx.js";

const DAG_ACTION = "dag_rewrite";
const APPROVE = "dag_rewrite_approve";
const REJECT = "dag_rewrite_reject";
/** owner 可能隔几天才看：审批窗口给满 7 天（ask-check 从开出算，答了也不延长） */
const ASK_TTL_MS = 7 * 24 * 3600_000;

const ops = (...names: string[]) => (prev: LedgerEvent) => names.includes(String(prev.data.op));

function currentDag(db: Database, f: Feature): { version: number; nodes: DagNode[] } {
  const v = f.currentVersion ? getDagVersion(db, f.id, f.currentVersion) : null;
  if (!v) throw new LedgerError("invalid", `feature ${f.id} 还没建 DAG（先 dag-init）`);
  return { version: v.version, nodes: effectiveNodes(db, v) };
}

const livePhase = (db: Database) => (n: DagNode) => nodePhase(n.taskId, n.taskId ? (getTask(db, n.taskId)?.stage ?? null) : null);

function checkCas(f: Feature, rev: number): void {
  if (f.rev !== rev) throw new LedgerError("conflict", `feature ${f.id} 已被改过：当前 rev ${f.rev}，你带的是 ${rev}`, { rev: f.rev });
}

/** 写新版本：换绑卡（移出去的卡清 featureId、新卡挂上，各 rev + 1 附 task 事件）、推 currentVersion 与 rev */
function applyVersion(db: Database, ctx: WriteCtx, f: Feature, c: ProposalContent, who: { proposedBy: string; approvedBy: string; askId: string | null }): number {
  const now = ctx.now ?? Date.now();
  db.prepare(`INSERT INTO dag_versions (featureId, version, reasonKind, reasonText, proposedBy, approvedBy, createdAt, nodes, cancels, scopeChange, askId)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(f.id, c.version, c.reasonKind, c.reasonText, who.proposedBy, who.approvedBy, now,
    JSON.stringify(c.nodes), JSON.stringify(c.cancels), c.scopeChange ? 1 : 0, who.askId);
  const kept = new Set(c.nodes.map((n) => n.taskId).filter(Boolean));
  for (const n of currentDag(db, f).nodes) {
    const t = n.taskId && !kept.has(n.taskId) ? getTask(db, n.taskId) : null;
    if (!t || t.featureId !== f.id) continue;
    db.prepare("UPDATE tasks SET featureId = NULL, rev = ?, updatedAt = ? WHERE id = ?").run(t.rev + 1, now, t.id);
    insertEvent(db, ctx, { project: t.project, target: t.id, kind: "task", data: { op: "set", patch: { featureId: null }, rev: t.rev + 1 } }, false);
  }
  linkTasks(db, ctx, f, c.nodes);
  const rev = f.rev + 1;
  db.prepare("UPDATE features SET currentVersion = ?, rev = ?, updatedAt = ? WHERE id = ?").run(c.version, rev, now, f.id);
  return rev;
}

function summary(cur: readonly DagNode[], c: ProposalContent): string {
  const d = diffNodes(cur, c.nodes, c.cancels);
  const part = (label: string, xs: string[]) => (xs.length ? `${label} ${xs.join(", ")}` : "");
  return [part("新增", d.added), part("移出", d.removed), part("改动", d.carried.filter((x) => x.changed).map((x) => x.key)),
    part("取消", d.cancelled.map((x) => `${x.key}（${x.reason}）`))].filter(Boolean).join("；") || "无节点变化";
}

export interface RewriteInput {
  id: string;
  rev: number;
  nodes: unknown;
  reasonKind: string;
  reasonText: string;
  /** 节点 key → 取消原因 */
  cancel: ReadonlyMap<string, string>;
  scopeChange: boolean;
  /** 审批 ask 回投给谁：发起的 agent 与它的频道（查不到频道时答复会落到大总管） */
  askFrom: { agent: string; channelId: string | null };
}

export interface RewriteOutcome {
  /** 直接生效的新版本；要批的为 null */
  version: DagVersion | null;
  proposal: DagProposal | null;
  ask: Ask | null;
  /** 直接生效时的一句变化摘要，回给调用方（PM）；不发给 owner */
  inform: string | null;
}

/** 已答复且是 owner 本人点了批准：先 dag-approve，不许被新的重写顶掉 */
const approvedAsk = (a: Ask) => a.state === "answered" && ownerAnswered(a.answer) && (a.answer?.choices ?? []).includes(`[button:${APPROVE}]`);

/** 已有 pending：ask 还开着、或 owner 已批且授权没过期（checkAsk 同样按开出时的 expiresAt 算）→ conflict；其余 → 这份作废，让位给新的 */
function clearStalePending(db: Database, ctx: WriteCtx, f: Feature, now: number): void {
  const p = getPendingProposal(db, f.id);
  if (!p) return;
  const a = getAsk(db, p.askId);
  if (a && a.expiresAt > now && (a.state === "open" || approvedAsk(a))) {
    throw new LedgerError("conflict", `feature ${f.id} 已有待批的 v${p.version}（ask ${a.id}${a.state === "open" ? " 还没答" : " owner 已批，先 dag-approve"}）`, { pending: p.version, askId: a.id });
  }
  closeProposal(db, ctx, f, p, "void", `审批 ask ${a ? (a.expiresAt > now ? a.state : "已过期") : "不见了"}，被新的重写取代`, false);
}

/** primary=false：顺带作废时 dedupKey 留给这一笔的主动作（重写 / 提案），否则两条主事件抢同一个键、整笔回滚 */
function closeProposal(db: Database, ctx: WriteCtx, f: Feature, p: DagProposal, state: "rejected" | "void", note: string, primary: boolean): LedgerEvent {
  db.prepare("UPDATE dag_proposals SET state = ?, decidedAt = ?, decidedBy = ?, decisionNote = ? WHERE seq = ?").run(state, ctx.now ?? Date.now(), ctx.actor, note, p.seq);
  const data = { op: `dag-${state === "void" ? "void" : "reject"}`, version: p.version, proposal: p.seq };
  return insertEvent(db, ctx, { project: f.project, target: f.id, kind: "feature", text: note, data }, primary);
}

function openApproval(db: Database, f: Feature, c: ProposalContent, sha: string, why: string[], from: RewriteInput["askFrom"], now: number): Ask {
  const bind = { action: DAG_ACTION, params: { feature: f.id, version: c.version, sha }, approve: [APPROVE] };
  return openAskFull(db, {
    project: f.project, source: "system", kind: "authorize", fromAgent: from.agent, fromChannelId: from.channelId, createdBy: `system:${from.agent}`,
    blocking: true, title: `${f.title}：子 DAG 重写成 v${c.version} 要你批`, context: why.join("；"),
    body: [`原因（${c.reasonKind}）：${c.reasonText}`, `变化：${summary(currentDag(db, f).nodes, c)}`, `快照 sha256 ${sha.slice(0, 12)}`].join("\n"),
    options: [{ type: "buttons", buttons: [{ id: APPROVE, label: "批准", style: "success" }, { id: REJECT, label: "驳回", style: "danger" }] }],
    askKey: `${DAG_ACTION}:${f.id}`, expiresAt: now + ASK_TTL_MS, bind: { ...bind, paramsHash: bindHash(bind, from.agent) },
  }, now).ask;
}

const informOf = (f: Feature, v: Pick<DagVersion, "version" | "reasonKind" | "reasonText">, change: string) =>
  `${f.title}：子 DAG 已重写成 v${v.version}（${v.reasonKind}：${v.reasonText}）。${change}`;

/** 重放按命中的那条事件还原当时的结果（待批的仍是待批、原来的 ask），不拿此刻的当前版本 / 最新提案去拼 */
function rewriteReplayed(db: Database, f: Feature, e: LedgerEvent): RewriteOutcome {
  if (e.data.op === "dag-propose") return { version: null, proposal: getProposal(db, Number(e.data.proposal)), ask: getAsk(db, String(e.data.askId)), inform: null };
  const v = getDagVersion(db, f.id, Number(e.data.version));
  return { version: v, proposal: null, ask: null, inform: v ? informOf(f, v, e.text) : null };
}

export function rewriteDag(db: Database, ctx: WriteCtx, input: RewriteInput): WriteResult<RewriteOutcome> {
  return tx(db, () => {
    const f = mustFeature(db, input.id);
    requireLocalSharedLedgerPlanning(f.id);
    const key = { project: f.project, target: f.id, kind: "feature" as const };
    const dup = replay(db, ctx, key, () => null, ops("dag-rewrite", "dag-propose"));
    if (dup) return { ...dup, row: rewriteReplayed(db, f, dup.event) };
    requireManager(db, ctx.actor, f.project);
    const cur = currentDag(db, f);
    checkCas(f, input.rev);
    const now = ctx.now ?? Date.now();
    clearStalePending(db, ctx, f, now);
    const plan = planPageRewrite(cur, livePhase(db), withPageCheck(db, f, buildNodes(db, f, dropPageCheck(input.nodes)), cur.nodes),
      input.cancel, input.scopeChange, cardContext(db, f));
    const c: ProposalContent = { featureId: f.id, version: cur.version + 1, baseVersion: cur.version, ...reasonOf(input.reasonKind, input.reasonText),
      nodes: plan.nodes, cancels: plan.cancels, scopeChange: input.scopeChange };
    const change = summary(cur.nodes, c);
    if (!plan.needsOwner.length) {
      const rev = applyVersion(db, ctx, f, c, { proposedBy: ctx.actor, approvedBy: "auto", askId: null });
      const event = insertEvent(db, ctx, { ...key, text: change, data: { op: "dag-rewrite", version: c.version, reasonKind: c.reasonKind, auto: true, uiPageCheck: true, rev } }, true);
      return { row: { version: getDagVersion(db, f.id, c.version), proposal: null, ask: null, inform: informOf(f, c, change) }, event, duplicate: false };
    }
    const sha = proposalSha(c);
    const ask = openApproval(db, f, c, sha, plan.needsOwner, input.askFrom, now);
    const seq = db.prepare(`INSERT INTO dag_proposals (featureId, version, baseVersion, reasonKind, reasonText, proposedBy, nodes, cancels, scopeChange, sha, askId, createdAt, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending') RETURNING seq`).get(f.id, c.version, c.baseVersion, c.reasonKind, c.reasonText, ctx.actor,
      JSON.stringify(c.nodes), JSON.stringify(c.cancels), c.scopeChange ? 1 : 0, sha, ask.id, now) as { seq: number };
    const rev = f.rev + 1;
    db.prepare("UPDATE features SET rev = ?, updatedAt = ? WHERE id = ?").run(rev, now, f.id);
    const data = { op: "dag-propose", version: c.version, proposal: seq.seq, askId: ask.id, sha, needsOwner: plan.needsOwner, rev };
    const event = insertEvent(db, ctx, { ...key, text: change, data }, true);
    return { row: { version: null, proposal: getProposal(db, seq.seq), ask, inform: null }, event, duplicate: false };
  });
}

const contentOf = (p: DagProposal): ProposalContent => ({ featureId: p.featureId, version: p.version, baseVersion: p.baseVersion, reasonKind: p.reasonKind,
  reasonText: p.reasonText, nodes: p.nodes, cancels: p.cancels, scopeChange: p.scopeChange });

/** 为什么这份提案批不了；null = 可以生效。哈希按库里的提案行重算：快照被换过就对不上 */
function approvalProblem(db: Database, f: Feature, p: DagProposal, a: Ask | null, now: number): { state: "rejected" | "void"; why: string } | null {
  if (!a) return { state: "void", why: `审批 ask ${p.askId} 不见了` };
  if (a.state !== "answered") return { state: "void", why: `审批 ask ${a.id} 已${a.state === "open" ? "过期" : a.state}` };
  if (!ownerAnswered(a.answer)) return { state: "void", why: `ask ${a.id} 不是 owner 本人作答` };
  if (!approvedAsk(a)) return { state: "rejected", why: `owner 驳回：${(a.answer?.labels ?? []).join("；") || a.answer?.text || "没选批准"}` };
  const bind = { action: DAG_ACTION, params: { feature: f.id, version: p.version, sha: proposalSha(contentOf(p)) } };
  const check = checkAsk(a, bindHash(bind, a.fromAgent ?? ""), a.fromAgent ?? "", now);
  if (!check.ok || a.bind?.action !== DAG_ACTION) return { state: "void", why: check.ok ? "ask 不是子 DAG 重写的授权" : check.reason };
  if (f.currentVersion !== p.baseVersion) return { state: "void", why: `当前版本已是 v${f.currentVersion}，提案基于 v${p.baseVersion}` };
  try {
    const cancel = new Map(p.cancels.map((x: DagCancel) => [x.key, x.reason]));
    const input = p.nodes.map(({ key, taskId, oneLine, deps, estimate, fileGlobs }) => ({ key, taskId, oneLine, deps, estimate, fileGlobs }));
    planPageRewrite(currentDag(db, f), livePhase(db), buildNodes(db, f, input), cancel, p.scopeChange, cardContext(db, f));
  } catch (e) {
    if (e instanceof LedgerError) return { state: "void", why: `卡的状态变了，按现在的规矩不成立：${e.message}` };
    throw e;
  }
  return null;
}

export interface ApproveOutcome {
  applied: boolean;
  version: DagVersion | null;
  proposal: DagProposal;
  why: string | null;
}

export function approveDag(db: Database, ctx: WriteCtx, input: { id: string }): WriteResult<ApproveOutcome> {
  return tx(db, () => {
    const f = mustFeature(db, input.id);
    requireLocalSharedLedgerPlanning(f.id);
    const key = { project: f.project, target: f.id, kind: "feature" as const };
    // 重放按事件记下的提案还原，不取最新一份：之后可能又有新的提案
    const dup = replay(db, ctx, key, () => null, ops("dag-approve", "dag-reject", "dag-void"));
    if (dup) {
      const proposal = getProposal(db, Number(dup.event.data.proposal)) as DagProposal;
      const applied = dup.event.data.op === "dag-approve";
      return { ...dup, row: { applied, version: applied ? getDagVersion(db, f.id, proposal.version) : null, proposal, why: proposal.decisionNote } };
    }
    requireManager(db, ctx.actor, f.project);
    const p = getPendingProposal(db, f.id);
    if (!p) throw new LedgerError("not_found", `feature ${f.id} 没有待批的重写`);
    const a = getAsk(db, p.askId);
    const now = ctx.now ?? Date.now();
    if (a?.state === "open" && a.expiresAt > now) throw new LedgerError("conflict", `ask ${a.id} owner 还没答`, { askId: a.id });
    const bad = approvalProblem(db, f, p, a, now);
    if (bad) {
      const event = closeProposal(db, ctx, f, p, bad.state, bad.why, true);
      return { row: { applied: false, version: null, proposal: getProposal(db, p.seq) as DagProposal, why: bad.why }, event, duplicate: false };
    }
    const approvedBy = (a as Ask).answer?.principal || "owner";
    const rev = applyVersion(db, ctx, f, contentOf(p), { proposedBy: p.proposedBy, approvedBy, askId: p.askId });
    db.prepare("UPDATE dag_proposals SET state = 'approved', decidedAt = ?, decidedBy = ? WHERE seq = ?").run(now, approvedBy, p.seq);
    const event = insertEvent(db, ctx, { ...key, data: { op: "dag-approve", version: p.version, proposal: p.seq, askId: p.askId, approvedBy, uiPageCheck: true, rev } }, true);
    return { row: { applied: true, version: getDagVersion(db, f.id, p.version), proposal: getProposal(db, p.seq) as DagProposal, why: null }, event, duplicate: false };
  });
}

/** 计划节点开工绑卡：不产生新版本，写 dag_bindings + 事件，卡挂上 featureId。节点要在当前版本、还没绑；卡同项目、不属于别的 feature、不在本图别的节点上 */
export function bindNode(db: Database, ctx: WriteCtx, input: { id: string; rev: number; key: string; taskId: string }): WriteResult<DagNode> {
  return tx(db, () => {
    const f = mustFeature(db, input.id);
    requireLocalSharedLedgerPlanning(f.id);
    const key = { project: f.project, target: f.id, kind: "feature" as const };
    const load = () => currentDag(db, mustFeature(db, f.id)).nodes.find((n) => n.key === input.key) as DagNode;
    const dup = replay(db, ctx, key, load, ops("dag-bind"));
    if (dup) return dup;
    if (!autostartGrant(ctx, input.taskId, { featureId: f.id, key: input.key })) requireManager(db, ctx.actor, f.project);
    const cur = currentDag(db, f);
    checkCas(f, input.rev);
    const node = cur.nodes.find((n) => n.key === input.key);
    if (!node) throw new LedgerError("not_found", `v${cur.version} 里没有节点 ${input.key}`);
    if (node.taskId) throw new LedgerError("conflict", `节点 ${input.key} 已绑 ${node.taskId}，换卡要重写`, { taskId: node.taskId });
    const task = nodeTask(db, f, input.key, input.taskId) ?? mustTask(db, input.taskId);
    const other = cur.nodes.find((n) => n.taskId === task.id);
    if (other) throw new LedgerError("conflict", `任务 ${task.id} 已在节点 ${other.key} 上`, { key: other.key });
    const now = ctx.now ?? Date.now();
    db.prepare("INSERT INTO dag_bindings (featureId, version, nodeKey, taskId, boundBy, boundAt) VALUES (?, ?, ?, ?, ?, ?)").run(f.id, cur.version, node.key, task.id, ctx.actor, now);
    linkTasks(db, ctx, f, [{ ...node, taskId: task.id }]);
    const rev = f.rev + 1;
    db.prepare("UPDATE features SET rev = ?, updatedAt = ? WHERE id = ?").run(rev, now, f.id);
    const event = insertEvent(db, ctx, { ...key, data: { op: "dag-bind", version: cur.version, key: node.key, taskId: task.id, rev } }, true);
    return { row: load(), event, duplicate: false };
  });
}
