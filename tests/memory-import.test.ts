import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMemoryImport, importVectorKey, planMemoryImport } from "../src/lib/memory-import.js";
import { importVectors } from "../src/lib/memory-import-vectors.js";
import { markMemory, memoryState, recordMemory, type MemoryInput } from "../src/lib/ledger-memory.js";
import { createHash } from "node:crypto";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { appendEvent, createTask } from "../src/lib/ledger-write.js";
import { renderMemoryImportReport } from "../src/manager/ledger-memory-import.js";

let dir: string, path: string, db: Database;
const ctx = { actor: "agent-pm", now: 1000 };
const row = (extra: Record<string, unknown> = {}) => ({
  kind: "pitfall", title: "事务回调不能 await", symptom: "事务提前提交", rule: "事务内必须同步写",
  files: ["src/lib/widget.ts"], family: "widget-tx", fixable: false, feature: null, task: null,
  sourceNote: "PM 私人记忆导入", visibility: "team", ...extra,
});
const raw = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n");
const counts = (d = db) => ["memories", "memory_marks", "events"].map((t) => (d.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
const plan = (text: string) => planMemoryImport(db, ctx, "demo", text);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memory-import-")); path = join(dir, "ledger.sqlite");
  db = openLedger(path);
  db.prepare("INSERT INTO ledger_instance(key,value) VALUES ('origin','ab12')").run();
});
afterEach(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });

test("导入备份包含写前快照；via import + PM open；重跑不写任何行、不再备份", () => {
  const text = raw(row(), row({ family: "other", title: "分页必须固定排序", files: ["src/lib/page.ts"] }));
  const r = applyMemoryImport(db, ctx, "demo", text);
  expect(r.imported).toEqual(["ab12-m1", "ab12-m2"]);
  expect(r.backup).toContain("ledger.sqlite.pre-memory-import-");
  const backup = new Database(r.backup!, { readonly: true });
  try { expect(counts(backup)).toEqual([0, 0, 0]); } finally { backup.close(); }
  expect(memoryState(db, r.imported[0]!)).toMatchObject({ status: "open", memory: { via: "import", authorRole: "pm", author: ctx.actor } });
  const before = counts();
  const again = applyMemoryImport(db, { actor: "owner", now: 2000 }, "demo", text);
  expect(again).toEqual({ backup: null, imported: [], replayed: r.imported });
  expect(counts()).toEqual(before);
  expect(readdirSync(join(dir, "backups"))).toHaveLength(1);
});

test("任何行运行时失败整批回滚（第二条回执失败，不留第一条记忆或事件）", () => {
  db.prepare(`CREATE TRIGGER injected BEFORE INSERT ON events WHEN NEW.dedupKey IS NOT NULL AND json_extract(NEW.data, '$.memoryId') = 'ab12-m2'
    BEGIN SELECT RAISE(ABORT, 'injected failure'); END`).run();
  expect(() => applyMemoryImport(db, ctx, "demo", raw(row(), row({ title: "查询必须稳定排序", family: "paging", files: ["src/page.ts"] })))).toThrow();
  expect(counts()).toEqual([0, 0, 0]);
  expect(readdirSync(join(dir, "backups"))).toHaveLength(1);
});

test("五类报告用例，源库 query_only 下扫描不写库、不建备份、不回显秘密", () => {
  const secret = ["sk", "abcdefghijklmnopqrstuv"].join("-");
  const text = [
    "{invalid JSON", JSON.stringify(row({ title: "中".repeat(27) })),
    JSON.stringify(row({ rule: secret })), JSON.stringify(row()),
    JSON.stringify(row({ title: "另一种同步事务约束" })), JSON.stringify(row({ feature: "missing" })),
    JSON.stringify(row({ title: "等待审查" })),
  ].join("\n");
  db.exec("PRAGMA query_only = ON");
  const p = plan(text);
  expect(new Set(p.issues.map((i) => i.kind))).toEqual(new Set(["format", "redaction", "duplicate", "anchor", "lint"]));
  expect(p.issues.find((i) => i.kind === "redaction")?.reason).toContain("rule");
  expect(JSON.stringify(p)).not.toContain(secret);
  const md = renderMemoryImportReport(p);
  for (const label of ["格式 / 长度", "脱敏命中", "重复", "锚点", "memoryLint"]) expect(md).toContain(label);
  expect(counts()).toEqual([0, 0, 0]);
  expect(existsSync(join(dir, "backups"))).toBe(false);
  expect((db.query("PRAGMA query_only").get() as { query_only: number }).query_only).toBe(1);
});

