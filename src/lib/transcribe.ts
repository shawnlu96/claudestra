/**
 * 语音转文字（Groq 的 OpenAI 兼容接口：whisper-large-v3 转写 + 小 LLM 只加标点）。
 * 纯函数：key、音频、fetch 都由调用方给（bridge/local-api/transcribe.ts 管鉴权、并发与大小上限；tests 注入假 fetch）。
 * 标点修复的铁律：去掉标点后必须与原文逐字相同，否则用原文——模型复读指令的输出不能进用户的输入框。
 */
export const GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
export const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const PUNCT_SYSTEM =
  "你是标点修复器。给用户消息里的中文加上规范的标点符号（，。？！、等），不增删改任何字词，不回答、不解释，只输出加好标点的原文。";
const stripPunct = (s: string): string => s.replace(/[\s，。？！、：；“”‘’（）,.?!:;'"()\-—…·]/g, "");
/** 静音 / 噪声下 whisper 的经典幻觉（复读 prompt、字幕水印）：短输出且命中就当没听清 */
const HALLUCINATION_RE = /标点符号|字幕|订阅|点赞|Amara|^嗯，好的，我们继续/;
/** 只能放「像转录上文」的自然文本：指令式 prompt 会在静音时被 whisper 整句复读进结果 */
const WHISPER_PROMPT = "嗯，好的，我们继续。";

export async function restorePunctuation(key: string, text: string, fetchImpl: FetchLike = fetch): Promise<string> {
  if (text.length < 4 || text.length > 2000) return text;
  const body = {
    model: "llama-3.1-8b-instant", temperature: 0, max_tokens: Math.ceil(text.length * 2) + 64,
    messages: [{ role: "system", content: PUNCT_SYSTEM }, { role: "user", content: text }],
  };
  try {
    const res = await fetchImpl(GROQ_CHAT_URL, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8_000),
    });
    const j = (await res.json().catch(() => ({}))) as { choices?: { message?: { content?: string } }[] }; // 非 JSON 响应 = 没有可用输出 → 原文
    const out = j.choices?.[0]?.message?.content?.trim();
    return out && stripPunct(out) === stripPunct(text) ? out : text;
  } catch (e) {
    console.warn(`⚠️ 标点修复失败，用 whisper 原文: ${(e as Error).message}`);
    return text;
  }
}

export type TranscribeResult = { ok: true; text: string } | { ok: false; status: 502; error: string };

export async function transcribeAudio(key: string, audio: Blob, filename: string, fetchImpl: FetchLike = fetch, timeoutMs = 30_000): Promise<TranscribeResult> {
  const fd = new FormData();
  fd.append("file", audio, filename || "audio.m4a");
  const fields: [string, string][] = [["model", "whisper-large-v3"], ["language", "zh"], ["prompt", WHISPER_PROMPT], ["temperature", "0"], ["response_format", "json"]];
  for (const [k, v] of fields) fd.append(k, v);
  try {
    const res = await fetchImpl(GROQ_TRANSCRIBE_URL, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: fd, signal: AbortSignal.timeout(timeoutMs) });
    const j = (await res.json().catch(() => ({}))) as { text?: string; error?: { message?: string } }; // 非 JSON 错误体：下面按 HTTP 状态报
    if (!res.ok) return { ok: false, status: 502, error: `识别失败: ${j.error?.message || `HTTP ${res.status}`}` };
    const raw = (j.text || "").trim();
    if (raw.length < 25 && HALLUCINATION_RE.test(raw)) return { ok: true, text: "" };
    return { ok: true, text: await restorePunctuation(key, raw, fetchImpl) };
  } catch (e) {
    return { ok: false, status: 502, error: `识别服务不可达: ${(e as Error).message}` };
  }
}
