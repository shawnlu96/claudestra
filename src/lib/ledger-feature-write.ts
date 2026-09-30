/**
 * feature 与子 DAG 的写入（T84 = 阶段 1 L1，设计稿 docs/design/feature-dag.md）：建 feature、改 feature、建 DAG 初版。
 * 每个导出函数一个 BEGIN IMMEDIATE 事务，改行与一条 feature 事件（target = feature id）同进同出；改字段带 rev（CAS），
 * dedupKey 与其它写入同一套（ledger-tx.ts）。只有项目 PM 名单里的人、master、owner 能写。
 * initDag 只建 v1：已有任何版本就拒绝——v2 起是「重写」，要原因与批准，属于 L2，不从这里开口子。
 */
import type { Database } from "bun:sqlite";
import { isManager, mustTask, type WriteCtx, type WriteResult } from "./ledger-checks.js";
import { DAG_REASON_KINDS, FEATURE_STATUSES, type FeatureStatus } from "./ledger-feature-schema.js";
import { getFeature, type DagNode, type DagVersion, type Feature, getDagVersion } from "./ledger-feature.js";
import { ledgerOrigin } from "./ledger-origin.js";
import type { LedgerEvent } from "./ledger-stages.js";
import { LedgerError } from "./ledger-store.js";
import { insertEvent, replay, tx } from "./ledger-tx.js";

export const FEATURE_TITLE_MAX = 60;
export const NODE_LINE_MAX = 60;
export const NODE_ESTIMATE_MAX = 20;
export const DAG_NODES_MAX = 200;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

export interface FeaturePatch {
  title?: string;
  ownerWords?: string;
  status?: FeatureStatus;
}

export interface NewFeature extends FeaturePatch {
  project: string;
  /** 本机内的短名；落库的 id = 「本机前缀-slug」 */
  slug: string;
  title: string;
}

/** 节点输入：id 是本项目已有的任务卡；oneLine 缺省取任务标题 */
export interface NodeInput {
  id: string;
  oneLine?: string;
  deps?: string[];
  estimate?: string;
}

/** 一行字：换行 / 控制字符 / 不可见格式符会让看板和 CLI 的单行显示错乱，也能藏东西 */
function line(v: unknown, what: string, max: number, required: boolean): string {
  if (v === undefined && !required) return "";
  if (typeof v !== "string") throw new LedgerError("invalid", `${what}要是字符串`);
  const s = v.trim();
  if (required && !s) throw new LedgerError("invalid", `${what}不能为空`);
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(s)) throw new LedgerError("invalid", `${what}只能是一行，不能含换行、控制字符或不可见字符`);
  if ([...s].length > max) throw new LedgerError("invalid", `${what}不超过 ${max} 字，现在 ${[...s].length} 字`);
  return s;
}

function requireManager(db: Database, actor: string, project: string): void {
  if (!isManager(db, actor, { project, agent: null })) throw new LedgerError("forbidden", `只有项目 ${project} 的 PM / master / owner 能改 feature（你是 ${actor}）`);
}

function mustFeature(db: Database, id: string): Feature {
  const f = getFeature(db, id);
  if (!f) throw new LedgerError("not_found", `没有 feature ${id}`);
  return f;
}

/** 标题在项目内唯一（跨项目不管：验收线允许） */
function checkTitleFree(db: Database, project: string, title: string, self: string | null): void {
  const hit = db.prepare("SELECT id FROM features WHERE project = ? AND title = ? AND id IS NOT ?").get(project, title, self) as { id: string } | null;
  if (hit) throw new LedgerError("conflict", `项目 ${project} 里已有同名 feature ${hit.id}`, { id: hit.id });
}

function checkPatch(p: FeaturePatch): FeaturePatch {
  const out: FeaturePatch = {};
  if (p.title !== undefined) out.title = line(p.title, "feature 名字", FEATURE_TITLE_MAX, true);
  if (p.ownerWords !== undefined) out.ownerWords = String(p.ownerWords);
  if (p.status !== undefined) {
    if (!FEATURE_STATUSES.includes(p.status)) throw new LedgerError("invalid", `feature 状态只能是 ${FEATURE_STATUSES.join(" / ")}，收到 ${String(p.status)}`);
    out.status = p.status;
  }
  return out;
}

const sameOp = (op: string) => (prev: LedgerEvent) => prev.data.op === op;

