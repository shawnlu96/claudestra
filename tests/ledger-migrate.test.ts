/** 台账库升级（src/lib/ledger-store.ts MIGRATIONS）：v1 旧库 → 依赖边版本；多个进程同时打开只迁移一次；bridge 读侧对旧库不报错 */
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { LedgerReader, projectView } from "../src/lib/ledger-read.js";
import { closeLedger, DEPS_SCHEMA_VERSION, getTask, LEDGER_MIGRATIONS, LEDGER_SCHEMA_VERSION, listDeps, openLedger, schemaVersion } from "../src/lib/ledger-store.js";

function tmp(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "ledger-mig-"));
  return { dir, path: join(dir, "ledger.sqlite") };
}

/** 按 v1 的建表语句造一个旧库：一条有执行者、一条没派人的任务 */
function makeV1(path: string): void {
  const raw = new Database(path);
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec(LEDGER_MIGRATIONS[0] as string);
  raw.exec("PRAGMA user_version = 1");
  const ins = raw.prepare("INSERT INTO tasks (id, project, title, kind, stage, agent, createdAt, updatedAt) VALUES (?, 'p', ?, 'code', ?, ?, 0, 0)");
  ins.run("T1", "有人", "build", "agent-exec");
  ins.run("T2", "没派", "spec", null);
  ins.run("T3", "空串", "spec", "");
  raw.close();
}

/** 子进程：同一时刻打开旧库（触发迁移），T2 → T1 各加一条不同的边 */
function openerScript(path: string, startAt: number, i: number): string {
  const store = resolve(import.meta.dir, "../src/lib/ledger-store.ts");
  const write = resolve(import.meta.dir, "../src/lib/ledger-write.ts");
  const deps = resolve(import.meta.dir, "../src/lib/ledger-deps-write.ts");
  return `
    const { openLedger } = await import(${JSON.stringify(store)});
    const { createTask } = await import(${JSON.stringify(write)});
    const { addDep } = await import(${JSON.stringify(deps)});
    while (Date.now() < ${startAt}) {}
    try {
      const db = openLedger(${JSON.stringify(path)});
      createTask(db, { actor: "owner" }, { project: "p", id: "N${i}", title: "x", kind: "code" });
      addDep(db, { actor: "owner" }, { from: "T1", to: "N${i}", when: "T1 合并后" });
      console.log(JSON.stringify({ ok: true }));
    } catch (e) {
      console.log(JSON.stringify({ ok: false, code: e.code, message: String(e.message) }));
    }
  `;
}

describe("v1 → 依赖边版本", () => {
  test("迁移常量由下标算：最新版本 = 迁移步数，依赖边从 DEPS_SCHEMA_VERSION 起", () => {
    expect(LEDGER_SCHEMA_VERSION).toBe(LEDGER_MIGRATIONS.length);
    expect(DEPS_SCHEMA_VERSION).toBeGreaterThan(1);
    expect(DEPS_SCHEMA_VERSION).toBeLessThanOrEqual(LEDGER_SCHEMA_VERSION);
  });

  test("旧任务有 agent 的回填成 assigneeKind=agent，没派人（含空串）的留空；task_deps 建好", () => {
    const { dir, path } = tmp();
    try {
      makeV1(path);
      const db = openLedger(path);
      expect(schemaVersion(db)).toBe(LEDGER_SCHEMA_VERSION);
      expect([getTask(db, "T1")?.assigneeKind, getTask(db, "T1")?.assignee]).toEqual(["agent", "agent-exec"]);
      expect([getTask(db, "T2")?.assigneeKind, getTask(db, "T2")?.assignee]).toEqual([null, null]);
      expect(getTask(db, "T3")?.assigneeKind).toBeNull();
      expect(listDeps(db, "p")).toEqual([]);
      closeLedger(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("迁移可重跑：已有 task_deps 与 assignee 列、版本号却被退回 1（撞号），再打开照样走通，边与已设的负责人不被覆盖", () => {
    const { dir, path } = tmp();
    try {
      makeV1(path);
      const db = openLedger(path);
      db.exec("INSERT INTO task_deps (project, fromTask, toTask, kind, cond, createdBy, createdAt, updatedAt) VALUES ('p', 'T1', 'T2', 'blocks', 'x', 'owner', 0, 0)");
      db.exec("UPDATE tasks SET assigneeKind = 'human', assignee = 'local:owner:self', agent = NULL WHERE id = 'T1'");
      db.exec("PRAGMA user_version = 1");
      closeLedger(path);
      const again = openLedger(path);
      expect(schemaVersion(again)).toBe(LEDGER_SCHEMA_VERSION);
      expect(listDeps(again, "p").map((d) => [d.from, d.to])).toEqual([["T1", "T2"]]);
      expect([getTask(again, "T1")?.assigneeKind, getTask(again, "T1")?.assignee]).toEqual(["human", "local:owner:self"]);
      closeLedger(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("8 个进程同时打开同一个旧库并写边，连跑 3 轮：全部成功、只迁移一次、边 8 条", async () => {
    for (let round = 0; round < 3; round++) {
      const { dir, path } = tmp();
      try {
        makeV1(path);
        const startAt = Date.now() + 800;
        const procs = Array.from({ length: 8 }, (_, i) =>
          Bun.spawn([process.execPath, "-e", openerScript(path, startAt, i)], { stdout: "pipe", stderr: "pipe", env: { ...process.env, CLAUDESTRA_STATE_DIR: dir } }),
        );
        const outs = await Promise.all(procs.map(async (p) => (await new Response(p.stdout).text()).trim()));
        expect(outs.map((o) => JSON.parse(o) as { ok: boolean })).toEqual(Array.from({ length: 8 }, () => ({ ok: true })));
        const db = openLedger(path);
        expect(schemaVersion(db)).toBe(LEDGER_SCHEMA_VERSION);
        expect(listDeps(db, "p")).toHaveLength(8);
        expect(getTask(db, "T1")?.assigneeKind).toBe("agent");
        closeLedger(path);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 60_000);

  test("bridge 读侧先于 CLI 升级：只读连接打开还没迁移的 v1 库，总览照常、deps 为空、任务带 null 的 assignee", () => {
    const { dir, path } = tmp();
    try {
      makeV1(path);
      const reader = new LedgerReader(path);
      const db = reader.get();
      expect(db).not.toBeNull();
      const view = projectView(db!, "p", 0);
      expect(view.deps).toEqual([]);
      expect(view.tasks.map((t) => [t.id, t.assigneeKind, t.runnable])).toEqual([["T1", null, true], ["T2", null, true], ["T3", null, true]]);
      reader.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("写事件的底座只给写入模块", () => {
  test("src 里 import ledger-tx 的只有 ledger-write.ts / ledger-deps-write.ts（直接写事件会绕过阶段机与权限）", () => {
    const root = resolve(import.meta.dir, "../src");
    const hits: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts") && /from "\.\/ledger-tx\.js"|ledger-tx\.js"/.test(readFileSync(p, "utf8"))) hits.push(p.slice(root.length + 1));
      }
    };
    walk(root);
    expect(hits.sort()).toEqual(["lib/ledger-deps-write.ts", "lib/ledger-write.ts"]);
  });
});
