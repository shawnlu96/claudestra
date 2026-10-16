/**
 * 项目记忆：事务外准备三路排名，同步拼单时重查状态、按整单预算选条，最后记录实际推出的 memoryIds。
 * 排名缓存和注入事件分开；同步降级不能阻止后续异步准备，预算或生命周期变化不能伪造推出记录。
 * 无记忆时不改报文、不写事件；检索故障不阻塞派单。tests/memory-retrieve-order.test.ts。
 */
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { memoryState } from "./ledger-memory.js";
import type { MemoryVisibility } from "./ledger-memory-schema.js";
import { getDagVersion, getFeature, effectiveNodes } from "./ledger-feature.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, getMeta } from "./ledger-store.js";
import { insertEvent } from "./ledger-tx.js";
import { EMBED_TIMEOUT_MS, pickEmbedder, readEmbedConfig, type Embedder } from "./memory-embed.js";
import {
  cardPatterns, fileRoute, graphRoute, MEMORY_CAPS, memoryCandidates, rankMemories, VECTOR_LIMIT, VECTOR_THRESHOLD,
  type Candidate, type DropReason, type MemoryOrderKind, type MemoryRoute, type Ranked, type Scored,
} from "./memory-retrieve.js";
import { cosine, openVectorStore, refreshVectors, semanticSearch, vectorSource, type VectorHit } from "./memory-vectors.js";
import { clipWire } from "./order-findings.js";
import { parseOrderWire, WIRE_LIMITS, WIRE_MAX_BYTES } from "./order-wire.js";
import { memoryHeadFiles } from "./memory-retrieve-head.js";
import { readTextSoft, specPathFor } from "./task-spec.js";
import { recordMemoryAttempt, type MemoryAttemptResult, type MemoryChannel } from "./memory-inject-attempt.js";

const OP = "memory_retrieve";
const WRITER_BUSY_MS = 2_000;
const DAY_MS = 86_400_000;
/** 事件里落选理由最多记几条（§9 用的是 memoryIds，落选只为排查） */
const DROPPED_MAX = 20;
const SPEC_QUERY_BYTES = 2048;

/** 事件里一条入选记忆：只记 id 和推荐理由，不复制正文（正文随记忆走，事件可能被同步） */
interface RetrievedItem {
  id: string;
  routes: MemoryRoute[];
  why: string;
  score: number;
  status: string;
  ageDays: number;
}

export interface RetrieveOpts {
  now?: number;
  /** 仅最终领取入口启用；预检与全文拼单不能冒充已领取。 */
  recordInjection?: boolean;
  /** 语义路的命中（ensureMemoryRetrieval 算好的）；不给 = 这路为空 */
  vector?: VectorHit[];
  /** HEAD 的文件列表（glob 对 glob 求交、「文件都不在了」先验用）；不给 = 按目录前缀判、不扣分 */
  headFiles?: readonly string[] | null;
  pairCosine?: (a: string, b: string) => number | null;
  /** PMEMTUNE1：只收这种可见性的候选（出借单 = team，home 一条都不出本机）；排名另记一份，不和本机排名混用 */
  visibility?: MemoryVisibility;
  /** 检索开始时刻（Date.now）；memory_rank.elapsedMs = 选完 − 它。不给 = 从算排名开始计 */
  startedAt?: number;
}

export const memoryDedupKey = (task: Pick<LedgerTask, "id" | "specRev">, head: string | null, kind: MemoryOrderKind): string =>
  `scheduler:memory:${task.id}:${task.specRev}:${head ?? "-"}:${kind}`;
/** 排名缓存的键：按可见性过滤的排名（出借）另起一份，推出记录仍用 memoryDedupKey（同一套口径） */
const rankKey = (task: Pick<LedgerTask, "id" | "specRev">, head: string | null, kind: MemoryOrderKind, visibility?: MemoryVisibility): string =>
  `${memoryDedupKey(task, head, kind)}${visibility ? `:${visibility}` : ""}`;

