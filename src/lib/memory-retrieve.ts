/**
 * 项目记忆的三路检索 + RRF + 上限（设计稿 docs/design/project-memory.md §3）。只读台账：候选、图、文件两路同步算；语义一路由调用方
 * 先异步算好命中（memory-retrieve-order.ts ensureMemoryRetrieval）传进来，没传 = 这路为空，图和文件两路照常。
 * 写进单子、记 scheduler 事件在 memory-retrieve-order.ts。tests/memory-retrieve.test.ts（§3.5 夹具逐数复现）。
 *
 * 去重在上限之前：所有有命中的候选里，同一来源卡的总结和坑同时在 → 留坑；
 * 两条余弦 ≥0.92 → 留新的。§3.5 夹具按这条重算：m2 与 m1 同来源卡（N1）→ m2 出局，开工单是 m4、m7、m1、m6。
 *
 * PMEMTUNE2（docs/architecture/project-memory-relevance.md）两个恢复键，缺省 on，off 逐字回到上面的规则：
 * - memoryPitfallRelevance：写单不再预留坑位、坑和其他记忆按同一分数竞争，低于本次最高分 RELATIVE_FLOOR 倍的不放（0..4 条）；
 *   只靠相邻 feature 的图命中（文件、语义都没中）的坑写单、审查单都不放。
 * - memoryFeedbackPrior：别的卡在 memoryRefs 标的 applied / irrelevant 汇成先验乘子（memory-feedback-prior.ts），memoryCandidates 一次读完。
 * observe：照算新旧两套，按单记一条 recordObserved 样本，实际用旧的。tests/memory-retrieve-relevance.test.ts。
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { memoryStatus, type MemoryState } from "./ledger-memory-fold.js";
import type { Memory } from "./ledger-memory.js";
import type { MemoryVisibility } from "./ledger-memory-schema.js";
import { getMemory, listMarks } from "./ledger-memory.js";
import { effectiveNodes, getDagVersion, getFeature, type DagNode } from "./ledger-feature.js";
import { featureDeps } from "./ledger-feature-deps.js";
import type { LedgerTask } from "./ledger-stages.js";
import { listDeps } from "./ledger-store.js";
import { feedbackPrior, marksByMemory, type FeedbackMark, UNRELATED_WEIGHT, type RefsRow } from "./memory-feedback-prior.js";
import type { VectorHit } from "./memory-vectors.js";
import { recordObserved, recoveryPolicy, type RecoveryMode } from "./recovery-policy.js";

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
/** memoryPitfallRelevance：写单里 RRF 终分低于本次候选最高分的这个比例就不放 */
export const RELATIVE_FLOOR = 0.35;
/** 只靠这一跳（相邻 feature）的图命中算「远邻」 */
const FAR_HOP = 3;

const PITFALL_RELEVANCE_KEY = "memoryPitfallRelevance" as const;
const FEEDBACK_PRIOR_KEY = "memoryFeedbackPrior" as const;
export interface SelectionModes { pitfallRelevance: RecoveryMode; feedbackPrior: RecoveryMode }
/** 没有检索上下文（直接调纯函数、没给 modes）= 两键 off，逐字是老规则 */
const MODES_OFF: SelectionModes = { pitfallRelevance: "off", feedbackPrior: "off" };

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
  /** memoryFeedbackPrior on 时乘进 prior 的那一项 */
  feedback?: number;
}

export type DropReason =
  | { kind: "dedup_source"; by: string }
  | { kind: "dedup_similar"; by: string }
  /** rule：relative = 低于本次最高分的 RELATIVE_FLOOR 倍；far_graph = 坑只靠相邻 feature 的图命中（两条都是 memoryPitfallRelevance） */
  | { kind: "below_floor"; rule?: "relative" | "far_graph" }
  | { kind: "not_pitfall" }
  | { kind: "displaced_by_pitfall"; by: string }
  | { kind: "over_limit" };

export interface Ranked {
  selected: Scored[];
  dropped: { id: string; score: number; reason: DropReason }[];
  /** 记进 memory_rank：哪套规则选的（两键都 off 时不带） */
  selectionVersion?: string;
}

const hasTable = (db: Database, t: string): boolean => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const KIND_ORDER: Record<Memory["kind"], number> = { pitfall: 0, decision: 1, summary: 2 };

