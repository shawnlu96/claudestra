/**
 * Jev（TypeSafe System One）通用客户端——给「代码里缺一块语义判断」的地方用，不是聊天模型（docs/jev.md）。
 * 一次请求：一份 state + 若干类型化问题 → 每题一个结构化答案（noul 概率 / choice 选项分布 / score 等级分布）。
 * 同一 state 上的多个问题**合在一次调用**（模型只读一遍 state，便宜且快）。key 只在服务端：设置里的 jevApiKey，
 * 兜底 env TYPESAFE_API_KEY；没有就抛 JevError("not_configured")，调用方按「没有 Jev」降级。
 * 纯 fetch 实现（不引 SDK，bridge 依赖树不加包）；429 / 529 按 retry-after 退避重试。tests/jev-client.test.ts。
 */
import { readConfig } from "./config-store.js";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_DEFAULT_MODEL = "jev-latest";
/** 只计输入 token；输出免费（docs.typesafe.ai/models） */
const JEV_USD_PER_MTOK = 0.042;

export type JevText = string | Record<string, unknown> | unknown[];
export interface JevNoul { type: "noul"; instructions: JevText; criteria?: { true?: JevText; false?: JevText } }
export interface JevChoice<O extends string = string> { type: "choice"; instructions: JevText; criteria: Record<O, JevText | null> }
export interface JevScore { type: "score"; instructions: JevText; criteria: JevText[] }
export type JevQuestion = JevNoul | JevChoice | JevScore;

/** 是 / 否：答案 noul ∈ [0,1] 是「是」的概率（0.5 附近 = 两可，不是「中等程度」） */
export const noul = (instructions: JevText, criteria?: JevNoul["criteria"]): JevNoul => ({ type: "noul", instructions, ...(criteria ? { criteria } : {}) });
/** 单选：criteria 的键就是选项名（≤255 个），值是该选项的说明（null = 不用解释）；记得留一个「都不是」的选项 */
export const choice = <O extends string>(instructions: JevText, criteria: Record<O, JevText | null>): JevChoice<O> => ({ type: "choice", instructions, criteria });
/** 打分：levels 是有序等级的描述，答案 score 是按概率加权的位置（可落在两级之间） */
export const score = (instructions: JevText, levels: JevText[]): JevScore => ({ type: "score", instructions, criteria: levels });

interface NoulAnswer { type: "noul"; noul: number }
interface ChoiceAnswer<O extends string = string> { type: "choice"; choice: O; probabilities: Record<O, number>; confidence: number }
interface ScoreAnswer { type: "score"; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number }
type AnswerFor<Q> = Q extends JevNoul ? NoulAnswer : Q extends JevChoice<infer O> ? ChoiceAnswer<O> : Q extends JevScore ? ScoreAnswer : never;
type JevAnswers<Qs extends Record<string, JevQuestion>> = { [K in keyof Qs]: AnswerFor<Qs[K]> };

export interface JevUsage { input_tokens: number; output_tokens: number }
export interface JevResult<Qs extends Record<string, JevQuestion>> { model: string; answers: JevAnswers<Qs>; usage: JevUsage; latencyMs: number; costUsd: number }

export type JevErrorCode = "not_configured" | "unauthorized" | "invalid_request" | "rate_limited" | "overloaded" | "timeout" | "network" | "bad_response" | "http";
export class JevError extends Error {
  constructor(public code: JevErrorCode, message: string, public status?: number) {
    super(message);
    this.name = "JevError";
  }
}

export interface JevDeps {
  readKey: () => Promise<string>;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
}
export interface JevAskOptions {
  /** 缺省 jev-latest；调过阈值的场景钉版本号（jev-1.13.0） */
  model?: string;
  /** 单次请求超时，缺省 15 s */
  timeoutMs?: number;
  /** 429 / 529 重试次数，缺省 2 */
  retries?: number;
  signal?: AbortSignal;
}