test("清单内同原始行也报重复；脏批次拒绝导入，第一条也不落", () => {
  const text = raw(row(), row());
  expect(plan(text).issues).toMatchObject([{ line: 2, kind: "duplicate" }]);
  expect(() => applyMemoryImport(db, ctx, "demo", text)).toThrow("清单有问题");
  expect(counts()).toEqual([0, 0, 0]);
  expect(existsSync(join(dir, "backups"))).toBe(false);
});

test("现有坑的同 family + 文件交集与内容重复均拒；跨项目键冲突不误认重跑", () => {
  const first = applyMemoryImport(db, ctx, "demo", raw(row()));
  expect(plan(raw(row({ title: "不同标题的同类坑" }))).issues[0]?.kind).toBe("duplicate");
  expect(plan(raw(row())).rows[0]?.replay).toBe(true);
  const other = planMemoryImport(db, ctx, "other", raw(row()));
  expect(other.issues[0]?.kind).toBe("duplicate");
  expect(first.imported).toHaveLength(1);
});

test("字段类型/多余身份字段/路径/长度不合法；锚点不存在或跨项目均拒", () => {
  for (const r of [null, [], row({ kind: "summary" }), row({ authorRole: "owner" }), row({ files: "src/a.ts" }),
    row({ fixable: "false" }), row({ files: ["../a.ts"] }), row({ files: Array(21).fill("src/a.ts") }), row({ task: 7 })]) {
    expect(plan(raw(r)).issues[0]?.kind).toBe("format");
  }
  createTask(db, { actor: "owner" }, { id: "X1", project: "other", title: "demo", kind: "code" });
  expect(plan(raw(row({ task: "X1" }))).issues[0]?.kind).toBe("anchor");
  expect(plan(raw(row({ task: "missing" }))).issues[0]?.kind).toBe("anchor");
});

test("锚卡自动取 head/specRev、feature 与 task 必须一致；内部内容只留 home", () => {
  db.prepare("INSERT INTO features (id,project,title,status,createdBy,createdAt,updatedAt) VALUES ('ab12-fx','demo','widget revision','active','pm',1,1)").run();
  createTask(db, { actor: "owner" }, { id: "N1", project: "demo", title: "demo", kind: "code" });
  db.prepare("UPDATE tasks SET headSHA = 'abc1234', featureId = 'ab12-fx' WHERE id = 'N1'").run();
  const text = raw(row({ task: "N1", feature: "ab12-fx", rule: "widget revision 必须同步写" }));
  const p = plan(text);
  expect(p.issues).toEqual([]);
  expect(p.rows[0]?.memory).toMatchObject({ head: "abc1234", specRev: 1, visibility: "home", featureId: "ab12-fx" });
  const result = applyMemoryImport(db, ctx, "demo", text);
  expect(memoryState(db, result.imported[0]!)?.memory.visibility).toBe("home");
});

test("报告展示解析版本；卡版本变化后重跑保留已存历史版本且零写入", () => {
  createTask(db, { actor: "owner" }, { id: "N1", project: "demo", title: "demo", kind: "code" });
  db.prepare("UPDATE tasks SET headSHA = 'old-head', specRev = 2 WHERE id = 'N1'").run();
  const text = raw(row({ task: "N1" }));
  const initial = plan(text);
  expect(renderMemoryImportReport(initial)).toContain("head=old-head, specRev=2");
  const result = applyMemoryImport(db, ctx, "demo", text);
  db.prepare("UPDATE tasks SET headSHA = 'new-head', specRev = 3 WHERE id = 'N1'").run();
  const before = counts();
  const replay = applyMemoryImport(db, ctx, "demo", text);
  expect(replay).toEqual({ backup: null, imported: [], replayed: result.imported });
  expect(counts()).toEqual(before);
  expect(memoryState(db, result.imported[0]!)?.memory).toMatchObject({ head: "old-head", specRev: 2 });
  expect(renderMemoryImportReport(plan(text))).toContain("head=old-head, specRev=2");
});

