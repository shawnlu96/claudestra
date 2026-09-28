/**
 * 媒体索引（「图片与文件」视图与大图查看器的数据源）：会话 jsonl → 附件行，存 bun:sqlite，按文件增量扫。
 *
 * jsonl 只追加：每个来源文件记着「扫到的字节位置 + 下一行的 seq」，大小没变就跳过，变大了从上次的位置接着读，
 * 变小（被换掉 / 截断）才从头扫这一个文件。seq 与历史面板同义（jsonl 行号），定位回消息直接用 jumpToContext。
 * 大会话（实测到过 500MB）分块读、块间让出事件循环、先按子串预筛再 JSON.parse——整读会把 bridge 主线程卡住（见 session-history 尾读注释）。
 * 解析规则变了就把 SCHEMA_VERSION 加一：库会清空重建。
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { AttachmentDirs } from "./attachment-lookup.js";
import { MEDIA_MARKERS, mediaRefsOf, type MediaRef } from "./media-extract.js";
import { buildInboxCatalog, displayName, resolveInbound, resolveOutbound, type InboxCatalog, type Resolved } from "./media-store.js";
import { createLineTranslator, runtimeForSessionPath } from "./session-source.js";

const SCHEMA_VERSION = 2;
const CHUNK_BYTES = 1024 * 1024;
/** 出站副本可能比 jsonl 记录晚几秒落盘：这么久以内没找到文件的行，下次刷新再解析一次 */
const RETRY_MISSING_MS = 15 * 60_000;

export interface MediaSource {
  agent: string;
  sessionId: string;
  path: string;
}

const dbs = new Map<string, Database>();

