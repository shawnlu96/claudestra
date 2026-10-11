/**
 * 按「每次叫醒」计量一个 Claude Code 会话的请求与上下文成本（PMCOST1）。只读：不改会话、不 ingest、不写 usage 库。
 *
 * 叫醒 = 按原始顺序，一条**不是纯 tool_result** 的 user 记录开一次，止于下一次叫醒或 EOF；混合文本与 tool_result 的
 * user 也算新边界，compact_boundary 这条 system 记录本身不叫醒。这和 token 账（usage-classify.ts inboundOf）的「轮」
 * 是两种口径：那边跳过 isMeta 附加 / 压缩摘要，这里把技能正文、压缩续接各算一次叫醒并单独归类，便于看出谁在叫醒 agent。
 *
 * 请求 = 叫醒内去重后、带 usage 的 assistant 响应，去重键复用 jsonl-cost.ts usageDedupKey（message.id + requestId，
 * 同一响应取最后写的那行 usage）。PM 实测脚本只按 message.id 去重，两者只在同一 message.id 配不同 requestId 时有差。
 * 说明与命令见 docs/architecture/wake-cost.md，单测 tests/wake-cost*.test.ts。
 */
import { writeJsonAtomic } from "./state-file.js";
import { usageDedupKey } from "./jsonl-cost.js";
import { translateSessionLine } from "./session-source.js";
import { join } from "path";

type Rec = Record<string, any>;

type WakeSource = "owner" | "executor" | "dispatch" | "task_notification" | "skill" | "compact_resume" | "other";
const WAKE_SOURCES: WakeSource[] = ["owner", "executor", "dispatch", "task_notification", "skill", "compact_resume", "other"];

/** 来源分类结果：reason 只写规则代号，不带正文、用户名或 id */
export interface WakeSourceResult {
  source: WakeSource;
  reason: string;
}

interface Tokens {
  input: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
}

interface WakeRow extends Tokens {
  source: WakeSource;
  reason: string;
  /** ISO；头部没有叫醒边界的那段用首条记录的时间 */
  start: string | null;
  end: string | null;
  requests: number;
  /** input + cacheRead + cacheCreation（不含 output） */
  contextTotal: number;
  /** 叫醒开始于窗口之前，只计了窗口内的请求 */
  windowTruncated: boolean;
  /** 止于 EOF（后面没有下一次叫醒，可能还在跑） */
  unfinished: boolean;
}

export interface WakeScan {
  wakes: WakeRow[];
  /** 窗口内每个去重请求的 contextTotal，按出现顺序 */
  requestContexts: number[];
  /** 每个 compact_boundary 后首个有效去重请求的 contextTotal（窗口内） */
  compactFloors: number[];
  /** 读不成 JSON 的行数（跳过，不致崩溃） */
  badLines: number;
  firstTs: string | null;
  lastTs: string | null;
}

export interface Pct {
  n: number;
  p10: number | null;
  p50: number | null;
  p90: number | null;
  max: number | null;
}

// ── 叫醒边界与来源 ──────────────────────────────────────────────────────

function contentBlocks(rec: Rec): unknown[] | null {
  const c = rec?.message?.content;
  return Array.isArray(c) ? c : null;
}

/** user 记录是不是叫醒边界：纯 tool_result（数组里全是 tool_result 块）不算，其它 user 都算 */
export function isWakeBoundary(rec: Rec): boolean {
  if (rec?.type !== "user") return false;
  const blocks = contentBlocks(rec);
  if (!blocks) return typeof rec?.message?.content === "string";
  if (blocks.length === 0) return false;
  return !blocks.every((b: any) => b?.type === "tool_result");
}

function textOf(rec: Rec): string {
  const c = rec?.message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.map((b: any) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).join("\n");
}