/** fix / 审查单再并上 PR 已改的范围外文件（order-deliver-scope.ts 登记的 deliver_scope 事件；范围内的已被 fileGlobs 盖住） */
function prFiles(db: Database, task: LedgerTask, head: string | null): string[] {
  const e = head ? getEventByDedup(db, `deliver-scope:${task.id}:${task.specRev}:${head}`) : null;
  const files = Array.isArray(e?.data.files) ? (e.data.files as { path?: unknown }[]) : [];
  return files.flatMap((f) => (typeof f?.path === "string" ? [f.path] : []));
}

/** 三路 → RRF → 去重 → 上限；只读 */
export function retrieveMemories(db: Database, task: LedgerTask, kind: MemoryOrderKind, head: string | null, opts: RetrieveOpts = {}):
  { candidates: Candidate[]; ranked: Ranked } {
  const candidates = candidatesOf(db, task, opts.visibility);
  if (!candidates.length) return { candidates, ranked: { selected: [], dropped: [] } };
  const extra = kind === "review" || task.stage === "fix" ? prFiles(db, task, head) : [];
  const routes = {
    graph: graphRoute(db, task, candidates),
    file: fileRoute(candidates, cardPatterns(task, extra), opts.headFiles ?? null),
    vector: (opts.vector ?? []).filter((h) => candidates.some((c) => c.memory.id === h.memoryId)),
  };
  return { candidates, ranked: rankMemories(candidates, routes, { kind, now: opts.now ?? Date.now(), headFiles: opts.headFiles, pairCosine: opts.pairCosine }) };
}

const ROUTE_ORDER: MemoryRoute[] = ["graph", "file", "vector"];

function whyOf(s: Scored): string {
  const parts: string[] = [];
  if (s.graph) parts.push(s.graph.via);
  if (s.file) parts.push(`同文件 ${s.file.first}`);
  if (s.cosine !== undefined) parts.push("语义");
  return parts.join(" + ");
}

const dropText = (r: DropReason): string => ({
  dedup_source: "同来源卡留坑", dedup_similar: "与更新的一条近似", below_floor: "低于下限", not_pitfall: "审查单只放坑",
  displaced_by_pitfall: "让坑位", over_limit: "超条数",
}[r.kind] + ("by" in r ? ` ${r.by}` : ""));

/** 记一条 scheduler 事件；bridge 的只读连接另开写连接（同 order-deliver-scope.ts）。同 dedupKey 已有就返回已有的 */
function record(db: Database, task: LedgerTask, key: string, text: string, data: Record<string, unknown>, now: number): LedgerEvent | null {
  const prior = getEventByDedup(db, key);
  if (prior) return prior;
  const queryOnly = (db.query("PRAGMA query_only").get() as { query_only: number }).query_only === 1;
  const writer = queryOnly ? new Database(db.filename, { readwrite: true, create: false }) : db;
  try {
    if (writer !== db) writer.exec(`PRAGMA busy_timeout = ${WRITER_BUSY_MS}`);
    return writer.transaction(() => getEventByDedup(writer, key)
      ?? insertEvent(writer, { actor: "scheduler", dedupKey: key, now }, { project: task.project, target: task.id, kind: "scheduler", text, data }, true)).immediate();
  } finally {
    if (writer !== db) writer.close();
  }
}

