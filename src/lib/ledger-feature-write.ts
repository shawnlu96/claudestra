/**
 * feature 与子 DAG 的写入（T84 = 阶段 1 L1，设计稿 docs/design/feature-dag.md）：建 feature、改 feature、建 DAG 初版。
 * 每个导出函数一个 BEGIN IMMEDIATE 事务，改行与一条 feature 事件（target = feature id）同进同出；改字段带 rev（CAS），
 * dedupKey 与其它写入同一套（ledger-tx.ts）。只有项目 PM 名单里的人、master、owner 能写。
 * initDag 只建 v1：已有任何版本就拒绝——v2 起只能走 ledger-dag-write.ts 的重写（四条规矩 + owner 审批），不从这里开口子。
 */
import type { Database } from "bun:sqlite";
import { isManager, mustTask, type WriteCtx, type WriteResult } from "./ledger-checks.js";
import { DAG_REASON_KINDS, FEATURE_STATUSES, type FeatureStatus } from "./ledger-feature-schema.js";
import { getDagVersion, getFeature, PLANNED, type DagNode, type DagVersion, type Feature } from "./ledger-feature.js";
import { ledgerOrigin } from "./ledger-origin.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { LedgerError } from "./ledger-store.js";
import { insertEvent, replay, tx } from "./ledger-tx.js";

const FEATURE_TITLE_MAX = 60;
const NODE_LINE_MAX = 60;
const NODE_ESTIMATE_MAX = 20;
const DAG_NODES_MAX = 200;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const NODE_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

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

export function requireManager(db: Database, actor: string, project: string): void {
  if (!isManager(db, actor, { project, agent: null })) throw new LedgerError("forbidden", `只有项目 ${project} 的 PM / master / owner 能改 feature（你是 ${actor}）`);
}

export function mustFeature(db: Database, id: string): Feature {
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
  const indeg = new Map(nodes.map((n) => [n.key, n.deps.length]));
  const out = new Map<string, string[]>();
  for (const n of nodes) for (const d of n.deps) out.set(d, [...(out.get(d) ?? []), n.key]);
  const queue = nodes.filter((n) => n.deps.length === 0).map((n) => n.key);
  for (let i = 0; i < queue.length; i++) {
    for (const next of out.get(queue[i]) ?? []) {
      const left = (indeg.get(next) as number) - 1;
      indeg.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  if (queue.length < nodes.length) throw new LedgerError("invalid", `节点依赖成环：${nodes.filter((n) => !queue.includes(n.key)).map((n) => n.key).join(", ")}`);
}

/** 节点的任务卡：要在本项目、不属于别的 feature；没绑卡返回 null */
export function nodeTask(db: Database, feature: Pick<Feature, "id" | "project">, key: string, raw: unknown): LedgerTask | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || !raw) throw new LedgerError("invalid", `节点 ${key} 的 taskId 要是任务卡 id 或 null`);
  const task = mustTask(db, raw);
  if (task.project !== feature.project) throw new LedgerError("invalid", `任务 ${raw} 在项目 ${task.project}，feature 在 ${feature.project}`);
  if (task.featureId && task.featureId !== feature.id) throw new LedgerError("conflict", `任务 ${raw} 已属于 feature ${task.featureId}`, { featureId: task.featureId });
  return task;
}

/** 校验一个节点输入并补成快照：status 取此刻的 stage，没卡为 planned */
function buildNode(db: Database, feature: Pick<Feature, "id" | "project">, x: unknown): DagNode {
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new LedgerError("invalid", "每个节点要是对象 {key?, taskId?, oneLine?, deps?, estimate?}");
  const n = x as Record<string, unknown>;
  const key = n.key ?? n.taskId;
  if (typeof key !== "string" || !NODE_KEY.test(key)) throw new LedgerError("invalid", "节点要有 key（字母数字开头、≤40 位；有 taskId 时缺省取它）");
  const task = nodeTask(db, feature, key, n.taskId);
  if (n.deps !== undefined && !(Array.isArray(n.deps) && n.deps.every((d) => typeof d === "string"))) throw new LedgerError("invalid", `节点 ${key} 的 deps 要是字符串数组`);
  const oneLine = n.oneLine === undefined && task ? task.title : line(n.oneLine, `节点 ${key} 的一句话`, NODE_LINE_MAX, true);
  const estimate = line(n.estimate, `节点 ${key} 的粗估`, NODE_ESTIMATE_MAX, false);
  return { key, taskId: task?.id ?? null, oneLine, deps: [...new Set((n.deps as string[] | undefined) ?? [])], status: task?.stage ?? PLANNED, estimate, inheritedFrom: null };
}

