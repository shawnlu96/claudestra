/**
 * PMEMTUNE2 [验收线 5]：只读回放——TMPDIR 里的夹具库上逐数核对新旧每单平均条数、旧 applied 保留率、按类型 / 路由拆分；库文件前后字节不变。
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { recordMemory, type MemoryInput } from "../src/lib/ledger-memory.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { replayRelevance } from "../src/lib/memory-relevance-replay.js";

const P = "demo";
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const M = (n: number) => `ab12-m${n}`;
let dir: string;
let path: string;

/** 库文件和 WAL 的 sha256（-shm 是 SQLite 的共享内存索引，任何读者都会碰，不是数据） */
const digests = () => Object.fromEntries(readdirSync(dir).filter((f) => !f.endsWith("-shm")).sort().map((f) => [f, createHash("sha256").update(readFileSync(join(dir, f))).digest("hex")]));

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mem-replay-"));
  path = join(dir, "ledger.sqlite");
  const db = openLedger(path);
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  for (const t of ["T1", "T2"]) createTask(db, { actor: "owner", now: 1 }, { project: P, id: t, title: t, kind: "code" });
  db.prepare("UPDATE tasks SET stage = 'build', extra = ? WHERE project = ?").run(JSON.stringify({ fileGlobs: ["src/lib/x*.ts"] }), P);
  // m1 坑最老；m2..m5 决定越来越新 → 文件路名次 m5 m4 m3 m2 m1
  const at = (n: number) => ({ actor: "pm", now: NOW - n * DAY });
  recordMemory(db, at(20), { project: P, kind: "pitfall", title: "老坑", symptom: "症状", rule: "规矩", files: ["src/lib/x.ts"], fixable: false, via: "tool", authorRole: "reviewer" } as MemoryInput);
  for (let i = 2; i <= 5; i++) recordMemory(db, at(20 - i), { project: P, kind: "decision", title: `决定${i}`, body: "b", files: ["src/lib/x.ts"], via: "tool", authorRole: "owner" } as MemoryInput);

  const ev = (ts: number, target: string, kind: string, data: unknown): number =>
    (db.prepare("INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (?, 'scheduler', ?, ?, ?, '', ?) RETURNING seq")
      .get(ts, P, target, kind, JSON.stringify(data)) as { seq: number }).seq;
  const file = (n: number, score: number) => ({ id: M(n), routes: ["file"], why: "同文件 src/lib/x.ts", score });

  // 单 1（T1）：旧规则让坑位，m1 顶掉 m2
  const r1 = ev(NOW - 3 * DAY, "T1", "scheduler", { op: "memory_rank", order: "write", items: [file(5, 1 / 61), file(4, 1 / 62), file(3, 1 / 63), file(1, 1 / 65)],
    dropped: [{ id: M(2), score: 1 / 64, reason: `让坑位 ${M(1)}` }] });
  ev(NOW - 3 * DAY, "T1", "scheduler", { op: "memory_retrieve", order: "write", memoryIds: [M(5), M(4), M(3), M(1)], rankingSeq: r1 });
  ev(NOW - 3 * DAY + 1000, "T1", "memory", { op: "refs", refs: [{ id: M(4), use: "applied" }, { id: M(3), use: "applied" }, { id: M(1), use: "irrelevant" }, { id: M(5), use: "irrelevant" }] });
  // 别的卡把 m5 标了 4 次无关（连同上面 T1 那次共 5 次）
  for (let i = 0; i < 4; i++) ev(NOW - 2 * DAY, `X${i}`, "memory", { op: "refs", refs: [{ id: M(5), use: "irrelevant" }] });
  // 单 2（T2）：m5 被降权低于相对阈值；m1 只靠相邻 feature 的图命中
  const r2 = ev(NOW - DAY, "T2", "scheduler", { op: "memory_rank", order: "write",
    items: [file(5, 1 / 61), { id: M(1), routes: ["graph"], why: "相邻 feature", score: 1 / 61 }, file(4, 1 / 62)], dropped: [] });
  ev(NOW - DAY, "T2", "scheduler", { op: "memory_retrieve", order: "write", memoryIds: [M(5), M(1), M(4)], rankingSeq: r2 });
  ev(NOW - DAY + 1000, "T2", "memory", { op: "refs", refs: [{ id: M(4), use: "applied" }, { id: M(1), use: "irrelevant" }] });
  // 窗口外的一单不算
  ev(NOW - 30 * DAY, "T2", "scheduler", { op: "memory_retrieve", order: "write", memoryIds: [M(5)], rankingSeq: r2 });
  closeLedger(path);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("只读回放 [验收线 5]", () => {
  test("数字逐条可核对；库文件前后字节不变", () => {
    const before = digests();
    expect(Object.keys(before)).toContain("ledger.sqlite");
    const r = replayRelevance(path, P, NOW - 7 * DAY, NOW);
    expect(digests()).toEqual(before);
    expect(r.skipped).toBe(0);
    // 旧：4 + 3 条；新：单 1 m5 m4 m3 m2（不再让坑位），单 2 只剩 m4
    //   单 2 的 m5：别的卡 5 次无关 → 先验 2/7，1/61 × 2/7 ≈ 0.0047 < 1/62 × 0.35 ≈ 0.0056；m1 只靠远邻图命中
    expect(r.old).toEqual({ orders: 2, items: 7, avgPerOrder: 3.5, byKind: { decision: 5, pitfall: 2 }, byRoute: { graph: 1, file: 6, vector: 0 } });
    expect(r.new).toEqual({ orders: 2, items: 5, avgPerOrder: 2.5, byKind: { decision: 5 }, byRoute: { graph: 0, file: 5, vector: 0 } });
    expect(r.appliedKept).toEqual({ total: 3, kept: 3, rate: 1 });
    // 单 1 的 m5 新规则下还在（当时别的卡还没标）、m1 拿掉；单 2 的 m1 拿掉
    expect(r.irrelevantRemoved).toEqual({ total: 3, removed: 2, rate: 0.6667 });
  });

  test("空窗口：0 单不报错", () => {
    const r = replayRelevance(path, P, NOW, NOW + DAY);
    expect(r.old).toMatchObject({ orders: 0, items: 0, avgPerOrder: 0 });
    expect(r.appliedKept.rate).toBeNull();
  });
});