/** `<channel a="b" …>` 的头属性；不是 channel 包装返回 null */
function channelAttrs(text: string): Record<string, string> | null {
  const m = /^\s*<channel\b([^>]*)>/.exec(text);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const a of m[1].matchAll(/([A-Za-z_][\w-]*)="([^"]*)"/g)) out[a[1]] = a[2];
  return out;
}

/** 调度 / 台账 / 巡检 / 监工 这类系统 agent 的名字（channel 头的 user 属性） */
const DISPATCH_AGENT_RE = /^(?:agent-)?(?:scheduler|dispatch\w*|ledger\w*|patrol\w*|inspect\w*|supervisor|watchdog|monitor\w*|cron)\b|调度|台账|巡检|监工/i;

/** channel 消息按结构字段归类；不读正文 */
function classifyChannel(a: Record<string, string>): WakeSourceResult {
  const trigger = a.trigger ?? "";
  if (trigger === "ask_answer") return { source: "owner", reason: "channel:trigger=ask_answer" };
  if (a.is_bridge === "true" || /^bridge(:|$)/.test(a.user ?? "")) return { source: "dispatch", reason: "channel:bridge" };
  if (trigger === "system" || trigger === "bridge_synth") return { source: "dispatch", reason: `channel:trigger=${trigger}` };
  if (a.is_agent === "true" || trigger === "agent_tool") {
    return DISPATCH_AGENT_RE.test(a.user ?? "")
      ? { source: "dispatch", reason: "channel:agent=dispatch-role" }
      : { source: "executor", reason: "channel:agent" };
  }
  if (trigger === "peer_http") return { source: "executor", reason: "channel:trigger=peer_http" };
  // api 入口可能是 owner 也可能是访客 / scoped token，头里分不出来：不猜 owner
  if (a.api === "true") return { source: "other", reason: "channel:api-unknown-principal" };
  if (trigger === "user_discord") return { source: "owner", reason: "channel:trigger=user_discord" };
  return { source: "other", reason: "channel:unknown" };
}

/** 一条叫醒边界归哪类来源。先看结构字段（isCompactSummary / origin / channel 头），再看固定前缀；认不出归 other */
export function classifyWakeSource(rec: Rec): WakeSourceResult {
  if (rec?.isCompactSummary) return { source: "compact_resume", reason: "isCompactSummary" };
  const text = textOf(rec);
  const t = text.trimStart();
  const ch = channelAttrs(t);
  if (ch) return classifyChannel(ch);
  const origin = typeof rec?.origin === "object" ? rec.origin?.kind : rec?.origin;
  if (origin === "task-notification" || t.startsWith("<task-notification")) return { source: "task_notification", reason: "task-notification" };
  if (/^Base directory for this skill:/.test(t)) return { source: "skill", reason: "skill-body" };
  if (/^This session is being continued from a previous conversation/.test(t)) return { source: "compact_resume", reason: "continued-text" };
  if (Array.isArray(rec?.message?.content) && rec.message.content.some((b: any) => b?.type === "tool_result")) {
    return { source: "other", reason: "mixed-tool-result" };
  }
  if (origin) return { source: "other", reason: `origin=${String(origin).replace(/[^\w-]/g, "").slice(0, 32)}` };
  return { source: "other", reason: "unknown" };
}

// ── 扫描 ────────────────────────────────────────────────────────────────