/** 只算排名数据，预览 cache miss 与真实领取共用同一套排名规则。 */
function retrievalData(db: Database, task: LedgerTask, kind: MemoryOrderKind, head: string | null, opts: RetrieveOpts) {
  const now = opts.now ?? Date.now();
  const startedAt = opts.startedAt ?? Date.now();
  const { candidates, ranked } = retrieveMemories(db, task, kind, head, { ...opts, now });
  if (!candidates.length) return null;
  const items: RetrievedItem[] = ranked.selected.map((s) => ({
    id: s.id, routes: ROUTE_ORDER.filter((r) => s.ranks[r] !== undefined), why: whyOf(s), score: Number(s.score.toFixed(6)), status: s.status,
    ageDays: Math.max(0, Math.floor((now - s.memory.createdAt) / DAY_MS)),
  }));
  const used = ["graph", "file", ...(opts.vector ? ["vector"] : [])];
  return {
    op: "memory_rank", order: kind, specRev: task.specRev, head, routes: used, items, selectionVersion: ranked.selectionVersion,
    dropped: ranked.dropped.slice(0, DROPPED_MAX).map((d) => ({ id: d.id, score: Number(d.score.toFixed(6)), reason: dropText(d.reason) })),
    elapsedMs: Math.max(0, Date.now() - startedAt), ...(opts.visibility ? { visibility: opts.visibility } : {}),
  };
}

/** 算一次并登记（没有候选就不登记、返回 null）；仅真实领取的准备 / 同步降级入口调用。 */
function registerRetrieval(db: Database, task: LedgerTask, kind: MemoryOrderKind, head: string | null, opts: RetrieveOpts = {}, prepared = false): LedgerEvent | null {
  const key = `${rankKey(task, head, kind, opts.visibility)}:${prepared ? "prepared" : "fallback"}`;
  const prior = getEventByDedup(db, key);
  if (prior) return prior;
  const data = retrievalData(db, task, kind, head, opts);
  return data ? record(db, task, key, `项目记忆排名：${data.items.length} 条（${data.routes.join(" + ")}）`, data, opts.now ?? Date.now()) : null;
}

// ── 异步一半：语义路 ──

export interface EnsureDeps {
  /** 不给 = 按 config.json memory.embed 取第一个可用的；null = 关掉语义路 */
  embedder?: Embedder | null;
  /** 向量库连接；不给 = 打开本机 memory-vectors.sqlite（用完关） */
  vectors?: Database;
  /** 出借准备必须感知失败；本机领单继续图 + 文件降级。 */
  throwOnError?: boolean;
  headFiles?: readonly string[] | null;
  /** 测试可指定仓库；生产从本卡项目配置 / 作者工作目录取。 */
  repoDir?: string;
  now?: number;
  timeoutMs?: number;
  /** 出借单：只排 team 记忆（另一份排名缓存） */
  visibility?: MemoryVisibility;
}

/** 查询文本 = 卡标题 + 节点 oneLine + 规格正文前 2KB。含内部内容，按 home 处理（不发远端模型） */
function queryText(db: Database, task: LedgerTask): string {
  const f = task.featureId ? getFeature(db, task.featureId) : null;
  const v = f && f.currentVersion > 0 ? getDagVersion(db, f.id, f.currentVersion) : null;
  const node = v ? effectiveNodes(db, v).find((n) => n.taskId === task.id) : undefined;
  const spec = readTextSoft(specPathFor(task, getMeta(db, task.project).docsDir)) ?? "";
  return [task.title, node?.oneLine ?? "", clipWire(spec, SPEC_QUERY_BYTES)].filter(Boolean).join("\n");
}

const fromBlob = (b: Uint8Array) => new Float32Array(b.slice().buffer);

/** 候选两两余弦（同模型、digest 对得上的向量）；去重 ≥0.92 用 */
function pairCosines(vdb: Database, model: string, cands: readonly Candidate[]): (a: string, b: string) => number | null {
  const want = new Map(cands.map((c) => [c.memory.id, c.memory.digest]));
  const vecs = new Map<string, Float32Array>();
  for (const r of vdb.query("SELECT memoryId, digest, vec FROM memory_vectors WHERE model = ?").all(model) as { memoryId: string; digest: string; vec: Uint8Array }[]) {
    if (want.get(r.memoryId) === r.digest) vecs.set(r.memoryId, fromBlob(r.vec));
  }
  return (a, b) => {
    const va = vecs.get(a), vb = vecs.get(b);
    return va && vb && va.length === vb.length ? cosine(va, vb) : null;
  };
}

