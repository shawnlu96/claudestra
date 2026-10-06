/**
 * pmem-M5 验收线 1 / 2：设计稿 §3.5 夹具逐数复现（终分、坑位、去重、落选理由）；没有嵌入时图和文件两路照常。
 * 去重按 PM 10-03 定（pmem-D1 审查 P2 retrieval-dedup）以规则为准重算：m2 与坑 m1 同来源卡 N1 → m2 出局；m5 与 m6 同来源卡 O7 → m5 出局。
 * 开工单 = m4、m7、m1、m6（设计稿原例的 m2、m4、m1、m6 与去重规则矛盾）。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { markMemory, recordMemory, type MemoryInput } from "../src/lib/ledger-memory.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import type { Embedder } from "../src/lib/memory-embed.js";
import {
  fileRoute, graphRoute, memoryCandidates, overlaps, rankMemories, SCORE_FLOOR, type Scored,
} from "../src/lib/memory-retrieve.js";
import { ensureMemoryRetrieval, memoryDedupKey, retrieveMemories, withMemory } from "../src/lib/memory-retrieve-order.js";
import { getEventByDedup } from "../src/lib/ledger-store.js";
import { openVectorStore } from "../src/lib/memory-vectors.js";

const P = "demo";
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const HEAD_FILES = ["src/lib/widget-store.ts", "src/lib/widget-schema.ts", "src/lib/widget-read.ts", "src/lib/gadget-import.ts", "web/index.html"];
const N3_GLOBS = ["src/lib/widget-store*.ts", "src/lib/widget-batch*.ts", "tests/widget-batch*.test.ts"];
/** 语义一路的余弦（§3.5）：m1 0.30、m8 0.12 低于阈值 0.35 不入 */
const COS: Record<string, number> = { m5: 0.71, m6: 0.66, m4: 0.62, m2: 0.55, m7: 0.41, m1: 0.30, m8: 0.12 };

let db: Database;
const ctx = { actor: "owner", now: 1 };
const id = (m: string) => `ab12-${m}`;
const short = (s: { id: string }) => s.id.replace("ab12-", "");

/** §3.5 的图：feature ab12-fx（N1←N2、N1←N3、N2/N3←N4），另一个 feature ab12-gx 的 O7；无 feature 间依赖 */
function fixture(): void {
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  setMeta(db, ctx, { project: P, key: "pms", value: ["pm"] });
  for (const t of ["N1", "N2", "N3", "O7", "FX"]) createTask(db, ctx, { project: P, id: t, title: `widget ${t}`, kind: "code" });
  db.prepare("UPDATE tasks SET extra = ? WHERE id = 'N3'").run(JSON.stringify({ fileGlobs: N3_GLOBS }));
  createFeature(db, ctx, { project: P, slug: "fx", title: "widget 改版" });
  initDag(db, ctx, { id: "ab12-fx", rev: 1, nodes: [
    { key: "N1", taskId: "N1", oneLine: "widget 存储层", fileGlobs: ["src/lib/widget-store.ts", "src/lib/widget-schema.ts"] },
    { key: "N2", taskId: "N2", oneLine: "widget 读接口", deps: ["N1"], fileGlobs: ["src/lib/widget-read.ts"] },
    { key: "N3", taskId: "N3", oneLine: "widget 批量写", deps: ["N1"], fileGlobs: N3_GLOBS },
    { key: "N4", oneLine: "widget 看板", deps: ["N2", "N3"] },
  ] });
  createFeature(db, ctx, { project: P, slug: "gx", title: "gadget" });
  initDag(db, ctx, { id: "ab12-gx", rev: 1, nodes: [{ key: "O7", taskId: "O7", oneLine: "gadget 批量导入", fileGlobs: ["src/lib/gadget-import.ts"] }] });

  const pit = (title: string, taskId: string | null, files: string[], fixable: boolean): MemoryInput => ({
    project: P, kind: "pitfall", title, symptom: `${title}的症状`, rule: `${title}的规矩`, files, fixable, via: "tool", authorRole: "reviewer",
    ...(taskId ? { taskId, head: "abc1234", specRev: 1 } : {}),
  });
  const sum = (title: string, taskId: string, files: string[]): MemoryInput => ({
    project: P, kind: "summary", title, body: `${title}的总结`, files, via: "verify_summary", authorRole: "system", taskId, head: "abc1234", specRev: 1,
  });
  const at = (daysAgo: number) => ({ actor: "pm", now: NOW - daysAgo * DAY });
  recordMemory(db, at(30), pit("迁移语句逐条 prepare().run()", "N1", ["src/lib/*-schema.ts"], false)); // m1
  recordMemory(db, at(9), sum("N1 存储层", "N1", ["src/lib/widget-store.ts", "src/lib/widget-schema.ts"])); // m2
  recordMemory(db, at(8), pit("widget-store 写入没包事务", "N1", ["src/lib/widget-store.ts"], true)); // m3
  recordMemory(db, at(7), { project: P, kind: "decision", title: "批量写单批上限 500", body: "超了拒，不自动分片", featureId: "ab12-fx", via: "tool", authorRole: "owner" }); // m4
  recordMemory(db, at(20), sum("O7 一个事务写完", "O7", ["src/lib/gadget-import.ts"])); // m5
  recordMemory(db, at(19), pit("bun:sqlite 事务回调里不能 await", "O7", ["src/lib/*-import.ts"], true)); // m6
  recordMemory(db, at(5), sum("N2 读接口", "N2", ["src/lib/widget-read.ts"])); // m7
  recordMemory(db, at(40), pit("UI 截图用 headless 脚本", null, ["web/**"], false)); // m8
  markMemory(db, at(3), { memoryId: id("m3"), mark: "link_fix", taskId: "FX" });
  markMemory(db, at(2), { memoryId: id("m3"), mark: "fixed", taskId: "FX" });
}

