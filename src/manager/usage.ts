/**
 * `usage` 命令族（T83 token 账）：ingest 导入会话记录，turns 看某 agent 的逐轮消耗，summary 看各 agent 汇总。
 * 逻辑在 lib/usage-*.ts；这里只解析参数和排版。turns / summary 默认先增量导入一趟（--no-ingest 跳过）。
 * 导入一律过库旁的文件锁：别的进程（bridge 每 10 分钟那趟、另一条查询）正在导就不再读一遍。
 */
import { formatTokens } from "../lib/agent-stats.js";
import { LEDGER_PATH } from "../lib/ledger-store.js";
import { ingestLocked, type IngestResult } from "../lib/usage-ingest.js";
import { attributeFromPath, openLedgerReadonly, resolveFeatureIds } from "../lib/usage-attr.js";
import { attrBreakdown, turnsFor, usageByFeature, usageByTask, usageSummary, type AttrRow, type SummaryRow, type TurnRow } from "../lib/usage-query.js";
import { openUsageDb, USAGE_DB_PATH } from "../lib/usage-store.js";
import { currentUsageWindow } from "../lib/usage-window.js";
import { outputSync } from "./core.js";

interface UsageArgs {
  positional: string[];
  db: string;
  sinceMs?: number;
  json: boolean;
  ingest: boolean;
  prune: boolean;
  limit: number;
  ledger: string;
}

/** 导入锁等多久：增量一趟通常 1 秒内；等不到多半是首轮全量在跑，查询就先查现有数据，ingest 就把这趟让给它 */
const QUERY_WAIT_MS = 30_000;
const INGEST_WAIT_MS = 60_000;
const lockOf = (db: string) => `${db}.ingest.lock`;

function parseSince(v: string | undefined): number {
  const n = /^\d+$/.test(v ?? "") ? Number(v) : Date.parse(v ?? "");
  if (!Number.isFinite(n)) throw new Error(`--since 认不出：${v}（给 ISO 时间或毫秒时间戳）`);
  return n;
}

function parseArgs(args: string[]): UsageArgs {
  const a: UsageArgs = { positional: [], db: USAGE_DB_PATH, json: false, ingest: true, prune: false, limit: 500, ledger: LEDGER_PATH };
  for (let i = 0; i < args.length; i++) {
    const x = args[i];
    if (x === "--today") a.sinceMs = currentUsageWindow().dayStart;
    else if (x === "--since") a.sinceMs = parseSince(args[++i]);
    else if (x === "--db") a.db = args[++i] ?? a.db;
    else if (x === "--ledger") a.ledger = args[++i] ?? a.ledger;
    else if (x === "--json") a.json = true;
    else if (x === "--no-ingest") a.ingest = false;
    else if (x === "--prune") a.prune = true;
    else if (x === "--limit") a.limit = Math.max(1, Number(args[++i]) || a.limit);
    else if (!x.startsWith("--")) a.positional.push(x);
  }
  return a;
}

