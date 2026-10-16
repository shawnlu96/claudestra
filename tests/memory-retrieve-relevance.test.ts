import { createFeature } from "../src/lib/ledger-feature-write.js";
/**
 * PMEMTUNE2：坑不再强占坑位（memoryPitfallRelevance）、被标无关的记忆跨卡降权（memoryFeedbackPrior）、两键的 on / observe / off。
 * 纯函数部分用字面候选 + 显式 modes；端到端走 memoryCandidates（模式从 recovery-policy.json 读，测试状态目录隔离）。
 */
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { recordMemory, type MemoryInput } from "../src/lib/ledger-memory.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { closeLedger, getEventByDedup, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import {
  contextualMarks, memoryCandidates, rankMemories, RELATIVE_FLOOR, type Candidate, type GraphHit, type RankOpts, type Routes, type SelectionModes,
} from "../src/lib/memory-retrieve.js";
import { ensureMemoryRetrieval, memoryDedupKey, retrieveMemories } from "../src/lib/memory-retrieve-order.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";

const P = "demo";
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const ON: SelectionModes = { pitfallRelevance: "on", feedbackPrior: "on" };
const OFF: SelectionModes = { pitfallRelevance: "off", feedbackPrior: "off" };

/** 字面候选：只要排序用到的字段 */
const cand = (id: string, kind: "pitfall" | "decision" | "summary", createdAt = NOW - DAY): Candidate => ({
  status: "open", disputed: false, memory: { id, kind, createdAt, taskId: null, files: [], title: id } as unknown as Candidate["memory"],
} as Candidate);
const ids = (r: { selected: { id: string }[] }) => r.selected.map((s) => s.id);
const rank = (cands: Candidate[], routes: Partial<Routes>, o: Partial<RankOpts> = {}) =>
  rankMemories(cands, { graph: [], file: [], vector: [], ...routes }, { kind: "write", now: NOW, ...o });
/** 语义一路按给定顺序排名 */
const vec = (order: string[]) => order.map((memoryId, i) => ({ memoryId, score: 0.9 - i / 100 }));

describe("坑不强占 [验收线 1]", () => {
  // d1..d4 语义第 1..4 名，p1 第 5 名、p2 第 6 名（都过 1/70 下限）
  const cands = [cand("d1", "decision"), cand("d2", "decision"), cand("d3", "decision"), cand("d4", "decision"), cand("p1", "pitfall"), cand("p2", "pitfall")];
  const routes = { vector: vec(["d1", "d2", "d3", "d4", "p1", "p2"]) };

  test("非坑分数高于后排坑：on 档不顶替，按分数取前 4；off 档照旧让坑位", () => {
    const on = rank(cands, routes, { modes: ON });
    expect(ids(on)).toEqual(["d1", "d2", "d3", "d4"]);
    expect(on.dropped.some((d) => d.reason.kind === "displaced_by_pitfall")).toBe(false);
    expect(on.dropped.map((d) => [d.id, d.reason.kind])).toEqual([["p1", "over_limit"], ["p2", "over_limit"]]);
    expect(on.selectionVersion).toBe("pitfall+feedback");
    const off = rank(cands, routes, { modes: OFF });
    expect(ids(off)).toEqual(["d1", "d2", "p1", "p2"]);
    expect(off.selectionVersion).toBeUndefined();
  });

  test("坑分数高时照样入选（同一分数竞争，不是排斥坑）", () => {
    expect(ids(rank(cands, { vector: vec(["p1", "d1", "p2", "d2", "d3", "d4"]) }, { modes: ON }))).toEqual(["p1", "d1", "p2", "d2"]);
  });

  const far = (id: string, i = 1): GraphHit => ({ id, hop: 3, via: "相邻 feature" });
  test("只靠相邻 feature 图命中、文件和语义都没中的坑：写单、审查单都不放；off 档照放", () => {
    const c = [cand("pf", "pitfall"), cand("pv", "pitfall"), cand("d1", "decision")];
    const routes: Partial<Routes> = { graph: [far("pf"), far("pv"), far("d1")], vector: vec(["pv"]) };
    for (const kind of ["write", "review"] as const) {
      const on = rank(c, routes, { kind, modes: ON });
      expect(ids(on)).not.toContain("pf");
      expect(ids(on)).toContain("pv"); // 远邻 + 语义命中：留
      expect(on.dropped.find((d) => d.id === "pf")!.reason).toEqual({ kind: "below_floor", rule: "far_graph" });
      expect(ids(rank(c, routes, { kind, modes: OFF }))).toContain("pf");
    }
    // 远邻规则只管坑：只靠远邻的决定照常竞争
    expect(ids(rank(c, routes, { modes: ON }))).toContain("d1");
    // 文件命中同样留
    const withFile = rank(c, { ...routes, file: [{ id: "pf", hits: 1, total: 1, first: "a.ts" }] }, { modes: ON });
    expect(ids(withFile)).toContain("pf");
  });

  test("审查单其他规则不变：只放坑、≤3 条、不按相对阈值砍", () => {
    const c = [cand("p1", "pitfall"), cand("d1", "decision"), cand("p2", "pitfall"), cand("p3", "pitfall"), cand("p4", "pitfall")];
    // p1 三路第一、其余只在语义后排：写单会被相对阈值砍掉，审查单不砍
    const routes: Partial<Routes> = { graph: [{ id: "p1", hop: 1, via: "依赖 X" }], file: [{ id: "p1", hits: 1, total: 1, first: "a.ts" }], vector: vec(["p1", "d1", "p2", "p3", "p4"]) };
    const on = rank(c, routes, { kind: "review", modes: ON });
    expect(ids(on)).toEqual(["p1", "p2", "p3"]);
    expect(ids(on)).toEqual(ids(rank(c, routes, { kind: "review", modes: OFF })));
  });
});