/** 语义路：补嵌入缺的记忆向量、嵌入查询文本搜一遍，顺带两两余弦。没有模型 = 空（两路）。出错照抛。只写向量库，不写台账。 */
async function semanticInputs(db: Database, task: LedgerTask, cands: readonly Candidate[], deps: EnsureDeps): Promise<Pick<RetrieveOpts, "vector" | "pairCosine">> {
  const embedder = deps.embedder !== undefined ? deps.embedder : await pickEmbedder(readEmbedConfig());
  if (!embedder) return {};
  const vdb = deps.vectors ?? openVectorStore();
  try {
    const sources = cands.map((c) => vectorSource(c.memory));
    // 全部批次共用截止时间，避免大候选池把每批超时累加成数分钟。
    const deadline = Date.now() + (deps.timeoutMs ?? EMBED_TIMEOUT_MS);
    for (let at = 0; at < sources.length && Date.now() < deadline; at += 16) {
      await refreshVectors(vdb, embedder, sources.slice(at, at + 16), { now: deps.now, timeoutMs: Math.max(1, deadline - Date.now()) });
    }
    const vector = Date.now() >= deadline ? [] : await semanticSearch(vdb, embedder, { text: queryText(db, task), visibility: "home" }, {
      candidates: new Map(sources.map((s) => [s.id, s.digest])), threshold: VECTOR_THRESHOLD, limit: VECTOR_LIMIT, timeoutMs: Math.max(1, deadline - Date.now()),
    });
    return { vector, pairCosine: pairCosines(vdb, embedder.model, cands) };
  } finally {
    if (vdb !== deps.vectors) vdb.close();
  }
}

const candidatesOf = (db: Database, task: LedgerTask, visibility?: MemoryVisibility) =>
  memoryCandidates(db, task).filter((c) => !visibility || c.memory.visibility === visibility);

/**
 * 派单前（事务外）调：补嵌入缺的记忆向量、嵌入查询文本走语义路，再算一次并登记。已登记过、没有候选、没有模型都照常（没模型 = 两路）。
 * 默认失败时降级；throwOnError 供出借准备保留错误结果。
 */
async function prepareRetrieval(db: Database, task: LedgerTask, kind: MemoryOrderKind, head: string | null = task.headSHA,
  deps: EnsureDeps = {}): Promise<void> {
  let headFiles = deps.headFiles;
  const startedAt = Date.now(), visibility = deps.visibility;
  try {
    if (getEventByDedup(db, `${rankKey(task, head, kind, visibility)}:prepared`)) return;
    const cands = candidatesOf(db, task, visibility);
    if (!cands.length) return;
    headFiles = deps.headFiles !== undefined ? deps.headFiles : await memoryHeadFiles(db, task, head, deps.repoDir);
    const semantic = await semanticInputs(db, task, cands, deps);
    registerRetrieval(db, task, kind, head, { now: deps.now, ...semantic, headFiles, visibility, startedAt }, true);
  } catch (e) {
    if (deps.throwOnError) throw e;
    console.error(`⚠️ ${task.id} 项目记忆检索失败，按图 + 文件两路补：${(e as Error).message}`);
    try { registerRetrieval(db, task, kind, head, { now: deps.now, headFiles, visibility, startedAt }, true); }
    catch (fallbackError) { console.error(`⚠️ ${task.id} 记忆降级登记失败，派单照常：${(fallbackError as Error).message}`); }
  }
}

/**
 * 同一份准备，只算不记（全文直发用：发送成功之前台账上不能多出事件）：HEAD 文件 + 语义路，交给 fitMemory 现算排名。
 * 已有排名缓存或没有候选 = 空（fitMemory 照用缓存 / 照空）。出错照抛，由调用方按无记忆照发。
 */