export function openMediaIndex(path: string): Database {
  const hit = dbs.get(path);
  if (hit) return hit;
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  const ver = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (ver !== SCHEMA_VERSION) {
    db.exec("DROP TABLE IF EXISTS media; DROP TABLE IF EXISTS sources;");
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS sources (
    path TEXT PRIMARY KEY, agent TEXT NOT NULL, session_id TEXT NOT NULL, size INTEGER NOT NULL, mtime REAL NOT NULL,
    offset INTEGER NOT NULL, next_seq INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY, agent TEXT NOT NULL, session_id TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT, ts_ms INTEGER NOT NULL, sk TEXT NOT NULL,
    dir TEXT NOT NULL, sender TEXT, name TEXT NOT NULL, ref_path TEXT NOT NULL, loc TEXT, size INTEGER, mime TEXT,
    kind TEXT NOT NULL, cat TEXT NOT NULL, ambiguous INTEGER NOT NULL DEFAULT 0, prio INTEGER NOT NULL)`);
  db.exec("CREATE INDEX IF NOT EXISTS media_sk ON media(sk)");
  db.exec("CREATE INDEX IF NOT EXISTS media_agent ON media(agent, ts_ms)");
  db.exec("CREATE INDEX IF NOT EXISTS media_loc ON media(loc)");
  dbs.set(path, db);
  return db;
}

export function closeMediaIndex(path: string): void {
  dbs.get(path)?.close();
  dbs.delete(path);
}

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "avif", "svg"]);
const CATS: Record<string, string[]> = {
  pdf: ["pdf"],
  doc: ["doc", "docx", "xls", "xlsx", "ppt", "pptx", "key", "pages", "numbers", "csv", "md", "txt", "rtf"],
  code: ["json", "log", "ts", "tsx", "js", "py", "sh", "html", "css", "yaml", "yml", "toml", "sql", "diff", "patch"],
  archive: ["zip", "tar", "gz", "tgz", "7z", "rar", "bz2", "xz"],
  media: ["mp4", "mov", "m4a", "mp3", "wav", "aac", "webm", "ogg"],
};

/** 文件名 → { kind, cat }：图片进网格，其余按大类给「类型」筛选用 */
function classify(name: string): { kind: "image" | "file"; cat: string } {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (IMAGE_EXT.has(ext)) return { kind: "image", cat: "image" };
  for (const [cat, exts] of Object.entries(CATS)) if (exts.includes(ext)) return { kind: "file", cat };
  return { kind: "file", cat: "other" };
}

/**
 * 排序键（定长字符串，字典序 = 时间序）：时间 → 行号 → 消息内第几个 → id。同一条消息的几张图时间相同，
 * 只按 id 排就是随机顺序，查看器里「第 n 张」会乱；分页游标也就是它。
 */
function sortKey(tsMs: number, seq: number, idx: number, id: string): string {
  return `${String(Math.max(0, tsMs)).padStart(15, "0")}${String(seq).padStart(10, "0")}${String(idx).padStart(3, "0")}${id}`;
}

function mediaId(agent: string, sessionId: string, r: MediaRef): string {
  const key = r.mid ? `${agent}|${sessionId}|m:${r.mid}|${r.idx}` : `${agent}|${sessionId}|${r.seq}|${r.dir}|${r.idx}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

async function resolveRef(r: { dir: string; path: string; ts: string | null }, dirs: AttachmentDirs, cat: () => InboxCatalog): Promise<Resolved | null> {
  return r.dir === "in" ? resolveInbound(r.path, dirs) : resolveOutbound(r.path, r.ts, dirs, cat());
}

async function upsertRefs(db: Database, src: MediaSource, refs: MediaRef[], dirs: AttachmentDirs, cat: () => InboxCatalog): Promise<void> {
  const rows: (string | number | null)[][] = [];
  for (const r of refs) {
    const hit = await resolveRef(r, dirs, cat);
    const name = hit ? displayName(hit.name) : basename(r.path);
    const { kind, cat: c } = classify(name);
    const tsMs = r.ts ? Date.parse(r.ts) || 0 : 0;
    const id = mediaId(src.agent, src.sessionId, r);
    rows.push([id, src.agent, src.sessionId, r.seq, r.ts, tsMs, sortKey(tsMs, r.seq, r.idx, id), r.dir, r.sender ?? (r.dir === "out" ? src.agent : null),
      name, r.path, hit?.loc ?? null, hit?.size ?? null, hit?.mime ?? null, kind, c, hit?.ambiguous ? 1 : 0, r.prio]);
  }
  const stmt = db.prepare(`INSERT INTO media (id, agent, session_id, seq, ts, ts_ms, sk, dir, sender, name, ref_path, loc, size, mime, kind, cat, ambiguous, prio)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, ts = excluded.ts, ts_ms = excluded.ts_ms, sk = excluded.sk, prio = excluded.prio
    WHERE excluded.prio > media.prio`);
  // 一块一个事务：逐行自动提交在 WAL 下每行一次落盘，一块几十行就能把事件循环卡住几百毫秒
  db.transaction(() => {
    for (const row of rows) stmt.run(...row);
  })();
}

function yieldLoop(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

const IN_MARKS = MEDIA_MARKERS.inbound.map((m) => Buffer.from(m));
const OUT_MARKS = MEDIA_MARKERS.outbound.map((m) => Buffer.from(m));
const OUT_NEEDS = Buffer.from(MEDIA_MARKERS.outboundNeeds);

function positions(buf: Buffer, marks: Buffer[]): number[] {
  const hits: number[] = [];
  for (const m of marks) {
    for (let i = buf.indexOf(m); i >= 0; i = buf.indexOf(m, i + 1)) hits.push(i);
  }
  return hits.sort((a, b) => a - b);
}

/** 游标式判断：[start, end) 里有没有 hits 中的位置（hits 升序，行也按顺序来） */
function cursorIn(hits: number[]): (start: number, end: number) => boolean {
  let h = 0;
  return (start, end) => {
    while (h < hits.length && hits[h] < start) h++;
    return h < hits.length && hits[h] < end;
  };
}

/** 块内逐行：seq 每行加一，命中标记的行才解码、翻译、抽取——整块解码的大字符串会引发几百毫秒的 GC 停顿 */
function refsInChunk(buf: Buffer, seq: number, translate: (line: string) => unknown): { refs: MediaRef[]; seq: number } {
  const hasIn = cursorIn(positions(buf, IN_MARKS));
  const hasOut = cursorIn(positions(buf, OUT_MARKS));
  const refs: MediaRef[] = [];
  // 行数 = 换行数 + 1（空行、结尾空行都算），与 split("\n") 一致
  for (let start = 0; ; ) {
    let end = buf.indexOf(10, start);
    if (end < 0) end = buf.length;
    const hit = hasIn(start, end) || (hasOut(start, end) && buf.subarray(start, end).includes(OUT_NEEDS));
    if (hit) refs.push(...mediaRefsOf(translate(buf.toString("utf8", start, end)), seq));
    seq++;
    if (end >= buf.length) break;
    start = end + 1;
  }
  return { refs, seq };
}

/** 从 offset 读到文件末尾最后一个换行，逐行抽取；返回新的 { offset, nextSeq }。读缓冲复用：每块新分配 1MB 会频繁触发 GC 停顿 */
async function scanFrom(src: MediaSource, size: number, offset: number, seq: number, onRefs: (refs: MediaRef[]) => Promise<void>): Promise<{ offset: number; nextSeq: number }> {
  const fh = await open(src.path, "r");
  try {
    const translate = createLineTranslator(runtimeForSessionPath(src.path));
    let buf = Buffer.allocUnsafe(CHUNK_BYTES);
    let pos = offset;
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - pos), pos);
      if (bytesRead <= 0) break;
      const nl = buf.subarray(0, bytesRead).lastIndexOf(10);
      if (nl < 0) {
        if (pos + bytesRead >= size) break; // 末尾半行（正在写）：下次再读
        buf = Buffer.allocUnsafe(buf.length * 2); // 单行超过一块（内嵌 base64 图片的记录）：放大缓冲重读
        continue;
      }
      const chunk = refsInChunk(buf.subarray(0, nl), seq, translate);
      seq = chunk.seq;
      if (chunk.refs.length) await onRefs(chunk.refs);
      pos += nl + 1;
      await yieldLoop();
    }
    return { offset: pos, nextSeq: seq };
  } finally {
    await fh.close();
  }
}

