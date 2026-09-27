/** 本地 API：POST /api/v1/transcribe（Groq whisper + 标点修复，假 fetch）：501 没 key、400 缺音频、413 超 20 MB、并发 2、幻觉过滤、标点铁律 */
import { afterAll, describe, expect, test } from "bun:test";
import { handleLocalApi } from "../src/bridge/local-api/index.js";
import { setTranscribeDepsForTest } from "../src/bridge/local-api/transcribe.js";
import { GROQ_CHAT_URL, GROQ_TRANSCRIBE_URL, restorePunctuation, transcribeAudio, type FetchLike } from "../src/lib/transcribe.js";
import type { Principal } from "../src/lib/principals.js";

const GUEST: Principal = { id: "guest:1234", role: "external", name: "friend", agents: ["worker"], createdAt: "2026-01-01T00:00:00Z", manage: false, credential: "dev_g1" };
const KEY = "gsk_test_key_0000000000000000";

afterAll(() => setTranscribeDepsForTest(undefined));

const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** 转写回 text，标点接口回 punct（函数可按输入算） */
function fakeFetch(text: string, punct: (t: string) => string = (t) => t): FetchLike & { calls: string[] } {
  const f = (async (input: string, init: RequestInit) => {
    f.calls.push(input);
    if (input === GROQ_TRANSCRIBE_URL) return jsonRes({ text });
    if (input === GROQ_CHAT_URL) {
      const body = JSON.parse(String(init.body)) as { messages: { content: string }[] };
      return jsonRes({ choices: [{ message: { content: punct(body.messages[1].content) } }] });
    }
    return jsonRes({}, 404);
  }) as FetchLike & { calls: string[] };
  f.calls = [];
  return f;
}

function audioRequest(bytes = 100, headers: Record<string, string> = {}): Request {
  const fd = new FormData();
  fd.append("audio", new File([new Uint8Array(bytes)], "clip.m4a", { type: "audio/mp4" }));
  return new Request("http://bridge.local/api/v1/transcribe", { method: "POST", body: fd, headers });
}
const call = (r: Request) => handleLocalApi(r, new URL(r.url), GUEST);

describe("POST /api/v1/transcribe", () => {
  test("没配 key → 501（不看音频）", async () => {
    setTranscribeDepsForTest({ readKey: async () => "", fetch: fakeFetch("x") });
    const res = (await call(audioRequest()))!;
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ ok: false, code: "not_configured" });
  });
  test("正常：转写 → 标点修复 → {text}", async () => {
    const fetch = fakeFetch("今天天气不错我们出去走走吧", (t) => t.replace("不错", "不错，").concat("。"));
    setTranscribeDepsForTest({ readKey: async () => KEY, fetch });
    const res = (await call(audioRequest()))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, text: "今天天气不错，我们出去走走吧。" });
    expect(fetch.calls).toEqual([GROQ_TRANSCRIBE_URL, GROQ_CHAT_URL]);
  });
  test("标点铁律：LLM 改了字就用原文；短音频幻觉（复读 prompt）→ 空串", async () => {
    setTranscribeDepsForTest({ readKey: async () => KEY, fetch: fakeFetch("今天天气不错我们出去走走吧", () => "好的，我明白了，今天天气不错。") });
    expect(await (await call(audioRequest()))!.json()).toEqual({ ok: true, text: "今天天气不错我们出去走走吧" });
    setTranscribeDepsForTest({ readKey: async () => KEY, fetch: fakeFetch("嗯，好的，我们继续。") });
    expect(await (await call(audioRequest()))!.json()).toEqual({ ok: true, text: "" });
  });
  test("缺 audio 字段 / 不是 multipart → 400；Content-Length 超 20 MB → 413", async () => {
    setTranscribeDepsForTest({ readKey: async () => KEY, fetch: fakeFetch("x") });
    const empty = new Request("http://bridge.local/api/v1/transcribe", { method: "POST", body: new FormData() });
    expect((await call(empty))!.status).toBe(400);
    const text = new Request("http://bridge.local/api/v1/transcribe", { method: "POST", body: "hello", headers: { "content-type": "text/plain" } });
    expect((await call(text))!.status).toBe(400);
    expect((await call(audioRequest(10, { "content-length": String(21 * 1024 * 1024) })))!.status).toBe(413);
  });
  test("上游 5xx → 502 带原因；网络错误 → 502", async () => {
    setTranscribeDepsForTest({ readKey: async () => KEY, fetch: async () => jsonRes({ error: { message: "quota" } }, 500) });
    const res = (await call(audioRequest()))!;
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, error: "识别失败: quota" });
    setTranscribeDepsForTest({ readKey: async () => KEY, fetch: async () => { throw new Error("ECONNRESET"); } });
    expect((await call(audioRequest()))!.status).toBe(502);
  });
  test("同时最多 2 路：第三路 429，前两路结束后再来就放行", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    setTranscribeDepsForTest({ readKey: async () => KEY, fetch: async () => { await gate; return jsonRes({ text: "ok" }); } });
    const a = call(audioRequest());
    const b = call(audioRequest());
    await new Promise((r) => setTimeout(r, 20));
    const c = (await call(audioRequest()))!;
    expect(c.status).toBe(429);
    expect(await c.json()).toMatchObject({ code: "busy" });
    release();
    expect((await a)!.status).toBe(200);
    expect((await b)!.status).toBe(200);
    expect((await call(audioRequest()))!.status).toBe(200);
  });
  test("别的方法 / 路径 → null", async () => {
    const r = new Request("http://bridge.local/api/v1/transcribe", { method: "GET" });
    expect(await call(r)).toBeNull();
  });
});

describe("lib/transcribe 纯函数", () => {
  test("restorePunctuation：太短 / 太长不调模型；非 JSON 响应用原文", async () => {
    const f = fakeFetch("", () => "x");
    expect(await restorePunctuation(KEY, "你好", f)).toBe("你好");
    expect(f.calls).toEqual([]);
    expect(await restorePunctuation(KEY, "字".repeat(2001), f)).toBe("字".repeat(2001));
    expect(await restorePunctuation(KEY, "这是一句没有标点的话", async () => new Response("<html>", { status: 200 }))).toBe("这是一句没有标点的话");
  });
  test("transcribeAudio 把音频以 file 字段发出去，模型 whisper-large-v3", async () => {
    let seen: FormData | null = null;
    const f: FetchLike = async (input, init) => {
      if (input === GROQ_TRANSCRIBE_URL) seen = init.body as FormData;
      return jsonRes(input === GROQ_TRANSCRIBE_URL ? { text: "hello world" } : {});
    };
    const r = await transcribeAudio(KEY, new Blob([new Uint8Array(3)]), "a.webm", f);
    expect(r).toEqual({ ok: true, text: "hello world" });
    expect(seen!.get("model")).toBe("whisper-large-v3");
    expect((seen!.get("file") as File).name).toBe("a.webm");
  });
});