beforeEach(() => {
  db = openLedger(":memory:");
  fixture();
});
afterEach(() => closeLedger(":memory:"));

const n3 = () => getTask(db, "N3")!;
const vectorHits = () => Object.entries(COS).filter(([, c]) => c >= 0.35).sort((a, b) => b[1] - a[1]).map(([m, score]) => ({ memoryId: id(m), score }));
const close = (x: number, y: number) => expect(Math.abs(x - y)).toBeLessThan(5e-6);

describe("§3.5 夹具", () => {
  test("过滤：m3 已修出局，其余都是候选", () => {
    expect(memoryCandidates(db, n3()).map((c) => short(c.memory)).sort()).toEqual(["m1", "m2", "m4", "m5", "m6", "m7", "m8"]);
  });

  test("图：跳 1 名次 m1、m4、m2（同跳 坑 > 决定 > 总结），跳 2 m7；m5 / m6 / m8 不相邻", () => {
    const g = graphRoute(db, n3(), memoryCandidates(db, n3()));
    expect(g.map((h) => [short(h), h.hop])).toEqual([["m1", 1], ["m4", 1], ["m2", 1], ["m7", 2]]);
    expect(g.map((h) => h.via)).toEqual(["依赖 N1", "本 feature", "依赖 N1", "同 feature N2"]);
  });

  test("文件：只有 m2（widget-store.ts 命中 widget-store*.ts）；m1 的 *-schema.ts、m6 的 *-import.ts 与本卡 glob 无交集", () => {
    const f = fileRoute(memoryCandidates(db, n3()), N3_GLOBS, HEAD_FILES);
    expect(f).toEqual([{ id: id("m2"), hits: 1, total: 2, first: "src/lib/widget-store.ts" }]);
  });

  test("终分逐数、去重、坑位、落选理由", () => {
    const { ranked } = retrieveMemories(db, n3(), "write", null, { now: NOW, vector: vectorHits(), headFiles: HEAD_FILES });
    const all = new Map<string, number>([...ranked.selected.map((s) => [short(s), s.score] as const), ...ranked.dropped.map((d) => [short(d), d.score] as const)]);
    close(all.get("m2")!, 0.03453);
    close(all.get("m4")!, 0.03200);
    close(all.get("m7")!, 0.02342);
    close(all.get("m1")!, 0.01639);
    close(all.get("m6")!, 0.01613);
    close(all.get("m5")!, 0.01041);
    // RRF 与先验分开核
    const m2 = ranked.dropped.find((d) => short(d) === "m2")!;
    expect(m2.reason).toEqual({ kind: "dedup_source", by: id("m1") });
    expect(ranked.dropped.find((d) => short(d) === "m5")!.reason).toEqual({ kind: "dedup_source", by: id("m6") });
    expect(ranked.selected.map(short)).toEqual(["m4", "m7", "m1", "m6"]);
    expect(ranked.selected.filter((s) => s.memory.kind === "pitfall").length).toBe(2);
    expect(ranked.dropped.map(short).sort()).toEqual(["m2", "m5"]);
    const s = new Map(ranked.selected.map((x) => [short(x), x]));
    expect(s.get("m4")!.ranks).toEqual({ graph: 2, vector: 3 });
    expect(s.get("m7")!.ranks).toEqual({ graph: 4, vector: 5 });
    expect(s.get("m1")!.ranks).toEqual({ graph: 1 });
    expect(s.get("m6")!.ranks).toEqual({ vector: 2 });
    expect(Math.abs(s.get("m7")!.prior - 0.755)).toBeLessThan(5e-4);
    expect(s.get("m6")!.score).toBeGreaterThanOrEqual(SCORE_FLOOR);
  });

  test("不去重时（假设 m1 不在）：前 4 只 1 个坑，坑位保 2 → m6 顶掉最低的非坑", () => {
    const cands = memoryCandidates(db, n3()).filter((c) => short(c.memory) !== "m1" && short(c.memory) !== "m5");
    const g = graphRoute(db, n3(), cands);
    const r = rankMemories(cands, { graph: g, file: fileRoute(cands, N3_GLOBS, HEAD_FILES), vector: vectorHits().filter((h) => h.memoryId !== id("m5")) },
      { kind: "write", now: NOW, headFiles: HEAD_FILES });
    // 剩 m2、m4、m7 三个非坑 + m6、m8(无命中) → 前 4 = m2、m4、m7、m6，本来就 1 个坑且没有别的过下限的坑可补
    expect(r.selected.map(short)).toEqual(["m2", "m4", "m7", "m6"]);
  });

  test("坑位：前 4 只有 1 个坑、还有过下限的坑时，顶掉最低的非坑；其余超条数", () => {
    const base = memoryCandidates(db, n3()).find((c) => short(c.memory) === "m4")!;
    const fake = (mid: string, kind: "decision" | "pitfall") => ({ ...base, memory: { ...base.memory, id: mid, kind, taskId: null } });
    const order = [fake("d1", "decision"), fake("d2", "decision"), fake("d3", "decision"), fake("p1", "pitfall"), fake("d4", "decision"), fake("p2", "pitfall")];
    const r = rankMemories(order, { graph: [], file: [], vector: order.map((c, i) => ({ memoryId: c.memory.id, score: 0.9 - i / 100 })) }, { kind: "write", now: NOW });
    // p2 第 6 名 1/66 ≥ 下限 1/70 → 顶掉前 4 里最低的非坑 d3
    expect(r.selected.map((x) => x.id)).toEqual(["d1", "d2", "p1", "p2"]);
    expect(r.dropped.map((d) => [d.id, d.reason])).toEqual([["d3", { kind: "displaced_by_pitfall", by: "p2" }], ["d4", { kind: "over_limit" }]]);
    // 坑不够过下限：不硬保
    const r2 = rankMemories(order, { graph: [], file: [], vector: order.map((c, i) => ({ memoryId: c.memory.id, score: 0.9 - i / 100 })).slice(0, 5) }, { kind: "write", now: NOW });
    expect(r2.selected.map((x) => x.id)).toEqual(["d1", "d2", "d3", "p1"]);
  });

  test("审查单只放坑、≤3 条", () => {
    const { ranked } = retrieveMemories(db, n3(), "review", null, { now: NOW, vector: vectorHits(), headFiles: HEAD_FILES });
    expect(ranked.selected.map(short)).toEqual(["m1", "m6"]);
    expect(ranked.dropped.filter((d) => d.reason.kind === "not_pitfall").map(short)).toEqual(["m4", "m7"]);
  });

  test("下限：只有图一路第 11 名以后的不推", () => {
    const cands = memoryCandidates(db, n3());
    const s = rankMemories(cands, { graph: [], file: [], vector: [] }, { kind: "write", now: NOW });
    expect(s.selected).toEqual([]);
    expect(1 / 71).toBeLessThan(SCORE_FLOOR);
  });

  test("余弦 ≥0.92 的两条留新的", () => {
    const cands = memoryCandidates(db, n3()).filter((c) => ["m4", "m1"].includes(short(c.memory)));
    const r = rankMemories(cands, { graph: [], file: [], vector: [{ memoryId: id("m1"), score: 0.9 }, { memoryId: id("m4"), score: 0.8 }] },
      { kind: "write", now: NOW, pairCosine: () => 0.95 });
    // m4 写于 7 天前，比 m1（30 天前）新
    expect(r.selected.map(short)).toEqual(["m4"]);
    expect(r.dropped[0]).toMatchObject({ id: id("m1"), reason: { kind: "dedup_similar", by: id("m4") } });
  });
});

