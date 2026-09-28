/**
 * 媒体索引的查询：按 agent 白名单 + 筛选条件分页（时间倒序，游标 = 排序键 sk，见 media-index.sortKey），以及大图查看器的「围绕某一张取一窗」。
 *
 * 权限在这里收口成一个布尔（isRestricted）：绑定不可信（正文里手写的标记、没账的出站副本）、出站认领有歧义、
 * 同一文件被不止一个 agent 认领——对非 manage 调用方都只给占位，不给取文件，也不给大小和类型。
 * 不可信行对非 manage 与「文件不存在」长得一模一样，否则 restricted 本身就能拿来探测某个文件名在不在（T22 审查 P0）。
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
  id: string; agent: string; session_id: string; seq: number; ts: string | null; sk: string; dir: "in" | "out"; sender: string | null;
  sender_id: string | null; name: string; loc: string | null; size: number | null; mime: string | null; kind: "image" | "file"; cat: string;
  trusted: number; ambiguous: number; shared: number;
};

/**
 * 同一个文件被不同 agent 的消息可信地认领 = shared（例如转交时 bridge 给两边都写了头属性）。
 * 只数可信认领：不可信的手写标记要是也算，任何 guest 都能往自己 agent 里写个名字，把别的 agent 的文件弄成对它的 guest 不可见。
 */
const SHARED_SQL = "(loc IS NOT NULL AND EXISTS (SELECT 1 FROM media m2 WHERE m2.loc = media.loc AND m2.agent != media.agent AND m2.trusted = 1))";
const COLS = `id, agent, session_id, seq, ts, sk, dir, sender, sender_id, name, loc, size, mime, kind, cat, trusted, ambiguous, ${SHARED_SQL} AS shared`;

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

export function isRestricted(row: { trusted: number; ambiguous: number; shared: number }, manage: boolean): boolean {
  return !manage && (row.trusted !== 1 || row.ambiguous === 1 || row.shared === 1);
}

/** 取文件是否还在（列表里逐项核，已删的文件别显示成可用） */
type LocExists = (loc: string) => boolean;

/** 一行 → 返回体里的一项（字段契约见 web/lib/api/media.ts 的 MediaItem）。available = 找到了副本、对调用方不受限、文件还在 */
function toItem(r: Row, manage: boolean, exists: LocExists) {
  const blocked = r.loc != null && isRestricted(r, manage);
  // 可信但有歧义 / 被共享的行给 restricted 占位；不可信的行对非 manage 就当文件不在
  const restricted = blocked && r.trusted === 1;
  const available = r.loc != null && !blocked && exists(r.loc);
  return {
    id: r.id, agent: r.agent, sessionId: r.session_id, seq: r.seq, ts: r.ts, dir: r.dir, sender: r.sender, senderId: r.sender_id, name: r.name,
    size: blocked ? null : r.size, mime: blocked ? null : r.mime, kind: r.kind, cat: r.cat, available, ...(restricted ? { restricted } : {}),
  };
}

const SK_RE = /^\d{28}[0-9a-f]{24}$/;
const skOf = (c: string | null | undefined): string | null => (c && SK_RE.test(c) ? c : null);

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

type Where = { sql: string; args: (string | number)[] };
/** 调用方：有没有 manage、怎么核文件在不在 */
export type Viewer = { manage: boolean; exists: LocExists };

function fetchOlder(db: Database, w: Where, cur: string | null, limit: number, inclusive = false): Row[] {
  const cond = cur ? (inclusive ? " AND sk <= ?" : " AND sk < ?") : "";
  return db.prepare(`SELECT ${COLS} FROM media WHERE ${w.sql}${cond} ORDER BY sk DESC LIMIT ?`).all(...w.args, ...(cur ? [cur] : []), limit) as Row[];
}

function fetchNewer(db: Database, w: Where, cur: string, limit: number): Row[] {
  return (db.prepare(`SELECT ${COLS} FROM media WHERE ${w.sql} AND sk > ? ORDER BY sk ASC LIMIT ?`).all(...w.args, cur, limit) as Row[]).reverse();
}

