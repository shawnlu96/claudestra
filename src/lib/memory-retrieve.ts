/**
 * 项目记忆的三路检索 + RRF + 上限（设计稿 docs/design/project-memory.md §3）。只读台账：候选、图、文件两路同步算；语义一路由调用方
 * 先异步算好命中（memory-retrieve-order.ts ensureMemoryRetrieval）传进来，没传 = 这路为空，图和文件两路照常。
 * 写进单子、记 scheduler 事件在 memory-retrieve-order.ts。tests/memory-retrieve.test.ts（§3.5 夹具逐数复现）。
 *
 * 去重按规则走、在上限之前（PM 10-03 定，pmem-D1 审查 P2 retrieval-dedup）：所有有命中的候选里，同一来源卡的总结和坑同时在 → 留坑；
 * 两条余弦 ≥0.92 → 留新的。§3.5 夹具按这条重算：m2 与 m1 同来源卡（N1）→ m2 出局，开工单是 m4、m7、m1、m6。
 */
import type { Database } from "bun:sqlite";
import { memoryStatus, type MemoryState } from "./ledger-memory-fold.js";
import type { Memory } from "./ledger-memory.js";
import { getMemory, listMarks } from "./ledger-memory.js";
import { effectiveNodes, getDagVersion, getFeature, type DagNode } from "./ledger-feature.js";
import { featureDeps } from "./ledger-feature-deps.js";
import type { LedgerTask } from "./ledger-stages.js";
import { listDeps } from "./ledger-store.js";
import type { VectorHit } from "./memory-vectors.js";

/** 写单（build / fix）还是审查单 */
export type MemoryOrderKind = "write" | "review";
export type MemoryRoute = "graph" | "file" | "vector";

/** RRF 常数（Cormack et al. 2009 默认） */
const RRF_K = 60;
/** 下限 = 单路第 10 名的分数 */
export const SCORE_FLOOR = 1 / (RRF_K + 10);
/** 语义一路的余弦起步阈值（nomic / embeddinggemma，§3.2），取前 20 */
export const VECTOR_THRESHOLD = 0.35;
export const VECTOR_LIMIT = 20;
/** 两条记忆余弦 ≥ 它算重复，留新的 */
const DUP_COSINE = 0.92;
const DAY_MS = 86_400_000;
const SUMMARY_PRIOR = 0.8;
const SUMMARY_HALF_LIFE_DAYS = 60;
const GONE_PRIOR = 0.3;

/** 条数 / 字节上限：写单 ≤4 条 ≤1600 字节、至少保 2 个坑位；审查单只放坑，≤3 条 ≤1000 字节 */
export const MEMORY_CAPS: Record<MemoryOrderKind, { count: number; bytes: number; pitfallSlots: number }> = {
  write: { count: 4, bytes: 1600, pitfallSlots: 2 },
  review: { count: 3, bytes: 1000, pitfallSlots: 0 },
};

export interface Candidate extends MemoryState {
  memory: Memory;
}

/** 某条记忆在图上离本卡几跳，和「为什么」（节点 key / feature） */
export interface GraphHit { id: string; hop: 0 | 1 | 2 | 3; via: string }
export interface FileHit { id: string; hits: number; total: number; first: string }

export interface Routes {
  graph: GraphHit[];
  file: FileHit[];
  vector: VectorHit[];
}

export interface Scored {
  id: string;
  memory: Memory;
  status: MemoryState["status"];
  /** 各路名次（1 起），没命中的路不在 */
  ranks: Partial<Record<MemoryRoute, number>>;
  rrf: number;
  prior: number;
  score: number;
  graph?: GraphHit;
  file?: FileHit;
  cosine?: number;
}

export type DropReason =
  | { kind: "dedup_source"; by: string }
  | { kind: "dedup_similar"; by: string }
  | { kind: "below_floor" }
  | { kind: "not_pitfall" }
  | { kind: "displaced_by_pitfall"; by: string }
  | { kind: "over_limit" };

export interface Ranked {
  selected: Scored[];
  dropped: { id: string; score: number; reason: DropReason }[];
}

const hasTable = (db: Database, t: string): boolean => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const KIND_ORDER: Record<Memory["kind"], number> = { pitfall: 0, decision: 1, summary: 2 };

// ── 候选（§3.1） ──

