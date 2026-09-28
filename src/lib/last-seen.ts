/**
 * 「上次以来」的时刻（协作视图首页摘要，T12c）：按 principal × scope 存在 web 状态库的 last_seen 表。
 * principal 用 id——owner 的每台设备都是 owner:self，所以多设备天然一致。时刻只往前走：写入取 max(旧值, now)，
 * 乱序到达的 PUT（手机后台补发、两台设备前后脚）不会把它拨回去。now 由服务端给，不信客户端时钟。
 */
import type { Database } from "bun:sqlite";

export function getLastSeen(db: Database, principal: string, scope: string): number | null {
  const row = db.prepare("SELECT ts FROM last_seen WHERE principal = ? AND scope = ?").get(principal, scope) as { ts: number } | null;
  return row?.ts ?? null;
}

/** 记一次「看过」，返回落库后的时刻（旧值更新时就是旧值） */
export function markSeen(db: Database, principal: string, scope: string, now: number): number {
  db.prepare("INSERT INTO last_seen (principal, scope, ts) VALUES (?, ?, ?) ON CONFLICT (principal, scope) DO UPDATE SET ts = MAX(ts, excluded.ts)").run(principal, scope, now);
  return getLastSeen(db, principal, scope) ?? now;
}
