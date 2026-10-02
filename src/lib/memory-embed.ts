/**
 * 项目记忆的嵌入提供方（设计稿 docs/design/project-memory.md §5）。配置 config.json 的 `memory.embed`（数组，按序取第一个可用的）：
 *   {"provider":"ollama","model":"embeddinggemma","url":"http://127.0.0.1:11434"}
 *   {"provider":"voyage","model":"voyage-4-lite","apiKeyEnv":"VOYAGE_API_KEY"} / {"provider":"openai","model":"text-embedding-3-small",…}
 * 没配 = 只试本机 Ollama 的 embeddinggemma、bge-m3（多语言；nomic-embed-text 以英文为主，不作默认）；配成 [] = 关掉语义这一路。
 * 远端 API 只有 owner 显式写进配置才会用。
 *
 * 三条硬规矩（M4 验收线）：
 * - 没有可用模型 / 调用失败 / 返回形状不对 → 结果为空（null），从不抛错：语义路为空不阻塞派单；
 * - 每次调用 2 秒超时（探活同样 2 秒），超时当失败；
 * - 发到远端（远端 API，或不在回环地址上的 Ollama）的只有 visibility = team 的文本，且发之前再过一遍 dispatch-redact
 *   （写入时已过闸，这里防的是规则更新后的老行）；home 文本这一条直接不嵌入。
 */
import { redactForPeer } from "./dispatch-redact.js";
import type { MemoryVisibility } from "./ledger-memory-schema.js";
import { CONFIG_PATH } from "./paths.js";
import { readJsonStateSync } from "./state-file.js";

export const EMBED_TIMEOUT_MS = 2000;

const OLLAMA_URL = "http://127.0.0.1:11434";
const REMOTE_URL = { openai: "https://api.openai.com/v1/embeddings", voyage: "https://api.voyageai.com/v1/embeddings" } as const;
const DEFAULT_EMBED: EmbedConfig[] = [
  { provider: "ollama", model: "embeddinggemma", url: OLLAMA_URL },
  { provider: "ollama", model: "bge-m3", url: OLLAMA_URL },
];

export type EmbedConfig =
  | { provider: "ollama"; model: string; url: string }
  | { provider: "openai" | "voyage"; model: string; url: string; apiKey?: string; apiKeyEnv?: string };

/** 一个能用的嵌入模型。model 带提供方前缀（`ollama:embeddinggemma`），是向量表主键的一半：换模型 = 另一套向量 */
export interface Embedder {
  model: string;
  /** true = 文本会离开本机，过 team + 脱敏闸 */
  remote: boolean;
  embed(texts: string[], signal: AbortSignal): Promise<unknown>;
}

/** 要嵌入的一段文本；visibility 由调用方按来源给（记忆取行上的，查询文本由检索方判） */
export interface EmbedText {
  text: string;
  visibility: MemoryVisibility;
}

export interface EmbedDeps {
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** `memory.embed` 的原值 → 配置列表；不认识的条目跳过（不报错，doctor 再提示）；undefined = 没配 → 默认 */
export function parseEmbedConfig(raw: unknown): EmbedConfig[] {
  if (raw === undefined || raw === null) return DEFAULT_EMBED;
  if (!Array.isArray(raw)) return [];
  const out: EmbedConfig[] = [];
  for (const e of raw as Record<string, unknown>[]) {
    const model = str(e?.model);
    if (!e || typeof e !== "object" || !model) continue;
    if (e.provider === "ollama") out.push({ provider: "ollama", model, url: str(e.url) ?? OLLAMA_URL });
    else if (e.provider === "openai" || e.provider === "voyage") {
      out.push({ provider: e.provider, model, url: str(e.url) ?? REMOTE_URL[e.provider], apiKey: str(e.apiKey), apiKeyEnv: str(e.apiKeyEnv) });
    }
  }
  return out;
}

/**
 * 读 config.json 的 `memory.embed`。直接读原文件：config-store 的 merge 是白名单，不带 memory 字段。
 * 文件不在 / 坏了 → 当没配（只试本机 Ollama，不会因此把远端打开）
 */
export function readEmbedConfig(path = CONFIG_PATH): EmbedConfig[] {
  const r = readJsonStateSync(path);
  const memory = r.status === "ok" ? (r.data as { memory?: { embed?: unknown } } | null)?.memory : undefined;
  return parseEmbedConfig(memory && typeof memory === "object" ? memory.embed : undefined);
}

function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "::1" || h === "[::1]" || /^127\./.test(h);
  } catch {
    return false;
  }
}

