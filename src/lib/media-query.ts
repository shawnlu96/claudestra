/**
 * 媒体索引的查询：按 agent 白名单 + 筛选条件分页（时间倒序，游标 = `<ts_ms>_<id>`），以及大图查看器的「围绕某一张取一窗」。
 *
 * 权限在这里收口成一个布尔：`restricted` 行（出站副本认领有歧义，或同一个文件被不止一个 agent 的消息认领）
 * 对非 manage 调用方只给元数据、不给取文件——宁可显示占位，也不冒把别的 agent 的文件串给 scoped 用户的险。
 * 返回体不含任何服务器路径（loc / ref_path 只在服务端用）。
 */
import type { Database } from "bun:sqlite";

export interface MediaFilter {
  /** 调用方 scope 内、且被请求的 agent（空数组 = 什么都看不到） */
  agents: string[];
  kind?: "image" | "file";
  dir?: "in" | "out";
  /** 文件大类（media-index.classify） */
  cat?: string;
  /** 文件名子串 */
  q?: string;
  /** ts_ms 区间 [since, until) */
  since?: number;
  until?: number;
}

type Row = {
  id: string; agent: string; session_id: string; seq: number; ts: string | null; ts_ms: number; dir: "in" | "out"; sender: string | null;
  name: string; loc: string | null; size: number | null; mime: string | null; kind: "image" | "file"; cat: string; ambiguous: number; shared: number;
};

/** 同一个文件被不同 agent 的消息认领 = shared（跨 agent 串文件的唯一通道） */
const SHARED_SQL = "(loc IS NOT NULL AND EXISTS (SELECT 1 FROM media m2 WHERE m2.loc = media.loc AND m2.agent != media.agent))";
const COLS = `id, agent, session_id, seq, ts, ts_ms, dir, sender, name, loc, size, mime, kind, cat, ambiguous, ${SHARED_SQL} AS shared`;

