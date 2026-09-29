/**
 * drops：「丢进工作台」的幂等记录。dropId 由前端在确认时生成，先 INSERT OR IGNORE 占位再投递：
 * 连点、重发同一个 dropId，只有占到位的那一次投递，其余直接返回已有记录。
 * 状态：held（占位后、送达前，或进了押后队列）→ sent（押后队列送达 / 直接送达）；押后 24 小时放弃、agent 被清理、
 * bridge 重启后押后队列里已经没有它 → failed，界面可重发（新 dropId）。
 */
import type { Database } from "bun:sqlite";

export type DropState = "sent" | "held" | "failed";

export interface DropRow {
  dropId: string;
  state: DropState;
  principal: string;
  personId: string;
  agent: string;
  roomFp: string;
  roomId: string;
  msgIds: string[];
  contentSha: string;
  messageId: string;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

const toRow = (r: Record<string, unknown>): DropRow => ({ ...(r as unknown as DropRow), msgIds: JSON.parse(String(r.msgIds)) as string[] });

export function getDrop(db: Database, dropId: string): DropRow | null {
  const r = db.prepare("SELECT * FROM drops WHERE dropId = ?").get(dropId) as Record<string, unknown> | null;
  return r ? toRow(r) : null;
}

/** 占位：插进去了返回 true（由这次负责投递）；dropId 已存在返回 false */
export function claimDrop(db: Database, d: Omit<DropRow, "state" | "error" | "updatedAt">): boolean {
  const r = db.prepare(
    `INSERT OR IGNORE INTO drops (dropId, state, principal, personId, agent, roomFp, roomId, msgIds, contentSha, messageId, createdAt, updatedAt)
     VALUES (?, 'held', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(d.dropId, d.principal, d.personId, d.agent, d.roomFp, d.roomId, JSON.stringify(d.msgIds), d.contentSha, d.messageId, d.createdAt, d.createdAt);
  return r.changes === 1;
}

/** 按投递信封的 messageId 改状态；只改还在 held 的（sent / failed 是终态，晚到的通知不回退） */
export function settleDropByMessage(db: Database, messageId: string, state: Exclude<DropState, "held">, error: string | null = null, now = Date.now()): DropRow | null {
  const r = db.prepare("UPDATE drops SET state = ?, error = ?, updatedAt = ? WHERE messageId = ? AND state = 'held' RETURNING *").get(state, error, now, messageId) as Record<string, unknown> | null;
  return r ? toRow(r) : null;
}

/** bridge 启动后第一次用 talk 时：held 却已不在押后队列里的（占位后崩溃、或重启期间被清掉）一律标 failed，别让界面永远显示「排队中」 */
export function failOrphanHeld(db: Database, stillQueued: ReadonlySet<string>, now = Date.now()): DropRow[] {
  const held = (db.prepare("SELECT * FROM drops WHERE state = 'held'").all() as Record<string, unknown>[]).map(toRow);
  const out: DropRow[] = [];
  for (const d of held) {
    if (stillQueued.has(d.messageId)) continue;
    const r = settleDropByMessage(db, d.messageId, "failed", "bridge 重启后不在押后队列里，没能确认送达", now);
    if (r) out.push(r);
  }
  return out;
}