export function createFeature(db: Database, ctx: WriteCtx, input: NewFeature): WriteResult<Feature> {
  return tx(db, () => {
    if (!SLUG.test(input.slug)) throw new LedgerError("invalid", "feature id 只能是字母数字开头、≤40 位的字母 / 数字 / - / _");
    const origin = ledgerOrigin(db);
    if (!origin) throw new LedgerError("invalid", "取不到本机前缀（状态目录的 instance-id 读写失败），不建 feature");
    const id = `${origin}-${input.slug}`;
    const key = { project: input.project, target: id, kind: "feature" as const };
    const dup = replay(db, ctx, key, () => mustFeature(db, id), sameOp("new"));
    if (dup) return dup;
    requireManager(db, ctx.actor, input.project);
    const cur = getFeature(db, id);
    if (cur) throw new LedgerError("conflict", `feature ${id} 已存在`, { rev: cur.rev });
    const patch = checkPatch({ title: input.title, ownerWords: input.ownerWords ?? "", status: input.status ?? "active" });
    checkTitleFree(db, input.project, patch.title as string, null);
    const now = ctx.now ?? Date.now();
    db.prepare("INSERT INTO features (id, project, title, ownerWords, status, currentVersion, rev, createdBy, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?, ?)")
      .run(id, input.project, patch.title as string, patch.ownerWords as string, patch.status as string, ctx.actor, now, now);
    const event = insertEvent(db, ctx, { ...key, text: patch.title, data: { op: "new", patch, rev: 1 } }, true);
    return { row: mustFeature(db, id), event, duplicate: false };
  });
}

export function setFeature(db: Database, ctx: WriteCtx, input: { id: string; rev: number; patch: FeaturePatch }): WriteResult<Feature> {
  return tx(db, () => {
    const cur = mustFeature(db, input.id);
    const key = { project: cur.project, target: cur.id, kind: "feature" as const };
    const dup = replay(db, ctx, key, () => mustFeature(db, cur.id), sameOp("set"));
    if (dup) return dup;
    requireManager(db, ctx.actor, cur.project);
    if (cur.rev !== input.rev) throw new LedgerError("conflict", `feature ${cur.id} 已被改过：当前 rev ${cur.rev}，你带的是 ${input.rev}`, { rev: cur.rev });
    const patch = checkPatch(input.patch);
    const cols = Object.keys(patch) as (keyof FeaturePatch)[];
    if (!cols.length) throw new LedgerError("invalid", "没有要改的字段（--title / --words / --status）");
    if (patch.title !== undefined) checkTitleFree(db, cur.project, patch.title, cur.id);
    const rev = cur.rev + 1;
    db.prepare(`UPDATE features SET ${cols.map((c) => `${c} = ?`).join(", ")}, rev = ?, updatedAt = ? WHERE id = ?`)
      .run(...cols.map((c) => patch[c] as string), rev, ctx.now ?? Date.now(), cur.id);
    const event = insertEvent(db, ctx, { ...key, data: { op: "set", patch, rev } }, true);
    return { row: mustFeature(db, cur.id), event, duplicate: false };
  });
}