describe("不固定打满 [验收线 2]", () => {
  test("只有 1 条高分、其余低于最高分的 0.35 倍：写单只放 1 条", () => {
    const c = ["top", "a", "b", "c", "d"].map((id) => cand(id, "decision"));
    // top 三路第 1：3/61 ≈ 0.049；其余只有图一路第 2..5 名 ≈ 0.016，低于 0.049 × 0.35 ≈ 0.0172
    const routes: Partial<Routes> = {
      graph: ["top", "a", "b", "c", "d"].map((id) => ({ id, hop: 1 as const, via: "依赖 X" })),
      file: [{ id: "top", hits: 1, total: 1, first: "a.ts" }], vector: vec(["top"]),
    };
    const on = rank(c, routes, { modes: ON });
    expect(ids(on)).toEqual(["top"]);
    const bar = on.selected[0]!.score * RELATIVE_FLOOR;
    expect(on.dropped.map((d) => [d.id, d.reason])).toEqual(["a", "b", "c", "d"].map((id) => [id, { kind: "below_floor", rule: "relative" }]));
    expect(on.dropped.every((d) => d.score < bar)).toBe(true);
    expect(ids(rank(c, routes, { modes: OFF }))).toHaveLength(4); // 老规则打满
  });

  test("没有候选：0 条，不报错", () => {
    expect(rank([], {}, { modes: ON })).toMatchObject({ selected: [], dropped: [] });
    expect(rank([cand("x", "decision")], {}, { modes: ON }).selected).toEqual([]);
  });
});

describe("跨卡降权接入排序 [验收线 3]", () => {
  test("被别的卡标无关 5 次的记忆先验降低、名次后移；不低于 0.2，也不因此掉到绝对下限以下", () => {
    const c = [cand("noisy", "decision"), cand("ok", "decision")];
    const feedback = new Map([["noisy", Array.from({ length: 5 }, () => ({ use: "irrelevant" as const, ts: NOW }))]]);
    const routes = { vector: vec(["noisy", "ok"]) };
    const fbOnly = { ...ON, pitfallRelevance: "off" as const };
    const r = rank(c, routes, { modes: fbOnly, feedback });
    expect(ids(r)).toEqual(["ok", "noisy"]);
    const noisy = r.selected.find((s) => s.id === "noisy")!;
    expect(noisy.feedback).toBeCloseTo(2 / 7, 12);
    expect(noisy.score).toBeCloseTo((1 / 61) * (2 / 7), 12);
    // 降到下限 0.2 的、只剩它一条时照样入选（绝对下限按乘先验之前的分判；相对阈值以它自己为最高分）
    const worst = new Map([["noisy", Array.from({ length: 500 }, () => ({ use: "irrelevant" as const, ts: NOW }))]]);
    const alone = rank([c[0]!], { vector: vec(["noisy"]) }, { modes: ON, feedback: worst });
    expect(ids(alone)).toEqual(["noisy"]);
    expect(alone.selected[0]!.feedback).toBe(0.2);
    // off：不乘
    expect(ids(rank(c, routes, { modes: OFF, feedback }))).toEqual(["noisy", "ok"]);
  });
});