function page(db: Database, w: Where, rows: Row[], v: Viewer, hasOlder: boolean, hasNewer: boolean): MediaPage {
  const first = rows[0];
  const last = rows[rows.length - 1];
  return {
    items: rows.map((r) => toItem(r, v.manage, v.exists)),
    older: last && hasOlder ? last.sk : null,
    newer: first && hasNewer ? first.sk : null,
    total: countWhere(db, w),
    newerCount: first ? countWhere(db, w, " AND sk > ?", [first.sk]) : 0,
  };
}

/** 普通分页：before（往更早翻）/ after（往更新翻）二选一，都不给 = 最新一页 */
export function queryMedia(db: Database, f: MediaFilter, opts: { before?: string | null; after?: string | null; limit: number }, v: Viewer): MediaPage {
  const w = where(f);
  const after = skOf(opts.after);
  if (after) {
    const rows = fetchNewer(db, w, after, opts.limit + 1);
    const more = rows.length > opts.limit;
    const kept = more ? rows.slice(1) : rows;
    return page(db, w, kept, v, true, more);
  }
  const before = skOf(opts.before);
  const rows = fetchOlder(db, w, before, opts.limit + 1);
  const more = rows.length > opts.limit;
  const kept = rows.slice(0, opts.limit);
  return page(db, w, kept, v, more, !!before && kept.length > 0);
}

/**
 * 找锚点：媒体 id，或气泡里的文件名（展示名 / 落盘名 / agent 原路径的 basename）。
 * 带了 session + seq 区间（气泡覆盖的记录范围）就只在这个区间里找，找不到就是找不到——
 * 退回「seq 之前最近的同名」会把同名旧图当成这一张打开（T22 审查 P1-3），调用方收到 404 退回只翻气泡里的几张。
 */
export function findAnchor(db: Database, f: MediaFilter, key: { id?: string; name?: string; sessionId?: string; seqFrom?: number; seqTo?: number }): { sk: string; id: string } | null {
  const w = where(f);
  if (key.id) {
    return (db.prepare(`SELECT sk, id FROM media WHERE ${w.sql} AND id = ?`).get(...w.args, key.id) as { sk: string; id: string } | null) ?? null;
  }
  if (!key.name) return null;
  const n = key.name;
  const nameSql = "(name = ? OR loc LIKE ? ESCAPE '\\' OR ref_path LIKE ? ESCAPE '\\' OR ref_path = ?)";
  const esc = n.replace(/[\\%_]/g, (c) => `\\${c}`);
  const nameArgs = [n, `%:${esc}`, `%/${esc}`, n];
  const exact = key.sessionId && key.seqTo != null;
  const at = exact ? " AND session_id = ? AND seq BETWEEN ? AND ? ORDER BY sk ASC" : " ORDER BY sk DESC";
  const atArgs = exact ? [key.sessionId!, key.seqFrom ?? key.seqTo!, key.seqTo!] : [];
  return (db.prepare(`SELECT sk, id FROM media WHERE ${w.sql} AND ${nameSql}${at} LIMIT 1`).get(...w.args, ...nameArgs, ...atArgs) as
    { sk: string; id: string } | null) ?? null;
}

/** 围绕锚点取一窗：锚点 + 更新的 half 条 + 更早的 half 条 */
export function queryAround(db: Database, f: MediaFilter, anchor: { sk: string; id: string }, half: number, v: Viewer): MediaPage & { anchor: string } {
  const w = where(f);
  const cur = anchor.sk;
  const newer = fetchNewer(db, w, cur, half + 1);
  const hasNewer = newer.length > half;
  const older = fetchOlder(db, w, cur, half + 2, true);
  const hasOlder = older.length > half + 1;
  const rows = [...(hasNewer ? newer.slice(1) : newer), ...older.slice(0, half + 1)];
  return { ...page(db, w, rows, v, hasOlder, hasNewer), anchor: anchor.id };
}

/** 取文件用：按 id 取一行（scope 由调用方按返回的 agent 核），带可信 / 歧义 / 共享标记 */
export function mediaRow(db: Database, id: string): { loc: string | null; name: string; agent: string; trusted: number; ambiguous: number; shared: number } | null {
  if (!/^[0-9a-f]{24}$/.test(id)) return null;
  return (db.prepare(`SELECT loc, name, agent, trusted, ambiguous, ${SHARED_SQL} AS shared FROM media WHERE id = ?`).get(id) as ReturnType<typeof mediaRow>) ?? null;
}
