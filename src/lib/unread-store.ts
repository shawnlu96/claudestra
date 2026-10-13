/**
 * 未读计数与跨端已读（web-state.sqlite 的 agent_unread / push_read 两张表）。服务端持有：派发器在 agent 回复 owner 的
 * 网页对话时 +1，任何已读信号（打开会话 / 点通知 / 在 Discord 里说话）归零；App 图标角标 = 全表之和。
 * 纯函数 over Database；唯一的进程内状态是 onAgentRead 的监听表——派发器靠它在已读时向各端发 dismiss / 同步角标，
 * 路由与派发器都只调 markAgentRead，不各自发推送。
 */
import type { Database } from "bun:sqlite";

/** agent 名规整：事件里可能带 agent- 前缀，表里一律存裸名 */
export const bareAgent = (agent: string): string => agent.replace(/^agent-/, "");

/** 这条回复要不要计未读：master 不计（前端会话名是 __master__，按设计不清它，计了角标永远降不到 0） */
export function countsUnread(agent: string): boolean {
  return !!agent && agent !== "master";
}

/** agent 收到一条给网页用户的回复 → count+1；返回当前全局未读总数（给角标） */
export function bumpUnread(db: Database, agent: string, ts: number): number {
  db.prepare(
    "INSERT INTO agent_unread (agent, count, last_reply_ts) VALUES (?, 1, ?) ON CONFLICT(agent) DO UPDATE SET count = count + 1, last_reply_ts = excluded.last_reply_ts",
  ).run(agent, ts);
  return totalUnread(db);
}

export function totalUnread(db: Database): number {
  const r = db.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM agent_unread").get() as { n: number } | null;
  return Number(r?.n) || 0;
}

/** agent → 未读数（只含 >0 的） */
export function unreadCounts(db: Database): Record<string, number> {
  const rows = db.prepare("SELECT agent, count FROM agent_unread WHERE count > 0").all() as { agent: string; count: number }[];
  return Object.fromEntries(rows.map((r) => [r.agent, r.count]));
}

/** 归零；返回归零前是否真有未读（决定要不要向各端同步角标） */
function clearUnread(db: Database, agent: string): boolean {
  const row = db.prepare("SELECT count FROM agent_unread WHERE agent = ?").get(agent) as { count: number } | null;
  if (!row || row.count <= 0) return false;
  db.prepare("UPDATE agent_unread SET count = 0 WHERE agent = ?").run(agent);
  return true;
}

/** push_read 全表：agent → 已读时刻（ISO）；iOS 打开 App 时按它补清别处已读的存量通知 */
export function readMarks(db: Database): Record<string, string> {
  const rows = db.prepare("SELECT agent, ts FROM push_read").all() as { agent: string; ts: number }[];
  return Object.fromEntries(rows.map((r) => [r.agent, new Date(r.ts).toISOString()]));
}

export interface ReadEvent {
  agent: string;
  /** 已读时刻（ms）：dismiss 只清 ts 早于它的通知 */
  ts: number;
  /** 归零前真有未读 → 各端角标要跟着变 */
  hadUnread: boolean;
  /** 用户手动清全部：即使原本为零也同步一次角标 */
  all?: boolean;
}

const listeners = new Set<(e: ReadEvent) => void>();

/** 派发器订阅：已读 → 发 dismiss / 同步角标。返回取消函数 */
export function onAgentRead(cb: (e: ReadEvent) => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

function notifyRead(e: ReadEvent): void {
  for (const cb of listeners) {
    try {
      cb(e);
    } catch (err) {
      console.error("⚠️ 已读监听器异常（已读已落库，只是这一次没同步到各端）:", (err as Error).message);
    }
  }
}

/** 任何已读信号都走这里：落 push_read 水位、未读归零、通知监听器 */
export function markAgentRead(db: Database, agent: string, ts: number = Date.now()): ReadEvent {
  const a = bareAgent(agent);
  db.prepare("INSERT INTO push_read (agent, ts) VALUES (?, ?) ON CONFLICT(agent) DO UPDATE SET ts = excluded.ts").run(a, ts);
  const e: ReadEvent = { agent: a, ts, hadUnread: clearUnread(db, a) };
  notifyRead(e);
  return e;
}

/** 全部已读共用一次事务、一次事件；已有水位只能往前，包含已归档的 agent。 */
export function markAllRead(db: Database, ts: number = Date.now()): number {
  const cleared = db.transaction(() => {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM agent_unread WHERE count > 0").get() as { n: number };
    db.prepare("UPDATE push_read SET ts = MAX(ts, ?)").run(ts);
    db.prepare("INSERT OR IGNORE INTO push_read (agent, ts) SELECT agent, ? FROM agent_unread").run(ts);
    db.prepare("UPDATE agent_unread SET count = 0").run();
    return n;
  })();
  notifyRead({ agent: "", ts, hadUnread: cleared > 0, all: true });
  return cleared;
}

/**
 * 该清掉的行：不在当前 agent 列表里的（前端名去掉 agent- 前缀后比较）与不计未读的（master）。
 * 已删除的 agent 的行若留着，角标永远降不到 0——manager kill 不会、也不该跨进程来删这张表。纯函数，便于单测。
 */
export function unreadOrphans(rows: { agent: string; count: number }[], liveNames: Iterable<string>): { agents: string[]; hadUnread: boolean } {
  const live = new Set<string>();
  for (const n of liveNames) live.add(bareAgent(n));
  const gone = rows.filter((r) => !countsUnread(r.agent) || !live.has(r.agent));
  return { agents: gone.map((r) => r.agent), hadUnread: gone.some((r) => r.count > 0) };
}

/** 删掉列表里已经没有的 agent 的未读行；真删掉了未读的，按已读事件通知监听器（角标要回落）。列表为空不动（拿不准是不是真没有） */
export function pruneUnread(db: Database, liveNames: string[], ts: number = Date.now()): { agents: string[]; hadUnread: boolean } {
  if (!liveNames.length) return { agents: [], hadUnread: false };
  const rows = db.prepare("SELECT agent, count FROM agent_unread").all() as { agent: string; count: number }[];
  const orphans = unreadOrphans(rows, liveNames);
  const del = db.prepare("DELETE FROM agent_unread WHERE agent = ?");
  for (const a of orphans.agents) del.run(a);
  for (const r of rows) if (orphans.agents.includes(r.agent) && r.count > 0) notifyRead({ agent: r.agent, ts, hadUnread: true });
  return orphans;
}
