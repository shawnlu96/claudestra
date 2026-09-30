/** 台账库升级（src/lib/ledger-store.ts MIGRATIONS）：v1 旧库 → 依赖边版本；多个进程同时打开只迁移一次；bridge 读侧对旧库不报错 */
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { LedgerReader, projectView } from "../src/lib/ledger-read.js";
import { closeLedger, getTask, LEDGER_MIGRATIONS, LEDGER_SCHEMA_VERSION, listDeps, openLedger, schemaVersion } from "../src/lib/ledger-store.js";

function tmp(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "ledger-mig-"));
  return { dir, path: join(dir, "ledger.sqlite") };
}

/** 按 v1 的建表语句造一个旧库：一条有执行者、一条没派人的任务 */
function makeV1(path: string): void {
  const raw = new Database(path);
  raw.exec("PRAGMA journal_mode = WAL");
  for (const sql of LEDGER_MIGRATIONS[0] as readonly string[]) raw.prepare(sql).run();
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
  test("迁移常量由下标算：最新版本 = 迁移步数", () => {
    expect(LEDGER_SCHEMA_VERSION).toBe(LEDGER_MIGRATIONS.length);
  });

  test("写成 SQL 数组的迁移一个元素只有一条语句：多语句交给 prepare 只跑第一条（其余静默丢掉）、交给 exec 会吞运行期错误", () => {
    // 同一条分别用 prepare().run() 与 exec 跑进两个库：一个元素里藏了第二条语句，两边的 schema 就对不上
    const [one, all] = [new Database(":memory:"), new Database(":memory:")];
    const schema = (d: Database) => d.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
    for (const step of LEDGER_MIGRATIONS) {
      if (typeof step === "function") continue;
      for (const sql of step) {
        one.prepare(sql).run();
        all.exec(sql);
        expect([sql, schema(one)]).toEqual([sql, schema(all)]);
      }
    }
    expect(schema(one).length).toBeGreaterThan(0);
    one.close();
    all.close();
  });

  test("字面检查：数组迁移的元素去掉触发器的 BEGIN … END 后不许再有 `;` 接语句（藏一条 UPDATE 时两边 schema 一样，上一条测不出）", () => {
    for (const step of LEDGER_MIGRATIONS) {
      if (typeof step === "function") continue;
      for (const sql of step) expect([sql, /;\s*\S/.test(sql.replace(/\bBEGIN\b[\s\S]*?\bEND\b/gi, ""))]).toEqual([sql, false]);
    }
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

  test("撞号真实场景：别的分支的 v2 先占了号（有 task_deps、没有 assignee 列），版本已是最新——打开时按表 / 列核对，缺的补齐", () => {
    const { dir, path } = tmp();
    try {
      makeV1(path);
      const raw = new Database(path);
      raw.exec("CREATE TABLE task_deps (project TEXT, fromTask TEXT, toTask TEXT, kind TEXT, cond TEXT, state TEXT, rev INTEGER, createdBy TEXT, createdAt INTEGER, updatedAt INTEGER)");
      raw.exec(`PRAGMA user_version = ${LEDGER_SCHEMA_VERSION}`);
      raw.close();
      const db = openLedger(path);
      expect([getTask(db, "T1")?.assigneeKind, getTask(db, "T1")?.assignee]).toEqual(["agent", "agent-exec"]);
      closeLedger(path);
      const raw2 = new Database(path);
      raw2.exec("DROP TABLE task_deps");
      raw2.close();
      expect(listDeps(openLedger(path), "p")).toEqual([]);
      closeLedger(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("回填撞上运行期错误（触发器 ABORT）：打开报错、整笔回滚，版本号不往前推", () => {
    const { dir, path } = tmp();
    try {
      makeV1(path);
      const raw = new Database(path);
      raw.exec("CREATE TRIGGER no_upd BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT, 'frozen'); END");
      raw.close();
      expect(() => openLedger(path)).toThrow(/frozen.*已回滚，库仍是 v1/);
      const after = new Database(path);
      expect(schemaVersion(after)).toBe(1);
      expect((after.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).some((c) => c.name === "assigneeKind")).toBe(false);
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("补齐核对看索引所属的表：同名索引先建在别的表上（IF NOT EXISTS 会跳过）→ 报错、回滚", () => {
    const { dir, path } = tmp();
    try {
      makeV1(path);
      const raw = new Database(path);
      raw.exec("CREATE INDEX task_deps_to ON tasks(kind)");
      raw.close();
      expect(() => openLedger(path)).toThrow(/index task_deps\.task_deps_to.*已回滚，库仍是 v1/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("task_deps 缺关键列（先建了只有三列的表，索引照样建得出来）→ 核对查出来、报错回滚，不带着 dep-add 必挂的库往下走", () => {
    const { dir, path } = tmp();
    try {
      makeV1(path);
      const raw = new Database(path);
      raw.exec("CREATE TABLE task_deps (project TEXT, fromTask TEXT, toTask TEXT)");
      raw.close();
      expect(() => openLedger(path)).toThrow(/task_deps\.kind.*已回滚，库仍是 v1/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("旧 CLI（不认识负责人列、只改 agent）写过之后再用新代码打开：按 agent 列纠正负责人，幂等；人 / 对面实例的负责人不动", () => {
    const { dir, path } = tmp();
    try {
      makeV1(path);
      const db = openLedger(path);
      db.exec("UPDATE tasks SET agent = NULL, assigneeKind = 'human', assignee = 'local:owner:self' WHERE id = 'T3'");
      closeLedger(path);
      // 旧代码的写法：set --agent 只动 agent 列、新建任务不写负责人列、清掉 agent 也不动 kind
      const raw = new Database(path);
      raw.exec("UPDATE tasks SET agent = 'agent-new' WHERE id = 'T1'");
      raw.exec("INSERT INTO tasks (id, project, title, kind, stage, agent, createdAt, updatedAt) VALUES ('T4', 'p', '旧建', 'code', 'spec', 'agent-old', 0, 0)");
      raw.exec("INSERT INTO tasks (id, project, title, kind, stage, agent, assigneeKind, assignee, createdAt, updatedAt) VALUES ('T5', 'p', '旧清', 'code', 'spec', NULL, 'agent', 'agent-gone', 0, 0)");
      raw.exec("UPDATE tasks SET agent = 'agent-late' WHERE id = 'T2'");
      raw.close();
      const who = (d: ReturnType<typeof openLedger>, id: string) => [getTask(d, id)?.agent ?? null, getTask(d, id)?.assigneeKind ?? null, getTask(d, id)?.assignee ?? null];
      const expected = {
        T1: ["agent-new", "agent", "agent-new"],
        T2: ["agent-late", "agent", "agent-late"],
        T3: [null, "human", "local:owner:self"],
        T4: ["agent-old", "agent", "agent-old"],
        T5: [null, null, null],
      };
      for (let round = 0; round < 2; round++) {
        const again = openLedger(path);
        expect(Object.fromEntries(Object.keys(expected).map((id) => [id, who(again, id)]))).toEqual(expected);
        closeLedger(path);
      }
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

  test("只读连接遇上「版本号已是最新、task_deps 却不在」（别的分支的代码先占了号，写者还没补齐）：deps 为空，不报 no such table", () => {
    const { dir, path } = tmp();
    try {
      makeV1(path);
      const raw = new Database(path);
      raw.exec(`PRAGMA user_version = ${LEDGER_SCHEMA_VERSION}`);
      raw.close();
      const reader = new LedgerReader(path);
      expect(projectView(reader.get()!, "p", 0).deps).toEqual([]);
      reader.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("写事件的底座只给写入模块", () => {
  // ledger-human.ts：v3.2 例外（human 节点的人工交付与重开指派），它按执行者角色推 build / fix → review，门在 human-node.ts；
  // ledger-steps-write.ts：步骤化台账（T47）的写入，派步骤要 PM，交付 / 审查的钩子挂在 ledger-write.ts 的事务里
  // ledger-scheduler-write.ts：调度意图与资源锁同事务写，入口只提供限定动作与 CAS
  // scheduler-observe.ts / scheduler-fallback.ts：observe 只写观察事件；退回人工是调度身份唯一能做的模式变更（T68e）
  test("src 里 import ledger-tx / applyMove 的只有写入模块（直接写事件、带 asRole 推阶段会绕过阶段机与权限）", () => {
    const root = resolve(import.meta.dir, "../src");
    const tx: string[] = [];
    const move: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts")) {
          const src = readFileSync(p, "utf8");
          if (/from "\.\/ledger-tx\.js"|ledger-tx\.js"/.test(src)) tx.push(p.slice(root.length + 1));
          if (/import \{[^}]*\bapplyMove\b[^}]*\} from/.test(src)) move.push(p.slice(root.length + 1));
        }
      }
    };
    walk(root);
    expect(tx.sort()).toEqual(["lib/ledger-deps-write.ts", "lib/ledger-human.ts", "lib/ledger-scheduler-write.ts", "lib/ledger-steps-write.ts", "lib/ledger-write.ts",
      "lib/scheduler-fallback.ts", "lib/scheduler-observe.ts", "lib/scheduler-sessions.ts"]);
    expect(move).toEqual(["lib/ledger-human.ts"]);
  });
});
