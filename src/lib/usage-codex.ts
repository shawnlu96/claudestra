/**
 * token 账（T92）的 Codex 部分：rollout 一行 → 切轮 / 一次调用 / 工具 / 主人。与 usage-classify.ts（Claude）对应，导入在 usage-ingest.ts。
 * 口径说明见 docs/architecture/token-usage.md「Codex」一节，单测 tests/usage-codex.test.ts。
 */
import { codexLineToClaudeShape } from "./codex-session.js";
import { codexSubOf, isCodexSubThread } from "./codex-subthread.js";
import { inboundOf, triggerSummary, type CallUsage } from "./usage-classify.js";
import type { FileState } from "./usage-store.js";

export const CODEX = "codex";

/**
 * `rollout-<ISO>-<threadId>.jsonl`，以及 thread/revert 之后的新段 `rollout-<ISO>-<threadId>_<rolloutId>.jsonl`（同一个线程，文件换了）。
 * 共用的 codexSessionIdFromFilename 只认前一种，这里两种都认：新段漏读就是漏计。
 */
const ROLLOUT_RE = /^rollout-\d{4}-\d{2}-\d{2}T[\d-]+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f-]{36})?\.jsonl$/i;
export const codexThreadOfFile = (name: string): string | null => ROLLOUT_RE.exec(name)?.[1] ?? null;

type Rec = Record<string, any>;

/** 模型发起的工具调用（response_item 的 payload.type）；各自的 *_output 也带 call_id，不算 */
const TOOL_TYPES = new Set(["function_call", "custom_tool_call", "local_shell_call", "web_search_call"]);
/** 只有这些行和账有关；先按子串筛（rollout 是紧凑 JSON），大部分几 KB 的对话 / 工具输出行不用 JSON.parse */
const RELEVANT_RE = new RegExp(`"type":"(session_meta|turn_context|token_usage_record|token_count|task_started|${[...TOOL_TYPES].join("|")})"|"role":"user"`);

const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Codex 的一次请求用量 → 与 Claude 同形的四项 + reasoning。Codex 的 input_tokens 含命中缓存的部分、output_tokens 含 reasoning：
 * 拆开后 input + cacheCreation + cacheRead + output + reasoning = total_tokens，四项的含义与 Claude 一致。全零（只报限流的那种）= null。
 */
export function codexUsage(u: unknown): Omit<CallUsage, "key" | "ts" | "model" | "tools"> | null {
  if (!u || typeof u !== "object") return null;
  const r = u as Rec;
  const cached = n(r.cached_input_tokens);
  const reasoning = n(r.reasoning_output_tokens);
  const out = {
    input: Math.max(0, n(r.input_tokens) - cached), cacheCreation: n(r.cache_write_input_tokens), cacheRead: cached,
    output: Math.max(0, n(r.output_tokens) - reasoning), reasoning,
  };
  return out.input + out.cacheCreation + out.cacheRead + out.output + out.reasoning > 0 ? out : null;
}

const USAGE_FIELDS = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens"];
const vecOf = (u: Rec) => USAGE_FIELDS.map((k) => n(u[k])).join(":");

/**
 * 一次请求的身份。只有「同一条记录被写了两遍」算重复；计数恰好相同的两次独立请求必须是两次（T92 r1 P1-1：
 * 同一线程两轮各 1100、或 revert 新段里的新请求和旧请求计数相同，按计数做键会只剩一次）。
 * - 新 Codex：token_usage_record 按 轮 + response_id（没有就按它自己的时间戳）；revert 新段 / 归档副本带过去的是同一条记录，同一个键。
 *   紧跟它、计数相同的 token_count 是同一次请求的回声，不另计（countCall）。
 * - 老 Codex 只有 token_count：按 轮 + 进程累计 total + 计数；重复落盘的同一行三者都相同，独立请求的累计值不同。
 * 不拿 record 的线程累计去配 token_count 的累计：resume 之后两者分叉（本机 30 天 4 千多次对不上）。
 */
const recordKey = (st: FileState, p: Rec, ts: string) =>
  `cx:${st.session_id}:${st.turn_id}:r:${typeof p.response_id === "string" && p.response_id ? p.response_id : `@${ts}:${vecOf(p.usage ?? {})}`}`;
const countKey = (st: FileState, info: Rec) => `cx:${st.session_id}:${st.turn_id}:t:${n(info.total_token_usage?.total_tokens)}:${vecOf(info.last_token_usage ?? {})}`;

export interface CodexLineCtx {
  cutoff: number;
  /** 线程（子线程再带父线程）→ 主人；认不出 = unowned */
  ownerOf: (thread: string, parent: string | null) => string;
  tool: (id: string, turnId: string, name: string) => void;
  /** 认过的回声（token_count 身份）：隔着别的行再落一遍的回声靠它认出来；存库，跨文件、跨增量导入 */
  isEcho: (key: string) => boolean;
  noteEcho: (key: string, ts: number) => void;
}

/**
 * 切到一轮：Codex 自己的 turn_id 就是轮的身份（revert 新段 / 归档副本里同一轮还是同一个 id，turns 按主键只建一次）。
 * 来源先记 other（没有人 / channel 输入的轮：接入时的引导轮等），本轮第一条外来输入再改成它的类型；从中间开始的段记 continued。
 */