const realDeps: JevDeps = {
  readKey: async () => (await readConfig()).jevApiKey || process.env.TYPESAFE_API_KEY || "",
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export const jevKeyHint = (key: string | undefined): string | null => (key ? `····${key.slice(-4)}` : null);
export const jevCostUsd = (usage: JevUsage): number => (usage.input_tokens / 1_000_000) * JEV_USD_PER_MTOK;
export async function jevConfigured(deps: Partial<JevDeps> = {}): Promise<boolean> {
  return !!(await (deps.readKey ?? realDeps.readKey)());
}

/** 请求体（纯函数，便于单测与日志） */
export function buildJevRequest(state: JevText, questions: Record<string, JevQuestion>, model = JEV_DEFAULT_MODEL): { state: JevText; model: string; questions: Record<string, JevQuestion> } {
  return { state, model, questions };
}

function retryAfterMs(res: Response, attempt: number): number {
  const h = Number(res.headers.get("retry-after"));
  return Number.isFinite(h) && h > 0 ? Math.min(h * 1000, 10_000) : Math.min(500 * 2 ** attempt, 4000);
}

async function errorFrom(res: Response): Promise<JevError> {
  const body = (await res.json().catch(() => null /* 非 JSON 错误体：只报状态码 */)) as { error?: unknown; message?: unknown } | null;
  const detail = typeof body?.error === "string" ? body.error : typeof body?.message === "string" ? body.message : "";
  const msg = `Jev HTTP ${res.status}${detail ? `: ${detail}` : ""}`;
  if (res.status === 401) return new JevError("unauthorized", msg, 401);
  if (res.status === 422) return new JevError("invalid_request", msg, 422);
  if (res.status === 429) return new JevError("rate_limited", msg, 429);
  if (res.status === 529) return new JevError("overloaded", msg, 529);
  return new JevError("http", msg, res.status);
}

/**
 * 主入口。`questions` 的键由你定（不发给模型），答案按同键返回并带类型推断：
 *   const r = await jevAsk(text, { urgent: noul("Is this urgent?"), kind: choice("What is it?", { bug: null, question: null, other: null }) });
 *   r.answers.urgent.noul; r.answers.kind.choice  // "bug" | "question" | "other"
 */
export async function jevAsk<Qs extends Record<string, JevQuestion>>(state: JevText, questions: Qs, opts: JevAskOptions = {}, deps: Partial<JevDeps> = {}): Promise<JevResult<Qs>> {
  const d: JevDeps = { ...realDeps, ...deps };
  const key = await d.readKey();
  if (!key) throw new JevError("not_configured", "Jev not configured: set the TypeSafe API key in settings (or TYPESAFE_API_KEY)");
  const body = JSON.stringify(buildJevRequest(state, questions, opts.model));
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const t0 = Date.now();
  for (let attempt = 0; ; attempt++) {
    const signals = [AbortSignal.timeout(timeoutMs), ...(opts.signal ? [opts.signal] : [])];
    let res: Response;
    try {
      res = await d.fetch(JEV_ENDPOINT, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body, signal: AbortSignal.any(signals) });
    } catch (e) {
      const timedOut = (e as Error).name === "TimeoutError" || (e as Error).name === "AbortError";
      throw new JevError(timedOut ? "timeout" : "network", `Jev ${timedOut ? "timed out" : "network error"}: ${(e as Error).message}`);
    }
    if ((res.status === 429 || res.status === 529) && attempt < retries) {
      await d.sleep(retryAfterMs(res, attempt));
      continue;
    }
    if (!res.ok) throw await errorFrom(res);
    const json = (await res.json().catch(() => null /* 非 JSON 成功体：下面按 bad_response 抛 */)) as { model?: unknown; answers?: unknown; usage?: Partial<JevUsage> } | null;
    if (!json || typeof json.answers !== "object" || json.answers === null) throw new JevError("bad_response", "Jev returned no answers");
    const usage: JevUsage = { input_tokens: json.usage?.input_tokens ?? 0, output_tokens: json.usage?.output_tokens ?? 0 };
    const model = typeof json.model === "string" ? json.model : opts.model ?? JEV_DEFAULT_MODEL;
    return { model, answers: json.answers as JevAnswers<Qs>, usage, latencyMs: Date.now() - t0, costUsd: jevCostUsd(usage) };
  }
}
