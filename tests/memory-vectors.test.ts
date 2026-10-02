/** 本机向量库 + 暴力余弦（pmem-M4 验收线 1 无模型返回空、2 digest 变了重算、3 超时当这路为空、4 远端不嵌 home） */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordMemory } from "../src/lib/ledger-memory.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import type { Embedder } from "../src/lib/memory-embed.js";
import {
  cosine, nearestMemories, openVectorStore, refreshVectors, semanticSearch, staleSources, vectorSource, type VectorSource,
} from "../src/lib/memory-vectors.js";

/** 假模型：文本里每出现一个关键词，对应维度 +1（可预期的余弦）；记下每批发了什么 */
const AXES = ["事务", "widget", "迁移", "缓存"];
function fakeEmbedder(remote = false, model = "fake:axes"): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    model, remote, calls,
    embed: async (texts) => (calls.push(texts), texts.map((t) => AXES.map((a) => t.split(a).length - 1 + 0.01))),
  };
}

const src = (id: string, text: string, digest = `d-${id}`, visibility: "team" | "home" = "team"): VectorSource => ({ id, digest, text, visibility });
let db: Database;
beforeEach(() => (db = openVectorStore(":memory:")));
afterEach(() => db.close());

describe("refreshVectors", () => {
  test("没有模型 → 什么都不做、不抛错", async () => {
    expect(await refreshVectors(db, null, [src("m1", "事务")])).toEqual({ embedded: 0, skipped: 0, failed: 0 });
    expect(await semanticSearch(db, null, { text: "事务", visibility: "team" })).toEqual([]);
  });

  test("补缺的；再跑一次不重算；digest 变了只重算那一条", async () => {
    const e = fakeEmbedder();
    const sources = [src("m1", "事务 事务"), src("m2", "widget"), src("m3", "迁移")];
    expect(await refreshVectors(db, e, sources, { now: 1 })).toEqual({ embedded: 3, skipped: 0, failed: 0 });
    expect(await refreshVectors(db, e, sources, { now: 2 })).toEqual({ embedded: 0, skipped: 0, failed: 0 });
    expect(e.calls).toHaveLength(1);

    const changed = [sources[0]!, src("m2", "缓存 缓存", "d-m2-v2"), sources[2]!];
    expect(staleSources(db, e.model, changed).map((s) => s.id)).toEqual(["m2"]);
    expect(await refreshVectors(db, e, changed, { now: 3 })).toEqual({ embedded: 1, skipped: 0, failed: 0 });
    expect(e.calls.at(-1)).toEqual(["缓存 缓存"]);
    const row = db.prepare("SELECT digest, dim, createdAt FROM memory_vectors WHERE memoryId = 'm2'").get();
    expect(row).toEqual({ digest: "d-m2-v2", dim: 4, createdAt: 3 });
    expect(nearestMemories(db, e.model, Float32Array.from([0, 0, 0, 1]), { limit: 1 })[0]!.memoryId).toBe("m2");
  });

  test("换模型 = 另一套向量（主键 memoryId + model）", async () => {
    await refreshVectors(db, fakeEmbedder(false, "fake:a"), [src("m1", "事务")]);
    expect(staleSources(db, "fake:b", [src("m1", "事务")])).toHaveLength(1);
    await refreshVectors(db, fakeEmbedder(false, "fake:b"), [src("m1", "事务")]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM memory_vectors").get() as { n: number }).n).toBe(2);
  });

  test("模型失败 / 超时 → 计 failed、不落行，下次再试", async () => {
    const broken: Embedder = { model: "fake:x", remote: false, embed: async () => { throw new Error("down"); } };
    expect(await refreshVectors(db, broken, [src("m1", "a"), src("m2", "b")])).toEqual({ embedded: 0, skipped: 0, failed: 2 });
    const stuck: Embedder = { model: "fake:x", remote: false, embed: () => new Promise(() => {}) };
    expect(await refreshVectors(db, stuck, [src("m1", "a")], { timeoutMs: 30 })).toEqual({ embedded: 0, skipped: 0, failed: 1 });
    expect(staleSources(db, "fake:x", [src("m1", "a")])).toHaveLength(1);
  });

  test("远端模型：home 记忆不发、计 skipped；team 照嵌", async () => {
    const e = fakeEmbedder(true);
    expect(await refreshVectors(db, e, [src("m1", "事务", "d1", "home"), src("m2", "widget")])).toEqual({ embedded: 1, skipped: 1, failed: 0 });
    expect(e.calls.flat()).toEqual(["widget"]);
  });

  test("分批调用（每批 16 条）", async () => {
    const e = fakeEmbedder();
    const many = Array.from({ length: 40 }, (_, i) => src(`m${i}`, `事务 ${i}`));
    expect((await refreshVectors(db, e, many)).embedded).toBe(40);
    expect(e.calls.map((c) => c.length)).toEqual([16, 16, 8]);
  });
});

describe("nearestMemories / semanticSearch：暴力余弦", () => {
  beforeEach(async () => {
    await refreshVectors(db, fakeEmbedder(), [src("m1", "事务 事务"), src("m2", "事务 widget"), src("m3", "迁移"), src("m4", "缓存")]);
  });

  test("余弦降序、阈值、上限", () => {
    const q = Float32Array.from([1, 0, 0, 0]);
    const all = nearestMemories(db, "fake:axes", q);
    expect(all.map((h) => h.memoryId).slice(0, 2)).toEqual(["m1", "m2"]);
    expect(all[0]!.score).toBeGreaterThan(all[1]!.score);
    expect(nearestMemories(db, "fake:axes", q, { threshold: 0.35 }).map((h) => h.memoryId)).toEqual(["m1", "m2"]);
    expect(nearestMemories(db, "fake:axes", q, { limit: 1 })).toHaveLength(1);
  });

  test("只认候选里 digest 一致的；维度不同、别的模型的不算", () => {
    const q = Float32Array.from([1, 0, 0, 0]);
    const cands = new Map([["m1", "d-m1-new"], ["m2", "d-m2"]]);
    expect(nearestMemories(db, "fake:axes", q, { candidates: cands }).map((h) => h.memoryId)).toEqual(["m2"]);
    expect(nearestMemories(db, "fake:axes", Float32Array.from([1, 0]))).toEqual([]);
    expect(nearestMemories(db, "other:model", q)).toEqual([]);
  });

  test("semanticSearch：查询嵌入一次再检索；查询超时 / 远端遇 home 查询 → 空", async () => {
    expect((await semanticSearch(db, fakeEmbedder(), { text: "迁移", visibility: "team" }, { threshold: 0.35 })).map((h) => h.memoryId)).toEqual(["m3"]);
    const stuck: Embedder = { model: "fake:axes", remote: false, embed: () => new Promise(() => {}) };
    expect(await semanticSearch(db, stuck, { text: "迁移", visibility: "team" }, { timeoutMs: 30 })).toEqual([]);
    const remote = fakeEmbedder(true);
    expect(await semanticSearch(db, remote, { text: "迁移", visibility: "home" })).toEqual([]);
    expect(remote.calls).toHaveLength(0);
  });

  test("cosine 边界：零向量 / 维度不同 → 0", () => {
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([2, 0]))).toBeCloseTo(1);
    expect(cosine(Float32Array.from([0, 0]), Float32Array.from([1, 0]))).toBe(0);
    expect(cosine(Float32Array.from([1]), Float32Array.from([1, 0]))).toBe(0);
  });
});