// ── 端到端：模式从 recovery-policy.json 读 ──

let db: Database;
let saved: Buffer | null = null;
const writePolicy = (keys: Partial<Record<"memoryPitfallRelevance" | "memoryFeedbackPrior", string>> | null) => {
  if (keys) writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { [P]: { keys } } }));
  else rmSync(RECOVERY_POLICY_PATH, { force: true });
};
const at = (n: number) => ({ actor: "pm", now: NOW - n * DAY });
const dec = (title: string): MemoryInput => ({ project: P, kind: "decision", title, body: `${title}的决定`, files: ["src/lib/x.ts"], via: "tool", authorRole: "owner" });
const pit = (title: string): MemoryInput => ({ project: P, kind: "pitfall", title, symptom: "症状", rule: "规矩", files: ["src/lib/x.ts"], fixable: false, via: "tool", authorRole: "reviewer" });
const t1 = () => getTask(db, "T1")!;
const observeNotes = () => listEvents(db, { project: P }).filter((e) => e.kind === "note" && e.data.op === "recovery_observe");
const refsEvent = (target: string, ts: number, refs: { id: string; use: string }[]) =>
  db.prepare("INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (?, 'w', ?, ?, 'memory', '', ?)").run(ts, P, target, JSON.stringify({ op: "refs", refs }));

beforeEach(() => {
  saved = existsSync(RECOVERY_POLICY_PATH) ? readFileSync(RECOVERY_POLICY_PATH) : null;
  writePolicy(null);
  db = openLedger(":memory:");
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  createTask(db, { actor: "owner", now: 1 }, { project: P, id: "T1", title: "批量写", kind: "code" });
  db.prepare("UPDATE tasks SET stage = 'build', extra = ? WHERE id = 'T1'").run(JSON.stringify({ fileGlobs: ["src/lib/x*.ts"] }));
  // 文件路按新者优先：d4 d3 d2 d1 第 1..4，坑 p1 最老、第 5 名
  recordMemory(db, at(9), pit("老坑")); // m1
  for (let i = 1; i <= 4; i++) recordMemory(db, at(9 - i), dec(`决定${i}`)); // m2..m5
});
afterEach(() => {
  closeLedger(":memory:");
  if (saved) writeFileSync(RECOVERY_POLICY_PATH, saved);
  else rmSync(RECOVERY_POLICY_PATH, { force: true });
});
const M = (n: number) => `ab12-m${n}`;
const selected = () => retrieveMemories(db, t1(), "write", null, { now: NOW }).ranked;