// ── 候选（§3.1） ──

/**
 * 本项目可推的记忆：坑看 open / fixing，总结 / 决定看 open；带 disputed 的不推；本卡自己的总结不推（本卡的坑、决定照收）。
 * 库里还没有记忆表（老只读库）= 空。
 */
/** visibility 给了 = 只收这种可见性（出借单只排 team）；在这里过滤，检索上下文才挂在 rankMemories 拿到的同一个数组上 */
export function memoryCandidates(db: Database, task: Pick<LedgerTask, "id" | "project"> & Partial<Pick<LedgerTask, "specRev">>,
  visibility?: MemoryVisibility): Candidate[] {
  if (!hasTable(db, "memories") || !hasTable(db, "memory_marks")) return [];
  const ids = db.query("SELECT id FROM memories WHERE project = ? ORDER BY id").all(task.project) as { id: string }[];
  const out: Candidate[] = [];
  for (const { id } of ids) {
    const memory = getMemory(db, id);
    if (!memory || (visibility && memory.visibility !== visibility)) continue;
    const st = memoryStatus(memory, listMarks(db, id));
    if (st.disputed) continue;
    const live = memory.kind === "pitfall" ? st.status === "open" || st.status === "fixing" : st.status === "open";
    if (!live || (memory.kind === "summary" && memory.taskId === task.id)) continue;
    out.push({ memory, ...st });
  }
  if (out.length) {
    const modes: SelectionModes = { pitfallRelevance: recoveryPolicy(task.project, PITFALL_RELEVANCE_KEY).mode, feedbackPrior: recoveryPolicy(task.project, FEEDBACK_PRIOR_KEY).mode };
    RETRIEVAL.set(out, { db, task, modes, feedback: modes.feedbackPrior === "off" ? new Map() : refsMarks(db, task) });
  }
  return out;
}

/** 检索上下文：memoryCandidates 记下，rankMemories 按同一个候选数组取（模式、跨卡标记、记 observe 样本） */
interface RetrievalCtx {
  db: Database;
  task: Pick<LedgerTask, "id" | "project"> & Partial<Pick<LedgerTask, "specRev">>;
  modes: SelectionModes;
  feedback: ReadonlyMap<string, readonly FeedbackMark[]>;
}
const RETRIEVAL = new WeakMap<readonly Candidate[], RetrievalCtx>();

/** 本项目所有 refs 事件一次读完、按记忆汇总（本卡自己的标记不算）；不逐条查 */
function refsMarks(db: Database, task: Pick<LedgerTask, "id" | "project">): Map<string, FeedbackMark[]> {
  if (!hasTable(db, "events")) return new Map();
  const rows = db.query("SELECT target, ts, data FROM events WHERE project = ? AND kind = 'memory' AND json_extract(data, '$.op') = 'refs'")
    .all(task.project) as RefsRow[];
  return contextualMarks(db, rows, task.id, task.project);
}

/** Bulk card metadata keeps cross-card feedback outside the ranking transaction. Missing cards are unrelated. */
export function contextualMarks(db: Database, rows: readonly RefsRow[], taskId: string, project: string, lowWeight = UNRELATED_WEIGHT) {
  const cards = db.query("SELECT id, featureId, extra FROM tasks WHERE project = ?").all(project) as
    { id: string; featureId: string | null; extra: string | null }[];
  const context = new Map(cards.map((c) => {
    let extra: Record<string, unknown> = {};
    try { extra = JSON.parse(c.extra ?? "{}"); } catch { /* Malformed historical metadata provides no file relevance evidence. */ }
    const files = Array.isArray(extra.fileGlobs) ? extra.fileGlobs.filter((x): x is string => typeof x === "string") : [];
    return [c.id, { feature: c.featureId, files }] as const;
  }));
  const self = context.get(taskId);
  return marksByMemory(rows, taskId, (id) => {
    const other = context.get(id);
    return self && other && ((self.feature && self.feature === other.feature)
      || self.files.some((a) => other.files.some((b) => overlaps(a, b, null)))) ? 1 : lowWeight;
  });
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
  /** 两键模式；不给 = 取 memoryCandidates 记下的（生产），再没有 = 两键 off */
  modes?: SelectionModes;
  /** 跨卡标记；不给 = 取 memoryCandidates 记下的 */
  feedback?: ReadonlyMap<string, readonly FeedbackMark[]>;
}

