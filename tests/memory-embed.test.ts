/** 嵌入提供方（pmem-M4 验收线 1 无模型返回空不抛错、3 两秒超时、4 远端只发 team 且已脱敏的文本） */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMBED_TIMEOUT_MS, embedTexts, parseEmbedConfig, pickEmbedder, readEmbedConfig, textForEmbedder, type Embedder, type EmbedConfig,
} from "../src/lib/memory-embed.js";

type Call = { url: string; init?: RequestInit };

/** 假 fetch：按 URL 片段回 JSON；记下每次调用 */
function fakeFetch(routes: Record<string, unknown>, calls: Call[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const key = Object.keys(routes).find((k) => u.includes(k));
    if (!key) throw new Error("connect ECONNREFUSED");
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as typeof fetch;
}

const hangs: typeof fetch = ((_u: unknown, init?: RequestInit) => new Promise((_, reject) => {
  init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
})) as typeof fetch;

const OLLAMA: EmbedConfig = { provider: "ollama", model: "embeddinggemma", url: "http://127.0.0.1:11434" };
const VOYAGE: EmbedConfig = { provider: "voyage", model: "voyage-4-lite", url: "https://api.voyageai.com/v1/embeddings", apiKeyEnv: "VK" };

function recorder(remote: boolean, reply: (texts: string[]) => unknown = (t) => t.map(() => [1, 0])): Embedder & { sent: string[][] } {
  const sent: string[][] = [];
  return { model: "fake:m", remote, sent, embed: async (texts) => (sent.push(texts), reply(texts)) };
}

describe("配置", () => {
  test("没配 → 只试本机 Ollama 的多语言模型；[] → 关；不认识的条目跳过、远端默认 URL 补上", () => {
    expect(parseEmbedConfig(undefined).map((c) => `${c.provider}:${c.model}`)).toEqual(["ollama:embeddinggemma", "ollama:bge-m3"]);
    expect(parseEmbedConfig([])).toEqual([]);
    expect(parseEmbedConfig("ollama")).toEqual([]);
    expect(parseEmbedConfig([{ provider: "x", model: "m" }, { provider: "ollama" }, null, { provider: "openai", model: "text-embedding-3-small", apiKeyEnv: "OK" }]))
      .toEqual([{ provider: "openai", model: "text-embedding-3-small", url: "https://api.openai.com/v1/embeddings", apiKey: undefined, apiKeyEnv: "OK" }]);
  });

  test("readEmbedConfig 读 config.json 的 memory.embed；文件不在 / 坏了当没配（不会因此打开远端）", () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-embed-"));
    try {
      const p = join(dir, "config.json");
      expect(readEmbedConfig(p).every((c) => c.provider === "ollama")).toBe(true);
      writeFileSync(p, "{not json");
      expect(readEmbedConfig(p).every((c) => c.provider === "ollama")).toBe(true);
      writeFileSync(p, JSON.stringify({ lang: "zh", memory: { embed: [{ provider: "voyage", model: "voyage-3.5-lite", apiKeyEnv: "VK" }] } }));
      expect(readEmbedConfig(p)).toMatchObject([{ provider: "voyage", model: "voyage-3.5-lite" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pickEmbedder：按序取第一个可用的，没有返回 null", () => {
  test("Ollama 不在、远端没 key → null，不抛错", async () => {
    expect(await pickEmbedder([OLLAMA, VOYAGE], { fetch: fakeFetch({}), env: {} })).toBeNull();
    expect(await pickEmbedder([], { fetch: fakeFetch({}) })).toBeNull();
  });

  test("Ollama 在但模型没拉 → 跳过；拉了（带 :latest 也算）→ 用它，本机回环不算远端", async () => {
    const none = fakeFetch({ "/api/tags": { models: [{ name: "llama3:latest" }] } });
    expect(await pickEmbedder([OLLAMA], { fetch: none, env: {} })).toBeNull();
    const e = await pickEmbedder([OLLAMA, VOYAGE], { fetch: fakeFetch({ "/api/tags": { models: [{ name: "embeddinggemma:latest" }] } }), env: { VK: "k" } });
    expect(e).toMatchObject({ model: "ollama:embeddinggemma", remote: false });
  });

  test("Ollama 配在别的机器上 → 当远端（过 team + 脱敏闸）", async () => {
    const e = await pickEmbedder([{ ...OLLAMA, url: "http://gpu-box.example.com:11434" }], { fetch: fakeFetch({ "/api/tags": { models: [{ name: "embeddinggemma" }] } }) });
    expect(e?.remote).toBe(true);
  });

  test("Ollama 不在时退到 owner 配的远端，key 从环境变量取", async () => {
    const e = await pickEmbedder([OLLAMA, VOYAGE], { fetch: fakeFetch({}), env: { VK: "k" } });
    expect(e).toMatchObject({ model: "voyage:voyage-4-lite", remote: true });
  });

  test("探活卡住 → 按超时放弃（不挂住派单）", async () => {
    const t0 = Date.now();
    expect(await pickEmbedder([OLLAMA], { fetch: hangs, timeoutMs: 50 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe("embedTexts：结果与输入对齐，失败处为 null，从不抛错", () => {
  const items = [{ text: "a", visibility: "team" as const }, { text: "b", visibility: "team" as const }];

  test("没有模型 → 全 null", async () => {
    expect(await embedTexts(null, items)).toEqual([null, null]);
    expect(await embedTexts(null, [])).toEqual([]);
  });

  test("模型抛错 / 返回条数不对 / 维度不齐 / 有 NaN → 整批 null", async () => {
    for (const reply of [() => { throw new Error("boom"); }, () => [[1, 2]], () => [[1, 2], [1]], () => [[1, NaN], [1, 2]], () => ({}), () => [[], []]]) {
      expect(await embedTexts(recorder(false, reply as () => unknown), items)).toEqual([null, null]);
    }
  });

  test("正常返回 → Float32Array", async () => {
    const out = await embedTexts(recorder(false, () => [[1, 2], [3, 4]]), items);
    expect(out.map((v) => (v ? [...v] : null))).toEqual([[1, 2], [3, 4]]);
  });

  test(`默认超时 ${EMBED_TIMEOUT_MS} 毫秒：卡住的调用按时返回 null，并中止请求`, async () => {
    expect(EMBED_TIMEOUT_MS).toBe(2000);
    let aborted = false;
    const stuck: Embedder = { model: "fake:m", remote: false, embed: (_t, signal) => new Promise(() => signal.addEventListener("abort", () => (aborted = true))) };
    const t0 = Date.now();
    expect(await embedTexts(stuck, items)).toEqual([null, null]);
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(1900);
    expect(took).toBeLessThan(3000);
    expect(aborted).toBe(true);
  });

  test("真实 HTTP 形状：Ollama /api/embed；远端按 index 排序、带 Bearer", async () => {
    const calls: Call[] = [];
    const f = fakeFetch({
      "/api/tags": { models: [{ name: "embeddinggemma" }] },
      "/api/embed": { embeddings: [[1, 0], [0, 1]] },
      "voyageai.com": { data: [{ index: 1, embedding: [0, 2] }, { index: 0, embedding: [2, 0] }] },
    }, calls);
    const local = await pickEmbedder([OLLAMA], { fetch: f });
    expect((await embedTexts(local, items)).map((v) => [...v!])).toEqual([[1, 0], [0, 1]]);
    expect(JSON.parse(String(calls.at(-1)!.init!.body))).toEqual({ model: "embeddinggemma", input: ["a", "b"] });
    const remote = await pickEmbedder([VOYAGE], { fetch: f, env: { VK: "k1" } });
    expect((await embedTexts(remote, items)).map((v) => [...v!])).toEqual([[2, 0], [0, 2]]);
    expect((calls.at(-1)!.init!.headers as Record<string, string>).authorization).toBe("Bearer k1");
  });
});

describe("远端闸：只发 team 可见、已脱敏的文本", () => {
  const secret = "联系 someone@example.com，token sk-abcdefghijklmnopqrstuvwx";

  test("远端：home 不发（结果 null），team 先脱敏再发", async () => {
    const e = recorder(true, (t) => t.map(() => [1, 1]));
    const out = await embedTexts(e, [{ text: "内部 feature 名", visibility: "home" }, { text: secret, visibility: "team" }]);
    expect(out[0]).toBeNull();
    expect(out[1]).not.toBeNull();
    expect(e.sent).toHaveLength(1);
    expect(e.sent[0]).toHaveLength(1);
    expect(e.sent[0]![0]).not.toContain("someone@example.com");
    expect(e.sent[0]![0]).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(e.sent[0]![0]).toContain("[已脱敏");
  });

  test("远端全是 home → 一次都不调", async () => {
    const e = recorder(true);
    expect(await embedTexts(e, [{ text: "x", visibility: "home" }])).toEqual([null]);
    expect(e.sent).toHaveLength(0);
  });

  test("本机模型：原文照用（不出本机）", () => {
    expect(textForEmbedder({ remote: false }, { text: secret, visibility: "home" })).toBe(secret);
    expect(textForEmbedder({ remote: true }, { text: secret, visibility: "home" })).toBeNull();
  });
});
