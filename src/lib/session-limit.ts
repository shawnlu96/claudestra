import type { SubSessionInfo } from "./runtimes/types.js";

type Row = { sessionId: string; sub?: SubSessionInfo };

/** 每行所属的主会话：顺着 sub.parentId 往上追到头；追不到头（父文件已删）或成环的，自己算主会话 */
function topsOf<T extends Row>(rows: T[]): Map<T, T> {
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
  return new Map(rows.map((r) => [r, topOf(r)]));
}

/**
 * 会话列表的条数上限只数主会话：Codex 一个主会话常带几十个子线程（subagent / 自动审查），按总数截断时子线程能占掉七成，
 * 真正的主会话反被挤出列表。子线程跟着所属的主会话走——主会话留下它就留下；顺着父会话追不到头（父文件已删）或成环的，
 * 自己按主会话算，不丢行。保持原顺序。tests/session-limit.test.ts。
 */
export function limitByMainSessions<T extends Row>(rows: T[], max: number): T[] {
  const tops = topsOf(rows);
  const kept = new Set(rows.filter((r) => tops.get(r) === r).slice(0, max));
  return rows.filter((r) => kept.has(tops.get(r)!));
}

/**
 * 每个主会话只带前 maxSubs 个子线程（行已按时间新→旧排好，即最新的），多出来的只在主会话行上报 moreSubs 个数。
 * 不设上限时 JSON 随子线程数线性变大（审查实测 3 个主会话 × 400 子线程 = 474KB），手机走中继明显变慢。
 * 被省掉的子线程下面的孙辈也一并省掉、计入数量：留着它们就追不到父会话，网页上会浮成顶层行。tests/session-limit.test.ts。
 */
export function capSubsPerMain<T extends Row>(rows: T[], maxSubs: number): Array<T & { moreSubs?: number }> {
  const tops = topsOf(rows);
  const byId = new Map(rows.map((r) => [r.sessionId, r]));
  const used = new Map<T, number>();
  const kept = new Set<T>();
  for (const r of rows) {
    const top = tops.get(r)!;
    if (top === r) { kept.add(r); continue; }
    const n = used.get(top) ?? 0;
    if (n >= maxSubs) continue;
    used.set(top, n + 1);
    kept.add(r);
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const r of kept) {
      const p = r.sub ? byId.get(r.sub.parentId) : undefined;
      if (tops.get(r) !== r && p && !kept.has(p)) { kept.delete(r); changed = true; }
    }
  }
  const more = new Map<T, number>();
  for (const r of rows) if (!kept.has(r)) more.set(tops.get(r)!, (more.get(tops.get(r)!) ?? 0) + 1);
  return rows.filter((r) => kept.has(r)).map((r) => (more.has(r) ? { ...r, moreSubs: more.get(r)! } : r) as T & { moreSubs?: number });
}
