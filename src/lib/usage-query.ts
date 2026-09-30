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
  /** 推理 token（Codex），不含在 output 里；合计里算上 */
  reasoning: number;
  totalTokens: number;
  calls: number;
}

/**
 * 模型字段的来源：Claude 记的是响应里的 message.model（实际应答的模型）；Codex rollout 只有 turn_context.model，是**请求**的模型，
 * 不能当成实际应答的模型展示（T91 查实 rollout 不记响应模型）。
 */
type ModelBasis = "response" | "request";
const basisOf = (runtime: string): ModelBasis => (runtime === "codex" ? "request" : "response");

/** 这一轮算到哪（usage-attr.ts 判的）；basis 是依据，task 为空时就是未归属的原因 */
interface TurnAttr {
  task: string | null;
  step: string | null;
  round: number | null;
  feature: string | null;
  item: string | null;
  basis: string | null;
}

export interface TurnRow extends TokenSums {
  turnId: string;
  agent: string;
  sessionId: string;
  sidechain: boolean;
  runtime: string;
  modelBasis: ModelBasis;
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
  attr: TurnAttr;
}

const SUMS = `SUM(c.input) AS input, SUM(c.cache_creation) AS cacheCreation, SUM(c.cache_read) AS cacheRead, SUM(c.output) AS output,
  SUM(c.reasoning) AS reasoning, COUNT(*) AS calls`;

function withTotal<T extends Omit<TokenSums, "totalTokens">>(r: T): T & TokenSums {
  return { ...r, totalTokens: r.input + r.cacheCreation + r.cacheRead + r.output + r.reasoning };
}

/** 某 agent 在 sinceMs 之后开始的轮（按开始时间），只列有调用的轮 */
export function turnsFor(db: Database, agent: string, sinceMs = 0, limit = 500): TurnRow[] {
  const rows = db.prepare(`SELECT t.turn_id AS turnId, t.agent, t.session_id AS sessionId, t.sidechain, t.runtime, t.kind, t.trigger, t.started_at AS startedAt,
      t.attr_task, t.attr_step, t.attr_round, t.attr_feature, t.attr_item, t.attr_basis,
      MAX(c.ts) AS endedAt, ${SUMS}, MAX(c.input + c.cache_creation + c.cache_read) AS contextSeen, GROUP_CONCAT(DISTINCT c.model) AS models
    FROM turns t JOIN calls c ON c.turn_id = t.turn_id
    WHERE t.agent = ? AND t.started_at >= ? GROUP BY t.turn_id ORDER BY t.started_at DESC LIMIT ?`).all(agent, sinceMs, limit) as any[];
  const tools = db.prepare(`SELECT tl.turn_id AS turnId, tl.name, COUNT(*) AS n FROM tools tl JOIN turns t ON t.turn_id = tl.turn_id
    WHERE t.agent = ? AND t.started_at >= ? GROUP BY tl.turn_id, tl.name`).all(agent, sinceMs) as { turnId: string; name: string; n: number }[];
  const byTurn = new Map<string, Record<string, number>>();
  for (const t of tools) (byTurn.get(t.turnId) ?? byTurn.set(t.turnId, {}).get(t.turnId)!)[t.name] = t.n;
  return rows.reverse().map(({ attr_task, attr_step, attr_round, attr_feature, attr_item, attr_basis, ...r }) => {
    const tl = byTurn.get(r.turnId) ?? {};
    const attr = { task: attr_task, step: attr_step, round: attr_round, feature: attr_feature, item: attr_item, basis: attr_basis };
    return withTotal({
      ...r, attr, sidechain: r.sidechain === 1, modelBasis: basisOf(r.runtime), models: String(r.models ?? "").split(",").filter(Boolean),
      tools: tl, toolCalls: Object.values(tl).reduce((s, n) => s + n, 0),
    }) as TurnRow;
  });
}

export interface SummaryRow extends TokenSums {
  agent: string;
  runtime: string;
  model: string;
  modelBasis: ModelBasis;
  /** 其中子 agent（sidechain）的部分；只有按明细汇总（带 sinceMs）时有 */
  sidechainTokens?: number;
}