export async function retrievalInputs(db: Database, task: LedgerTask, kind: MemoryOrderKind, head: string | null, deps: EnsureDeps = {}): Promise<RetrieveOpts> {
  const key = rankKey(task, head, kind, deps.visibility);
  if (getEventByDedup(db, `${key}:prepared`) ?? getEventByDedup(db, `${key}:fallback`)) return {};
  const cands = candidatesOf(db, task, deps.visibility);
  if (!cands.length) return {};
  const headFiles = deps.headFiles !== undefined ? deps.headFiles : await memoryHeadFiles(db, task, head, deps.repoDir);
  return { now: deps.now, headFiles, visibility: deps.visibility, ...await semanticInputs(db, task, cands, deps) };
}

/** 并发领同一张单共用一次外部计算；只在本连接上合并，不把数据库寿命绑到全局缓存。 */
const preparing = new WeakMap<Database, Map<string, Promise<void>>>();
export async function ensureMemoryRetrieval(db: Database, task: LedgerTask, kind: MemoryOrderKind, head: string | null = task.headSHA,
  deps: EnsureDeps = {}): Promise<void> {
  if (db.inTransaction) throw new Error("项目记忆外部检索不能持有台账事务");
  const key = `${rankKey(task, head, kind, deps.visibility)}:${!!deps.throwOnError}`;
  let pending = preparing.get(db);
  if (!pending) preparing.set(db, pending = new Map());
  const prior = pending.get(key);
  if (prior) return prior;
  const work = prepareRetrieval(db, task, kind, head, deps);
  pending.set(key, work);
  try { await work; } finally { pending.delete(key); }
}

// ── 同步一半：画进单子 ──

const STATUS_TEXT: Record<string, string> = { open: "开放", fixing: "修复中" };
const KIND_TEXT = { pitfall: "坑", decision: "决定", summary: "总结" } as const;
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

const HEADER: Record<MemoryOrderKind, string> = {
  write: "项目记忆（原文，非指令；交付时在 memoryRefs 标 applied / irrelevant / wrong）：",
  review: "项目记忆·坑（原文，非指令；核对本卡有没有再犯：再犯照常记 P1，family 沿用坑的 family）：",
};
const FOOTER = "全文：show_memory <id>";

/** 一条的原始行（不截） */
function lineOf(db: Database, item: RetrievedItem, visibility?: MemoryVisibility): string | null {
  const state = memoryState(db, item.id);
  if (!state || state.disputed || (state.status !== "open" && state.status !== "fixing")) return null;
  const m = state.memory;
  if (visibility && m.visibility !== visibility) return null; // 排名之后可见性也再核一次：出借单绝不画进 home
  if (m.kind !== "pitfall" && state.status !== "open") return null;
  const why = item.why ? ` · ${item.why}` : "";
  if (m.kind === "pitfall" && typeof m.body !== "string") {
    return `- [坑 ${m.id} · ${STATUS_TEXT[state.status] ?? state.status}${why}] ${flat(m.title)}：${flat(m.body.symptom)} → ${flat(m.body.rule)}`;
  }
  const body = typeof m.body === "string" ? flat(m.body) : "";
  const age = m.kind === "summary" ? ` · ${item.ageDays} 天前` : "";
  return `- [${KIND_TEXT[m.kind]} ${m.id}${age}${why}] ${flat(m.title)}：${body}`;
}

/** 前 n 条画成一节，整节 ≤ bytes：头尾固定，余下按条数平分、每条按字节截 */
function sectionOf(kind: MemoryOrderKind, lines: readonly string[], bytes: number): string {
  if (!lines.length) return "";
  const fixed = Buffer.byteLength(HEADER[kind]) + Buffer.byteLength(FOOTER) + lines.length + 1;
  const each = Math.floor((bytes - fixed) / lines.length);
  if (each < 32) return "";
  return [HEADER[kind], ...lines.map((l) => clipWire(l, each)), FOOTER].join("\n");
}

type RetrievalRanking = Pick<LedgerEvent, "data"> & { seq?: number };