/** 一套选择规则：两个键各开没开 */
interface Rules { pitfall: boolean; feedback: boolean }

/** 先验：总结 ×0.8 × 0.5^(天数/60)；files 在 HEAD 一个都不在 ×0.3 */
function priorOf(m: Memory, now: number, headFiles: readonly string[] | null | undefined): number {
  let p = m.kind === "summary" ? SUMMARY_PRIOR * 0.5 ** ((now - m.createdAt) / DAY_MS / SUMMARY_HALF_LIFE_DAYS) : 1;
  if (headFiles && m.files.length && !m.files.some((f) => headFiles.some((h) => overlaps(f, h, null)))) p *= GONE_PRIOR;
  return p;
}

function score(cands: readonly Candidate[], routes: Routes, opts: RankOpts, rules: Rules, feedback: ReadonlyMap<string, readonly FeedbackMark[]>): Scored[] {
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
    if (!rules.feedback) return { ...s, rrf, prior, score: rrf * prior };
    const fb = feedbackPrior(feedback.get(s.id) ?? [], opts.now);
    return { ...s, rrf, prior: prior * fb, feedback: fb, score: rrf * prior * fb };
  }).sort(byScore);
}

/** 终分降序，平局新者优先，再按 id（回放 memory-relevance-replay.ts 用同一个比较） */
export const rankOrder = (a: { score: number; createdAt: number; id: string }, b: { score: number; createdAt: number; id: string }): number =>
  b.score - a.score || b.createdAt - a.createdAt || byId(a.id, b.id);
const byScore = (a: Scored, b: Scored) => rankOrder({ score: a.score, createdAt: a.memory.createdAt, id: a.id }, { score: b.score, createdAt: b.memory.createdAt, id: b.id });

/** 坑只靠相邻 feature 的图命中，文件、语义都没中 */
const farGraphOnly = (s: Scored): boolean =>
  s.memory.kind === "pitfall" && s.graph?.hop === FAR_HOP && s.ranks.file === undefined && s.ranks.vector === undefined;

/** RRF → 先验 → 去重 → 上限；rules 全关 = 老规则（审查单只留坑；写单保坑位） */
function select(cands: readonly Candidate[], routes: Routes, opts: RankOpts, rules: Rules, feedback: ReadonlyMap<string, readonly FeedbackMark[]>): Ranked {
  const cap = MEMORY_CAPS[opts.kind];
  const scored = score(cands, routes, opts, rules, feedback);
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
    // 绝对下限按乘跨卡先验之前的分判：先验只调名次，不把记忆压到永远出不来
    if (s.score / (s.feedback ?? 1) < SCORE_FLOOR) drop(s, { kind: "below_floor" });
    else if (opts.kind === "review" && s.memory.kind !== "pitfall") drop(s, { kind: "not_pitfall" });
    else if (rules.pitfall && farGraphOnly(s)) drop(s, { kind: "below_floor", rule: "far_graph" });
    else eligible.push(s);
  }
  if (rules.pitfall && opts.kind === "write") {
    // 同一分数竞争、不保坑位；低于本次最高分一定比例的不放（可以 0 条）
    const bar = (eligible[0]?.score ?? 0) * RELATIVE_FLOOR;
    const fit = eligible.filter((s) => s.score >= bar);
    for (const s of eligible) if (s.score < bar) drop(s, { kind: "below_floor", rule: "relative" });
    const selected = fit.slice(0, cap.count);
    for (const s of fit.slice(cap.count)) drop(s, { kind: "over_limit" });
    return finish(scored, selected, dropped);
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
  return finish(scored, selected, dropped);
}

function finish(scored: readonly Scored[], selected: Scored[], dropped: Ranked["dropped"]): Ranked {
  selected.sort(byScore);
  const order = new Map(scored.map((s, i) => [s.id, i]));
  dropped.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return { selected, dropped };
}

const versionOf = (modes: SelectionModes, rules: Rules): string | undefined =>
  modes.pitfallRelevance === "off" && modes.feedbackPrior === "off" ? undefined
    : [rules.pitfall ? "pitfall" : "", rules.feedback ? "feedback" : ""].filter(Boolean).join("+") || "base";