describe("没有嵌入：图和文件两路照常（验收线 2）", () => {
  test("语义路为空时：m1（图 1/61）、m4（图 1/62）入选；m2 去重；m7 只剩图第 4 名 × 总结衰减低于下限；m6 只有语义能找回", () => {
    const { ranked } = retrieveMemories(db, n3(), "write", null, { now: NOW, headFiles: HEAD_FILES });
    expect(ranked.selected.map(short)).toEqual(["m1", "m4"]);
    expect(ranked.dropped.map((d) => [short(d), d.reason.kind])).toEqual([["m2", "dedup_source"], ["m7", "below_floor"]]);
    expect(ranked.selected.every((s: Scored) => s.cosine === undefined)).toBe(true);
  });

  test("ensureMemoryRetrieval 无模型：照样登记两路结果、不抛错", async () => {
    await ensureMemoryRetrieval(db, n3(), "write", null, { embedder: null, now: NOW, headFiles: HEAD_FILES });
    const e = getEventByDedup(db, `${memoryDedupKey(n3(), null, "write")}:prepared`)!;
    expect(e.kind).toBe("scheduler");
    expect(e.data).toMatchObject({ op: "memory_rank", routes: ["graph", "file"], items: [{ id: id("m1") }, { id: id("m4") }] });
  });

  test("嵌入模型调用失败：语义路为空，两路照常", async () => {
    const broken: Embedder = { model: "fake:broken", remote: false, embed: async () => { throw new Error("down"); } };
    await ensureMemoryRetrieval(db, n3(), "write", null, { embedder: broken, vectors: openVectorStore(":memory:"), now: NOW, headFiles: HEAD_FILES });
    expect(getEventByDedup(db, `${memoryDedupKey(n3(), null, "write")}:prepared`)!.data.items).toMatchObject([{ id: id("m1") }, { id: id("m4") }]);
  });
});

