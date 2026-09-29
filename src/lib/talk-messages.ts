/**
 * talk 的消息。主键 (origin, id)：origin 是写这条消息的实例指纹（一期都是本机），二期同一 id 从两个实例发来互不影响。
 * 副作用（推送、SSE、开 ask）只在「这次真的插进去了」时触发：insertMessage 返回 false 表示重复，调用方什么都不做。
 * 删除 = 清空正文、附件、引用、@，只留主键和 deletedAt，去重仍然有效；删除不同步给别的实例。
 */
import type { Database } from "bun:sqlite";
import { touchRoom, type RoomRef } from "./talk-rooms.js";
import { TALK_MSG_ID_RE } from "./talk-schema.js";

const TEXT_MAX = 8000;
const ATTS_MAX = 9;
const REFS_MAX = 5;
const REF_KINDS = ["message", "task", "ask", "doc"] as const;
type RefKind = (typeof REF_KINDS)[number];

/** 引用卡片：存定位信息和一份标题快照；打开时按查看者的权限实时校验，没权限只显示快照标题（talk-refs.ts） */
export interface TalkRef {
  kind: RefKind;
  /** message：agent 名；task / doc：项目；ask：不用 */
  scope: string;
  /** message：消息 id；task：任务号；ask：askId；doc：文档相对路径 */
  id: string;
  title: string;
}

export interface TalkMessage {
  origin: string;
  id: string;
  room: RoomRef;
  authorKey: string;
  text: string;
  atts: string[];
  refs: TalkRef[];
  mentions: string[];
  createdAt: number;
  deletedAt: number | null;
}

export interface Draft {
  id: string;
  text: string;
  atts: string[];
  refs: TalkRef[];
  mentions: string[];
}

const SHA_RE = /^[0-9a-f]{64}$/;
const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const strList = (v: unknown, max: number, ok: (s: string) => boolean): string[] | null =>
  v === undefined ? [] : Array.isArray(v) && v.length <= max && v.every((s) => typeof s === "string" && ok(s)) ? [...new Set(v as string[])] : null;

function parseRef(v: unknown): TalkRef | null {
  const r = (v ?? {}) as Record<string, unknown>;
  if (!REF_KINDS.includes(r.kind as RefKind) || !isStr(r.scope, 128) || !isStr(r.id, 256) || !r.id || !isStr(r.title, 200)) return null;
  return { kind: r.kind as RefKind, scope: r.scope, id: r.id, title: r.title };
}

/** 网页发来的草稿：形状不对返回错误文案（调用方回 400）。@ 的对象是不是房间成员由调用方判 */
export function parseDraft(body: Record<string, unknown>): Draft | string {
  if (typeof body.id !== "string" || !TALK_MSG_ID_RE.test(body.id)) return "id must match tm_<uuid>";
  const text = typeof body.text === "string" ? body.text.replace(/\r\n?/g, "\n").trim() : null;
  if (text === null || text.length > TEXT_MAX) return `text must be a string of at most ${TEXT_MAX} chars`;
  const atts = strList(body.atts, ATTS_MAX, (s) => SHA_RE.test(s));
  if (!atts) return `atts must be at most ${ATTS_MAX} sha256 strings`;
  const mentions = strList(body.mentions, 20, (s) => s.startsWith("local:") && s.length <= 80);
  if (!mentions) return "mentions must be local person ids";
  const rawRefs = body.refs === undefined ? [] : body.refs;
  if (!Array.isArray(rawRefs) || rawRefs.length > REFS_MAX) return `refs must be an array of at most ${REFS_MAX}`;
  const refs = rawRefs.map(parseRef);
  if (refs.some((r) => !r)) return "each ref needs kind / scope / id / title";
  if (!text && !atts.length && !refs.length) return "empty message";
  return { id: body.id, text, atts, refs: refs as TalkRef[], mentions };
}

const parseJson = <T>(s: unknown, fallback: T): T => {
  try {
    return JSON.parse(String(s)) as T;
  } catch {
    // 库里的 JSON 列只由本模块写；真坏了按空处理，别让一条坏行拖垮整个房间的列表
    return fallback;
  }
};

const rowToMessage = (r: Record<string, unknown>): TalkMessage => ({
  origin: String(r.origin), id: String(r.id), room: { creatorFp: String(r.roomFp), id: String(r.roomId) }, authorKey: String(r.authorKey),
  text: String(r.text), atts: parseJson(r.atts, []), refs: parseJson(r.refs, []), mentions: parseJson(r.mentions, []),
  createdAt: Number(r.createdAt), deletedAt: r.deletedAt === null || r.deletedAt === undefined ? null : Number(r.deletedAt),
});

/** 插入一条；重复 (origin, id) 返回 false 且不动任何东西。附件引用、房间 lastAt 同一事务 */
export function insertMessage(db: Database, m: Omit<TalkMessage, "deletedAt">): boolean {
  return db.transaction(() => {
    const r = db.prepare(
      "INSERT OR IGNORE INTO messages (origin, id, roomFp, roomId, authorKey, text, atts, refs, mentions, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(m.origin, m.id, m.room.creatorFp, m.room.id, m.authorKey, m.text, JSON.stringify(m.atts), JSON.stringify(m.refs), JSON.stringify(m.mentions), m.createdAt);
    if (r.changes !== 1) return false;
    const ref = db.prepare("INSERT OR IGNORE INTO att_refs (sha256, refKind, refId) VALUES (?, 'msg', ?)");
    for (const sha of m.atts) ref.run(sha, `${m.origin}/${m.id}`);
    touchRoom(db, m.room, m.createdAt);
    return true;
  }).immediate();
}

export function getMessage(db: Database, origin: string, id: string): TalkMessage | null {
  const r = db.prepare("SELECT * FROM messages WHERE origin = ? AND id = ?").get(origin, id) as Record<string, unknown> | null;
  return r ? rowToMessage(r) : null;
}

/** 一页消息（时间正序）：before = 只要比这个 createdAt 早的；limit 最多 200 */
export function listMessages(db: Database, room: RoomRef, opts: { before?: number; limit?: number } = {}): TalkMessage[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = db.prepare(
    "SELECT * FROM messages WHERE roomFp = ? AND roomId = ? AND createdAt < ? ORDER BY createdAt DESC, id DESC LIMIT ?",
  ).all(room.creatorFp, room.id, opts.before ?? Number.MAX_SAFE_INTEGER, limit) as Record<string, unknown>[];
  return rows.map(rowToMessage).reverse();
}

/**
 * 删除：清空正文与附件引用，返回因此没人再引用的附件 sha（调用方删文件、删 atts 行）。已删的再删返回 null。
 */
export function deleteMessage(db: Database, origin: string, id: string, now = Date.now()): string[] | null {
  return db.transaction(() => {
    const r = db.prepare("UPDATE messages SET text = '', atts = '[]', refs = '[]', mentions = '[]', deletedAt = ? WHERE origin = ? AND id = ? AND deletedAt IS NULL")
      .run(now, origin, id);
    if (r.changes !== 1) return null;
    const shas = (db.prepare("DELETE FROM att_refs WHERE refKind = 'msg' AND refId = ? RETURNING sha256").all(`${origin}/${id}`) as { sha256: string }[]).map((x) => x.sha256);
    return shas.filter((sha) => !db.prepare("SELECT 1 FROM att_refs WHERE sha256 = ? LIMIT 1").get(sha));
  }).immediate();
}