/** 整版校验：key 唯一、一张卡只进一个节点、依赖只指向同版节点、不许自环 / 成环 */
export function buildNodes(db: Database, feature: Pick<Feature, "id" | "project">, raw: unknown): DagNode[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new LedgerError("invalid", "--nodes 要是非空 JSON 数组");
  if (raw.length > DAG_NODES_MAX) throw new LedgerError("invalid", `一版最多 ${DAG_NODES_MAX} 个节点，收到 ${raw.length}`);
  const nodes = raw.map((x: unknown) => buildNode(db, feature, x));
  const keys = new Set<string>();
  const tasks = new Set<string>();
  for (const n of nodes) {
    if (keys.has(n.key)) throw new LedgerError("invalid", `节点 ${n.key} 重复`);
    if (n.taskId && tasks.has(n.taskId)) throw new LedgerError("invalid", `任务 ${n.taskId} 出现在两个节点里`);
    keys.add(n.key);
    if (n.taskId) tasks.add(n.taskId);
  }
  for (const n of nodes) {
    for (const d of n.deps) if (d === n.key || !keys.has(d)) throw new LedgerError("invalid", `节点 ${n.key} 的依赖 ${d} ${d === n.key ? "是它自己" : "不在这一版的节点里"}`);
  }
  checkAcyclic(nodes);
  return nodes;
}

/** 一张卡挂上 featureId：rev + 1、附一条 task 事件（和 task-set 的事件同形），依赖任务 rev 的 CAS 能看到这次改动 */
function setTaskFeature(db: Database, ctx: WriteCtx, feature: Feature, t: LedgerTask): void {
  const rev = t.rev + 1;
  db.prepare("UPDATE tasks SET featureId = ?, rev = ?, updatedAt = ? WHERE id = ?").run(feature.id, rev, ctx.now ?? Date.now(), t.id);
  insertEvent(db, ctx, { project: t.project, target: t.id, kind: "task", data: { op: "set", patch: { featureId: feature.id }, rev } }, false);
}

/** 节点任务卡挂上 featureId（节点已由 buildNodes 校验过）；已挂同一个的跳过 */
export function linkTasks(db: Database, ctx: WriteCtx, feature: Feature, nodes: readonly DagNode[]): void {
  for (const n of nodes) {
    if (!n.taskId) continue;
    const t = mustTask(db, n.taskId);
    if (t.featureId !== feature.id) setTaskFeature(db, ctx, feature, t);
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
      const v = Math.max(cur.currentVersion, has.v ?? 0);
      throw new LedgerError("conflict", `feature ${cur.id} 已有 v${v}：dag-init 只建初版，改图用 dag-rewrite`, { currentVersion: cur.currentVersion });
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
    const event = insertEvent(db, ctx, { ...key, data: { op: "dag-init", version: 1, nodes: nodes.map((n) => n.key), rev } }, true);
    return { row: getDagVersion(db, cur.id, 1) as DagVersion, event, duplicate: false };
  });
}

/**
 * 不进 DAG 的卡挂到 feature 下（L3 迁移：已完成 / 已取消 / 待排的卡）：只写 featureId，阶段、依赖不动。
 * 卡要在本项目、没挂别的 feature（挂了就整批拒）；已挂这个 feature 的跳过。没有卡真改时不写 feature 事件。
 */
export function assignFeature(db: Database, ctx: WriteCtx, input: { id: string; taskIds: readonly string[] }): { feature: Feature; assigned: string[] } {
  return tx(db, () => {
    const cur = mustFeature(db, input.id);
    requireManager(db, ctx.actor, cur.project);
    const assigned: string[] = [];
    for (const id of new Set(input.taskIds)) {
      const t = nodeTask(db, cur, id, id) as LedgerTask;
      if (t.featureId === cur.id) continue;
      setTaskFeature(db, ctx, cur, t);
      assigned.push(t.id);
    }
    if (assigned.length) insertEvent(db, ctx, { project: cur.project, target: cur.id, kind: "feature", data: { op: "assign", tasks: assigned } }, true);
    return { feature: cur, assigned };
  });
}
