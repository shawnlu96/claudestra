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
  /** bridge 每个主会话只带最新 50 个子线程，省掉的个数记在主会话行上（src/lib/session-limit.ts capSubsPerMain） */
  moreSubs?: number;
}

/**
 * 列表行的唯一键：同一个 sessionId 可能在不同 cwd（甚至不同运行时）下各有一行，只用 sessionId 当 React key
 * 会撞键，删除确认也会把两行一起带上（tests/codex-sub-sessions.test.ts）。
 */
export function sessionRowKey(r: { runtime?: string; cwd?: string; sessionId: string }): string {
  return `${r.runtime ?? ""}:${r.cwd ?? ""}:${r.sessionId}`;
}

/** 分组头上要标「已纳管」的 agent 短名；没有 agentName（例如临时目录里没纳管的主会话）返回 null，只给中性分组头 */
export function managedAgentOf(r: { agentName?: string | null }): string | null {
  return r.agentName ? r.agentName.replace(/^agent-/, "") : null;
}

export interface TreeRow<T> {
  row: T;
  depth: number;
  /** 这一行下面（含孙辈）要显示的子会话数；> 0 才给折叠开关 */
  kids: number;
  /** 行本身不列（已纳管，或在临时目录里的主会话），只当分组头挂它的子会话；「已纳管」徽章要另看 agentName */
  anchor: boolean;
  /** 后端省掉、没带过来的子线程数（只有主会话行可能 > 0），展开时报个数 */
  more: number;
}

/**
 * 子会话收到父会话下面，默认折叠（expanded 里有行键才展开）。父会话按全部会话找——主会话收编成 agent 后
 * 不在「未纳管」里了，它的子会话仍要挂在一个分组头下，不能又平铺开；shown 决定哪些行本身要列出。
 * 追不到父会话的子会话留在顶层；成环的各自当顶层，不丢行（tests/codex-sub-sessions.test.ts）。
 */
export function sessionTree<T extends SubSessionRow>(all: T[], shown: (r: T) => boolean, expanded: ReadonlySet<string>): TreeRow<T>[] {
  const byId = new Map(all.map((r) => [r.sessionId, r]));
  const kids = new Map<T, T[]>();
  for (const r of all) {
    const p = r.sub ? byId.get(r.sub.parentId) : undefined;
    if (p && p !== r) kids.set(p, [...(kids.get(p) ?? []), r]);
  }
  const reached = new Set<T>();
  const reach = (r: T) => {
    if (reached.has(r)) return;
    reached.add(r);
    for (const k of kids.get(r) ?? []) reach(k);
  };
  const roots = all.filter((r) => !r.sub || !byId.has(r.sub.parentId) || byId.get(r.sub.parentId) === r);
  roots.forEach(reach);
  for (const r of all) {
    if (reached.has(r)) continue;
    roots.push(r);
    reach(r);
  }
  const count = (r: T, seen: Set<T>): number =>
    (kids.get(r) ?? []).reduce((n, k) => (seen.has(k) ? n : (seen.add(k), n + (shown(k) ? 1 : 0) + count(k, seen))), 0);
  const out: TreeRow<T>[] = [];
  const done = new Set<T>();
  const walk = (r: T, depth: number) => {
    if (done.has(r)) return;
    done.add(r);
    const n = count(r, new Set([r]));
    if (!shown(r) && n === 0) return;
    out.push({ row: r, depth, kids: n, anchor: !shown(r), more: r.moreSubs ?? 0 });
    if (n > 0 && expanded.has(sessionRowKey(r))) for (const k of kids.get(r) ?? []) walk(k, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}
