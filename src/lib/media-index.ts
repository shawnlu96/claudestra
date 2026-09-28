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
import { existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { AttachmentDirs } from "./attachment-lookup.js";
import { sanitizeAttachmentBase } from "./attachment-name.js";
import { MEDIA_MARKERS, mediaRefsOf, type MediaRef } from "./media-extract.js";
import { ensureOutboundTable, ledgerCopy, OUT_WINDOW_AFTER_MS, ownedByOther } from "./media-outbound.js";
import { buildInboxCatalog, displayName, resolveInbound, resolveOutbound, type InboxCatalog, type OutboundLedger, type Resolved } from "./media-store.js";
import { createLineTranslator, runtimeForSessionPath } from "./session-source.js";

const SCHEMA_VERSION = 3;
const CHUNK_BYTES = 1024 * 1024;
/** 出站副本可能比 jsonl 记录晚几秒落盘：这么久以内没找到文件的行，下次刷新再解析一次 */
const RETRY_MISSING_MS = 15 * 60_000;

export interface MediaSource {
  agent: string;
  sessionId: string;
  path: string;
}

const dbs = new Map<string, Database>();

function migrate(db: Database, onReset?: () => void): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000"); // 同进程多条请求并发刷新 / 读，别一撞锁就 500
  const ver = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (ver !== SCHEMA_VERSION) {
    db.exec("DROP TABLE IF EXISTS media; DROP TABLE IF EXISTS sources;");
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    onReset?.(); // 行 id 对应的内容可能变了：缩略图缓存要跟着清
  }
  db.exec(`CREATE TABLE IF NOT EXISTS sources (
    path TEXT PRIMARY KEY, agent TEXT NOT NULL, session_id TEXT NOT NULL, size INTEGER NOT NULL, mtime REAL NOT NULL,
    offset INTEGER NOT NULL, next_seq INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY, agent TEXT NOT NULL, session_id TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT, ts_ms INTEGER NOT NULL, sk TEXT NOT NULL,
    dir TEXT NOT NULL, sender TEXT, sender_id TEXT, name TEXT NOT NULL, ref_path TEXT NOT NULL, ref_base TEXT NOT NULL, loc TEXT, size INTEGER,
    mime TEXT, kind TEXT NOT NULL, cat TEXT NOT NULL, trusted INTEGER NOT NULL, ambiguous INTEGER NOT NULL DEFAULT 0, prio INTEGER NOT NULL)`);
  db.exec("CREATE INDEX IF NOT EXISTS media_sk ON media(sk)");
  db.exec("CREATE INDEX IF NOT EXISTS media_agent ON media(agent, ts_ms)");
  db.exec("CREATE INDEX IF NOT EXISTS media_loc ON media(loc)");
  db.exec("CREATE INDEX IF NOT EXISTS media_out ON media(dir, ref_base, ts_ms)");
  ensureOutboundTable(db);
}

/** 删掉库文件（含 WAL / SHM）：库坏了就重建，索引都能从 jsonl 重扫出来 */
function dropFiles(path: string): void {
  for (const f of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(f)) unlinkSync(f);
  }
}

/** 打开（缓存）索引库；打不开或迁移失败 = 库坏了，删掉重建一次 */
export function openMediaIndex(path: string, onReset?: () => void): Database {
  const hit = dbs.get(path);
  if (hit) return hit;
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  let db = new Database(path);
  try {
    migrate(db, onReset);
  } catch (e) {
    console.error(`[media] 索引库打不开，重建: ${(e as Error).message}`);
    db.close();
    dropFiles(path);
    db = new Database(path);
    migrate(db, onReset);
  }
  dbs.set(path, db);
  return db;
}

