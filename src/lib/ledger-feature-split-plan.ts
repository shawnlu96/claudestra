import type { Database } from "bun:sqlite";
import { cardContext, cardNames, pinNodes } from "./ledger-card-names.js";
import { openClaims } from "./ledger-autostart-grant.js";
import { findPath } from "./ledger-deps.js";
import { featureDeps } from "./ledger-feature-deps.js";
import { effectiveNodes, getDagVersion, getFeature, getPendingProposal, projectNodes, type DagNode, type Feature } from "./ledger-feature.js";
import { mustFeature } from "./ledger-feature-write.js";
import { storedOrigin } from "./ledger-origin.js";
import { getTask, LedgerError } from "./ledger-store.js";

interface SplitTarget { slug?: string; id?: string; title: string; words?: string; nodes: string[] }
export interface SplitMap { targets: SplitTarget[]; deps: { from: string; to: string; note?: string }[] }
export interface SplitGroup { id: string; title: string; target: SplitTarget | null; feature: Feature | null; nodes: DagNode[] }
export interface SplitPlan { source: Feature; groups: SplitGroup[]; deps: SplitMap["deps"]; rejected: string[] }

export function parseSplitMap(raw: unknown): SplitMap {
  const m = raw as SplitMap;
  const bad = () => { throw new LedgerError("invalid", "映射须为 {targets:[{slug 或 id,title,words?,nodes:[]}],deps?:[{from,to,note?}]}"); };
  if (!m || !Array.isArray(m.targets) || !m.targets.length) bad();
  for (const t of m.targets) {
    if (!t || (typeof t.slug === "string") === (typeof t.id === "string")) bad();
    if (t.id !== undefined && (typeof t.id !== "string" || !t.id.trim())) bad();
    if (t.slug !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(t.slug)) bad();
    if (typeof t.title !== "string" || !t.title.trim() || [...t.title.trim()].length > 60 || /[\p{Cc}\p{Cf}]/u.test(t.title)) bad();
    if (t.words !== undefined && typeof t.words !== "string") bad();
    if (!Array.isArray(t.nodes) || !t.nodes.length || !t.nodes.every((n) => typeof n === "string" && n)) bad();
  }
  if (m.deps !== undefined && !Array.isArray(m.deps)) bad();
  for (const d of m.deps ?? []) {
    if (!d || typeof d.from !== "string" || typeof d.to !== "string") bad();
    if (d.note !== undefined && (typeof d.note !== "string" || [...d.note].length > 60 || /[\p{Cc}]/u.test(d.note))) bad();
  }
  return { targets: m.targets, deps: m.deps ?? [] };
}

function nodesOf(db: Database, f: Feature): DagNode[] {
  const v = f.currentVersion ? getDagVersion(db, f.id, f.currentVersion) : null;
  return v ? effectiveNodes(db, v) : [];
}

function targetGroups(db: Database, source: Feature, map: SplitMap, rejected: string[]): SplitGroup[] {
  const origin = storedOrigin(db);
  if (!origin) rejected.push("台账没有固定 origin");
  const groups: SplitGroup[] = [];
  for (const t of map.targets) {
    const id = t.id ? (getFeature(db, t.id)?.id ?? `${origin}-${t.id}`) : `${origin}-${t.slug}`;
    const f = getFeature(db, id);
    if (id === source.id || groups.some((g) => g.id === id)) rejected.push(`目标 ${id} 重复或等于源 feature`);
    if (t.id && !f) rejected.push(`目标 ${id} 不存在`);
    if (t.slug && f) rejected.push(`新 feature ${id} 已存在`);
    if (f && f.project !== source.project) rejected.push(`目标 ${id} 不在源项目`);
    if (f && getPendingProposal(db, id)) rejected.push(`目标 ${id} 有待批提案`);
    const title = t.title.trim();
    if (!t.id && (groups.some((g) => g.title === title) || db.query("SELECT id FROM features WHERE project=? AND title=?").get(source.project, title))) {
      rejected.push(`标题 ${title} 已存在`);
    }
    groups.push({ id, title: f?.title ?? title, target: t, feature: f, nodes: f ? nodesOf(db, f) : [] });
  }
  return groups;
}