test("显式版本保留；显式 null/错误类型不当省略，未有版本的卡逐行报错", () => {
  createTask(db, { actor: "owner" }, { id: "N1", project: "demo", title: "demo", kind: "code" });
  expect(plan(raw(row({ task: "N1" }))).issues).toMatchObject([{ line: 1, kind: "format" }]);
  db.prepare("UPDATE tasks SET headSHA = 'current', specRev = 3 WHERE id = 'N1'").run();
  expect(plan(raw(row({ task: "N1", head: "explicit", specRev: 2 }))).rows[0]?.memory).toMatchObject({ head: "explicit", specRev: 2 });
  for (const version of [{ head: null }, { specRev: null }, { head: 123 }, { specRev: 0 }]) {
    expect(plan(raw(row({ task: "N1", ...version }))).issues).toMatchObject([{ line: 1, kind: "format" }]);
  }
});

test("回执核空 target、pitfall 类型、完整绑定；错误 op/id/项目均拒", () => {
  const text = raw(row());
  const key = "import:" + createHash("sha256").update(text).digest("hex");
  const unrelated = recordMemory(db, ctx, {
    project: "demo", kind: "pitfall", title: "不同内容", symptom: "不同症状", rule: "必须稳定排序", files: ["src/other.ts"],
    family: "other", fixable: false, via: "import", authorRole: "pm", sourceNote: "PM import",
  }).memory;
  appendEvent(db, { ...ctx, dedupKey: key }, { project: "demo", target: "", kind: "note", data: { op: "memory_import", memoryId: unrelated.id } });
  expect(plan(text).issues).toMatchObject([{ line: 1, kind: "duplicate" }]);
});

test("规范完整哈希 note 键可存；非空 target、错误 op/id/项目/类型/额外数据回执拒绝", () => {
  createTask(db, { actor: "owner" }, { id: "Anchor", project: "demo", title: "anchor", kind: "code" });
  const cases = ["target", "op", "id", "project", "kind", "extra", "memory-kind"];
  for (const bad of cases) {
    const r = row({ title: "导入约束 " + bad, family: "binding-" + bad });
    const text = raw(r), key = "import:" + createHash("sha256").update(text).digest("hex");
    const memory = recordMemory(db, ctx, bad === "memory-kind"
      ? { project: "demo", kind: "decision", title: r.title, body: "必须复核", files: r.files, via: "import", authorRole: "pm", sourceNote: r.sourceNote }
      : { ...r, project: "demo", kind: "pitfall", via: "import", authorRole: "pm" } as MemoryInput).memory;
    appendEvent(db, { ...ctx, dedupKey: key }, {
      project: bad === "project" ? "other" : "demo", target: bad === "target" ? "Anchor" : "",
      kind: bad === "kind" ? "decision" : "note",
      data: { op: bad === "op" ? "other" : "memory_import", memoryId: bad === "id" ? "ab12-m99999" : memory.id,
        ...(bad === "extra" ? { raw: "unexpected" } : {}) },
    });
    const before = counts();
    expect(plan(text).issues).toMatchObject([{ line: 1, kind: "duplicate" }]);
    expect(() => applyMemoryImport(db, ctx, "demo", text)).toThrow("清单有问题");
    expect(counts()).toEqual(before);
  }
});