/** 运行中查询报库损坏时调用：关掉、删文件，下次 openMediaIndex 重建（出站副本账本也随之丢失，老副本退回按名字猜） */
export function resetMediaIndex(path: string): void {
  closeMediaIndex(path);
  if (path !== ":memory:") dropFiles(path);
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

/** 一次刷新共用的上下文：库、目录、inbox 快照（要用到才建） */
interface Ctx {
  db: Database;
  dirs: AttachmentDirs;
  cat: () => InboxCatalog;
}

function ledgerFor(ctx: Ctx, agent: string): OutboundLedger {
  const others = ctx.db.prepare("SELECT 1 FROM media WHERE dir = 'out' AND ref_base = ? AND agent != ? AND ts_ms BETWEEN ? AND ? LIMIT 1");
  return {
    copyFor: (src, t) => ledgerCopy(ctx.db, agent, src, t),
    ownedByOther: (dest) => ownedByOther(ctx.db, agent, dest),
    othersSentSameName: (base, t) => !!others.get(base, agent, t - OUT_WINDOW_AFTER_MS, t + OUT_WINDOW_AFTER_MS),
  };
}

function resolveRef(ctx: Ctx, agent: string, r: { dir: string; path: string; ts: string | null; trusted: boolean }): Promise<Resolved | null> | Resolved | null {
  return r.dir === "in" ? resolveInbound(r.path, ctx.dirs, r.trusted) : resolveOutbound(r.path, r.ts, ctx.dirs, ctx.cat(), ledgerFor(ctx, agent));
}

/**
 * 展示名：可信且找到的按实际文件名，其余一律按记录里的 basename——不可信的引用若按「找没找到」换算法，
 * 名字本身就泄露了文件在不在（审查 r2 P2-1）。
 */
function shown(hit: Resolved | null, refPath: string): { name: string; kind: string; cat: string } {
  const name = hit?.trusted ? displayName(hit.name, hit.loc.startsWith("u:")) : displayName(basename(refPath), refPath.includes("/web/uploads/"));
  return { name, ...classify(name) };
}

async function upsertRefs(ctx: Ctx, src: MediaSource, refs: MediaRef[]): Promise<void> {
  const rows: (string | number | null)[][] = [];
  for (const r of refs) {
    const hit = await resolveRef(ctx, src.agent, r);
    const { name, kind, cat } = shown(hit, r.path);
    const tsMs = r.ts ? Date.parse(r.ts) || 0 : 0;
    const id = mediaId(src.agent, src.sessionId, r);
    rows.push([id, src.agent, src.sessionId, r.seq, r.ts, tsMs, sortKey(tsMs, r.seq, r.idx, id), r.dir, r.sender ?? (r.dir === "out" ? src.agent : null),
      r.senderId ?? null, name, r.path, sanitizeAttachmentBase(r.path), hit?.loc ?? null, hit?.size ?? null, hit?.mime ?? null, kind, cat,
      // 没找到文件时记引用本身的可信度（入站头属性 = 可信），retryMissing 找到文件后照它重算
      (hit ? hit.trusted : r.trusted) ? 1 : 0, hit?.ambiguous ? 1 : 0, r.prio]);
  }
  const stmt = ctx.db.prepare(`INSERT INTO media (id, agent, session_id, seq, ts, ts_ms, sk, dir, sender, sender_id, name, ref_path, ref_base, loc, size,
    mime, kind, cat, trusted, ambiguous, prio) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, ts = excluded.ts, ts_ms = excluded.ts_ms, sk = excluded.sk, prio = excluded.prio
    WHERE excluded.prio > media.prio`);
  // 一块一个事务：逐行自动提交在 WAL 下每行一次落盘，一块几十行就能把事件循环卡住几百毫秒
  ctx.db.transaction(() => {
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
async function scanSource(ctx: Ctx, src: MediaSource): Promise<boolean> {
  const { db } = ctx;
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
  const end = await scanFrom(src, st.size, start.offset, start.seq, (refs) => upsertRefs(ctx, src, refs));
  db.prepare(`INSERT INTO sources (path, agent, session_id, size, mtime, offset, next_seq) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, offset = excluded.offset, next_seq = excluded.next_seq`)
    .run(src.path, src.agent, src.sessionId, st.size, st.mtimeMs, end.offset, end.nextSeq);
  return true;
}

/** 最近的、还没找到文件的行再解析一次（出站副本晚于 jsonl 记录落盘；窗口外的副本 resolveOutbound 本身就不认） */
async function retryMissing(ctx: Ctx, now: number): Promise<void> {
  const rows = ctx.db.prepare("SELECT id, agent, dir, ref_path, ts, trusted FROM media WHERE loc IS NULL AND ts_ms > ?").all(now - RETRY_MISSING_MS) as
    { id: string; agent: string; dir: string; ref_path: string; ts: string | null; trusted: number }[];
  const upd = ctx.db.prepare("UPDATE media SET loc = ?, size = ?, mime = ?, name = ?, kind = ?, cat = ?, trusted = ?, ambiguous = ? WHERE id = ?");
  for (const r of rows) {
    // 入站：行里记的是引用的可信度（头属性来的才是 1）；出站由账本重新决定
    const hit = await resolveRef(ctx, r.agent, { dir: r.dir, path: r.ref_path, ts: r.ts, trusted: r.dir === "in" && r.trusted === 1 });
    if (!hit) continue;
    const { name, kind, cat } = shown(hit, r.ref_path);
    upd.run(hit.loc, hit.size, hit.mime, name, kind, cat, hit.trusted ? 1 : 0, hit.ambiguous ? 1 : 0, r.id);
  }
}

/** 回收：清单里已经没有的会话文件（被删 / 换了路径）连同它们的行一起删掉 */
function collect(db: Database, sources: MediaSource[]): void {
  const keep = new Set(sources.map((s) => s.path));
  const sessions = new Set(sources.map((s) => `${s.agent}|${s.sessionId}`));
  const gone = (db.prepare("SELECT path FROM sources").all() as { path: string }[]).filter((r) => !keep.has(r.path));
  const stale = (db.prepare("SELECT DISTINCT agent, session_id FROM media").all() as { agent: string; session_id: string }[])
    .filter((r) => !sessions.has(`${r.agent}|${r.session_id}`));
  db.transaction(() => {
    for (const g of gone) db.prepare("DELETE FROM sources WHERE path = ?").run(g.path);
    for (const r of stale) db.prepare("DELETE FROM media WHERE agent = ? AND session_id = ?").run(r.agent, r.session_id);
  })();
}

/**
 * 刷新一批来源：逐个增量扫。complete = 这是全部 agent 的完整清单，可以顺带回收消失的会话
 * （只刷一部分时回收会把别的 agent 的行当成消失删掉）。
 */
export async function refreshMediaIndex(db: Database, sources: MediaSource[], dirs: AttachmentDirs, opts: { now?: number; complete?: boolean } = {}): Promise<void> {
  let catalog: InboxCatalog | null = null;
  const ctx: Ctx = { db, dirs, cat: () => (catalog ??= buildInboxCatalog(dirs)) };
  for (const s of sources) await scanSource(ctx, s);
  await retryMissing(ctx, opts.now ?? Date.now());
  if (opts.complete) collect(db, sources);
}