/** 优先取异步排名；预览 cache miss 只在内存算，不开写连接或事务。 */
function rankedEvent(db: Database, task: LedgerTask, kind: MemoryOrderKind, head: string | null, opts: RetrieveOpts, persist = false): RetrievalRanking | null {
  const key = rankKey(task, head, kind, opts.visibility);
  const cached = getEventByDedup(db, `${key}:prepared`) ?? getEventByDedup(db, `${key}:fallback`);
  if (cached) return cached;
  if (persist) return registerRetrieval(db, task, kind, head, opts);
  const data = retrievalData(db, task, kind, head, opts);
  return data ? { data } : null;
}

function liveLines(db: Database, e: RetrievalRanking | null, visibility?: MemoryVisibility): { item: RetrievedItem; line: string }[] {
  const items = Array.isArray(e?.data.items) ? e.data.items as RetrievedItem[] : [];
  return items.flatMap((item) => {
    const line = lineOf(db, item, visibility);
    return line ? [{ item, line }] : [];
  });
}

/** 排名只作缓存；预览不记推出事件，每次渲染重查生命周期。 */
export function memorySection(db: Database, task: LedgerTask, kind: MemoryOrderKind, head: string | null, maxItems = MEMORY_CAPS[kind].count,
  bytes = MEMORY_CAPS[kind].bytes, opts: RetrieveOpts = {}): string {
  const lines = liveLines(db, rankedEvent(db, task, kind, head, opts), opts.visibility).slice(0, maxItems);
  return sectionOf(kind, lines.map((x) => x.line), Math.min(bytes, WIRE_LIMITS.input));
}

/** 事件不可改写：同一实际报文去重，预算 / 状态改变时另记一条，保留过去确实推出过的记录。 */
function recordInjection(db: Database, task: LedgerTask, kind: MemoryOrderKind, head: string | null, e: RetrievalRanking | null,
  ids: string[], wire: unknown, now: number, channel?: MemoryChannel): void {
  if (e?.seq === undefined) return;
  const base = memoryDedupKey(task, head, kind);
  const fingerprint = createHash("sha256").update(JSON.stringify(wire)).digest("hex");
  const last = db.query(`SELECT dedupKey FROM events WHERE target = ? AND kind = 'scheduler'
    AND (dedupKey = ? OR (dedupKey > ? AND dedupKey < ?)) ORDER BY seq DESC LIMIT 1`)
    .get(task.id, base, `${base}:injected:`, `${base}:injected;`) as { dedupKey: string } | null;
  const prior = last ? getEventByDedup(db, last.dedupKey) : null;
  if (prior?.data.fingerprint === fingerprint) return;
  const key = prior ? `${base}:injected:${prior.seq}:${fingerprint}` : base;
  record(db, task, key, `项目记忆：${kind === "review" ? "审查单" : "写单"}推 ${ids.length} 条`, {
    op: OP, order: kind, specRev: task.specRev, head, memoryIds: ids, fingerprint, rankingSeq: e.seq, ...(channel ? { channel } : {}),
  }, now);
}

/** 拼好的一节：单子、实际放进的 id、排名事件，和这次尝试的结果（未覆盖原因）。 */
export interface MemoryFit<W> {
  wire: W;
  ids: string[];
  ranking: RetrievalRanking | null;
  result: MemoryAttemptResult;
  /** 放进的那一节（没放 = ""） */
  section: string;
}

/**
 * 拼单的最后一步（只算不记）：inputs 末尾加「项目记忆」一节。整单（JSON）要留在 WIRE_MAX_BYTES 内——放不下就少放几条，一条都放不下就不加；
 * inputs 已满 20 项也不加。opts.visibility 给了 = 只排、只画这种可见性的记忆。出错照抛，由调用方决定（withMemory 吞掉、单子照发）。
 */
