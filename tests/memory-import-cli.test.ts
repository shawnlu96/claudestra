import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { LedgerCli, type LedgerDeps } from "../src/manager/ledger-context.js";
import { parseLedgerArgs } from "../src/manager/ledger-identity.js";
import { MEMORY_IMPORT_CMDS, memoryImportCmd } from "../src/manager/ledger-memory-import.js";
import { runLedger } from "../src/manager/ledger.js";
import { writeMemoryImportReport } from "../src/lib/memory-import-report.js";
import { DRY_RUN_READS, isWriteInvocation } from "../src/manager/write-commands.js";
import type { Embedder } from "../src/lib/memory-embed.js";

let dir: string, path: string, file: string, db: Database;
const PM = "agent-pm";
const row = { kind: "pitfall", title: "事务回调必须同步", symptom: "部分数据提交", rule: "事务内必须同步写",
  files: ["src/a.ts"], family: "tx", fixable: false, sourceNote: "PM import", visibility: "team" };
const deps = (actor: string, database = db): LedgerDeps => ({
  db: database, actor, actorProject: "demo", projectIds: ["demo"], now: () => 1000,
  loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {},
});
const cli = (actor: string, args: string[], database = db) => {
  const spec = MEMORY_IMPORT_CMDS["memory-import"]!;
  const p = parseLedgerArgs(["memory-import", ...args], spec.valued, spec.bools);
  if ("error" in p) throw new Error(p.error);
  return new LedgerCli(deps(actor, database), p);
};
const run = (actor: string, args: string[], database = db, embedder: Embedder | null = null) => memoryImportCmd(cli(actor, args, database), embedder);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memory-import-cli-"));
  path = join(dir, "ledger.sqlite"); file = join(dir, "manifest.jsonl");
  db = openLedger(path);
  db.prepare("INSERT INTO ledger_instance(key,value) VALUES ('origin','ab12')").run();
  setMeta(db, { actor: "owner" }, { project: "demo", key: "pms", value: [PM, "agent-dispatch"] });
  db.prepare("INSERT INTO meta(project,key,value) VALUES ('demo','team',?)").run(JSON.stringify({ dispatcher: "agent-dispatch", audit: true, sinceSeq: 1 }));
  writeFileSync(file, JSON.stringify(row));
});
afterEach(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });

test("注册命令与只读分类；默认 actor 项目；dry-run 匿名可读、实读连接不改库", async () => {
  expect(DRY_RUN_READS.has("memory-import")).toBe(true);
  expect(isWriteInvocation("ledger", ["memory-import", "--dry-run"])).toBe(false);
  expect(isWriteInvocation("ledger", ["memory-import"])).toBe(true);
  const reader = new Database(path, { readonly: true });
  try {
    expect(await run("unknown", ["--file", file, "--dry-run"], reader)).toMatchObject({ ok: true, clean: true, writes: 1 });
    expect(await run("unknown", ["--file", file, "--dry-run", "--project", "demo"], reader)).toMatchObject({ clean: true });
    expect(reader.query("SELECT * FROM memories").all()).toEqual([]);
  } finally { reader.close(); }
  expect(existsSync(join(dir, "backups"))).toBe(false);
  expect(await runLedger(["memory-import", "--file", file], deps("agent-exec"))).toMatchObject({ ok: false, code: "forbidden" });
});

test("正式入口只许真实 PM/master/owner；执行者和调度助理拒；身份字段不能从清单注入", async () => {
  for (const actor of ["agent-exec", "unknown", "agent-dispatch"]) {
    await expect(run(actor, ["--file", file])).rejects.toThrow("只有");
  }
  for (const actor of [PM, "owner", "master"]) {
    expect(await run(actor, ["--file", file])).toMatchObject({ ok: true });
  }
  expect((db.query("SELECT count(*) AS n FROM memories").get() as { n: number }).n).toBe(1);
});