/**
 * 按 agent × 运行时 × 模型汇总（同名模型在两个运行时里含义不同：Claude 是应答模型、Codex 是请求模型）。sinceMs 给了就从明细按调用时间算（与 cost --today 同口径，只能看保留期内）；
 * 不给就读 daily（全部时段，含已清掉明细的日子）。
 */
export function usageSummary(db: Database, sinceMs?: number): SummaryRow[] {
  if (sinceMs === undefined) {
    const rows = db.prepare(`SELECT agent, runtime, model, SUM(input) AS input, SUM(cache_creation) AS cacheCreation,
      SUM(cache_read) AS cacheRead, SUM(output) AS output, SUM(reasoning) AS reasoning, SUM(calls) AS calls FROM daily GROUP BY agent, runtime, model`).all() as any[];
    return rows.map(summaryRow).sort((a, b) => b.totalTokens - a.totalTokens);
  }
  const rows = db.prepare(`SELECT t.agent, t.runtime, c.model, ${SUMS},
      SUM(CASE WHEN t.sidechain = 1 THEN c.input + c.cache_creation + c.cache_read + c.output + c.reasoning ELSE 0 END) AS sidechainTokens
    FROM calls c JOIN turns t ON t.turn_id = c.turn_id WHERE c.ts >= ? GROUP BY t.agent, t.runtime, c.model`).all(sinceMs) as any[];
  return rows.map(summaryRow).sort((a, b) => b.totalTokens - a.totalTokens);
}

const summaryRow = (r: any): SummaryRow => withTotal({ ...r, modelBasis: basisOf(r.runtime) });

export interface AttrRow extends TokenSums {
  turns: number;
  firstAt: number;
  lastAt: number;
}

/** 一张卡按 步骤 × 轮次 × agent 分（同一步换过执行者就是两行）；按开始时间排 */
export interface TaskStepRow extends AttrRow {
  step: string | null;
  round: number | null;
  agent: string;
  runtime: string;
  basis: string;
}

const ATTR_SUMS = `${SUMS}, COUNT(DISTINCT t.turn_id) AS turns,
  MIN(t.started_at) AS firstAt, MAX(c.ts) AS lastAt`;

export function usageByTask(db: Database, taskId: string): TaskStepRow[] {
  const rows = db.prepare(`SELECT t.attr_step AS step, t.attr_round AS round, t.agent, MAX(t.runtime) AS runtime, t.attr_basis AS basis, ${ATTR_SUMS}
    FROM turns t JOIN calls c ON c.turn_id = t.turn_id WHERE t.attr_task = ?
    GROUP BY t.attr_step, t.attr_round, t.agent, t.attr_basis ORDER BY firstAt`).all(taskId) as any[];
  return rows.map((r) => withTotal(r) as TaskStepRow);
}

export interface FeatureTaskRow extends AttrRow {
  task: string;
}

/** 一个 feature 按卡汇总：ids 是 feature id 或事项 id（还没迁进 feature 的卡挂在事项上），命中任一个就算 */
export function usageByFeature(db: Database, ids: string[]): FeatureTaskRow[] {
  if (!ids.length) return [];
  const qs = ids.map(() => "?").join(", ");
  const rows = db.prepare(`SELECT t.attr_task AS task, ${ATTR_SUMS} FROM turns t JOIN calls c ON c.turn_id = t.turn_id
    WHERE t.attr_task IS NOT NULL AND (t.attr_feature IN (${qs}) OR t.attr_item IN (${qs})) GROUP BY t.attr_task ORDER BY firstAt`).all(...ids, ...ids) as any[];
  return rows.map((r) => withTotal(r) as FeatureTaskRow);
}

export interface BasisRow extends AttrRow {
  basis: string;
}

/** 归属依据的分布（按轮开始时间取 sinceMs 之后）：未归属比例和原因就看这张 */
export function attrBreakdown(db: Database, sinceMs = 0): BasisRow[] {
  const rows = db.prepare(`SELECT COALESCE(t.attr_basis, 'pending') AS basis, ${ATTR_SUMS} FROM turns t JOIN calls c ON c.turn_id = t.turn_id
    WHERE t.started_at >= ? GROUP BY basis`).all(sinceMs) as any[];
  return rows.map((r) => withTotal(r) as BasisRow).sort((a, b) => b.totalTokens - a.totalTokens);
}