export function fitMemory<W extends { inputs: string[] }>(db: Database, task: LedgerTask, kind: MemoryOrderKind, head: string | null, wire: W,
  opts: RetrieveOpts & { persist?: boolean } = {}): MemoryFit<W> {
  const e = rankedEvent(db, task, kind, head, opts, opts.persist);
  const lines = liveLines(db, e, opts.visibility);
  for (let n = Math.min(MEMORY_CAPS[kind].count, lines.length); wire.inputs.length < WIRE_LIMITS.items && n > 0; n--) {
    const selected = lines.slice(0, n);
    const section = sectionOf(kind, selected.map((x) => x.line), MEMORY_CAPS[kind].bytes);
    if (!section) break;
    const next = { ...wire, inputs: [...wire.inputs, section] };
    if (Buffer.byteLength(JSON.stringify(next)) <= WIRE_MAX_BYTES) return { wire: next, ids: selected.map((x) => x.item.id), ranking: e, result: "injected", section };
  }
  const filtered = !lines.length && !!opts.visibility && memoryCandidates(db, task).length > 0;
  return { wire, ids: [], ranking: e, result: lines.length ? "budget_drop" : filtered ? "filtered_visibility" : "empty", section: "" };
}

/** 单子实际写进 / 发出之后才调：按现有口径记一条推出（同一实际报文去重）。永不抛。 */
export function recordMemoryInjection<W>(db: Database, task: LedgerTask, kind: MemoryOrderKind, head: string | null, fit: MemoryFit<W>,
  sent: unknown, channel: MemoryChannel, now = Date.now(), visibility?: MemoryVisibility): void {
  try {
    // 现算没登记的排名（fitMemory persist = false）：发出去之后才把那份排名原样登记成 fallback，推出事件指向它
    const ranking = fit.ranking && fit.ranking.seq === undefined
      ? record(db, task, `${rankKey(task, head, kind, visibility)}:fallback`, `项目记忆排名：${fit.ids.length} 条`, fit.ranking.data, now) : fit.ranking;
    recordInjection(db, task, kind, head, ranking, fit.ids, sent, now, channel);
  }
  catch (e) { console.error(`⚠️ ${task.id} 项目记忆推出没记上：${(e as Error).message}`); }
}

const orderIdOf = (w: unknown): string | null => {
  const o = w as { orderId?: unknown; dedupKey?: unknown };
  return typeof o.orderId === "string" ? o.orderId : typeof o.dedupKey === "string" ? o.dedupKey : null;
};

/**
 * 拼单的最后一步：fitMemory + 真实领取时记推出（local_take 渠道）。没有可推的记忆 / 出错：单子原样返回（逐字不变）。
 * 真实领取另记一条检索尝试（memory-inject-attempt.ts，同一单号只一条）。
 */
export function withMemory<W extends { inputs: string[] }>(db: Database | null | undefined, task: LedgerTask, kind: MemoryOrderKind,
  head: string | null, wire: W, opts: RetrieveOpts = {}): W {
  if (!db) return wire;
  const startedAt = Date.now(), orderId = opts.recordInjection ? orderIdOf(wire) : null;
  const attempt = (result: MemoryAttemptResult, count: number, reason?: string) => {
    if (orderId) recordMemoryAttempt(db, task, { orderId, channel: "local_take", order: kind, result, count, elapsedMs: Date.now() - startedAt, reason }, opts.now);
  };
  try {
    const fit = fitMemory(db, task, kind, head, wire, { ...opts, persist: opts.recordInjection, startedAt });
    // 坏单会被入口拒绝，不把其中的候选误记成已经发出。
    if (opts.recordInjection && (!("orderId" in fit.wire) || parseOrderWire(fit.wire).ok)) {
      recordInjection(db, task, kind, head, fit.ranking, fit.ids, fit.wire, opts.now ?? Date.now(), "local_take");
      attempt(fit.result, fit.ids.length);
    }
    return fit.wire;
  } catch (e) {
    console.error(`⚠️ ${task.id} 项目记忆没写进单子（单子照发）：${(e as Error).message}`);
    attempt("error", 0, (e as Error).message);
  }
  return wire;
}