describe("语义路端到端（假模型，余弦按 §3.5）", () => {
  test("ensureMemoryRetrieval：补嵌入 → 查询 → 阈值 0.35 → 三路合并，结果同夹具", async () => {
    // 查询 = e0；记忆 k = c·e0 + √(1-c²)·e_k（各占一根正交轴），对查询的余弦正好是 c，两两余弦 = c_a·c_b < 0.92 不触发近似去重
    const titleOf = new Map(memoryCandidates(db, n3()).map((c) => [c.memory.title, short(c.memory)]));
    const fake: Embedder = {
      model: "fake:2d", remote: false,
      embed: async (texts) => texts.map((t) => {
        const m = [...titleOf.entries()].find(([title]) => t.startsWith(title))?.[1];
        const v = new Array(9).fill(0);
        if (!m) return (v[0] = 1, v);
        const c = COS[m]!;
        v[0] = c;
        v[Number(m.slice(1))] = Math.sqrt(1 - c * c);
        return v;
      }),
    };
    await ensureMemoryRetrieval(db, n3(), "write", null, { embedder: fake, vectors: openVectorStore(":memory:"), now: NOW, headFiles: HEAD_FILES });
    const e = getEventByDedup(db, `${memoryDedupKey(n3(), null, "write")}:prepared`)!;
    expect(e.data.routes).toEqual(["graph", "file", "vector"]);
    expect(e.data.memoryIds).toBeUndefined();
    withMemory(db, n3(), "write", null, { inputs: [] }, { recordInjection: true });
    expect(getEventByDedup(db, memoryDedupKey(n3(), null, "write"))!.data.memoryIds).toEqual([id("m4"), id("m7"), id("m1"), id("m6")]);
    const items = e.data.items as { id: string; why: string; routes: string[] }[];
    expect(items.map((i) => i.why)).toEqual(["本 feature + 语义", "同 feature N2 + 语义", "依赖 N1", "语义"]);
    expect((e.data.dropped as { id: string; reason: string }[]).map((d) => [d.id, d.reason])).toEqual([[id("m2"), `同来源卡留坑 ${id("m1")}`], [id("m5"), `同来源卡留坑 ${id("m6")}`]]);
    // 第二次不重算（同卡同 specRev 同 head 只算一次）
    await ensureMemoryRetrieval(db, n3(), "write", null, { embedder: fake, vectors: openVectorStore(":memory:"), now: NOW + DAY });
    expect(db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'scheduler' AND json_extract(data, '$.op') = 'memory_retrieve'").get()).toEqual({ n: 1 });
  });
});

describe("文件求交", () => {
  test("glob 对 glob：有一边展开出文件就按交集，两边都展开不出才按目录前缀", () => {
    expect(overlaps("src/lib/*-schema.ts", "src/lib/widget-batch*.ts", HEAD_FILES)).toBe(false);
    expect(overlaps("src/lib/*-schema.ts", "src/lib/widget-s*.ts", HEAD_FILES)).toBe(true);
    expect(overlaps("src/lib/*-batch*.ts", "src/lib/widget-batch*.ts", HEAD_FILES)).toBe(true);
    expect(overlaps("web/**", "src/lib/widget-batch*.ts", HEAD_FILES)).toBe(false);
    expect(overlaps("src/lib/a.ts", "src/lib/*.ts", null)).toBe(true);
    expect(overlaps("src/lib/a.ts", "src/lib/b.ts", null)).toBe(false);
  });
});