interface OpenWake {
  src: WakeSourceResult;
  startTs: string | null;
  endTs: string | null;
  /** 去重键（按首次出现顺序）+ 无键记录 */
  keys: string[];
  loose: Rec[];
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function tokensOf(rec: Rec): Tokens {
  const u = rec?.message?.usage ?? {};
  return {
    input: num(u.input_tokens), cacheRead: num(u.cache_read_input_tokens),
    cacheCreation: num(u.cache_creation_input_tokens), output: num(u.output_tokens),
  };
}

const contextOf = (t: Tokens): number => t.input + t.cacheRead + t.cacheCreation;

function tsMs(rec: Rec): number {
  return Date.parse(rec?.timestamp);
}

/** 第一遍：按原始顺序切叫醒，记下每个请求的最后一份 usage 与压缩后首请求 */
function splitWakes(text: string) {
  const wakes: OpenWake[] = [];
  const latest = new Map<string, Rec>();
  const floorRefs: (string | Rec)[] = [];
  let badLines = 0;
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  let pendingCompact = false;
  let cur: OpenWake | null = null;
  const scope = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const rec = translateSessionLine(undefined, line, scope);
    if (!rec) { badLines++; continue; }
    const ts = typeof rec.timestamp === "string" && Number.isFinite(tsMs(rec)) ? rec.timestamp : null;
    if (ts) { firstTs ??= ts; lastTs = ts; }
    if (rec.type === "system" && rec.subtype === "compact_boundary") { pendingCompact = true; continue; }
    if (isWakeBoundary(rec)) {
      if (cur && ts) cur.endTs = ts; // 前一轮止于下一次叫醒的边界时间（EOF 时为最后一条记录的时间）
      cur = { src: classifyWakeSource(rec), startTs: ts, endTs: ts, keys: [], loose: [] };
      wakes.push(cur);
      continue;
    }
    const isRequest = rec.type === "assistant" && !!rec.message?.usage;
    if (!cur) {
      // 文件头的元数据（file-history-snapshot、permission-mode 等）不算叫醒；
      // 只有边界前确有请求（续接会话的开头）才单列一次 other 来归属它
      if (!isRequest) continue;
      cur = { src: { source: "other", reason: "no-boundary-head" }, startTs: ts, endTs: ts, keys: [], loose: [] };
      wakes.push(cur);
    }
    if (ts) cur.endTs = ts;
    if (!isRequest) continue;
    const k = usageDedupKey(rec);
    const isNew = k === null || !latest.has(k);
    if (k === null) cur.loose.push(rec);
    else { if (isNew) cur.keys.push(k); latest.set(k, rec); }
    if (pendingCompact && isNew) { floorRefs.push(k ?? rec); pendingCompact = false; }
  }
  return { wakes, latest, floorRefs, badLines, firstTs, lastTs };
}

/**
 * 会话全文 → 叫醒列表。sinceTs（ms）> 0 时只累加窗口内的请求：窗口前开始的叫醒仍按它自己的边界归属（标 windowTruncated），
 * 窗口内没有请求、又开始于窗口前的叫醒不输出。没有时间戳的请求在有窗口时不计（与 rollupJsonl 同）。
 */
export function scanWakes(text: string, sinceTs = 0): WakeScan {
  const s = splitWakes(text);
  const inWin = (rec: Rec) => sinceTs <= 0 || tsMs(rec) >= sinceTs;
  const requestContexts: number[] = [];
  const out: WakeRow[] = [];
  s.wakes.forEach((w, i) => {
    const recs = [...w.keys.map((k) => s.latest.get(k)!), ...w.loose].filter(inWin);
    const startMs = w.startTs ? Date.parse(w.startTs) : NaN;
    const startsBefore = sinceTs > 0 && !(startMs >= sinceTs);
    if (startsBefore && recs.length === 0) return;
    const sum: Tokens = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 };
    for (const r of recs) {
      const t = tokensOf(r);
      sum.input += t.input; sum.cacheRead += t.cacheRead; sum.cacheCreation += t.cacheCreation; sum.output += t.output;
      requestContexts.push(contextOf(t));
    }
    out.push({
      source: w.src.source, reason: w.src.reason, start: w.startTs, end: w.endTs, requests: recs.length,
      ...sum, contextTotal: contextOf(sum), windowTruncated: startsBefore, unfinished: i === s.wakes.length - 1,
    });
  });
  const compactFloors = s.floorRefs
    .map((r) => (typeof r === "string" ? s.latest.get(r)! : r))
    .filter(inWin)
    .map((r) => contextOf(tokensOf(r)));
  return { wakes: out, requestContexts, compactFloors, badLines: s.badLines, firstTs: s.firstTs, lastTs: s.lastTs };
}