function where(f: MediaFilter): { sql: string; args: (string | number)[] } {
  const parts = [`agent IN (${f.agents.map(() => "?").join(",") || "NULL"})`];
  const args: (string | number)[] = [...f.agents];
  if (f.kind) (parts.push("kind = ?"), args.push(f.kind));
  if (f.dir) (parts.push("dir = ?"), args.push(f.dir));
  if (f.cat) (parts.push("cat = ?"), args.push(f.cat));
  if (f.since != null) (parts.push("ts_ms >= ?"), args.push(f.since));
  if (f.until != null) (parts.push("ts_ms < ?"), args.push(f.until));
  if (f.q) {
    parts.push("name LIKE ? ESCAPE '\\'");
    args.push(`%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  return { sql: parts.join(" AND "), args };
}

export function isRestricted(row: { ambiguous: number; shared: number }, manage: boolean): boolean {
  return !manage && (row.ambiguous === 1 || row.shared === 1);
}

/** 一行 → 返回体里的一项（字段契约见 web/lib/api/media.ts 的 MediaItem）。available = 找到了副本且对调用方不受限 */
function toItem(r: Row, manage: boolean) {
  const restricted = r.loc != null && isRestricted(r, manage);
  return {
    id: r.id, agent: r.agent, sessionId: r.session_id, seq: r.seq, ts: r.ts, dir: r.dir, sender: r.sender, name: r.name,
    size: r.size, mime: r.mime, kind: r.kind, cat: r.cat, available: r.loc != null && !restricted, ...(restricted ? { restricted } : {}),
  };
}

function cursorOf(r: { ts_ms: number; id: string }): string {
  return `${r.ts_ms}_${r.id}`;
}

function parseCursor(c: string | null | undefined): { t: number; id: string } | null {
  const m = c ? /^(\d{1,16})_([0-9a-f]{24})$/.exec(c) : null;
  return m ? { t: Number(m[1]), id: m[2] } : null;
}

export interface MediaPage {
  items: ReturnType<typeof toItem>[];
  /** 更早一页的游标（没有了 = null） */
  older: string | null;
  /** 更新一页的游标（没有了 = null） */
  newer: string | null;
  total: number;
  /** items[0] 之前（更新）还有多少条——查看器算「第 n 张」用 */
  newerCount: number;
}

function countWhere(db: Database, w: { sql: string; args: (string | number)[] }, extra = "", extraArgs: (string | number)[] = []): number {
  const r = db.prepare(`SELECT COUNT(*) AS n FROM media WHERE ${w.sql}${extra}`).get(...w.args, ...extraArgs) as { n: number };
  return r.n;
}

const NEWER_THAN = " AND (ts_ms > ? OR (ts_ms = ? AND id > ?))";
const OLDER_THAN = " AND (ts_ms < ? OR (ts_ms = ? AND id < ?))";

function fetchOlder(db: Database, w: { sql: string; args: (string | number)[] }, cur: { t: number; id: string } | null, limit: number, inclusive = false): Row[] {
  const cond = cur ? (inclusive ? " AND (ts_ms < ? OR (ts_ms = ? AND id <= ?))" : OLDER_THAN) : "";
  const args = cur ? [cur.t, cur.t, cur.id] : [];
  return db.prepare(`SELECT ${COLS} FROM media WHERE ${w.sql}${cond} ORDER BY ts_ms DESC, id DESC LIMIT ?`).all(...w.args, ...args, limit) as Row[];
}

function fetchNewer(db: Database, w: { sql: string; args: (string | number)[] }, cur: { t: number; id: string }, limit: number): Row[] {
  const rows = db.prepare(`SELECT ${COLS} FROM media WHERE ${w.sql}${NEWER_THAN} ORDER BY ts_ms ASC, id ASC LIMIT ?`).all(...w.args, cur.t, cur.t, cur.id, limit) as Row[];
  return rows.reverse();
}

function page(db: Database, w: { sql: string; args: (string | number)[] }, rows: Row[], manage: boolean, hasOlder: boolean, hasNewer: boolean): MediaPage {
  const first = rows[0];
  const last = rows[rows.length - 1];
  const newerCount = first ? countWhere(db, w, NEWER_THAN, [first.ts_ms, first.ts_ms, first.id]) : 0;
  return {
    items: rows.map((r) => toItem(r, manage)),
    older: last && hasOlder ? cursorOf(last) : null,
    newer: first && hasNewer ? cursorOf(first) : null,
    total: countWhere(db, w),
    newerCount,
  };
}

/** 普通分页：before（往更早翻）/ after（往更新翻）二选一，都不给 = 最新一页 */
export function queryMedia(db: Database, f: MediaFilter, opts: { before?: string | null; after?: string | null; limit: number; manage: boolean }): MediaPage {
  const w = where(f);
  const after = parseCursor(opts.after);
  if (after) {
    const rows = fetchNewer(db, w, after, opts.limit + 1);
    const more = rows.length > opts.limit;
    const kept = more ? rows.slice(1) : rows;
    return page(db, w, kept, opts.manage, true, more);
  }
  const before = parseCursor(opts.before);
  const rows = fetchOlder(db, w, before, opts.limit + 1);
  const more = rows.length > opts.limit;
  const kept = rows.slice(0, opts.limit);
  return page(db, w, kept, opts.manage, more, !!before && kept.length > 0);
}

/** 找锚点：媒体 id，或气泡里的文件名（展示名 / 落盘名 / agent 原路径的 basename），可带 sessionId + seq 精确到那一条 */
export function findAnchor(db: Database, f: MediaFilter, key: { id?: string; name?: string; sessionId?: string; seq?: number }): { ts_ms: number; id: string } | null {
  const w = where(f);
  if (key.id) {
    return (db.prepare(`SELECT ts_ms, id FROM media WHERE ${w.sql} AND id = ?`).get(...w.args, key.id) as { ts_ms: number; id: string } | null) ?? null;
  }
  if (!key.name) return null;
  const n = key.name;
  const nameSql = "(name = ? OR loc LIKE ? ESCAPE '\\' OR ref_path LIKE ? ESCAPE '\\' OR ref_path = ?)";
  const esc = n.replace(/[\\%_]/g, (c) => `\\${c}`);
  const nameArgs = [n, `%:${esc}`, `%/${esc}`, n];
  const at = key.sessionId && key.seq != null ? " AND session_id = ? AND seq <= ? ORDER BY seq DESC" : " ORDER BY ts_ms DESC";
  const atArgs = key.sessionId && key.seq != null ? [key.sessionId, key.seq] : [];
  return (db.prepare(`SELECT ts_ms, id FROM media WHERE ${w.sql} AND ${nameSql}${at} LIMIT 1`).get(...w.args, ...nameArgs, ...atArgs) as
    { ts_ms: number; id: string } | null) ?? null;
}

/** 围绕锚点取一窗：锚点 + 更新的 half 条 + 更早的 half 条 */
export function queryAround(db: Database, f: MediaFilter, anchor: { ts_ms: number; id: string }, half: number, manage: boolean): MediaPage & { anchor: string } {
  const w = where(f);
  const cur = { t: anchor.ts_ms, id: anchor.id };
  const newer = fetchNewer(db, w, cur, half + 1);
  const hasNewer = newer.length > half;
  const older = fetchOlder(db, w, cur, half + 2, true);
  const hasOlder = older.length > half + 1;
  const rows = [...(hasNewer ? newer.slice(1) : newer), ...older.slice(0, half + 1)];
  return { ...page(db, w, rows, manage, hasOlder, hasNewer), anchor: anchor.id };
}

/** 取文件用：按 id 取一行（scope 由调用方按返回的 agent 核），带歧义 / 共享标记 */
export function mediaRow(db: Database, id: string): { loc: string | null; name: string; mime: string | null; ambiguous: number; shared: number; agent: string } | null {
  if (!/^[0-9a-f]{24}$/.test(id)) return null;
  return (db.prepare(`SELECT loc, name, mime, ambiguous, agent, ${SHARED_SQL} AS shared FROM media WHERE id = ?`).get(id) as ReturnType<typeof mediaRow>) ?? null;
}