function enterTurn(st: FileState, turnId: string, ts: number, continued: boolean): void {
  const id = `cx:${turnId}`;
  if (st.turn_id === id) return;
  st.turn_id = id;
  st.turn_start = ts;
  st.turn_kind = continued ? "continued" : "other";
  st.turn_trigger = "";
  st.turn_input = null;
}

/** 本轮第一条外来输入定来源类型和摘要（复用 Claude 那边的判定：channel 包装、人敲的字；注入的环境说明、工具输出不算） */
function noteInbound(line: string, st: FileState): void {
  if (!st.turn_id || st.turn_trigger) return;
  const shaped = codexLineToClaudeShape(line);
  const i = shaped ? inboundOf(shaped) : null;
  if (!i) return;
  st.turn_kind = st.sidechain && i.kind === "human" ? "subagent" : i.kind;
  st.turn_trigger = triggerSummary(i);
}

/**
 * 一行 rollout：改文件状态（主人、当前轮、模型），是一次保留期内的请求就返回它。
 * 轮边界 = task_started / turn_context 的 turn_id；用量取 token_usage_record.usage（新 Codex，每请求一条）或 token_count.last_token_usage，
 * 两者是同一次请求（见 recordKey / countCall）。模型取 turn_context.model：那是**请求**的模型，rollout 不记响应模型（查询时标 modelBasis = request）。
 */
export function handleCodexLine(line: string, st: FileState, ctx: CodexLineCtx): CallUsage | null {
  if (!RELEVANT_RE.test(line)) return null;
  let e: Rec;
  try { e = JSON.parse(line); } catch { return null; } // 写到一半的行：只可能在文件尾，按整行读时不会遇到；坏行跳过不影响其它行
  const p: Rec = e?.payload && typeof e.payload === "object" ? e.payload : {};
  const ts = Date.parse(e?.timestamp);
  switch (e?.type) {
    case "session_meta": {
      const thread = String(p.id ?? p.session_id ?? "") || st.session_id;
      const parent = isCodexSubThread(p) ? codexSubOf(p).parentId || null : null;
      Object.assign(st, { session_id: thread, parent, sidechain: parent ? 1 : 0, agent: ctx.ownerOf(thread, parent) });
      return null;
    }
    case "turn_context":
      if (typeof p.model === "string" && p.model) st.model = p.model;
      if (typeof p.turn_id === "string" && p.turn_id) enterTurn(st, p.turn_id, ts, false);
      return null;
    case "event_msg":
      if (p.type === "task_started" && typeof p.turn_id === "string") enterTurn(st, p.turn_id, ts, false);
      if (p.type === "token_count") return countCall(p.info ?? {}, ts, st, ctx);
      return null;
    case "token_usage_record":
      // 新段从一轮中间开始时这里先看到本轮的 id：单独起一轮，来源记 continued
      if (typeof p.turn_id === "string" && p.turn_id && `cx:${p.turn_id}` !== st.turn_id) enterTurn(st, p.turn_id, ts, true);
      return callOf(p.usage, ts, st, ctx, () => {
        st.cx_pair = `rec|${st.turn_id}|${vecOf(p.usage ?? {})}`;
        return recordKey(st, p, String(e.timestamp));
      });
    case "response_item":
      if (p.type === "message" && p.role === "user") noteInbound(line, st);
      else if (TOOL_TYPES.has(p.type) && st.turn_id) ctx.tool(`cx:${p.call_id ?? p.id ?? `${st.turn_id}:${e.ordinal}`}`, st.turn_id, String(p.name ?? p.type));
      return null;
    default:
      return null;
  }
}

/**
 * token_count 三种情况不另计：紧跟 record、计数相同 = 它的回声（记下回声身份）；和上一条 token_count 累计值、计数都相同 = 紧挨着重复落盘
 * （本机见过重复那条落在下一轮 task_started 之后，所以不看轮）；身份是认过的回声 = 隔着别的行又落了一遍。其余是一次独立请求。
 * 配对状态存 files.cx_pair，跨读块、跨增量导入接得上。
 */
function countCall(info: Rec, ts: number, st: FileState, ctx: CodexLineCtx): CallUsage | null {
  const u: Rec = info.last_token_usage ?? {};
  if (!codexUsage(u)) return null;
  const prev = st.cx_pair;
  st.cx_pair = `tc|${n(info.total_token_usage?.total_tokens)}|${vecOf(u)}`;
  if (prev === st.cx_pair) return null;
  if (!st.turn_id) enterTurn(st, `head:${st.session_id}`, ts, true);
  const key = countKey(st, info);
  if (prev === `rec|${st.turn_id}|${vecOf(u)}`) {
    ctx.noteEcho(key, ts);
    return null;
  }
  if (ctx.isEcho(key)) return null;
  return callOf(u, ts, st, ctx, () => key);
}

function callOf(u: unknown, ts: number, st: FileState, ctx: CodexLineCtx, key: () => string): CallUsage | null {
  const usage = codexUsage(u);
  if (!usage) return null;
  if (!st.turn_id) enterTurn(st, `head:${st.session_id}`, ts, true); // 文件里第一条用量之前没有轮边界（老格式 / 截断的副本）
  const k = key(); // 保留期之前的也要走一遍：record 的配对状态得记下，它的回声才不会被当成独立请求
  if (!Number.isFinite(ts) || ts < ctx.cutoff) return null;
  return { key: k, ts, model: st.model ?? "unknown", ...usage, tools: [] };
}
