/**
 * `usage` 命令族（T83 token 账）：ingest 导入会话记录，turns 看某 agent 的逐轮消耗，summary 看各 agent 汇总。
 * 逻辑在 lib/usage-*.ts；这里只解析参数和排版。turns / summary 默认先增量导入一趟（--no-ingest 跳过）。
 * 导入一律过库旁的文件锁：别的进程（bridge 每 10 分钟那趟、另一条查询）正在导就不再读一遍。
 */
import { formatTokens } from "../lib/agent-stats.js";
import { ingestLocked } from "../lib/usage-ingest.js";
import { turnsFor, usageSummary, type SummaryRow, type TurnRow } from "../lib/usage-query.js";
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
  const a: UsageArgs = { positional: [], db: USAGE_DB_PATH, json: false, ingest: true, prune: false, limit: 500 };
  for (let i = 0; i < args.length; i++) {
    const x = args[i];
    if (x === "--today") a.sinceMs = currentUsageWindow().dayStart;
    else if (x === "--since") a.sinceMs = parseSince(args[++i]);
    else if (x === "--db") a.db = args[++i] ?? a.db;
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

function turnLine(t: TurnRow): string {
  const tools = Object.entries(t.tools).sort((x, y) => y[1] - x[1]).slice(0, 4).map(([n, k]) => `${n}×${k}`).join(" ");
  const kind = t.sidechain ? `↳${t.kind}` : t.kind;
  return `${hhmm(t.startedAt)}  ${kind.padEnd(13)}${col(t.calls, 5)}${col(formatTokens(t.contextSeen), 9)}${col(formatTokens(t.totalTokens), 9)}`
    + `${col(formatTokens(t.output), 7)}  ${tools}${t.trigger ? `  「${t.trigger}」` : ""}`;
}

function summaryLine(r: SummaryRow): string {
  return `${r.agent.padEnd(28)} ${r.model.padEnd(26)}${col(r.calls, 7)}${col(formatTokens(r.input), 8)}${col(formatTokens(r.cacheCreation), 8)}`
    + `${col(formatTokens(r.cacheRead), 8)}${col(formatTokens(r.output), 8)}${col(formatTokens(r.totalTokens), 9)}`;
}

function grand(rows: SummaryRow[]) {
  const g = { input: 0, cacheCreation: 0, cacheRead: 0, output: 0, totalTokens: 0, calls: 0 };
  for (const r of rows) for (const k of Object.keys(g) as (keyof typeof g)[]) g[k] += r[k];
  return g;
}

export async function cmdUsage(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const a = parseArgs(rest);
  const db = openUsageDb(a.db);
  try {
    if (sub === "ingest") {
      const r = await ingestLocked(db, lockOf(a.db), { sinceMs: a.sinceMs, prune: a.prune }, INGEST_WAIT_MS);
      outputSync(r ? { ok: true, db: a.db, ...r } : { ok: true, db: a.db, skipped: "另一个进程正在导入" });
      return;
    }
    if (sub !== "turns" && sub !== "summary") {
      outputSync({ ok: false, error: "用法：usage ingest [--since <ts>] [--prune] | turns <agent> [--today|--since <ts>] [--json] | summary [--today] [--json]" });
      process.exitCode = 1;
      return;
    }
    const ingested = a.ingest ? (await ingestLocked(db, lockOf(a.db), {}, QUERY_WAIT_MS)) ?? { skipped: "另一个进程正在导入，先查现有数据" } : null;
    const period = a.sinceMs !== undefined ? `since ${new Date(a.sinceMs).toISOString()}` : "all-time";
    const stale = ingested && "skipped" in ingested ? "（另一个进程正在导入，下面是现有数据）\n" : "";
    if (sub === "summary") {
      const rows = usageSummary(db, a.sinceMs);
      if (a.json) return outputSync({ ok: true, period, rows, grand: grand(rows), ...(ingested ? { ingested } : {}) });
      const head = `${stale}token 账 · ${period}\n${"agent".padEnd(28)} ${"模型".padEnd(24)}   调用    输入  写缓存  读缓存    输出     合计`;
      outputSync([head, ...rows.map(summaryLine), summaryLine({ agent: "合计", model: "", ...grand(rows) })].join("\n"));
      return;
    }
    const agent = a.positional[0];
    if (!agent) throw new Error("usage turns 要给 agent 名");
    let turns = turnsFor(db, agent, a.sinceMs ?? 0, a.limit);
    if (!turns.length && !agent.startsWith("agent-")) turns = turnsFor(db, `agent-${agent}`, a.sinceMs ?? 0, a.limit);
    if (a.json) return outputSync({ ok: true, agent, period, turns, ...(ingested ? { ingested } : {}) });
    const head = `${stale}${agent} · ${turns.length} 轮 · ${period}\n时间         来源          调用  看到上下文   合计   输出  工具 / 来源摘要`;
    outputSync([head, ...turns.map(turnLine)].join("\n"));
  } finally {
    db.close();
  }
}