/**
 * 本项目可推的记忆：坑看 open / fixing，总结 / 决定看 open；带 disputed 的不推；本卡自己的总结不推（本卡的坑、决定照收）。
 * 库里还没有记忆表（老只读库）= 空。
 */
export function memoryCandidates(db: Database, task: Pick<LedgerTask, "id" | "project">): Candidate[] {
  if (!hasTable(db, "memories") || !hasTable(db, "memory_marks")) return [];
  const ids = db.query("SELECT id FROM memories WHERE project = ? ORDER BY id").all(task.project) as { id: string }[];
  const out: Candidate[] = [];
  for (const { id } of ids) {
    const memory = getMemory(db, id);
    if (!memory) continue;
    const st = memoryStatus(memory, listMarks(db, id));
    if (st.disputed) continue;
    const live = memory.kind === "pitfall" ? st.status === "open" || st.status === "fixing" : st.status === "open";
    if (!live || (memory.kind === "summary" && memory.taskId === task.id)) continue;
    out.push({ memory, ...st });
  }
  return out;
}

// ── 图（§3.2） ──

interface GraphCtx {
  taskId: string;
  featureId: string | null;
  /** 本卡在当前 DAG 里的节点 */
  self: DagNode | null;
  nodes: DagNode[];
  adjacentFeatures: Set<string>;
  /** 卡不在 feature 里时：task_deps 的直接邻居 */
  taskNeighbors: Set<string>;
}

function graphCtx(db: Database, task: LedgerTask): GraphCtx {
  const featureId = task.featureId ?? null;
  const f = featureId && hasTable(db, "features") ? getFeature(db, featureId) : null;
  const v = f && f.currentVersion > 0 ? getDagVersion(db, f.id, f.currentVersion) : null;
  const nodes = v ? effectiveNodes(db, v) : [];
  const adjacentFeatures = new Set(f ? featureDeps(db, task.project, f.id).map((d) => (d.from === f.id ? d.to : d.from)) : []);
  const taskNeighbors = new Set(f ? [] : listDeps(db, task.project).flatMap((d) => (d.from === task.id ? [d.to] : d.to === task.id ? [d.from] : [])));
  return { taskId: task.id, featureId: f?.id ?? null, self: nodes.find((n) => n.taskId === task.id) ?? null, nodes, adjacentFeatures, taskNeighbors };
}

/** 记忆锚在哪个节点：nodeKey（同 feature）优先，其次按 taskId 找当前 DAG 里绑它的节点 */
function nodeOf(g: GraphCtx, m: Memory): DagNode | null {
  if (m.featureId === g.featureId && m.nodeKey) return g.nodes.find((n) => n.key === m.nodeKey) ?? null;
  return m.taskId ? (g.nodes.find((n) => n.taskId === m.taskId) ?? null) : null;
}

function hopOf(g: GraphCtx, m: Memory): Omit<GraphHit, "id"> | null {
  const node = nodeOf(g, m);
  if (m.taskId === g.taskId || (g.self && node?.key === g.self.key)) return { hop: 0, via: "本卡" };
  if (!g.featureId) return m.taskId && g.taskNeighbors.has(m.taskId) ? { hop: 1, via: `依赖卡 ${m.taskId}` } : null;
  if (g.self && node && (g.self.deps.includes(node.key) || node.deps.includes(g.self.key))) return { hop: 1, via: `${g.self.deps.includes(node.key) ? "依赖" : "下游"} ${node.key}` };
  if (m.featureId === g.featureId && !m.taskId && !m.nodeKey) return { hop: 1, via: "本 feature" };
  if (m.featureId === g.featureId) return { hop: 2, via: node ? `同 feature ${node.key}` : "同 feature" };
  if (m.featureId && g.adjacentFeatures.has(m.featureId)) return { hop: 3, via: "相邻 feature" };
  return null;
}

/** 按跳数排，同跳 坑 > 决定 > 总结，再新者优先 */
export function graphRoute(db: Database, task: LedgerTask, cands: readonly Candidate[]): GraphHit[] {
  const g = graphCtx(db, task);
  const hits = cands.flatMap((c) => {
    const h = hopOf(g, c.memory);
    return h ? [{ c, h }] : [];
  });
  hits.sort((a, b) => a.h.hop - b.h.hop || KIND_ORDER[a.c.memory.kind] - KIND_ORDER[b.c.memory.kind]
    || b.c.memory.createdAt - a.c.memory.createdAt || byId(a.c.memory.id, b.c.memory.id));
  return hits.map(({ c, h }) => ({ id: c.memory.id, ...h }));
}

