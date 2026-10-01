/** Agent detail reads only the existing usage ledger; never opens session files or ingests. */
import type { Database } from "bun:sqlite";
import { turnsFor, usageSummary, type SummaryRow, type TurnRow } from "./usage-query.js";
import { retentionCutoff } from "./usage-store.js";

export interface AgentUsageOptions {
  since: number;
  limit: number;
  before?: { at: number; row: number };
}

export function parseAgentUsageOptions(url: URL): AgentUsageOptions | null {
  const raw = url.searchParams.get("since"), count = url.searchParams.get("limit"), cursor = url.searchParams.get("before");
  const since = !raw ? 0 : /^\d+$/.test(raw) ? Number(raw) : /^\d{4}-\d{2}-\d{2}T/.test(raw) ? Date.parse(raw) : NaN;
  const limit = count === null ? 20 : Number(count);
  if (!Number.isSafeInteger(since) || since < 0 || since > 8.64e15 || !Number.isSafeInteger(limit) || limit < 1) return null;
  const match = cursor?.match(/^(\d+)\.(\d+)$/);
  if (cursor !== null && (!match || !Number.isSafeInteger(Number(match[1])) || !Number.isSafeInteger(Number(match[2])))) return null;
  return { since, limit: Math.min(limit, 100), ...(match ? { before: { at: Number(match[1]), row: Number(match[2]) } } : {}) };
}

/** Stored summaries already mask credentials. Also hide local paths and the session id if quoted in that stored text. */
function displayText(value: string, sessionId?: string, max = 160): string {
  const text = sessionId ? value.replaceAll(sessionId, "[session]") : value;
  // A path may contain punctuation or quotes: hide the rest of its line, stopping only before a URL.
  return text.replace(/https?:\/\/[^\s"'<>]+|(?:file:\/\/|~)?\/(?:(?!https?:\/\/)[^\r\n])*|[A-Za-z]:\\(?:(?!https?:\/\/)[^\r\n])*/g,
    (match, offset) => /^https?:\/\//.test(match) ? match
      : "[path]" + (/^https?:\/\//.test(text.slice(offset + match.length)) ? " " : "")).slice(0, max);
}

function publicTurn(r: TurnRow) {
  return {
    id: String(r.rowId), startedAt: r.startedAt, runtime: displayText(r.runtime), kind: displayText(r.kind, r.sessionId, 40),
    trigger: displayText(r.trigger, r.sessionId, 80), calls: r.calls, contextSeen: r.contextSeen,
    totalTokens: r.totalTokens, output: r.output, reasoning: r.reasoning,
    tools: Object.entries(r.tools).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3)
      .map(([name, count]) => ({ name: displayText(name, r.sessionId), count })),
    attr: { task: r.attr.task, step: r.attr.step, round: r.attr.round, basis: r.attr.basis },
  };
}

/** Uses the CLI's call-time aggregation, including calls after midnight in turns that started yesterday. */
function agentSummary(db: Database, agent: string, since: number) {
  const rows = usageSummary(db, since, agent);
  const total = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0, reasoning: 0, calls: 0, totalTokens: 0 };
  for (const r of rows) for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += r[key];
  return { since, total, rows: rows.map(({ agent: _agent, ...r }: SummaryRow) => ({ ...r, model: displayText(r.model) })) };
}

export function agentUsage(db: Database | null, agent: string, options: AgentUsageOptions, now = Date.now()) {
  if (!db) return { agent, state: "missing", turns: [], next: null, today: null, week: null };
  // Prefer exact stored names; web also uses names without the registry prefix. Daily rows still resolve expired agents.
  const known = db.prepare("SELECT 1 FROM turns WHERE agent = ? UNION ALL SELECT 1 FROM daily WHERE agent = ? LIMIT 1");
  if (!agent.startsWith("agent-") && !known.get(agent, agent) && known.get(`agent-${agent}`, `agent-${agent}`)) agent = `agent-${agent}`;
  const day = new Date(now); day.setHours(0, 0, 0, 0);
  const page = turnsFor(db, agent, options.since, options.limit + 1, options.before).reverse();
  const more = page.length > options.limit;
  const rows = page.slice(0, options.limit), last = rows.at(-1);
  const cutoff = retentionCutoff(now);
  const d = new Date(cutoff), cutoffDay = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const retained = !rows.length && db.prepare(`SELECT 1 FROM calls c JOIN turns t ON t.turn_id = c.turn_id
    WHERE t.agent = ? AND c.ts >= ? LIMIT 1`).get(agent, cutoff);
  const expired = !rows.length && !retained && options.since < cutoff && !options.before && !!db.prepare("SELECT 1 FROM daily WHERE agent = ? AND day < ? LIMIT 1").get(agent, cutoffDay);
  return {
    agent, state: rows.length ? "ready" : expired ? "expired" : "empty", turns: rows.map(publicTurn),
    next: more && last ? `${last.startedAt}.${last.rowId}` : null,
    today: agentSummary(db, agent, day.getTime()), week: agentSummary(db, agent, now - 7 * 86400_000),
  };
}
