export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/api-auth";
import { st } from "@/lib/server-lang";
import { readWebConfig } from "@/lib/web-config";

/**
 * 语音转文字（2026-07-14 owner：应用内语音输入,根治豆包输入法跳 App 黑屏）。
 *
 * v1 后端 = Groq 免费层（whisper-large-v3-turbo,每天 2000 次转写额度）。
 * 前端录音 blob → 这里转发 Groq OpenAI 兼容接口 → {text}。
 * key 放 web/.env.local 的 GROQ_API_KEY;未配置返回 501（前端提示配置）。
 * 结构上留了换后端的口子（火山/阿里只改这一个文件）。
 */

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";

/**
 * 标点修复(2026-07-14 owner:whisper 中文吞标点)。whisper 的标点靠语音停顿
 * 线索,中文尤其弱——用 Groq 免费层的小 LLM 做「只加标点,一字不改」后处理,
 * ~300ms。输出长度偏离过大(模型自由发挥)或调用失败 → 原文兜底。
 */
async function restorePunctuation(key: string, text: string): Promise<string> {
  if (text.length < 4 || text.length > 2000) return text;
  try {
    const res = await fetch(GROQ_CHAT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        temperature: 0,
        max_tokens: Math.ceil(text.length * 2) + 64,
        messages: [
          {
            role: "system",
            content:
              "你是标点修复器。给用户消息里的中文加上规范的标点符号（，。？！、等），不增删改任何字词，不回答、不解释，只输出加好标点的原文。",
          },
          { role: "user", content: text },
        ],
      }),
      signal: AbortSignal.timeout(8_000),
    });
    const j = (await res.json().catch(() => ({}))) as {
      choices?: { message?: { content?: string } }[];
    };
    const out = j.choices?.[0]?.message?.content?.trim();
    if (!out) return text;
    // 铁律:LLM 只许加标点——去掉标点后必须与原文**逐字相同**,否则一律用原文
    // (之前 ±20% 的松护栏放过了模型的指令复读,2026-07-14 真机)
    const strip = (s: string) => s.replace(/[\s，。？！、：；""''（）,.?!:;'"()\-—…·]/g, "");
    if (strip(out) !== strip(text)) return text;
    return out;
  } catch {
    return text;
  }
}

export async function POST(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  // 界面配置优先（设置弹窗保存,即时生效）,env 兜底
  const key = (await readWebConfig()).groqApiKey || process.env.GROQ_API_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "语音识别未配置——点侧栏 ⚙️ 设置里填入 Groq API Key" },
      { status: 501 }
    );
  }
  const form = await request.formData().catch(() => null);
  const audio = form?.get("audio");
  if (!(audio instanceof File) || audio.size === 0) {
    return NextResponse.json({ error: "missing audio" }, { status: 400 });
  }
  if (audio.size > 20 * 1024 * 1024) {
    return NextResponse.json({ error: "音频过大（>20MB）" }, { status: 400 });
  }

  const fd = new FormData();
  fd.append("file", audio, audio.name || "audio.m4a");
  // large-v3 全量版:中文质量明显好于 turbo,免费层同样覆盖(短音频延迟差异无感)
  fd.append("model", "whisper-large-v3");
  fd.append("language", "zh");
  // ⚠ prompt 只能放「像转录上文」的自然文本——指令式 prompt(如「请使用规范的
  // 标点符号」)会在静音/短音频时被 whisper 整句幻觉复读进结果(2026-07-14
  // 真机:「经常返回一个请使用正确的标点符号」)。标点由后置 LLM 阶段负责。
  fd.append("prompt", "嗯，好的，我们继续。");
  fd.append("temperature", "0");
  fd.append("response_format", "json");

  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: fd,
      signal: AbortSignal.timeout(30_000),
    });
    const j = (await res.json().catch(() => ({}))) as { text?: string; error?: { message?: string } };
    if (!res.ok) {
      return NextResponse.json(
        { error: `${await st("识别失败", "Transcription failed")}: ${j.error?.message || `HTTP ${res.status}`}` },
        { status: 502 }
      );
    }
    const raw = (j.text || "").trim();
    // 静音/噪声下 whisper 的经典幻觉(复读 prompt、字幕水印等)——短输出且命中
    // 特征词就按「没听清」处理,别把幻觉喂给用户
    if (raw.length < 25 && /标点符号|字幕|订阅|点赞|Amara|^嗯，好的，我们继续/.test(raw)) {
      return NextResponse.json({ text: "" });
    }
    const text = await restorePunctuation(key, raw);
    return NextResponse.json({ text });
  } catch (e) {
    return NextResponse.json(
      { error: `${await st("识别服务不可达", "Transcription service unreachable")}: ${(e as Error).message}` },
      { status: 502 }
    );
  }
}
