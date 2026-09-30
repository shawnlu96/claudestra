/**
 * token 账（T83）的读：某 agent 的逐轮明细、按 agent×模型的汇总。数字全部从 calls 现聚合（有明细的时段）或读 daily（全部时段）。
 * 口径说明见 docs/architecture/token-usage.md；CLI 在 src/manager/usage.ts。
 */
import type { Database } from "bun:sqlite";

interface TokenSums {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
  totalTokens: number;
  calls: number;
}

export interface TurnRow extends TokenSums {
  turnId: string;
  agent: string;
  sessionId: string;
  sidechain: boolean;
  kind: string;
  trigger: string;
  startedAt: number;
  endedAt: number;
  /** 本轮单次调用里 input + cacheCreation + cacheRead 的最大值 */
  contextSeen: number;
  models: string[];
  toolCalls: number;
  /** 工具名 → 次数（同一个 tool_use id 只算一次） */
  tools: Record<string, number>;
}

const SUMS = `SUM(c.input) AS input, SUM(c.cache_creation) AS cacheCreation, SUM(c.cache_read) AS cacheRead, SUM(c.output) AS output,
  COUNT(*) AS calls`;

function withTotal<T extends Omit<TokenSums, "totalTokens">>(r: T): T & TokenSums {
  return { ...r, totalTokens: r.input + r.cacheCreation + r.cacheRead + r.output };
}

/** 某 agent 在 sinceMs 之后开始的轮（按开始时间），只列有调用的轮 */
export function turnsFor(db: Database, agent: string, sinceMs = 0, limit = 500): TurnRow[] {
  const rows = db.prepare(`SELECT t.turn_id AS turnId, t.agent, t.session_id AS sessionId, t.sidechain, t.kind, t.trigger, t.started_at AS startedAt,
      MAX(c.ts) AS endedAt, ${SUMS}, MAX(c.input + c.cache_creation + c.cache_read) AS contextSeen, GROUP_CONCAT(DISTINCT c.model) AS models
    FROM turns t JOIN calls c ON c.turn_id = t.turn_id
    WHERE t.agent = ? AND t.started_at >= ? GROUP BY t.turn_id ORDER BY t.started_at DESC LIMIT ?`).all(agent, sinceMs, limit) as any[];
  const tools = db.prepare(`SELECT tl.turn_id AS turnId, tl.name, COUNT(*) AS n FROM tools tl JOIN turns t ON t.turn_id = tl.turn_id
    WHERE t.agent = ? AND t.started_at >= ? GROUP BY tl.turn_id, tl.name`).all(agent, sinceMs) as { turnId: string; name: string; n: number }[];
  const byTurn = new Map<string, Record<string, number>>();
  for (const t of tools) (byTurn.get(t.turnId) ?? byTurn.set(t.turnId, {}).get(t.turnId)!)[t.name] = t.n;
  return rows.reverse().map((r) => {
    const tl = byTurn.get(r.turnId) ?? {};
    return withTotal({
      ...r, sidechain: r.sidechain === 1, models: String(r.models ?? "").split(",").filter(Boolean),
      tools: tl, toolCalls: Object.values(tl).reduce((s, n) => s + n, 0),
    }) as TurnRow;
  });
}

export interface SummaryRow extends TokenSums {
  agent: string;
  model: string;
  /** 其中子 agent（sidechain）的部分；只有按明细汇总（带 sinceMs）时有 */
  sidechainTokens?: number;
}

/**
 * 按 agent×模型汇总。sinceMs 给了就从明细按调用时间算（与 cost --today 同口径，只能看保留期内）；
 * 不给就读 daily（全部时段，含已清掉明细的日子）。
 */
export function usageSummary(db: Database, sinceMs?: number): SummaryRow[] {
  if (sinceMs === undefined) {
    const rows = db.prepare(`SELECT agent, model, SUM(input) AS input, SUM(cache_creation) AS cacheCreation, SUM(cache_read) AS cacheRead,
      SUM(output) AS output, SUM(calls) AS calls FROM daily GROUP BY agent, model`).all() as any[];
    return rows.map(withTotal).sort((a, b) => b.totalTokens - a.totalTokens);
  }
  const rows = db.prepare(`SELECT t.agent, c.model, ${SUMS},
      SUM(CASE WHEN t.sidechain = 1 THEN c.input + c.cache_creation + c.cache_read + c.output ELSE 0 END) AS sidechainTokens
    FROM calls c JOIN turns t ON t.turn_id = c.turn_id WHERE c.ts >= ? GROUP BY t.agent, c.model`).all(sinceMs) as any[];
  return rows.map(withTotal).sort((a, b) => b.totalTokens - a.totalTokens);
}

/** 某个会话的 token 合计（出借收据用，T94）；账里没有这个会话 = null（调用方记「未知」，不记 0） */
export function sessionTokens(db: Database, sessionId: string): TokenSums | null {
  const r = db.prepare(`SELECT ${SUMS} FROM turns t JOIN calls c ON c.turn_id = t.turn_id WHERE t.session_id = ?`).get(sessionId) as
    Omit<TokenSums, "totalTokens"> | null;
  return r && r.calls > 0 ? withTotal(r) : null;
}
