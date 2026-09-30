/**
 * 旧卡迁进 feature（T90 = L3）：四类处理、v1 节点与依赖、幂等、dry-run 零写入、冲突整批拒、先备份、中途失败整批回滚。
 * 用文件库：正式迁移要 VACUUM INTO 备份，内存库没法备份会被拒。
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applyMigration, bucketOf, parseMap, planMigration, type MigrateMap } from "../src/lib/ledger-feature-migrate.js";
import { getDagVersion, getFeature } from "../src/lib/ledger-feature.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { runLedger } from "../src/manager/ledger.js";
import { isWriteInvocation } from "../src/manager/write-commands.js";
import type { FactsDeps } from "../src/lib/ledger-verify-facts.js";

const P = "claude-orchestrator";
const PM = "agent-pm";
let dir: string;
let path: string;
let db: Database;

/** 卡 → 阶段；A1/A2 进行中、D1/D2 已完成、C1 已取消、S1 待排、B1 blocked（之前在 build）、U1 未归类 */
const STAGES: Record<string, string> = { A1: "build", A2: "review", D1: "verified", D2: "done", C1: "cancelled", S1: "spec", B1: "blocked", U1: "done", X1: "fix" };

const MAP: MigrateMap = {
  project: P,
  features: [
    { slug: "f1", title: "功能一", cards: ["A1", "A2", "D1", "D2", "C1", "S1", "B1"] },
    { slug: "f2", title: "功能二", cards: ["X1"] },
    { slug: "f3", title: "功能三", cards: ["GONE"] },
  ],
  unassigned: ["U1"],
  unsure: { S1: "不确定" },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ledger-t90-"));
  path = join(dir, "ledger.sqlite");
  db = openLedger(path);
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  const owner = { actor: "owner", now: 500 };
  setMeta(db, owner, { project: P, key: "pms", value: [PM] });
  for (const id of Object.keys(STAGES)) createTask(db, owner, { project: P, id, title: `卡 ${id}`, kind: "code", agent: "agent-exec" });
  for (const [id, stage] of Object.entries(STAGES)) db.prepare("UPDATE tasks SET stage = ?, stageBefore = ? WHERE id = ?").run(stage, stage === "blocked" ? "build" : null, id);
  const dep = db.prepare("INSERT INTO task_deps (project, fromTask, toTask, kind, createdBy, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'owner', 0, 0)");
  // D1 → A1（已完成前驱，进图）；D2 → D1（前驱的前驱：只补直接前驱，D2 不进图）；S1 → A2（待排前驱，不进图）；
  // X1 → A1（跨 feature，不进图）；A1 → A2（都进行中，连上）；D1 → A2 走 branch（不是 blocks，不连）
  for (const [f, t, k] of [["D1", "A1", "blocks"], ["D2", "D1", "blocks"], ["S1", "A2", "blocks"], ["X1", "A1", "blocks"], ["A1", "A2", "blocks"], ["D1", "A2", "branch"]]) dep.run(P, f, t, k);
});
afterEach(() => closeLedger(path));