test("重跑 disputed/fixed/retracted 的行保持状态且不追加任何行", () => {
  createTask(db, { actor: "owner" }, { id: "Fix", project: "demo", title: "fix", kind: "code" });
  const text = raw(row({ fixable: true }));
  const id = applyMemoryImport(db, ctx, "demo", text).imported[0]!;
  markMemory(db, ctx, { memoryId: id, mark: "dispute", reason: "需复核" });
  for (const action of ["disputed", "fixed", "retracted"] as const) {
    if (action === "fixed") {
      markMemory(db, ctx, { memoryId: id, mark: "link_fix", taskId: "Fix" });
      markMemory(db, ctx, { memoryId: id, mark: "fixed", taskId: "Fix" });
    }
    if (action === "retracted") markMemory(db, ctx, { memoryId: id, mark: "retract", reason: "不再采用" });
    const before = counts(), state = memoryState(db, id);
    if (action === "disputed") expect(state?.disputed).toBe(true);
    else expect(state?.status).toBe(action);
    expect(applyMemoryImport(db, ctx, "demo", text)).toMatchObject({ backup: null, imported: [], replayed: [id] });
    expect(counts()).toEqual(before);
    expect(memoryState(db, id)).toEqual(state);
  }
});

test("权限回调在正式 IMMEDIATE 事务内重核；拒绝不留记忆/回执", () => {
  let called = 0;
  expect(() => applyMemoryImport(db, ctx, "demo", raw(row()), new Map(), () => {
    expect(db.inTransaction).toBe(true);
    called++;
    throw new Error("permission revoked");
  })).toThrow("permission revoked");
  expect(called).toBe(1);
  expect(counts()).toEqual([0, 0, 0]);
});

test("备份失败则不写；失败重试使用不同备份，不复用旧库快照", () => {
  mkdirSync(join(dir, "backups"));
  db.prepare("CREATE TRIGGER injected BEFORE INSERT ON memories BEGIN SELECT RAISE(ABORT,'fail'); END").run();
  // Planning omits runtime triggers; real writes must still roll back.
  expect(() => applyMemoryImport(db, ctx, "demo", raw(row()))).toThrow();
  db.prepare("DROP TRIGGER injected").run();
  const r = applyMemoryImport(db, ctx, "demo", raw(row()));
  expect(r.imported).toHaveLength(1);
  expect(readdirSync(join(dir, "backups"))).toHaveLength(2);
});

test("原库未存 origin 时 dry-run 只在副本使用前缀，不创建主场 instance-id", () => {
  db.prepare("DELETE FROM ledger_instance").run();
  expect(plan(raw(row())).issues).toEqual([]);
  expect(db.query("SELECT * FROM ledger_instance").all()).toEqual([]);
});

test("语义判重覆盖库内与清单内；无模型为空；远端不发 home", async () => {
  const existing: MemoryInput = { project: "demo", kind: "pitfall", title: "写入必须一个事务", symptom: "部分提交", rule: "写入必须同步",
    files: ["src/other.ts"], family: "other-tx", fixable: false, via: "tool", authorRole: "pm", sourceNote: "review" };
  const m = recordMemory(db, ctx, existing).memory;
  const text = raw(row());
  const initial = plan(text);
  const noModel = await importVectors(db, initial, null);
  expect(noModel.size).toBe(0);
  const vectors = await importVectors(db, initial, { model: "test", remote: false, embed: async (texts) => texts.map(() => [1, 0]) });
  expect(vectors.get(importVectorKey(m))).toEqual(new Float32Array([1, 0]));
  expect(planMemoryImport(db, ctx, "demo", text, vectors).issues[0]?.kind).toBe("duplicate");
  expect(() => applyMemoryImport(db, ctx, "demo", text, vectors)).toThrow();
  const two = raw(row({ family: "first" }), row({ title: "同步写入整批", family: "second", files: ["src/two.ts"] }));
  const p = plan(two);
  const within = new Map(p.rows.map((r) => [importVectorKey(r.memory), new Float32Array([0, 1])]));
  expect(planMemoryImport(db, ctx, "demo", two, within).issues).toMatchObject([{ line: 2, kind: "duplicate" }]);
  let sent: string[] = [];
  const home = plan(raw(row({ visibility: "home" })));
  await importVectors(db, home, { model: "test", remote: true, embed: async (texts) => { sent = texts; return texts.map(() => [1, 0]); } });
  expect(sent.join("\n")).not.toContain("事务回调不能 await");
});
