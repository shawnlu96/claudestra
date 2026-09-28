/** bridge 给子会话带的归属（目前只有 Codex：subagent / guardian_review 自动审查线程） */
export interface SubSessionInfo {
  parentId: string;
  kind: string;
  nickname?: string;
}

export interface SubSessionRow {
  sessionId: string;
  name: string;
  sub?: SubSessionInfo;
}

/**
 * 列表行的唯一键：同一个 sessionId 可能在不同 cwd（甚至不同运行时）下各有一行，只用 sessionId 当 React key
 * 会撞键，删除确认也会把两行一起带上（tests/codex-sub-sessions.test.ts）。
 */
export function sessionRowKey(r: { runtime?: string; cwd?: string; sessionId: string }): string {
  return `${r.runtime ?? ""}:${r.cwd ?? ""}:${r.sessionId}`;
}

/**
 * 子会话排到父会话下面，缩进一级；父会话不在列表里（已纳管 / 被截在 100 条外）就留在原位，只靠徽章区分。
 * Codex 一个主会话常带一串 subagent + 自动审查线程，cwd 相同、名字相同，平铺时分不出谁是主会话。
 */
export function nestSubSessions<T extends SubSessionRow>(rows: T[]): { row: T; depth: number }[] {
  const ids = new Set(rows.map((r) => r.sessionId));
  const kids = new Map<string, T[]>();
  for (const r of rows) {
    const p = r.sub?.parentId;
    if (p && p !== r.sessionId && ids.has(p)) kids.set(p, [...(kids.get(p) ?? []), r]);
  }
  const out: { row: T; depth: number }[] = [];
  // 按行对象去重，不按 sessionId：同一个 id 可能在不同 cwd 下各有一行（Claude Code 的会话），按 id 会吞掉第二行
  const seen = new Set<T>();
  const walk = (r: T, depth: number) => {
    if (seen.has(r)) return;
    seen.add(r);
    out.push({ row: r, depth });
    for (const k of kids.get(r.sessionId) ?? []) walk(k, depth + 1);
  };
  for (const r of rows) if (!r.sub || !ids.has(r.sub.parentId)) walk(r, 0);
  for (const r of rows) walk(r, 0); // 成环的父子关系：兜底原样列出，不丢行
  return out;
}