const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${d.toTimeString().slice(0, 5)}`;
};
const col = (s: string | number, w: number) => String(s).padStart(w);

/** 归属列：「T85 write#1」；没归上的写原因（overlap / coordination …），还没算过的写 - */
function attrLabel(a: TurnRow["attr"]): string {
  if (!a.task) return a.basis ? `(${a.basis})` : "-";
  const step = a.step ? ` ${a.step}${a.round !== null ? `#${a.round}` : ""}` : "";
  return `${a.task}${step}${a.basis === "session" ? " ⚓" : ""}`;
}

function turnLine(t: TurnRow): string {
  const tools = Object.entries(t.tools).sort((x, y) => y[1] - x[1]).slice(0, 4).map(([n, k]) => `${n}×${k}`).join(" ");
  const kind = t.sidechain ? `↳${t.kind}` : t.kind;
  return `${hhmm(t.startedAt)}  ${t.runtime.padEnd(12)}${kind.padEnd(13)}${attrLabel(t.attr).padEnd(22)}${col(t.calls, 5)}${col(formatTokens(t.contextSeen), 9)}`
    + `${col(formatTokens(t.totalTokens), 9)}${col(formatTokens(t.output), 7)}${col(formatTokens(t.reasoning), 7)}  ${tools}${t.trigger ? `  「${t.trigger}」` : ""}`;
}

/** Codex 的模型是请求模型：名字后面标「(请求)」，不和 Claude 的应答模型混成一个意思 */
const modelLabel = (r: Pick<SummaryRow, "model" | "modelBasis">) => (r.modelBasis === "request" ? `${r.model}(请求)` : r.model);

function summaryLine(r: SummaryRow): string {
  return `${r.agent.padEnd(28)} ${r.runtime.padEnd(12)}${modelLabel(r).padEnd(26)}${col(r.calls, 7)}${col(formatTokens(r.input), 8)}`
    + `${col(formatTokens(r.cacheCreation), 8)}${col(formatTokens(r.cacheRead), 8)}${col(formatTokens(r.output), 8)}${col(formatTokens(r.reasoning), 8)}`
    + `${col(formatTokens(r.totalTokens), 9)}`;
}

type Sums = Pick<SummaryRow, "input" | "cacheCreation" | "cacheRead" | "output" | "reasoning" | "totalTokens" | "calls">;

function grand(rows: readonly Sums[]) {
  const g = { input: 0, cacheCreation: 0, cacheRead: 0, output: 0, reasoning: 0, totalTokens: 0, calls: 0 };
  for (const r of rows) for (const k of Object.keys(g) as (keyof typeof g)[]) g[k] += r[k];
  return g;
}

const USAGE_HELP = "用法：usage ingest [--since <ts>] [--prune] | turns <agent> [--today|--since <ts>] [--json] | summary [--today] [--json]"
  + " | by-task <卡号> [--json] | by-feature <feature 名或 id> [--json] | attribute [--today|--since <ts>] [--json]；台账默认线上库，--ledger 换";

function attrLine(label: string, r: AttrRow): string {
  return `${label.padEnd(34)}${col(r.turns, 6)}${col(r.calls, 7)}${col(formatTokens(r.cacheRead), 9)}${col(formatTokens(r.output), 8)}`
    + `${col(formatTokens(r.reasoning), 8)}${col(formatTokens(r.totalTokens), 9)}  ${hhmm(r.firstAt)} → ${hhmm(r.lastAt)}`;
}
const ATTR_HEAD = `${"".padEnd(34)}    轮   调用   读缓存    输出    推理     合计  起止`;

function grandAttr(rows: AttrRow[]): AttrRow {
  const g = { ...grand(rows), turns: 0, firstAt: Infinity, lastAt: 0 };
  for (const r of rows) Object.assign(g, { turns: g.turns + r.turns, firstAt: Math.min(g.firstAt, r.firstAt), lastAt: Math.max(g.lastAt, r.lastAt) });
  return g;
}

/** by-task / by-feature / attribute：都读归属列，导入那趟已按台账重算过 */
function attrReport(sub: string, a: UsageArgs, db: ReturnType<typeof openUsageDb>, stale: string): void {
  const key = a.positional[0];
  if (sub === "attribute") {
    const rows = attrBreakdown(db, a.sinceMs ?? 0), g = grandAttr(rows);
    const share = (r: AttrRow) => `${((100 * r.totalTokens) / Math.max(1, g.totalTokens)).toFixed(1)}%`;
    if (a.json) return outputSync({ ok: true, rows: rows.map((r) => ({ ...r, share: share(r) })), grand: g });
    return outputSync([`${stale}归属依据分布（按 token）`, ATTR_HEAD, ...rows.map((r) => attrLine(`${r.basis} ${share(r)}`, r)), attrLine("合计", g)].join("\n"));
  }
  if (!key) throw new Error(`usage ${sub} 要给${sub === "by-task" ? "卡号" : " feature"}`);
  if (sub === "by-task") {
    const rows = usageByTask(db, key);
    if (a.json) return outputSync({ ok: true, task: key, rows, grand: grandAttr(rows) });
    const label = (r: (typeof rows)[number]) => `${r.step ?? "(步骤不明)"}${r.round !== null ? `#${r.round}` : ""} ${r.agent}${r.basis === "session" ? " ⚓" : ""}`;
    return outputSync([`${stale}${key} · 按步骤 / 轮次`, ATTR_HEAD, ...rows.map((r) => attrLine(label(r), r)), attrLine("合计", grandAttr(rows))].join("\n"));
  }
  const ledger = openLedgerReadonly(a.ledger);
  if (!ledger) throw new Error(`没有台账库：${a.ledger}`);
  let hit: ReturnType<typeof resolveFeatureIds>;
  try { hit = resolveFeatureIds(ledger, key); } finally { ledger.close(); }
  if (!hit) throw new Error(`台账里没有 feature 或事项「${key}」`);
  if ("ambiguous" in hit) throw new Error(`「${key}」对上了不止一个，写 id：\n${hit.ambiguous.join("\n")}`);
  const rows = usageByFeature(db, hit.ids);
  if (a.json) return outputSync({ ok: true, feature: hit.labels, rows, grand: grandAttr(rows) });
  return outputSync([`${stale}${hit.labels.join(" / ")} · 按卡`, ATTR_HEAD, ...rows.map((r) => attrLine(r.task, r)), attrLine("合计", grandAttr(rows))].join("\n"));
}

function summaryReport(a: UsageArgs, db: ReturnType<typeof openUsageDb>, period: string, stale: string, ingested: object | null): void {
  const rows = usageSummary(db, a.sinceMs);
  if (a.json) return outputSync({ ok: true, period, rows, grand: grand(rows), ...(ingested ? { ingested } : {}) });
  const head = `${stale}token 账 · ${period}\n${"agent".padEnd(28)} ${"运行时".padEnd(9)}${"模型".padEnd(24)}   调用    输入  写缓存  读缓存`
    + `    输出    推理     合计`;
  const total = summaryLine({ agent: "合计", runtime: "", model: "", modelBasis: "response", ...grand(rows) });
  outputSync([head, ...rows.map(summaryLine), total].join("\n"));
}

function turnsReport(a: UsageArgs, db: ReturnType<typeof openUsageDb>, period: string, stale: string, ingested: object | null): void {
  const agent = a.positional[0];
  if (!agent) throw new Error("usage turns 要给 agent 名");
  let turns = turnsFor(db, agent, a.sinceMs ?? 0, a.limit);
  if (!turns.length && !agent.startsWith("agent-")) turns = turnsFor(db, `agent-${agent}`, a.sinceMs ?? 0, a.limit);
  if (a.json) return outputSync({ ok: true, agent, period, turns, ...(ingested ? { ingested } : {}) });
  const head = `${stale}${agent} · ${turns.length} 轮 · ${period}\n时间         运行时      来源         归属                   调用  看到上下文   合计   输出   推理  工具 / 来源摘要`;
  outputSync([head, ...turns.map(turnLine)].join("\n"));
}

const QUERIES = new Set(["turns", "summary", "by-task", "by-feature", "attribute"]);

export async function cmdUsage(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const a = parseArgs(rest);
  const db = openUsageDb(a.db);
  try {
    if (sub === "ingest") {
      const r = await ingestLocked(db, lockOf(a.db), { sinceMs: a.sinceMs, prune: a.prune, ledgerPath: a.ledger }, INGEST_WAIT_MS);
      outputSync(r ? { ok: true, db: a.db, ...r } : { ok: true, db: a.db, skipped: "另一个进程正在导入" });
      return;
    }
    if (!QUERIES.has(sub)) {
      outputSync({ ok: false, error: USAGE_HELP });
      process.exitCode = 1;
      return;
    }
    let ingested: IngestResult | { skipped: string } | null = null;
    if (a.ingest) ingested = (await ingestLocked(db, lockOf(a.db), { ledgerPath: a.ledger }, QUERY_WAIT_MS)) ?? { skipped: "另一个进程正在导入，先查现有数据" };
    // --no-ingest 也按台账现状重算归属：只读台账、只写归属列，毫秒级
    else if (sub !== "summary") attributeFromPath(db, a.ledger);
    const period = a.sinceMs !== undefined ? `since ${new Date(a.sinceMs).toISOString()}` : "all-time";
    const stale = ingested && "skipped" in ingested ? "（另一个进程正在导入，下面是现有数据）\n" : "";
    if (sub === "summary") return summaryReport(a, db, period, stale, ingested);
    if (sub === "turns") return turnsReport(a, db, period, stale, ingested);
    attrReport(sub, a, db, stale);
  } finally {
    db.close();
  }
}