describe("开关 [验收线 4]", () => {
  test("两键未配置 = on：坑不顶替，事件带 selectionVersion", async () => {
    expect(ids(selected())).toEqual([M(5), M(4), M(3), M(2)]);
    await ensureMemoryRetrieval(db, t1(), "write", null, { embedder: null, now: NOW, headFiles: null });
    expect(getEventByDedup(db, `${memoryDedupKey(t1(), null, "write")}:prepared`)!.data.selectionVersion).toBe("pitfall+feedback");
    expect(observeNotes()).toEqual([]);
  });

  test("off：逐字回到老规则（坑顶掉最低的决定），事件不带 selectionVersion", async () => {
    writePolicy({ memoryPitfallRelevance: "off", memoryFeedbackPrior: "off" });
    const r = selected();
    expect(ids(r)).toEqual([M(5), M(4), M(3), M(1)]);
    expect(r.dropped.map((d) => [d.id, d.reason])).toEqual([[M(2), { kind: "displaced_by_pitfall", by: M(1) }]]);
    expect(r.selectionVersion).toBeUndefined();
    expect(r.selected.every((s) => !("feedback" in s))).toBe(true);
    await ensureMemoryRetrieval(db, t1(), "write", null, { embedder: null, now: NOW, headFiles: null });
    expect("selectionVersion" in getEventByDedup(db, `${memoryDedupKey(t1(), null, "write")}:prepared`)!.data).toBe(false);
  });

  test("observe：实际走旧选择，按单记一条新旧对比样本（重算不重复记）", () => {
    writePolicy({ memoryPitfallRelevance: "observe", memoryFeedbackPrior: "observe" });
    const r = selected();
    expect(ids(r)).toEqual([M(5), M(4), M(3), M(1)]);
    expect(r.selectionVersion).toBe("base");
    selected();
    const notes = observeNotes();
    expect(notes.map((e) => e.data.mechanism).sort()).toEqual(["memoryFeedbackPrior", "memoryPitfallRelevance"]);
    const pitNote = notes.find((e) => e.data.mechanism === "memoryPitfallRelevance")!;
    expect(pitNote.target).toBe("T1");
    expect(pitNote.data).toMatchObject({
      order: "write", oldVersion: "base", newVersion: "pitfall",
      oldIds: [M(5), M(4), M(3), M(1)], newIds: [M(5), M(4), M(3), M(2)], removed: [{ id: M(1), reason: "over_limit" }], added: [M(2)],
    });
    // 没有标记：降权这一套与旧的一样，样本照记（按版本对比用）
    expect(notes.find((e) => e.data.mechanism === "memoryFeedbackPrior")!.data).toMatchObject({ oldIds: [M(5), M(4), M(3), M(1)], removed: [] });
  });

  const fbOnly = () => writePolicy({ memoryPitfallRelevance: "off" });
  test("跨卡标记从台账一次读：别的卡标无关 5 次的降权、排到后面被挤出", () => {
    for (let i = 0; i < 5; i++) refsEvent(`X${i}`, NOW - DAY, [{ id: M(5), use: "irrelevant" }]);
    fbOnly();
    const r = selected();
    expect(ids(r)).toEqual([M(4), M(3), M(2), M(1)]);
    expect(r.dropped).toMatchObject([{ id: M(5), reason: { kind: "over_limit" } }]);
  });

  test("本卡自己标的不算（只认别的卡）", () => {
    for (let i = 0; i < 5; i++) refsEvent("T1", NOW - DAY, [{ id: M(5), use: "irrelevant" }]);
    fbOnly();
    expect(ids(selected())[0]).toBe(M(5));
  });

  test("wrong 不并进先验（仍走 dispute 排除）", () => {
    for (let i = 0; i < 5; i++) refsEvent(`X${i}`, NOW - DAY, [{ id: M(5), use: "wrong" }]);
    fbOnly();
    expect(ids(selected())[0]).toBe(M(5));
  });

  test("没有候选：0 条、不报错、不记样本", () => {
    createTask(db, { actor: "owner", now: 1 }, { project: "empty", id: "E1", title: "空项目", kind: "code" });
    writePolicy({ memoryPitfallRelevance: "observe" });
    const e1 = getTask(db, "E1")!;
    expect(memoryCandidates(db, e1)).toEqual([]);
    expect(retrieveMemories(db, e1, "write", null, { now: NOW }).ranked).toEqual({ selected: [], dropped: [] });
    expect(observeNotes()).toEqual([]);
  });
});