// ── 聚合 ────────────────────────────────────────────────────────────────

/** 排序后取 floor(p×(n−1))；空样本全为 null */
export function percentiles(values: number[]): Pct {
  const v = [...values].sort((a, b) => a - b);
  const at = (p: number) => (v.length ? v[Math.floor(p * (v.length - 1))] : null);
  return { n: v.length, p10: at(0.1), p50: at(0.5), p90: at(0.9), max: v.length ? v[v.length - 1] : null };
}

export type StepBucket = "0" | "1-3" | "4-10" | "11+";
const STEP_BUCKETS: StepBucket[] = ["0", "1-3", "4-10", "11+"];

export function stepBucket(requests: number): StepBucket {
  if (requests <= 0) return "0";
  if (requests <= 3) return "1-3";
  if (requests <= 10) return "4-10";
  return "11+";
}

interface ShareRow {
  wakes: number;
  requests: number;
  contextTotal: number;
  /** contextTotal / 总 contextTotal（0–1）；总量为 0 时为 0 */
  share: number;
}

interface WakeTotals extends Tokens {
  wakes: number;
  requests: number;
  contextTotal: number;
}

export interface WakeAggregate {
  totals: WakeTotals;
  requestContext: Pct;
  wakeCost: Pct;
  compactFloor: Pct;
  buckets: ({ bucket: StepBucket } & ShareRow)[];
  bySource: ({ source: WakeSource; reasons: Record<string, number> } & ShareRow)[];
}

function shareRows<K extends string>(keys: K[], wakes: WakeRow[], keyOf: (w: WakeRow) => K, total: number) {
  return keys.map((k) => {
    const ws = wakes.filter((w) => keyOf(w) === k);
    const contextTotal = ws.reduce((s, w) => s + w.contextTotal, 0);
    return { key: k, ws, wakes: ws.length, requests: ws.reduce((s, w) => s + w.requests, 0), contextTotal, share: total > 0 ? contextTotal / total : 0 };
  });
}

export function aggregateWakes(scan: WakeScan): WakeAggregate {
  const w = scan.wakes;
  const totals: WakeTotals = { wakes: w.length, requests: 0, input: 0, cacheRead: 0, cacheCreation: 0, output: 0, contextTotal: 0 };
  for (const r of w) {
    totals.requests += r.requests; totals.input += r.input; totals.cacheRead += r.cacheRead;
    totals.cacheCreation += r.cacheCreation; totals.output += r.output; totals.contextTotal += r.contextTotal;
  }
  const strip = ({ key: _k, ws: _w, ...rest }: { key: string; ws: WakeRow[] } & ShareRow) => rest;
  return {
    totals,
    requestContext: percentiles(scan.requestContexts),
    wakeCost: percentiles(w.map((r) => r.contextTotal)),
    compactFloor: percentiles(scan.compactFloors),
    buckets: shareRows(STEP_BUCKETS, w, (r) => stepBucket(r.requests), totals.contextTotal).map((r) => ({ bucket: r.key, ...strip(r) })),
    bySource: shareRows(WAKE_SOURCES, w, (r) => r.source, totals.contextTotal)
      .filter((r) => r.wakes > 0)
      .map((r) => {
        const reasons: Record<string, number> = {};
        for (const x of r.ws) reasons[x.reason] = (reasons[x.reason] ?? 0) + 1;
        return { source: r.key, reasons, ...strip(r) };
      }),
  };
}

// ── 报表 ────────────────────────────────────────────────────────────────

export interface WakeWindow {
  /** 窗口起点 ms；0 = 全会话 */
  since: number;
  /** today / week:quota / week:rolling / since / all */
  source: string;
}

interface WakeCoverage {
  scope: "registry-current-session";
  /** 会话 id 前 8 位 */
  session: string;
  start: string | null;
  end: string | null;
}