/** 依赖只能指向同一版里的节点、不许自环、不许成环（Kahn：剩下排不出去的就在环上） */
function checkAcyclic(nodes: readonly DagNode[]): void {
  const indeg = new Map(nodes.map((n) => [n.id, n.deps.length]));
  const out = new Map<string, string[]>();
  for (const n of nodes) for (const d of n.deps) out.set(d, [...(out.get(d) ?? []), n.id]);
  const queue = nodes.filter((n) => n.deps.length === 0).map((n) => n.id);
  for (let i = 0; i < queue.length; i++) {
    for (const next of out.get(queue[i]) ?? []) {
      const left = (indeg.get(next) as number) - 1;
      indeg.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  if (queue.length < nodes.length) throw new LedgerError("invalid", `节点依赖成环：${nodes.filter((n) => !queue.includes(n.id)).map((n) => n.id).join(", ")}`);
}

/** 校验节点输入并补成快照：任务卡要在本项目、不属于别的 feature；status 取此刻的 stage */
export function buildNodes(db: Database, feature: Pick<Feature, "id" | "project">, raw: unknown): DagNode[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new LedgerError("invalid", "--nodes 要是非空 JSON 数组");
  if (raw.length > DAG_NODES_MAX) throw new LedgerError("invalid", `一版最多 ${DAG_NODES_MAX} 个节点，收到 ${raw.length}`);
  const seen = new Set<string>();
  const nodes = raw.map((x: unknown): DagNode => {
    if (!x || typeof x !== "object" || Array.isArray(x)) throw new LedgerError("invalid", "每个节点要是对象 {id, oneLine?, deps?, estimate?}");
    const n = x as Record<string, unknown>;
    if (typeof n.id !== "string" || !n.id) throw new LedgerError("invalid", "节点缺 id（任务卡 id）");
    if (seen.has(n.id)) throw new LedgerError("invalid", `节点 ${n.id} 重复`);
    seen.add(n.id);
    const task = mustTask(db, n.id);
    if (task.project !== feature.project) throw new LedgerError("invalid", `任务 ${n.id} 在项目 ${task.project}，feature 在 ${feature.project}`);
    if (task.featureId && task.featureId !== feature.id) throw new LedgerError("conflict", `任务 ${n.id} 已属于 feature ${task.featureId}`, { featureId: task.featureId });
    if (n.deps !== undefined && !(Array.isArray(n.deps) && n.deps.every((d) => typeof d === "string"))) throw new LedgerError("invalid", `节点 ${n.id} 的 deps 要是字符串数组`);
    const deps = [...new Set((n.deps as string[] | undefined) ?? [])];
    const oneLine = n.oneLine === undefined ? task.title : line(n.oneLine, `节点 ${n.id} 的一句话`, NODE_LINE_MAX, true);
    return { id: n.id, oneLine, deps, status: task.stage, estimate: line(n.estimate, `节点 ${n.id} 的粗估`, NODE_ESTIMATE_MAX, false), inheritedFrom: null };
  });
  for (const n of nodes) {
    for (const d of n.deps) if (d === n.id || !seen.has(d)) throw new LedgerError("invalid", `节点 ${n.id} 的依赖 ${d} ${d === n.id ? "是它自己" : "不在这一版的节点里"}`);
  }
  checkAcyclic(nodes);
  return nodes;
}

/** 节点任务卡挂上 featureId：每张卡 rev + 1、附一条 task 事件（和 task-set 的事件同形），依赖任务 rev 的 CAS 能看到这次改动 */
function linkTasks(db: Database, ctx: WriteCtx, feature: Feature, nodes: readonly DagNode[]): void {
  for (const n of nodes) {
    const t = mustTask(db, n.id);
    if (t.featureId === feature.id) continue;
    const rev = t.rev + 1;
    db.prepare("UPDATE tasks SET featureId = ?, rev = ?, updatedAt = ? WHERE id = ?").run(feature.id, rev, ctx.now ?? Date.now(), t.id);
    insertEvent(db, ctx, { project: t.project, target: t.id, kind: "task", data: { op: "set", patch: { featureId: feature.id }, rev } }, false);
  }
}

export function initDag(db: Database, ctx: WriteCtx, input: { id: string; rev: number; nodes: unknown; reasonText?: string }): WriteResult<DagVersion> {
  return tx(db, () => {
    const cur = mustFeature(db, input.id);
    const key = { project: cur.project, target: cur.id, kind: "feature" as const };
    const dup = replay(db, ctx, key, () => getDagVersion(db, cur.id, 1) as DagVersion, sameOp("dag-init"));
    if (dup) return dup;
    requireManager(db, ctx.actor, cur.project);
    const has = db.prepare("SELECT MAX(version) AS v FROM dag_versions WHERE featureId = ?").get(cur.id) as { v: number | null };
    if (cur.currentVersion !== 0 || has.v !== null) {
      throw new LedgerError("conflict", `feature ${cur.id} 已有 v${Math.max(cur.currentVersion, has.v ?? 0)}：dag-init 只建初版，v2 起是重写（L2，要原因与批准）`, { currentVersion: cur.currentVersion });
    }
    if (cur.rev !== input.rev) throw new LedgerError("conflict", `feature ${cur.id} 已被改过：当前 rev ${cur.rev}，你带的是 ${input.rev}`, { rev: cur.rev });
    const nodes = buildNodes(db, cur, input.nodes);
    const reasonText = input.reasonText === undefined ? "" : String(input.reasonText);
    const now = ctx.now ?? Date.now();
    db.prepare("INSERT INTO dag_versions (featureId, version, reasonKind, reasonText, proposedBy, approvedBy, createdAt, nodes) VALUES (?, 1, ?, ?, ?, NULL, ?, ?)")
      .run(cur.id, DAG_REASON_KINDS[0], reasonText, ctx.actor, now, JSON.stringify(nodes));
    const rev = cur.rev + 1;
    db.prepare("UPDATE features SET currentVersion = 1, rev = ?, updatedAt = ? WHERE id = ?").run(rev, now, cur.id);
    linkTasks(db, ctx, cur, nodes);
    const event = insertEvent(db, ctx, { ...key, data: { op: "dag-init", version: 1, nodes: nodes.map((n) => n.id), rev } }, true);
    return { row: getDagVersion(db, cur.id, 1) as DagVersion, event, duplicate: false };
  });
}