describe("observe 样本走生产形状的 query_only 读连接 [验收线 4]", () => {
  test("bridge LedgerReader（PRAGMA query_only = ON）上准备：两键各记一条样本，实际排名仍是旧规则；重试不重复记", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-observe-ro-"));
    const path = join(dir, "ledger.sqlite");
    const reader = new LedgerReader(path);
    try {
      const w = openLedger(path);
      w.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
      createTask(w, { actor: "owner", now: 1 }, { project: P, id: "T1", title: "批量写", kind: "code" });
      w.prepare("UPDATE tasks SET stage = 'build', extra = ? WHERE id = 'T1'").run(JSON.stringify({ fileGlobs: ["src/lib/x*.ts"] }));
      recordMemory(w, at(9), pit("老坑"));
      for (let i = 1; i <= 4; i++) recordMemory(w, at(9 - i), dec(`决定${i}`));
      closeLedger(path);
      writePolicy({ memoryPitfallRelevance: "observe", memoryFeedbackPrior: "observe" });
      const ro = reader.get()!;
      expect((ro.query("PRAGMA query_only").get() as { query_only: number }).query_only).toBe(1);
      const task = getTask(ro, "T1")!;
      for (let i = 0; i < 2; i++) await ensureMemoryRetrieval(ro, task, "write", null, { embedder: null, now: NOW, headFiles: null });
      const prepared = getEventByDedup(ro, `${memoryDedupKey(task, null, "write")}:prepared`)!;
      expect(prepared.data.selectionVersion).toBe("base");
      expect((prepared.data.items as { id: string }[]).map((x) => x.id)).toEqual([M(5), M(4), M(3), M(1)]);
      const notes = listEvents(ro, { project: P }).filter((e) => e.kind === "note" && e.data.op === "recovery_observe");
      expect(notes.map((e) => e.data.mechanism).sort()).toEqual(["memoryFeedbackPrior", "memoryPitfallRelevance"]);
      expect(notes.find((e) => e.data.mechanism === "memoryPitfallRelevance")!.data).toMatchObject({ oldIds: [M(5), M(4), M(3), M(1)], newIds: [M(5), M(4), M(3), M(2)] });
      expect((ro.query("PRAGMA query_only").get() as { query_only: number }).query_only).toBe(1);
    } finally {
      reader.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("已在事务里（同步拼单）不记，也不另开写连接", () => {
    writePolicy({ memoryPitfallRelevance: "observe" });
    db.transaction(() => { selected(); })();
    expect(observeNotes()).toEqual([]);
  });
});

test("PM 补 4：无关卡两次 irrelevant、同 feature applied 仍入选；相关卡 irrelevant 降权", () => {
  const rows = ["A", "B", "C"].map((target, i) => ({ target, ts: NOW,
    data: JSON.stringify({ refs: [{ id: "pit", use: i === 2 ? "applied" : "irrelevant" }] }) }));
  const temp = mkdtempSync(join(tmpdir(), "prior-context-"));
  const dbPath = join(temp, "ledger.sqlite");
  const db = openLedger(dbPath);
  db.query("INSERT INTO ledger_instance (key,value) VALUES ('origin','ab12')").run();

  for (const id of ["SELF", "A", "B", "C"]) createTask(db, { actor: "owner", now: 1 }, { project: P, id, title: id, kind: "code" });
  for (const slug of ["one", "other"]) createFeature(db, { actor: "owner", now: 1 }, { project: P, slug, title: slug });
  db.query("UPDATE tasks SET featureId = CASE WHEN id IN ('SELF','C') THEN 'ab12-one' ELSE 'ab12-other' END").run();
  const marks = contextualMarks(db, rows, "SELF", P);
  expect(marks.get("pit")!.map((m) => m.weight)).toEqual([0.25, 0.25, 1]);
  db.query("UPDATE tasks SET extra = ? WHERE id IN ('SELF','A')").run(JSON.stringify({ fileGlobs: ["src/lib/x*.ts"] }));
  expect(contextualMarks(db, rows, "SELF", P).get("pit")![0]!.weight).toBe(1);
  const c = [cand("pit", "pitfall"), ...[1, 2, 3, 4].map((i) => cand(`d${i}`, "decision"))];
  const routes = { vector: vec(["pit", "d1", "d2", "d3", "d4"]) };
  expect(ids(rank(c, routes, { modes: ON, feedback: marks }))).toContain("pit");
  expect(rank(c, routes, { modes: ON, feedback: marks }).selected[0]!.feedback).toBe(1);
  db.query("UPDATE tasks SET featureId = 'ab12-one'").run();
  const related = contextualMarks(db, rows.map((r) => ({ ...r, data: JSON.stringify({ refs: [{ id: "pit", use: "irrelevant" }] }) })), "SELF", P);
  closeLedger(dbPath);
  rmSync(temp, { recursive: true, force: true });
  expect(ids(rank(c, routes, { modes: ON, feedback: related }))).not.toContain("pit");
});