/** fn 在 ms 内没完成就中止并返回 null；fn 抛错也返回 null。用 race 而不是只靠 signal：fetch 实现不认 signal 时也按时返回 */
async function within<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      ac.abort();
      resolve(null);
    }, ms);
  });
  try {
    return await Promise.race([fn(ac.signal), timeout]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(f: typeof fetch, url: string, body: unknown, signal: AbortSignal, headers: Record<string, string> = {}): Promise<unknown> {
  const r = await f(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function ollamaEmbedder(c: Extract<EmbedConfig, { provider: "ollama" }>, f: typeof fetch): Embedder {
  return {
    model: `ollama:${c.model}`,
    remote: !isLoopback(c.url),
    embed: async (texts, signal) => ((await postJson(f, `${c.url}/api/embed`, { model: c.model, input: texts }, signal)) as { embeddings?: unknown })?.embeddings,
  };
}

function apiEmbedder(c: Extract<EmbedConfig, { provider: "openai" | "voyage" }>, key: string, f: typeof fetch): Embedder {
  return {
    model: `${c.provider}:${c.model}`,
    remote: true,
    embed: async (texts, signal) => {
      const res = (await postJson(f, c.url, { model: c.model, input: texts }, signal, { authorization: `Bearer ${key}` })) as { data?: unknown };
      if (!Array.isArray(res?.data)) return undefined;
      return [...(res.data as { index?: number; embedding?: unknown }[])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
    },
  };
}

/** Ollama 在不在、模型拉没拉：GET /api/tags，名字等于 model 或 `model:<tag>` 都算 */
async function ollamaHas(c: Extract<EmbedConfig, { provider: "ollama" }>, f: typeof fetch, ms: number): Promise<boolean> {
  const tags = await within(ms, async (signal) => {
    const r = await f(`${c.url}/api/tags`, { signal });
    return r.ok ? ((await r.json()) as { models?: { name?: unknown }[] }) : null;
  });
  const want = c.model.includes(":") ? [c.model] : [c.model, `${c.model}:latest`];
  return !!tags?.models?.some((m) => typeof m?.name === "string" && (want.includes(m.name) || (!c.model.includes(":") && m.name.startsWith(`${c.model}:`))));
}

/** 按配置顺序取第一个可用的嵌入模型；一个都没有返回 null（语义路关闭，不是错误） */
export async function pickEmbedder(configs: readonly EmbedConfig[], deps: EmbedDeps = {}): Promise<Embedder | null> {
  const f = deps.fetch ?? fetch;
  const env = deps.env ?? process.env;
  for (const c of configs) {
    if (c.provider === "ollama") {
      if (await ollamaHas(c, f, deps.timeoutMs ?? EMBED_TIMEOUT_MS)) return ollamaEmbedder(c, f);
      continue;
    }
    const key = c.apiKey ?? (c.apiKeyEnv ? str(env[c.apiKeyEnv]) : undefined);
    if (key) return apiEmbedder(c, key, f);
  }
  return null;
}

/** 远端闸：home → 不发；team → 过一遍脱敏再发。本机模型原文照用 */
export function textForEmbedder(e: Pick<Embedder, "remote">, item: EmbedText): string | null {
  if (!e.remote) return item.text;
  if (item.visibility !== "team") return null;
  return redactForPeer(item.text).text;
}

/** 返回值要是 n 条等长、非空、全是有限数的数组，否则整批作废 */
function toVectors(raw: unknown, n: number): Float32Array[] | null {
  if (!Array.isArray(raw) || raw.length !== n) return null;
  const dim = Array.isArray(raw[0]) ? raw[0].length : 0;
  if (!dim) return null;
  const out: Float32Array[] = [];
  for (const v of raw) {
    if (!Array.isArray(v) || v.length !== dim || !v.every((x) => typeof x === "number" && Number.isFinite(x))) return null;
    out.push(Float32Array.from(v as number[]));
  }
  return out;
}

/**
 * 嵌入一批文本，结果与输入逐条对齐：过不了远端闸的、调用失败 / 超时的位置是 null。没有模型（e = null）全是 null。从不抛错。
 * 一批一次调用、一次 2 秒超时；批大小由调用方控制。
 */
export async function embedTexts(e: Embedder | null, items: readonly EmbedText[], deps: Pick<EmbedDeps, "timeoutMs"> = {}): Promise<(Float32Array | null)[]> {
  const out: (Float32Array | null)[] = items.map(() => null);
  if (!e || !items.length) return out;
  const idx: number[] = [];
  const texts: string[] = [];
  items.forEach((it, i) => {
    const t = textForEmbedder(e, it);
    if (t !== null && t.trim()) {
      idx.push(i);
      texts.push(t);
    }
  });
  if (!texts.length) return out;
  const vecs = toVectors(await within(deps.timeoutMs ?? EMBED_TIMEOUT_MS, (signal) => e.embed(texts, signal)), texts.length);
  if (vecs) idx.forEach((i, k) => (out[i] = vecs[k]!));
  return out;
}