function splitNodes(db: Database, source: Feature, groups: SplitGroup[], rejected: string[]): void {
  const nodes = nodesOf(db, source), views = projectNodes(db, nodes);
  const owners = new Map<string, SplitGroup>();
  for (const g of groups) for (const key of g.target?.nodes ?? []) {
    if (owners.has(key)) rejected.push(`节点 ${key} 在两个 target 里`);
    if (!nodes.some((n) => n.key === key)) rejected.push(`源版本没有节点 ${key}`);
    if (g.nodes.some((n) => n.key === key)) rejected.push(`目标 ${g.id} 的 key ${key} 撞了`);
    owners.set(key, g);
  }
  const kept: SplitGroup = { id: source.id, title: source.title, target: null, feature: source, nodes: [] };
  // 目标原有的节点也固化：搬进来的前缀可能成为它唯一的前缀，没固化的会跟着漂
  for (const g of groups) g.nodes = g.nodes.map((n) => (n.cardSlug !== undefined || !g.feature ? n : { ...n, cardSlug: cardNames(db, g.feature, n.key, n).slug }));
  for (const n of nodes) {
    const g = owners.get(n.key) ?? kept;
    const dropped: string[] = [];
    for (const dep of n.deps) {
      if ((owners.get(dep) ?? kept).id === g.id) continue;
      if (!views.find((v) => v.key === dep)?.satisfied) rejected.push(`跨组未完成依赖 ${n.key} → ${dep}`);
      else dropped.push(dep);
    }
    g.nodes.push({ ...n, deps: n.deps.filter((d) => !dropped.includes(d)),
      cardSlug: n.cardSlug ?? cardNames(db, source, n.key, n).slug,
      ...(g !== kept ? { movedFrom: { featureId: source.id, version: source.currentVersion } } : {}),
      ...(dropped.length ? { droppedDeps: [...new Set([...(n.droppedDeps ?? []), ...dropped])] } : {}) });
  }
  for (const g of groups) {
    const tasks = new Set<string>();
    for (const n of g.nodes) {
      if (!n.taskId) continue;
      const t = getTask(db, n.taskId);
      if (!t || t.project !== source.project) rejected.push(`节点 ${n.key} 的任务不存在或跨项目`);
      if (g.target?.nodes.includes(n.key) && t?.featureId && t.featureId !== source.id) rejected.push(`节点 ${n.key} 的任务归属不一致`);
      if (tasks.has(n.taskId)) rejected.push(`目标 ${g.id} 的任务 ${n.taskId} 重复`);
      tasks.add(n.taskId);
    }
    if (g.nodes.length > 200) rejected.push(`目标 ${g.id} 超过 200 节点`);
  }
  for (const c of openClaims(db, source.id)) if (owners.has(c.key)) rejected.push(`节点 ${c.key} 有未结 claim ${c.seq}`);
  groups.unshift(kept);
  siblingCheck(db, source, groups, owners, rejected);
}

/** 搬进目标的节点按写入后的样子做兄弟校验：同前缀下别的 feature（含这次拆分的其他组）已有同名 key 就拒 */
function siblingCheck(db: Database, source: Feature, groups: SplitGroup[], owners: Map<string, SplitGroup>, rejected: string[]): void {
  const base = cardContext(db, source, groups.map((g) => g.id));
  for (const g of groups.slice(1)) {
    const taken = new Map(base.taken);
    for (const o of groups) if (o !== g) for (const n of o.nodes) taken.set(`${n.cardSlug}-${n.key}`, o.id);
    try {
      pinNodes({ ...base, taken }, g.nodes, (n) => owners.get(n.key) === g);
    } catch (e) {
      if (!(e instanceof LedgerError)) throw e;
      rejected.push(`目标 ${g.id}：${e.message}`);
    }
  }
}

function planDeps(db: Database, source: Feature, groups: SplitGroup[], map: SplitMap, rejected: string[]): SplitMap["deps"] {
  const resolve = (raw: string) => groups.find((g) => g.id === raw || g.target?.slug === raw || g.target?.id === raw)?.id
    ?? getFeature(db, raw)?.id ?? getFeature(db, `${storedOrigin(db)}-${raw}`)?.id ?? raw;
  const edges = featureDeps(db, source.project).map((d) => ({ from: d.from, to: d.to }));
  const deps = [...groups.slice(1).map((g) => ({ from: source.id, to: g.id, note: "feature-split 默认前置" })),
    ...map.deps.map((d) => ({ ...d, from: resolve(d.from), to: resolve(d.to) }))];
  const result: SplitMap["deps"] = [];
  for (const d of deps) {
    for (const id of [d.from, d.to]) {
      if (!groups.some((g) => g.id === id) && getFeature(db, id)?.project !== source.project) rejected.push(`依赖 feature ${id} 不在源项目`);
    }
    if (d.from === d.to || findPath(edges, d.to, d.from)) rejected.push(`feature 依赖成环 ${d.from} → ${d.to}`);
    if (edges.some((e) => e.from === d.from && e.to === d.to)) continue;
    edges.push(d); result.push(d);
  }
  return result;
}

export function planFeatureSplit(db: Database, sourceId: string, map: SplitMap): SplitPlan {
  const source = mustFeature(db, sourceId), rejected: string[] = [];
  if (!source.currentVersion) rejected.push("源 feature 没有子 DAG");
  if (getPendingProposal(db, source.id)) rejected.push("源 feature 有待批重写提案");
  const groups = targetGroups(db, source, map, rejected);
  splitNodes(db, source, groups, rejected);
  const deps = planDeps(db, source, groups, map, rejected);
  return { source, groups, deps, rejected };
}
