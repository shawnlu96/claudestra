/**
 * POST /api/v1/transcribe（multipart 字段 audio）→ { text }。原 web BFF 的 chat/transcribe：Groq whisper + 标点修复（lib/transcribe.ts）。
 * 这是唯一的 bridge 进程，所以限额都在这里：音频 ≤ 20 MB、同时最多 2 路、单次 30 s；key 取设置（config.json）再 env GROQ_API_KEY，没有就 501。
 */
import { readConfig } from "../../lib/config-store.js";
import { transcribeAudio, type FetchLike } from "../../lib/transcribe.js";
import { apiJson } from "../api-respond.js";

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
/** multipart 边界与字段头的余量 */
const MAX_BODY_BYTES = MAX_AUDIO_BYTES + 64 * 1024;
const MAX_CONCURRENT = 2;
const TIMEOUT_MS = 30_000;

interface Deps {
  readKey: () => Promise<string>;
  fetch: FetchLike;
}
const realDeps: Deps = {
  readKey: async () => (await readConfig()).groqApiKey || process.env.GROQ_API_KEY || "",
  fetch: (input, init) => fetch(input, init),
};
let deps = realDeps;
let inflight = 0;
/** 单测注入假 key / 假 fetch；生产不调 */
export function setTranscribeDepsForTest(d: Partial<Deps> | undefined): void {
  deps = d ? { ...realDeps, ...d } : realDeps;
}

export async function handleTranscribe(req: Request, path: string): Promise<Response | null> {
  if (path !== "/transcribe" || req.method !== "POST") return null;
  const key = await deps.readKey();
  if (!key) return apiJson(501, { ok: false, error: "transcription not configured: set groqApiKey in settings (or GROQ_API_KEY)", code: "not_configured" });
  if (Number(req.headers.get("content-length") || 0) > MAX_BODY_BYTES) return apiJson(413, { ok: false, error: "audio exceeds 20 MB" });
  if (inflight >= MAX_CONCURRENT) return apiJson(429, { ok: false, error: `transcription busy (${MAX_CONCURRENT} in flight), retry shortly`, code: "busy" });
  inflight++;
  try {
    const form = await req.formData().catch(() => null); // 不是 multipart / 解析失败：下面按缺 audio 字段回 400
    const audio = form?.get("audio");
    if (!audio || typeof audio === "string" || audio.size === 0) return apiJson(400, { ok: false, error: 'multipart field "audio" required' });
    if (audio.size > MAX_AUDIO_BYTES) return apiJson(413, { ok: false, error: "audio exceeds 20 MB" });
    const r = await transcribeAudio(key, audio, audio.name, deps.fetch, TIMEOUT_MS);
    return r.ok ? apiJson(200, { ok: true, text: r.text }) : apiJson(r.status, { ok: false, error: r.error });
  } finally {
    inflight--;
  }
}