/** 全库快照：每张表按全部列排序后的行，外加 schema；逐表比较用 */
function dump(d: Database = db): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const { name } of d.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]) {
    out[name] = d.query(`SELECT * FROM ${name} ORDER BY 1, 2`).all();
  }
  out.schema = d.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
  return out;
}

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const count = (t: string) => (db.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
const apply = (map: MigrateMap = MAP, actor = PM) => applyMigration(db, { actor, now: 2_000 }, map);

function run(actor: string, args: string[], facts?: FactsDeps) {
  return runLedger(args, {
    db, actor, actorProject: P, projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => 3_000,
    ...(facts ? { factsDeps: () => facts } : {}),
  }) as Promise<Record<string, any>>;
}

describe("四类处理", () => {
  test("stage → 分类：blocked 按进 blocked 前的阶段", () => {
    expect(bucketOf({ stage: "build", stageBefore: null })).toBe("active");
    expect(bucketOf({ stage: "verified", stageBefore: null })).toBe("done");
    expect(bucketOf({ stage: "cancelled", stageBefore: null })).toBe("cancelled");
    expect(bucketOf({ stage: "spec", stageBefore: null })).toBe("pending");
    expect(bucketOf({ stage: "blocked", stageBefore: "review" })).toBe("active");
    expect(bucketOf({ stage: "blocked", stageBefore: null })).toBe("pending");
  });

  test("进行中 + 已完成直接前驱进 v1，依赖只连两端都进图的 blocks 边；其余只挂 featureId", () => {
    const r = apply();
    expect(r.created).toEqual(["ab12-f1", "ab12-f2", "ab12-f3"]);
    expect(r.versions).toEqual(["ab12-f1", "ab12-f2"]);
    const v1 = getDagVersion(db, "ab12-f1", 1)!;
    expect(v1.nodes.map((n) => [n.key, n.deps, n.status])).toEqual([
      ["A1", ["D1"], "build"], ["A2", ["A1"], "review"], ["B1", [], "blocked"], ["D1", [], "verified"],
    ]);
    for (const id of ["A1", "A2", "B1", "D1", "D2", "C1", "S1"]) expect(getTask(db, id)!.featureId).toBe("ab12-f1");
    expect(getTask(db, "U1")!.featureId).toBeNull();
    expect(getFeature(db, "ab12-f3")).toMatchObject({ currentVersion: 0 });
    expect(r.plan.missing).toEqual(["GONE"]);
    expect(r.plan.droppedEdges).toEqual([
      { from: "S1", to: "A2", why: "S1 待排，不进图" },
      { from: "X1", to: "A1", why: "X1 不在这个 feature" },
    ]);
    expect(r.plan.unassigned.map((c) => c.id)).toEqual(["U1"]);
    expect(r.plan.unsure).toEqual([{ id: "S1", feature: "f1", note: "不确定" }]);
  });

  test("阶段、依赖、旧事件原样；卡只多 featureId、rev + 1", () => {
    const before = dump();
    apply();
    const after = dump();
    expect(after.task_deps).toEqual(before.task_deps);
    expect(after.items).toEqual(before.items);
    expect(after.meta).toEqual(before.meta);
    expect(after.schema).toEqual(before.schema);
    expect(after.events.slice(0, before.events.length)).toEqual(before.events);
    const strip = (rows: unknown[]) => (rows as Record<string, unknown>[]).map(({ featureId: _f, rev: _r, updatedAt: _u, ...rest }) => rest);
    expect(strip(after.tasks)).toEqual(strip(before.tasks));
    const t0 = new Map((before.tasks as { id: string; rev: number }[]).map((t) => [t.id, t.rev]));
    for (const t of after.tasks as { id: string; rev: number; featureId: string | null }[]) expect(t.rev).toBe(t0.get(t.id)! + (t.featureId ? 1 : 0));
  });
});

describe("幂等与冲突", () => {
  test("重跑：不再建 feature / 版本、不写事件、不再备份", () => {
    apply();
    const snap = dump();
    const r = apply();
    expect(r).toMatchObject({ backup: null, created: [], versions: [], assigned: 0 });
    expect(dump()).toEqual(snap);
    expect(readdirSync(join(dir, "backups"))).toHaveLength(1);
  });

  test("已有 v1 后又有卡开工：只挂 featureId，不建第二版", () => {
    apply();
    createTask(db, { actor: "owner", now: 600 }, { project: P, id: "A3", title: "新卡", kind: "code" });
    db.prepare("UPDATE tasks SET stage = 'build' WHERE id = 'A3'").run();
    const r = apply({ ...MAP, features: [{ ...MAP.features[0], cards: [...MAP.features[0].cards, "A3"] }, ...MAP.features.slice(1)] });
    expect(r.versions).toEqual([]);
    expect(getTask(db, "A3")!.featureId).toBe("ab12-f1");
    expect(count("dag_versions")).toBe(2);
  });

  test("卡已属于别的 feature：整批拒绝，一行不写", () => {
    apply({ project: P, features: [{ slug: "other", title: "别的", cards: ["A1"] }] });
    const snap = dump();
    expect(() => apply()).toThrow(/已属于 feature ab12-other/);
    expect(dump()).toEqual(snap);
  });

  test("同一张卡归进两个 feature / 同时 unassigned：映射表校验就拒", () => {
    const two = { project: P, features: [{ slug: "a", title: "甲", cards: ["A1"] }, { slug: "b", title: "乙", cards: ["A1"] }] };
    expect(() => parseMap(two)).toThrow(/同时归在/);
    expect(() => parseMap({ project: P, features: [{ slug: "a", title: "甲", cards: ["A1"] }], unassigned: ["A1"] })).toThrow(/同时归在/);
    expect(() => parseMap({ project: P, features: [{ slug: "a", title: "甲", cards: [] }, { slug: "a", title: "乙", cards: [] }] })).toThrow(/slug a 重复/);
  });

  test("标题被别的 feature 占了：记冲突，正式迁移拒绝", () => {
    apply({ project: P, features: [{ slug: "old", title: "功能一", cards: [] }] });
    expect(planMigration(db, MAP).conflicts).toEqual(["feature「功能一」的标题已被 ab12-old 占用"]);
    expect(() => apply()).toThrow(/有冲突/);
  });

  test("中途一步失败整批回滚：feature、版本、featureId、事件都不留", () => {
    const snap = dump();
    db.exec("CREATE TEMP TRIGGER boom BEFORE INSERT ON dag_versions WHEN NEW.featureId = 'ab12-f2' BEGIN SELECT RAISE(ABORT, 'boom'); END");
    expect(() => apply()).toThrow(/boom/);
    db.exec("DROP TRIGGER boom");
    expect(dump()).toEqual(snap);
  });
});

describe("备份与权限", () => {
  test("写之前先备份：备份内容 = 迁移前的库", () => {
    const snap = dump();
    const r = apply();
    expect(r.backup && existsSync(r.backup)).toBe(true);
    const bak = new Database(r.backup as string, { readonly: true });
    expect(dump(bak)).toEqual(snap);
    bak.close();
  });

  test("备份失败就不迁移；内存库拒绝迁移", () => {
    writeFileSync(join(dir, "backups"), "不是目录");
    const snap = dump();
    expect(() => apply()).toThrow(/备份失败/);
    expect(dump()).toEqual(snap);
    const mem = openLedger(":memory:");
    mem.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
    createTask(mem, { actor: "owner" }, { project: P, id: "A1", title: "x", kind: "code" });
    expect(() => applyMigration(mem, { actor: "owner" }, { project: P, features: [{ slug: "f", title: "f", cards: ["A1"] }] })).toThrow(/内存库/);
    closeLedger(":memory:");
  });

  test("CLI：执行者不能正式迁移；--dry-run 算读、正式迁移算写", async () => {
    const map = join(dir, "map.json");
    writeFileSync(map, JSON.stringify(MAP));
    expect(await run("agent-exec", ["feature-migrate", "--map", map])).toMatchObject({ ok: false, code: "forbidden" });
    expect(count("features")).toBe(0);
    expect(await run(PM, ["feature-migrate", "--map", map])).toMatchObject({ ok: true, created: ["ab12-f1", "ab12-f2", "ab12-f3"] });
    expect(isWriteInvocation("ledger", ["feature-migrate", "--map", map, "--dry-run"])).toBe(false);
    expect(isWriteInvocation("ledger", ["feature-migrate", "--map", map])).toBe(true);
  });
});

describe("dry-run", () => {
  /** 假 gh：A2 的 PR 已合并（阶段落后），X1 查询失败，其余没合并 */
  const facts = {
    run: async (argv: string[]) => {
      const target = argv[3];
      if (target === "12") return { code: 0, stdout: JSON.stringify({ number: 12, state: "MERGED", mergedAt: "2026-09-30T00:00:00Z" }), stderr: "" };
      if (argv.includes("feat/x1")) return { code: 1, stdout: "", stderr: "gh: network down" };
      return { code: 0, stdout: argv[2] === "list" ? "[]" : JSON.stringify({ number: 1, state: "OPEN" }), stderr: "" };
    },
  } as unknown as FactsDeps;

  test("零写入（读写连接也一样）：库文件字节不变，报告列出四类与各清单", async () => {
    db.prepare("UPDATE tasks SET pr = '12' WHERE id = 'A2'").run();
    db.prepare("UPDATE tasks SET branch = 'feat/x1' WHERE id = 'X1'").run();
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const map = join(dir, "map.json");
    const out = join(dir, "out", "report.md");
    mkdirSync(dirname(out));
    writeFileSync(map, JSON.stringify(MAP));
    const snap = dump();
    const before = sha(path);
    const r = await run("agent-exec", ["feature-migrate", "--map", map, "--dry-run", "--out", out], facts);
    expect(r).toMatchObject({ ok: true, dryRun: true, writes: { features: 3, versions: 2, cards: 8 }, lagging: ["A2"], prErrors: { X1: "gh: network down" }, report: out });
    expect(dump()).toEqual(snap);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(sha(path)).toBe(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);
    expect((db.query("PRAGMA query_only").get() as { query_only: number }).query_only).toBe(0);
    const md = readFileSync(out, "utf8");
    expect(md).toContain("| 进行中 · 进 v1 | A1 | build |");
    expect(md).toContain("| 已完成 · 前驱进 v1 | D1 | verified |");
    expect(md).toContain("| 待排 | S1 | spec |");
    expect(md).toContain("| 已取消 | C1 | cancelled |");
    expect(md).toContain("- U1（done）");
    expect(md).toContain("- S1 → f1：不确定");
    expect(md).toContain("- A2：阶段 review，PR #12 合并于 2026-09-30T00:00:00Z");
    expect(md).toContain("- S1 → A2：S1 待排，不进图");
    expect(md).toContain("- GONE");
  });

  test("dry-run 期间连接是 query_only：中途有人借这条连接写也会被挡", async () => {
    const map = join(dir, "map.json");
    writeFileSync(map, JSON.stringify(MAP));
    db.prepare("UPDATE tasks SET branch = 'feat/a1' WHERE id = 'A1'").run();
    let blocked = "";
    const sneaky = {
      run: async () => {
        try {
          db.prepare("UPDATE tasks SET title = 'x' WHERE id = 'A1'").run();
        } catch (e) {
          blocked = (e as Error).message;
        }
        return { code: 0, stdout: "[]", stderr: "" };
      },
    } as unknown as FactsDeps;
    const r = await run(PM, ["feature-migrate", "--map", map, "--dry-run"], sneaky);
    expect(r.ok).toBe(true);
    expect(typeof r.markdown).toBe("string");
    expect(blocked).toMatch(/readonly/);
    expect(getTask(db, "A1")!.title).toBe("卡 A1");
    db.prepare("UPDATE tasks SET title = '写得进' WHERE id = 'A1'").run();
  });
});
