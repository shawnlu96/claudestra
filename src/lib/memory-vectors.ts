/**
 * 项目记忆的本机向量库 + 暴力余弦（设计稿 docs/design/project-memory.md §5）。
 * 单独的 STATE_DIR/memory-vectors.sqlite，表 memory_vectors 主键 (memoryId, model)，向量存 float32 BLOB。
 * 它是 title + body 的派生缓存：不进台账备份 / 迁移、不同步；打不开就删了重建。digest 对不上 memories.digest 就重算，
 * 检索时也只认 digest 与当前记忆一致的行（还没来得及重算的旧向量不参与）。
 * 千条量级，检索在 TS 里逐条算余弦；超过 5 万条再评估 sqlite-vec。
 */
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { Memory } from "./ledger-memory.js";
import { embedTexts, type Embedder, type EmbedText } from "./memory-embed.js";
import { statePath } from "./paths.js";

const MEMORY_VECTORS_PATH = statePath("memory-vectors.sqlite");

/** 一次嵌入调用带多少条：每次调用各有 2 秒超时，批太大本机模型容易超时 */
const EMBED_BATCH = 16;

const SCHEMA = `CREATE TABLE IF NOT EXISTS memory_vectors (
  memoryId TEXT NOT NULL, model TEXT NOT NULL, dim INTEGER NOT NULL CHECK (dim > 0), digest TEXT NOT NULL,
  vec BLOB NOT NULL, createdAt INTEGER NOT NULL, PRIMARY KEY (memoryId, model))`;

function openAt(path: string): Database {
  const db = new Database(path, { create: true });
  db.prepare(SCHEMA).run();
  return db;
}

/** 打开（没有就建）向量库；文件坏了直接删掉重建——向量随时可重算 */
export function openVectorStore(path = MEMORY_VECTORS_PATH): Database {
  if (path === ":memory:") return openAt(path);
  mkdirSync(dirname(path), { recursive: true });
  try {
    return openAt(path);
  } catch {
    for (const p of [path, `${path}-wal`, `${path}-shm`]) rmSync(p, { force: true });
    return openAt(path);
  }
}

/** 一条记忆要嵌入的东西：id、当前 digest、文本（title + body；坑是 symptom + rule）、可见范围 */
export interface VectorSource extends EmbedText {
  id: string;
  digest: string;
}

export function vectorSource(m: Pick<Memory, "id" | "digest" | "title" | "body" | "visibility">): VectorSource {
  const body = typeof m.body === "string" ? m.body : `${m.body.symptom}\n${m.body.rule}`;
  return { id: m.id, digest: m.digest, text: `${m.title}\n${body}`, visibility: m.visibility };
}

const toBlob = (v: Float32Array) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
/** 拷一份再转：BLOB 的偏移不一定 4 字节对齐 */
const fromBlob = (b: Uint8Array) => new Float32Array(b.slice().buffer);

/** 该模型下还没有向量、或存的 digest 与当前记忆对不上的那些（要重算） */
export function staleSources(db: Database, model: string, sources: readonly VectorSource[]): VectorSource[] {
  const have = new Map((db.prepare("SELECT memoryId, digest FROM memory_vectors WHERE model = ?").all(model) as { memoryId: string; digest: string }[])
    .map((r) => [r.memoryId, r.digest]));
  return sources.filter((s) => have.get(s.id) !== s.digest);
}

export interface RefreshResult {
  embedded: number;
  /** 过不了远端闸（home 文本配远端模型）的条数 */
  skipped: number;
  /** 调用失败 / 超时的条数，下次再试 */
  failed: number;
}

/**
 * 把缺的 / digest 变了的补上（异步、不在任何台账事务里调）。没有模型就什么都不做；失败不抛错，只计数。
 */
export async function refreshVectors(db: Database, embedder: Embedder | null, sources: readonly VectorSource[],
  opts: { now?: number; timeoutMs?: number } = {}): Promise<RefreshResult> {
  const res: RefreshResult = { embedded: 0, skipped: 0, failed: 0 };
  if (!embedder) return res;
  const todo = staleSources(db, embedder.model, sources);
  const upsert = db.prepare(`INSERT INTO memory_vectors (memoryId, model, dim, digest, vec, createdAt) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (memoryId, model) DO UPDATE SET dim = excluded.dim, digest = excluded.digest, vec = excluded.vec, createdAt = excluded.createdAt`);
  for (let i = 0; i < todo.length; i += EMBED_BATCH) {
    const batch = todo.slice(i, i + EMBED_BATCH);
    const gated = batch.map((s) => embedder.remote && s.visibility !== "team");
    const vecs = await embedTexts(embedder, batch, { timeoutMs: opts.timeoutMs });
    const now = opts.now ?? Date.now();
    db.transaction(() => {
      batch.forEach((s, k) => {
        const v = vecs[k];
        if (v) {
          upsert.run(s.id, embedder.model, v.length, s.digest, toBlob(v), now);
          res.embedded++;
        } else if (gated[k]) res.skipped++;
        else res.failed++;
      });
    })();
  }
  return res;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export interface VectorHit {
  memoryId: string;
  score: number;
}

export interface NearestOpts {
  /** 候选（id → 当前 digest）：只在这些里找，digest 对不上的旧向量不算；不给 = 表里该模型的全部 */
  candidates?: ReadonlyMap<string, string>;
  /** 余弦下限（§3.2 起步 0.35，由检索方按模型给） */
  threshold?: number;
  limit?: number;
}

/** 暴力余弦：该模型、同维度的向量逐条算，≥ 阈值的按分数降序取前 limit，同分按 id 定序 */
export function nearestMemories(db: Database, model: string, query: Float32Array, opts: NearestOpts = {}): VectorHit[] {
  const rows = db.prepare("SELECT memoryId, digest, vec FROM memory_vectors WHERE model = ? AND dim = ?").all(model, query.length) as
    { memoryId: string; digest: string; vec: Uint8Array }[];
  const hits: VectorHit[] = [];
  for (const r of rows) {
    if (opts.candidates && opts.candidates.get(r.memoryId) !== r.digest) continue;
    const score = cosine(query, fromBlob(r.vec));
    if (score >= (opts.threshold ?? -1)) hits.push({ memoryId: r.memoryId, score });
  }
  hits.sort((a, b) => b.score - a.score || (a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0));
  return hits.slice(0, opts.limit ?? 20);
}

/**
 * 语义这一路：查询文本嵌入一次再暴力余弦。没有模型、查询过不了远端闸、嵌入失败 / 超时 → 空数组（这路为空，不是错误）
 */
export async function semanticSearch(db: Database, embedder: Embedder | null, query: EmbedText,
  opts: NearestOpts & { timeoutMs?: number } = {}): Promise<VectorHit[]> {
  if (!embedder) return [];
  const [q] = await embedTexts(embedder, [query], { timeoutMs: opts.timeoutMs });
  return q ? nearestMemories(db, embedder.model, q, opts) : [];
}