export interface WakeReport extends WakeAggregate {
  ok: true;
  status: "ok";
  agent: string;
  runtime: "claude-code";
  window: WakeWindow & { sinceIso: string | null };
  coverage: WakeCoverage;
  dedup: string;
  badLines: number;
  wakes: WakeRow[];
}

const DEDUP_NOTE = "message.id+requestId（jsonl-cost usageDedupKey，取最后一行 usage）；PM 脚本只按 message.id";

export function buildWakeReport(agent: string, sessionId: string, scan: WakeScan, win: WakeWindow): WakeReport {
  return {
    ok: true, status: "ok", agent, runtime: "claude-code",
    window: { ...win, sinceIso: win.since > 0 ? new Date(win.since).toISOString() : null },
    coverage: { scope: "registry-current-session", session: sessionId.slice(0, 8), start: scan.firstTs, end: scan.lastTs },
    dedup: DEDUP_NOTE, badLines: scan.badLines,
    ...aggregateWakes(scan), wakes: scan.wakes,
  };
}

const fmtN = (n: number | null) => (n === null ? "-" : n.toLocaleString("en-US"));
const fmtPct = (x: number) => `${(x * 100).toFixed(1)}%`;
const pctLine = (label: string, p: Pct) => `${label}: n=${p.n} p10=${fmtN(p.p10)} p50=${fmtN(p.p50)} p90=${fmtN(p.p90)} max=${fmtN(p.max)}`;

function padRow(cells: string[], widths: number[]): string {
  return cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
}

function table(head: string[], rows: string[][]): string[] {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  return [padRow(head, widths), ...rows.map((r) => padRow(r, widths))];
}

/** 人读表；合计行与 JSON 的 totals 同源 */
export function renderWakeTable(r: WakeReport): string {
  const t = r.totals;
  const lines = [
    `wake-cost  agent=${r.agent}  window=${r.window.source}${r.window.sinceIso ? ` since ${r.window.sinceIso}` : ""}`,
    `coverage: ${r.coverage.scope} session=${r.coverage.session} ${r.coverage.start ?? "-"} → ${r.coverage.end ?? "-"}`,
    `dedup: ${r.dedup}${r.badLines ? `  badLines=${r.badLines}` : ""}`,
    "",
    ...table(["steps", "wakes", "requests", "contextTotal", "share"],
      r.buckets.map((b) => [b.bucket, fmtN(b.wakes), fmtN(b.requests), fmtN(b.contextTotal), fmtPct(b.share)])),
    "",
    ...table(["source", "wakes", "requests", "contextTotal", "share"],
      r.bySource.map((b) => [b.source, fmtN(b.wakes), fmtN(b.requests), fmtN(b.contextTotal), fmtPct(b.share)])),
    "",
    pctLine("requestContext", r.requestContext),
    pctLine("wakeCost", r.wakeCost),
    pctLine("compactFloor", r.compactFloor),
    "",
    `total: wakes=${t.wakes} requests=${t.requests} input=${t.input} cacheRead=${t.cacheRead} cacheCreation=${t.cacheCreation} output=${t.output} contextTotal=${t.contextTotal}`,
  ];
  return lines.join("\n");
}

// ── 周汇总（显式 --write-weekly 才写） ─────────────────────────────────

/** 周汇总：去掉逐次叫醒明细，只留聚合与覆盖范围；不含生成时刻，同窗口同数据重写结果逐字相同 */
function weeklySummary(r: WakeReport) {
  const { wakes: _wakes, ok: _ok, ...rest } = r;
  return rest;
}

/** <stateDir>/wake-cost/<周起点 ISO>.json 原子覆盖；返回写入路径 */
export async function writeWeeklySummary(stateDir: string, r: WakeReport): Promise<string> {
  const stamp = new Date(r.window.since).toISOString().replace(/:/g, "-");
  const path = join(stateDir, "wake-cost", `${stamp}.json`);
  await writeJsonAtomic(path, weeklySummary(r), { trailingNewline: true });
  return path;
}