/**
 * RRF → 先验 → 去重 → 上限。两键 on 用新规则、off 用老规则；observe 的键照算「打开它」那一套，按单记一条样本，实际返回现行这套。
 * 模式 / 跨卡标记默认取 memoryCandidates 记下的；直接拿字面候选调（没有上下文、没给 modes）= 两键 off。
 */
export function rankMemories(cands: readonly Candidate[], routes: Routes, opts: RankOpts): Ranked {
  const ctx = RETRIEVAL.get(cands);
  const modes = opts.modes ?? ctx?.modes ?? MODES_OFF;
  const feedback = opts.feedback ?? ctx?.feedback ?? new Map<string, readonly FeedbackMark[]>();
  const rules: Rules = { pitfall: modes.pitfallRelevance === "on", feedback: modes.feedbackPrior === "on" };
  const ranked = select(cands, routes, opts, rules, feedback);
  ranked.selectionVersion = versionOf(modes, rules);
  if (ctx) {
    const watch = (key: typeof PITFALL_RELEVANCE_KEY | typeof FEEDBACK_PRIOR_KEY, next: Rules) =>
      observeSelection(ctx, key, opts, ranked, select(cands, routes, opts, next, feedback), versionOf(modes, next)!);
    if (modes.pitfallRelevance === "observe") watch(PITFALL_RELEVANCE_KEY, { ...rules, pitfall: true });
    if (modes.feedbackPrior === "observe") watch(FEEDBACK_PRIOR_KEY, { ...rules, feedback: true });
  }
  return ranked;
}

const SAMPLE_PART = /^[\w.:@/-]{1,80}$/;
const samplePart = (s: string): string => (SAMPLE_PART.test(s) ? s : createHash("sha256").update(s, "utf8").digest("hex").slice(0, 32));

/** 样本写连接：已在事务里（同步拼单）不记——同一单的事务外准备那次已经记过；bridge 的 query_only 读连接另开写连接（同 memory-retrieve-order.ts record） */
const OBSERVE_WRITER_BUSY_MS = 2_000;
function observeWriter(db: Database): Database | null {
  if (db.inTransaction) return null;
  if ((db.query("PRAGMA query_only").get() as { query_only: number }).query_only !== 1) return db;
  if (!db.filename || db.filename === ":memory:") return null;
  const writer = new Database(db.filename, { readwrite: true, create: false });
  writer.exec(`PRAGMA busy_timeout = ${OBSERVE_WRITER_BUSY_MS}`);
  return writer;
}

/**
 * observe 样本：一单（卡 + specRev + 写 / 审查）一条，带新旧条目 id、被拿掉的条目和原因、新补进的条目。
 * 事务外记（只读连接走另开的写连接），按单去重；记失败不影响检索。
 */
function observeSelection(ctx: RetrievalCtx, mechanism: typeof PITFALL_RELEVANCE_KEY | typeof FEEDBACK_PRIOR_KEY, opts: RankOpts,
  current: Ranked, next: Ranked, nextVersion: string): void {
  let writer: Database | null = null;
  try {
    writer = observeWriter(ctx.db);
    if (!writer) return;
    const oldIds = current.selected.map((s) => s.id), newIds = next.selected.map((s) => s.id);
    const removed = oldIds.filter((id) => !newIds.includes(id)).map((id) => {
      const d = next.dropped.find((x) => x.id === id);
      return { id, reason: d ? d.reason.kind + (d.reason.kind === "below_floor" && d.reason.rule ? `:${d.reason.rule}` : "") : "reordered" };
    });
    recordObserved(writer, {
      project: ctx.task.project, mechanism, target: samplePart(ctx.task.id),
      actionKey: `memsel:${samplePart(ctx.task.id)}:${ctx.task.specRev ?? 0}:${opts.kind}`,
      action: `${opts.kind === "review" ? "审查单" : "写单"}记忆 ${oldIds.length} → ${newIds.length} 条（拿掉 ${removed.length}）`,
      data: { order: opts.kind, specRev: ctx.task.specRev ?? null, oldVersion: current.selectionVersion ?? "base", newVersion: nextVersion,
        oldIds, newIds, removed, added: newIds.filter((id) => !oldIds.includes(id)) },
    }, opts.now);
  } catch (e) {
    console.error(`⚠️ ${ctx.task.id} 记忆选择 observe 样本没记上：${(e as Error).message}`);
  } finally {
    if (writer && writer !== ctx.db) writer.close();
  }
}
