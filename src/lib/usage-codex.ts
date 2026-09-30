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

/**
 * 一次请求的去重键：线程 + 五项原始计数。同一次请求会落两遍（token_usage_record 和紧跟的 token_count.last_token_usage，数一样）、
 * token_count 会重复落盘、revert 新段 / 归档副本会带着旧段的记录——这几份的线程和计数都相同，落到同一个键。
 * 不用时间戳：record 和 token_count 差几毫秒。不用 response_id：老 Codex 没有 record、token_count 里也没有它。
 * 本机 30 天 7259 次请求实测，同一线程里五项全同的两次不同请求为 0。
 */
function callKey(thread: string, u: Rec): string {
  const f = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens"];
  return `cx:${thread}:${f.map((k) => n(u[k])).join(":")}`;
}

export interface CodexLineCtx {
  cutoff: number;
  /** 线程（子线程再带父线程）→ 主人；认不出 = unowned */
  ownerOf: (thread: string, parent: string | null) => string;
  tool: (id: string, turnId: string, name: string) => void;
}

/** 切到一轮：Codex 自己的 turn_id 就是轮的身份（revert 新段 / 归档副本里同一轮还是同一个 id，turns 按主键只建一次） */
function enterTurn(st: FileState, turnId: string, ts: number, continued: boolean): void {
  const id = `cx:${turnId}`;
  if (st.turn_id === id) return;
  st.turn_id = id;
  st.turn_start = ts;
  st.turn_kind = continued ? "continued" : null;
  st.turn_trigger = "";
  st.turn_input = null;
}

/** 本轮第一条外来输入定来源类型和摘要（复用 Claude 那边的判定：channel 包装、人敲的字；注入的环境说明、工具输出不算） */
function noteInbound(line: string, st: FileState): void {
  if (!st.turn_id || st.turn_kind) return;
  const shaped = codexLineToClaudeShape(line);
  const i = shaped ? inboundOf(shaped) : null;
  if (!i) return;
  st.turn_kind = st.sidechain && i.kind === "human" ? "subagent" : i.kind;
  st.turn_trigger = triggerSummary(i);
}

/**
 * 一行 rollout：改文件状态（主人、当前轮、模型），是一次保留期内的请求就返回它。
 * 轮边界 = task_started / turn_context 的 turn_id；用量取 token_usage_record.usage（新 Codex，每请求一条）或 token_count.last_token_usage，
 * 两者按 callKey 落成同一次。模型取 turn_context.model：那是**请求**的模型，rollout 不记响应模型（查询时标 modelBasis = request）。
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
      if (p.type === "token_count") return callOf(p.info?.last_token_usage, ts, st, ctx);
      return null;
    case "token_usage_record":
      // 新段从一轮中间开始时这里先看到本轮的 id：单独起一轮，来源记 continued
      if (typeof p.turn_id === "string" && p.turn_id && `cx:${p.turn_id}` !== st.turn_id) enterTurn(st, p.turn_id, ts, true);
      return callOf(p.usage, ts, st, ctx);
    case "response_item":
      if (p.type === "message" && p.role === "user") noteInbound(line, st);
      else if (TOOL_TYPES.has(p.type) && st.turn_id) ctx.tool(`cx:${p.call_id ?? p.id ?? `${st.turn_id}:${e.ordinal}`}`, st.turn_id, String(p.name ?? p.type));
      return null;
    default:
      return null;
  }
}

function callOf(u: unknown, ts: number, st: FileState, ctx: CodexLineCtx): CallUsage | null {
  const usage = codexUsage(u);
  if (!usage || !Number.isFinite(ts) || ts < ctx.cutoff) return null;
  if (!st.turn_id) enterTurn(st, `head:${st.session_id}`, ts, true); // 文件里第一条用量之前没有轮边界（老格式 / 截断的副本）
  return { key: callKey(st.session_id, u as Rec), ts, model: st.model ?? "unknown", ...usage, tools: [] };
}
