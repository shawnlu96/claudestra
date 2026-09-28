import type { SubSessionInfo } from "./runtimes/types.js";

/**
 * 会话列表的条数上限只数主会话：Codex 一个主会话常带几十个子线程（subagent / 自动审查），按总数截断时子线程能占掉七成，
 * 真正的主会话反被挤出列表。子线程跟着所属的主会话走——主会话留下它就留下；顺着父会话追不到头（父文件已删）或成环的，
 * 自己按主会话算，不丢行。保持原顺序。tests/session-limit.test.ts。
 */
export function limitByMainSessions<T extends { sessionId: string; sub?: SubSessionInfo }>(rows: T[], max: number): T[] {
  const byId = new Map(rows.map((r) => [r.sessionId, r]));
  const topOf = (r: T): T => {
    const seen = new Set<T>([r]);
    let cur = r;
    for (;;) {
      const p = cur.sub ? byId.get(cur.sub.parentId) : undefined;
      if (!p) return cur;
      if (seen.has(p)) return r;
      seen.add(p);
      cur = p;
    }
  };
  const tops = new Map(rows.map((r) => [r, topOf(r)]));
  const kept = new Set(rows.filter((r) => tops.get(r) === r).slice(0, max));
  return rows.filter((r) => kept.has(tops.get(r)!));
}