test("dry-run 的 --out 报告包含五类标题与行号，清单问题只报告，不改库", async () => {
  writeFileSync(file, JSON.stringify({ ...row, task: "missing" }));
  const out = join(dir, "report.md");
  expect(await run(PM, ["--file", file, "--dry-run", "--out", out])).toMatchObject({ ok: true, clean: false, issues: [{ line: 1, kind: "anchor" }] });
  expect(readFileSync(out, "utf8")).toContain("行 1");
  await expect(run(PM, ["--file", file, "--out", out])).rejects.toThrow("--out 只随");
  expect(db.query("SELECT * FROM memories").all()).toEqual([]);
});

test("--out 防覆写库/旁路/备份/软链/硬链/软链目录，拒绝后库仍完整", async () => {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const backup = join(dir, "copy.bak");
  db.prepare("VACUUM INTO ?").run(backup);
  const sym = join(dir, "sym.md");
  symlinkSync(path, sym);
  const linkDir = join(dir, "link-dir"); symlinkSync(dir, linkDir);
  const sidecar = path + "-wal";
  const sideBytes = readFileSync(sidecar);
  const sideHard = join(dir, "side-hard.md"); linkSync(sidecar, sideHard);
  const subdir = join(dir, "subdir"); mkdirSync(subdir);
  for (const out of [path, path + "-wal", path + "-shm", path + "-journal", backup, sym, subdir, sideHard, join(linkDir, "ledger.sqlite")]) {
    await expect(run(PM, ["--file", file, "--dry-run", "--out", out])).rejects.toThrow("报告没写");
  }
  expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  expect(readFileSync(sidecar)).toEqual(sideBytes);
  const normal = join(dir, "normal.md"); writeFileSync(normal, "old report");
  expect(await run(PM, ["--file", file, "--dry-run", "--out", normal])).toMatchObject({ ok: true, report: normal });
  expect(readFileSync(normal, "utf8")).toContain("项目记忆导入检查");
});

test("备份目录被同名文件占用时失败，不写入任何记忆", async () => {
  writeFileSync(join(dir, "backups"), "occupied");
  await expect(run(PM, ["--file", file])).rejects.toThrow("备份失败");
  expect(db.query("SELECT * FROM memories").all()).toEqual([]);
});

test("可选嵌入过程中 query_only 防住源写入；模型失败不阻塞；恢复原 query_only", async () => {
  let blocked = false;
  const fake: Embedder = { model: "test", remote: false, embed: async () => {
    try { db.prepare("INSERT INTO ledger_instance(key,value) VALUES ('injected','1')").run(); }
    catch { blocked = true; /* The expected read-only rejection verifies that embedding cannot mutate the source ledger. */ }
    throw new Error("model unavailable");
  } };
  expect(await run(PM, ["--file", file, "--dry-run"], db, fake)).toMatchObject({ clean: true });
  expect(blocked).toBe(true);
  expect((db.query("PRAGMA query_only").get() as { query_only: number }).query_only).toBe(0);
  db.exec("PRAGMA query_only = ON");
  expect(await run(PM, ["--file", file, "--dry-run"])).toMatchObject({ clean: true });
  expect((db.query("PRAGMA query_only").get() as { query_only: number }).query_only).toBe(1);
});

test("嵌入期间 PM 被撤销，正式导入在写前重核身份", async () => {
  const other = new Database(path);
  const fake: Embedder = { model: "test", remote: false, embed: async (texts) => {
    other.prepare("UPDATE meta SET value = '[]' WHERE project = 'demo' AND key = 'pms'").run();
    return texts.map(() => [1, 0]);
  } };
  try { await expect(run(PM, ["--file", file], db, fake)).rejects.toThrow("只有"); }
  finally { other.close(); }
  expect(db.query("SELECT * FROM memories").all()).toEqual([]);
});

test("report writer 拒绝库本体硬链（数据库关闭后检查，避免 macOS vnode 读错误）", () => {
  closeLedger(path);
  const hard = join(dir, "hard.md");
  linkSync(path, hard);
  const before = readFileSync(path);
  expect(() => writeMemoryImportReport(hard, path, "report")).toThrow("报告没写");
  expect(readFileSync(path)).toEqual(before);
  unlinkSync(hard);
});