type SourceRow = { size: number; mtime: number; offset: number; next_seq: number };

/** 扫一个来源文件（增量）。返回是否有新内容被扫过。 */
async function scanSource(db: Database, src: MediaSource, dirs: AttachmentDirs, cat: () => InboxCatalog): Promise<boolean> {
  let st;
  try {
    st = statSync(src.path);
  } catch {
    return false; // 列清单与扫描之间文件被删 / 被归档挪走：下次刷新按新清单来
  }
  const row = db.prepare("SELECT size, mtime, offset, next_seq FROM sources WHERE path = ?").get(src.path) as SourceRow | null;
  if (row && row.size === st.size && row.mtime === st.mtimeMs) return false;
  const grown = row && st.size >= row.offset;
  const start = grown ? { offset: row.offset, seq: row.next_seq } : { offset: 0, seq: 0 };
  const end = await scanFrom(src, st.size, start.offset, start.seq, (refs) => upsertRefs(db, src, refs, dirs, cat));
  db.prepare(`INSERT INTO sources (path, agent, session_id, size, mtime, offset, next_seq) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, offset = excluded.offset, next_seq = excluded.next_seq`)
    .run(src.path, src.agent, src.sessionId, st.size, st.mtimeMs, end.offset, end.nextSeq);
  return true;
}

/** 最近的、还没找到文件的行再解析一次（出站副本晚于 jsonl 记录落盘） */
async function retryMissing(db: Database, dirs: AttachmentDirs, cat: () => InboxCatalog, now: number): Promise<void> {
  const rows = db.prepare("SELECT id, dir, ref_path, ts FROM media WHERE loc IS NULL AND ts_ms > ?").all(now - RETRY_MISSING_MS) as
    { id: string; dir: string; ref_path: string; ts: string | null }[];
  const upd = db.prepare("UPDATE media SET loc = ?, size = ?, mime = ?, name = ?, kind = ?, cat = ?, ambiguous = ? WHERE id = ?");
  for (const r of rows) {
    const hit = await resolveRef({ dir: r.dir, path: r.ref_path, ts: r.ts }, dirs, cat);
    if (!hit) continue;
    const name = displayName(hit.name);
    const { kind, cat: c } = classify(name);
    upd.run(hit.loc, hit.size, hit.mime, name, kind, c, hit.ambiguous ? 1 : 0, r.id);
  }
}

/** 刷新一批来源：逐个增量扫，inbox 快照整批只建一次（要用到才建） */
export async function refreshMediaIndex(db: Database, sources: MediaSource[], dirs: AttachmentDirs, now = Date.now()): Promise<void> {
  let catalog: InboxCatalog | null = null;
  const cat = () => (catalog ??= buildInboxCatalog(dirs));
  for (const s of sources) await scanSource(db, s, dirs, cat);
  await retryMissing(db, dirs, cat, now);
}
