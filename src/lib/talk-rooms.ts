/**
 * talk 的房间与成员。成员在建房时定下，之后不增不减（不做群管理）。能不能看一个房间 = 查看者名下的成员键里有没有一个在 members 里，
 * 网页列表、单个房间、消息、附件、SSE 五处都经 isMember 这一个判定。
 * dm 的 id 由两个成员键算：hex(sha256(a + "\n" + b))，a、b 按字节序排好（二期接收方自己重算，不采信帧里的 id）。
 */
import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { DM_ID_RE, THREAD_ID_RE } from "./talk-schema.js";

export interface RoomRef {
  creatorFp: string;
  id: string;
}
export interface Room extends RoomRef {
  kind: "dm" | "thread";
  title: string | null;
  createdBy: string;
  createdAt: number;
  lastAt: number;
  members: string[];
}

export const memberKey = (fp: string, principal: string): string => `${fp.toLowerCase()}/${principal}`;
/** 成员键里的 principal（`<fp>/` 之后的部分） */
export const principalOfKey = (key: string): string => key.slice(key.indexOf("/") + 1);

export function dmRoomId(a: string, b: string): string {
  const [x, y] = [a, b].sort((p, q) => Buffer.compare(Buffer.from(p, "utf8"), Buffer.from(q, "utf8")));
  return createHash("sha256").update(`${x}\n${y}`, "utf8").digest("hex");
}

/** URL 里用的房间键：dm 就是 id，thread 是 `<creatorFp>:<id>`（fp 与 id 都不含冒号） */
export const roomKey = (r: RoomRef): string => (r.creatorFp ? `${r.creatorFp}:${r.id}` : r.id);

export function parseRoomKey(key: string): RoomRef | null {
  if (DM_ID_RE.test(key)) return { creatorFp: "", id: key };
  const i = key.indexOf(":");
  if (i <= 0) return null;
  const ref = { creatorFp: key.slice(0, i), id: key.slice(i + 1) };
  return THREAD_ID_RE.test(ref.id) ? ref : null;
}

function membersOf(db: Database, r: RoomRef): string[] {
  return (db.prepare("SELECT memberKey FROM members WHERE roomFp = ? AND roomId = ? ORDER BY memberKey").all(r.creatorFp, r.id) as { memberKey: string }[]).map((m) => m.memberKey);
}

function rowToRoom(db: Database, row: Record<string, unknown>): Room {
  const ref = { creatorFp: String(row.creatorFp), id: String(row.id) };
  return {
    ...ref, kind: row.kind as Room["kind"], title: (row.title as string | null) ?? null, createdBy: String(row.createdBy),
    createdAt: Number(row.createdAt), lastAt: Number(row.lastAt), members: membersOf(db, ref),
  };
}

export function getRoom(db: Database, r: RoomRef): Room | null {
  const row = db.prepare("SELECT * FROM rooms WHERE creatorFp = ? AND id = ?").get(r.creatorFp, r.id) as Record<string, unknown> | null;
  return row ? rowToRoom(db, row) : null;
}

/** keys = 查看者名下的所有成员键（合并过的人有多个）；任一在房间里就算成员 */
export function isMember(db: Database, r: RoomRef, keys: readonly string[]): boolean {
  if (!keys.length) return false;
  const marks = keys.map(() => "?").join(",");
  return !!db.prepare(`SELECT 1 FROM members WHERE roomFp = ? AND roomId = ? AND memberKey IN (${marks}) LIMIT 1`).get(r.creatorFp, r.id, ...keys);
}

export function roomsFor(db: Database, keys: readonly string[]): Room[] {
  if (!keys.length) return [];
  const marks = keys.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT DISTINCT r.* FROM rooms r JOIN members m ON m.roomFp = r.creatorFp AND m.roomId = r.id WHERE m.memberKey IN (${marks}) ORDER BY r.lastAt DESC`,
  ).all(...keys) as Record<string, unknown>[];
  return rows.map((row) => rowToRoom(db, row));
}

function insertRoom(db: Database, r: Omit<Room, "lastAt">): boolean {
  const ins = db.prepare("INSERT OR IGNORE INTO rooms (creatorFp, id, kind, title, createdBy, createdAt, lastAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(r.creatorFp, r.id, r.kind, r.title, r.createdBy, r.createdAt, r.createdAt);
  if (ins.changes !== 1) return false;
  const add = db.prepare("INSERT OR IGNORE INTO members (roomFp, roomId, memberKey) VALUES (?, ?, ?)");
  for (const k of r.members) add.run(r.creatorFp, r.id, k);
  return true;
}

/**
 * 两个人之间的 dm：mine / theirs 是双方名下的所有成员键（合并过的人有多个），已有任意一对的 dm 就用它，
 * 否则按两边的规范键（各自数组第 0 个）新建。同一对规范键重复调用幂等。
 */
export function ensureDm(db: Database, mine: readonly string[], theirs: readonly string[], createdBy: string, now = Date.now()): Room {
  if (!mine.length || !theirs.length || mine.some((k) => theirs.includes(k))) throw new Error("dm 需要两个不同的人");
  for (const a of mine) {
    for (const b of theirs) {
      const hit = getRoom(db, { creatorFp: "", id: dmRoomId(a, b) });
      if (hit) return hit;
    }
  }
  const room = { creatorFp: "", id: dmRoomId(mine[0], theirs[0]), kind: "dm" as const, title: null, createdBy, createdAt: now, members: [mine[0], theirs[0]].sort() };
  db.transaction(() => insertRoom(db, room)).immediate();
  return getRoom(db, room)!;
}

/** 本机建的 thread：creatorFp = 本机指纹，成员含建房人，至少 2 人 */
export function createThread(db: Database, selfFp: string, creatorKey: string, others: readonly string[], title: string, now = Date.now()): Room {
  const members = [...new Set([creatorKey, ...others])].sort();
  if (members.length < 2) throw new Error("thread 至少要两个人");
  const room = { creatorFp: selfFp.toLowerCase(), id: `tr_${randomUUID()}`, kind: "thread" as const, title: title || null, createdBy: creatorKey, createdAt: now, members };
  db.transaction(() => insertRoom(db, room)).immediate();
  return getRoom(db, room)!;
}

export function touchRoom(db: Database, r: RoomRef, now = Date.now()): void {
  db.prepare("UPDATE rooms SET lastAt = MAX(lastAt, ?) WHERE creatorFp = ? AND id = ?").run(now, r.creatorFp, r.id);
}