// ── 文件（§3.2） ──

const GLOB_CHARS = /[*?[\]{}!]/;
const isGlob = (s: string) => GLOB_CHARS.test(s);
/** glob 第一个通配符之前的部分 */
const staticPrefix = (g: string) => g.slice(0, g.search(GLOB_CHARS));

/**
 * 两个仓库相对路径 / glob 有没有交：路径对路径相等；glob 对路径用 Bun.Glob；glob 对 glob 两边展开到 HEAD 的文件列表再求交，
 * 只要有一边展开出文件就按交集判（另一边还没有文件 = 没交）；两边都展开不出（或没有文件列表）才按目录前缀判
 * （一边的固定前缀是另一边的前缀）。
 * §3.5：本卡 `widget-batch*.ts` 还没文件、m1 的 `*-schema.ts` 展开出 widget-schema.ts → 不交
 */
export function overlaps(a: string, b: string, headFiles: readonly string[] | null): boolean {
  const ga = isGlob(a), gb = isGlob(b);
  if (!ga && !gb) return a === b;
  if (ga && !gb) return new Bun.Glob(a).match(b);
  if (!ga && gb) return new Bun.Glob(b).match(a);
  const ea = headFiles ? headFiles.filter((f) => new Bun.Glob(a).match(f)) : [];
  const eb = headFiles ? headFiles.filter((f) => new Bun.Glob(b).match(f)) : [];
  if (ea.length || eb.length) return ea.some((f) => eb.includes(f));
  const pa = staticPrefix(a), pb = staticPrefix(b);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

/** 本卡的文件范围：卡上 extra.fileGlobs，再并上调用方给的（fix / 审查单 = PR 已改的范围外文件） */
export function cardPatterns(task: LedgerTask, extra: readonly string[] = []): string[] {
  const globs = Array.isArray(task.extra.fileGlobs) ? task.extra.fileGlobs.filter((g): g is string => typeof g === "string") : [];
  return [...new Set([...globs, ...extra])];
}

/** 记忆 files 与本卡范围求交；排序键 命中文件数 / 记忆文件数，平局新者优先 */
export function fileRoute(cands: readonly Candidate[], patterns: readonly string[], headFiles: readonly string[] | null): FileHit[] {
  if (!patterns.length) return [];
  const hits = cands.flatMap((c) => {
    const files = c.memory.files;
    const hit = files.filter((f) => patterns.some((p) => overlaps(f, p, headFiles)));
    return hit.length ? [{ c, h: { id: c.memory.id, hits: hit.length, total: files.length, first: hit[0]! } }] : [];
  });
  hits.sort((a, b) => b.h.hits / b.h.total - a.h.hits / a.h.total || b.c.memory.createdAt - a.c.memory.createdAt || byId(a.h.id, b.h.id));
  return hits.map((x) => x.h);
}

// ── 合并、去重、上限（§3.3） ──

export interface RankOpts {
  kind: MemoryOrderKind;
  now: number;
  /** HEAD 的文件列表：给了才判「files 一个都不在了 ×0.3」 */
  headFiles?: readonly string[] | null;
  /** 两条记忆的余弦（没有向量 = null，不按相似去重） */
  pairCosine?: (a: string, b: string) => number | null;
}

/** 先验：总结 ×0.8 × 0.5^(天数/60)；files 在 HEAD 一个都不在 ×0.3 */
function priorOf(m: Memory, now: number, headFiles: readonly string[] | null | undefined): number {
  let p = m.kind === "summary" ? SUMMARY_PRIOR * 0.5 ** ((now - m.createdAt) / DAY_MS / SUMMARY_HALF_LIFE_DAYS) : 1;
  if (headFiles && m.files.length && !m.files.some((f) => headFiles.some((h) => overlaps(f, h, null)))) p *= GONE_PRIOR;
  return p;
}

function score(cands: readonly Candidate[], routes: Routes, opts: RankOpts): Scored[] {
  const byMem = new Map(cands.map((c) => [c.memory.id, c]));
  const out = new Map<string, Scored>();
  const add = (route: MemoryRoute, id: string, rank: number, patch: Partial<Scored>) => {
    const c = byMem.get(id);
    if (!c) return;
    const s = out.get(id) ?? { id, memory: c.memory, status: c.status, ranks: {}, rrf: 0, prior: 1, score: 0 };
    if (s.ranks[route] !== undefined) return;
    s.ranks[route] = rank;
    out.set(id, { ...s, ...patch });
  };
  routes.graph.forEach((h, i) => add("graph", h.id, i + 1, { graph: h }));
  routes.file.forEach((h, i) => add("file", h.id, i + 1, { file: h }));
  routes.vector.forEach((h, i) => add("vector", h.memoryId, i + 1, { cosine: h.score }));
  return [...out.values()].map((s) => {
    // 按名次从小到大累加：浮点加法不满足结合律，同一组名次换个路序会差最后一位，平局就不稳了
    const rrf = Object.values(s.ranks).sort((x, y) => x - y).reduce((sum, r) => sum + 1 / (RRF_K + r), 0);
    const prior = priorOf(s.memory, opts.now, opts.headFiles);
    return { ...s, rrf, prior, score: rrf * prior };
  }).sort(byScore);
}

/** 终分降序，平局新者优先，再按 id */
const byScore = (a: Scored, b: Scored) => b.score - a.score || b.memory.createdAt - a.memory.createdAt || byId(a.id, b.id);

/** RRF → 先验 → 去重 → 上限（审查单只留坑；写单保坑位）。纯函数 */
export function rankMemories(cands: readonly Candidate[], routes: Routes, opts: RankOpts): Ranked {
  const cap = MEMORY_CAPS[opts.kind];
  const scored = score(cands, routes, opts);
  const dropped: Ranked["dropped"] = [];
  const drop = (s: Scored, reason: DropReason) => dropped.push({ id: s.id, score: s.score, reason });

  // 去重：同一来源卡的总结让给坑；余弦 ≥0.92 留新的
  const pitfallOfTask = new Map<string, string>();
  for (const s of scored) if (s.memory.kind === "pitfall" && s.memory.taskId && !pitfallOfTask.has(s.memory.taskId)) pitfallOfTask.set(s.memory.taskId, s.id);
  const kept: Scored[] = [];
  for (const s of scored) {
    const pit = s.memory.kind === "summary" && s.memory.taskId ? pitfallOfTask.get(s.memory.taskId) : undefined;
    if (pit) { drop(s, { kind: "dedup_source", by: pit }); continue; }
    kept.push(s);
  }
  const unique: Scored[] = [];
  for (const s of kept) {
    const twin = opts.pairCosine ? kept.find((o) => o !== s && (opts.pairCosine!(s.id, o.id) ?? 0) >= DUP_COSINE
      && (o.memory.createdAt > s.memory.createdAt || (o.memory.createdAt === s.memory.createdAt && o.id > s.id))) : undefined;
    if (twin) drop(s, { kind: "dedup_similar", by: twin.id });
    else unique.push(s);
  }

  // 上限：过下限的才有资格；审查单只放坑
  const eligible: Scored[] = [];
  for (const s of unique) {
    if (s.score < SCORE_FLOOR) drop(s, { kind: "below_floor" });
    else if (opts.kind === "review" && s.memory.kind !== "pitfall") drop(s, { kind: "not_pitfall" });
    else eligible.push(s);
  }
  const selected = eligible.slice(0, cap.count);
  const rest = eligible.slice(cap.count);
  const pitfalls = () => selected.filter((s) => s.memory.kind === "pitfall").length;
  for (const p of rest.filter((s) => s.memory.kind === "pitfall")) {
    if (pitfalls() >= cap.pitfallSlots) break;
    const victim = selected.findLastIndex((s) => s.memory.kind !== "pitfall");
    if (victim < 0) break;
    drop(selected[victim]!, { kind: "displaced_by_pitfall", by: p.id });
    selected.splice(victim, 1);
    selected.push(p);
  }
  for (const s of rest) if (!selected.includes(s)) drop(s, { kind: "over_limit" });
  selected.sort(byScore);
  const order = new Map(scored.map((s, i) => [s.id, i]));
  dropped.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return { selected, dropped };
}