describe("vectorSource 取真实记忆行", () => {
  afterEach(() => closeLedger(":memory:"));

  test("文本 = title + body（坑取 symptom + rule），digest / visibility 跟着记忆行", () => {
    const ledger = openLedger(":memory:");
    ledger.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
    createTask(ledger, { actor: "owner", now: 1 }, { project: "demo", id: "N1", title: "N1", kind: "code" });
    const base = { project: "demo", files: ["src/lib/widget-store.ts"], via: "tool" as const, authorRole: "pm" as const, head: "abc1234", specRev: 1, sourceNote: "夹具" };
    const pit = recordMemory(ledger, { actor: "pm", now: 1 }, { ...base, kind: "pitfall", title: "事务回调里不能 await", symptom: "事务提前提交", rule: "只做同步写", fixable: true }).memory;
    const sum = recordMemory(ledger, { actor: "pm", now: 1 }, { ...base, kind: "summary", taskId: "N1", title: "widget 表", body: "CAS 写" }).memory;
    expect(vectorSource(pit)).toEqual({ id: pit.id, digest: pit.digest, text: "事务回调里不能 await\n事务提前提交\n只做同步写", visibility: pit.visibility });
    expect(vectorSource(sum).text).toBe("widget 表\nCAS 写");
  });
});

describe("openVectorStore：单独文件，坏了删掉重建", () => {
  test("建在给定路径；文件坏了重建成空库", () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-vec-"));
    try {
      const p = join(dir, "sub", "memory-vectors.sqlite");
      openVectorStore(p).close();
      writeFileSync(p, "this is not a sqlite file at all, just garbage bytes ".repeat(200));
      const v = openVectorStore(p);
      expect((v.prepare("SELECT COUNT(*) AS n FROM memory_vectors").get() as { n: number }).n).toBe(0);
      v.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
