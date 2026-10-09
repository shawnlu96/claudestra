/** 台账库升级（src/lib/ledger-store.ts MIGRATIONS）：v1 旧库 → 依赖边版本；多个进程同时打开只迁移一次；bridge 读侧对旧库不报错 */
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { LedgerReader, projectView } from "../src/lib/ledger-read.js";
import { SCHEDULER_MERGE_WAIT_SCHEMA } from "../src/lib/ledger-scheduler-schema.js";
import { closeLedger, getTask, LEDGER_MIGRATIONS, LEDGER_SCHEMA_VERSION, listDeps, openLedger, schemaVersion } from "../src/lib/ledger-store.js";

const BEFORE_MERGE_WAIT = LEDGER_MIGRATIONS.indexOf(SCHEDULER_MERGE_WAIT_SCHEMA);

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

/** The schema immediately before UNKNOWN waits were persisted, including an in-flight merge row. */
function makeBeforeMergeWait(path: string): void {
  makeV1(path);
  const db = new Database(path);
  for (const step of LEDGER_MIGRATIONS.slice(1, BEFORE_MERGE_WAIT)) {
    if (typeof step === "function") step(db);
    else for (const sql of step) db.prepare(sql).run();
  }
  db.prepare(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,taskRev,specRev,templateVersion,status,reason,createdAt,updatedAt)
    VALUES ('merge-old','T1','p','merge_deploy','merge',1,1,1,2,'submitted','r',0,0)`).run();
  db.prepare(`INSERT INTO scheduler_merges (intentId,taskId,project,prRef,expectedBranch,reviewedHead,requiredChecks,phase,createdAt,updatedAt)
    VALUES ('merge-old','T1','p','https://github.com/a/b/pull/1','task/T1',?,'check','await_ci',0,0)`).run("a".repeat(40));
  db.exec(`PRAGMA user_version = ${BEFORE_MERGE_WAIT}`);
  db.close();
}

describe("UNKNOWN wait migration", () => {
  test("old schema upgrades existing merge rows to a nullable unknownSince, also repairing a version collision", () => {
    for (const version of [BEFORE_MERGE_WAIT, LEDGER_SCHEMA_VERSION]) {
      const { dir, path } = tmp();
      try {
        makeBeforeMergeWait(path);
        const raw = new Database(path);
        expect((raw.query("PRAGMA table_info(scheduler_merges)").all() as { name: string }[]).some((c) => c.name === "unknownSince")).toBe(false);
        raw.exec(`PRAGMA user_version = ${version}`);
        raw.close();
        const db = openLedger(path);
        expect(schemaVersion(db)).toBe(LEDGER_SCHEMA_VERSION);
        expect(db.query("SELECT phase,rev,unknownSince FROM scheduler_merges WHERE intentId='merge-old'").get())
          .toEqual({ phase: "await_ci", rev: 1, unknownSince: null });
      } finally { closeLedger(path); rmSync(dir, { recursive: true, force: true }); }
    }
  });
  test("repeated migration and reopening preserve an existing wait timestamp", () => {
    const { dir, path } = tmp();
    try {
      makeBeforeMergeWait(path);
      const db = openLedger(path);
      db.prepare("UPDATE scheduler_merges SET unknownSince=123456 WHERE intentId='merge-old'").run();
      for (let round = 0; round < 2; round++) {
        openLedger(path).exec(`PRAGMA user_version = ${BEFORE_MERGE_WAIT}`);
        closeLedger(path);
        const again = openLedger(path);
        expect(schemaVersion(again)).toBe(LEDGER_SCHEMA_VERSION);
        expect(again.query("SELECT unknownSince FROM scheduler_merges WHERE intentId='merge-old'").get()).toEqual({ unknownSince: 123456 });
        expect((again.query("PRAGMA table_info(scheduler_merges)").all() as { name: string }[]).filter((c) => c.name === "unknownSince")).toHaveLength(1);
      }
    } finally { closeLedger(path); rmSync(dir, { recursive: true, force: true }); }
  });
});

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
  // scheduler-merge-train-hold.ts：合并槽让出 / 取回在推进合并的事务内校验持槽与阶段、递增 rev，并写同阶段的调度回执
  // ledger-human.ts：v3.2 例外（human 节点的人工交付与重开指派），它按执行者角色推 build / fix → review，门在 human-node.ts；
  // ledger-steps-write.ts：步骤化台账（T47）的写入，派步骤要 PM，交付 / 审查的钩子挂在 ledger-write.ts 的事务里
  // ledger-scheduler-write.ts：调度意图与资源锁同事务写，入口只提供限定动作与 CAS；意图结算（CAS）拆在 ledger-scheduler-settle.ts
  // scheduler-observe.ts / scheduler-fallback.ts：observe 只写观察事件；退回人工是调度身份唯一能做的模式变更（T68e）
  // ledger-feature-write.ts：feature 与子 DAG 初版（T84），权限与 CAS 在它自己的事务里
  // ledger-dag-write.ts：子 DAG 重写 / 审批 / 绑卡（T89），四条规矩与 owner 审批在它自己的事务里
  // ledger-scheduler-resume.ts：改规格后把退回人工的 auto 卡交回调度（T68h），只 PM / master / owner，CAS + 未定意图先对账
  // ledger-scheduler-pool.ts：调度身份把审查挂进共享池（i28-R9），事务内重算计划核对后才出单，之后只按出借单状态 CAS 结算意图
  // scheduler-apply.ts：调度身份按模板推自动卡（只许 restate→build、review→fix / merge），事务内重算计划核对后才 applyMove（T68f）
  // scheduler-deploy.ts：部署 journal（T68g），只有调度身份推进，deployed 才把本卡 merge→live，结清只 PM / master / owner
  // scheduler-merge-handoff.ts：合并交仓库方（MHO1），只有调度身份记交接事件、按 GitHub 已合并把本卡 merge→live，事务内重核阶段 / head / PR / 审查
  // ledger-lend-peers.ts：借算力 v2（i28-W2）的 hello 入账、beat 续租 / 收回、推送应答，CAS 在它的事务里，写事件只经 ledger-lend.ts 的 leaseLend / withdrawPooledLend
  // ledger-lend-relay.ts：出借写单持单期间的规格追加 / 复述答复转发队列（i28-RS1），只写自己的两张表和一条 lend relay note，不推阶段
  // order-mark.ts：只写两种按意图去重的 scheduler 事件（领单留痕 = 收件人本人本会话、未领单报警 = 调度身份），不推阶段（i28-M4b）
  // ledger-autostart*.ts：自动开卡的 claim / step / settle 与开关（i28-A1）：调度身份的写权只由活着的 claim 授予，step 先核 claim 再调 lib 写函数；
  //   step 回滚取消本 claim 建的卡时按 pm 推 cancelled（applyMove asRole）；自动交回在事务里重判后走 PM 交回的同一核心
  // scheduler-spec-resume-write.ts：spec 阶段 auto 卡放到 peer（i28-RSM1），调度身份照开卡的规矩按 pm 推 spec→restate（applyMove asRole），事务内重核资格与 rev
  // lend-fix-reassign-start.ts / -pr.ts / -tick.ts：自动改派修复单（i28-RA1）在挂池事务里结束旧写租约、记改派事件；关旧 PR、等租约方计时各记去重事件，不推阶段
  // memory-retrieve-order.ts：只写排名缓存与最终领取的 scheduler 回执，事务内按 dedupKey 去重；appendEvent 不允许 scheduler kind。
  // review-converge-notice-write.ts：后续节点未建成的 PM 通知发出后，调度身份经 scheduler-converge-notice 记一条 informed（state-protection-F2）；
  //   事务内先核租约，再核本卡本轮 head 的降级事件，按原 dedupKey 去重，不推阶段（调度器读连接只读）
  // lend-fix-start.ts：修复单起点（i28-FB1）在挂池事务里记起点更新 / 报警 / 重挂事件，不推阶段
  // recovery-policy.ts：恢复策略（dispatch-recovery-CFG）的审计 / 已生效 / 作废 note 在自己的事务里核权限后写，不推阶段
  // lend-pr-takeover-refusal-diagnostic.ts：锁内复核当前阻塞，只经 uiDeliverPort.observe 写去重诊断，不推阶段或改接管业务表
  // manual-merge-queue.ts：人工合并排队（MQ1）的请求 / 撤销 decision 与占槽 scheduler 事件在自己的事务里核权限、重判轮转后写，不推阶段
  // recovery-machine-policy.ts：整机恢复策略（LCFG1W）的审计在自己的事务里核 owner / master 后写，已生效 / 作废 note 复用 recovery-policy.ts，不推阶段
  // agent-lifecycle-store.ts：卡 worker 登记 / 收回（LIFE1）在自己的事务里写 worker_agents 与一条 scheduler 事件，不推阶段
  // scheduler-spec-wait-ledger.ts：缺规格提醒（PMWAKE）只经 ledger CLI 调度身份写 spec_wait 事件，事务内重算门与 feature PM、按次去重，不推阶段
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
    expect(tx.sort()).toEqual(["lib/agent-lifecycle-store.ts", "lib/fix-strategy-lifecycle.ts", "lib/fix-strategy-remote-deliver.ts", "lib/fix-strategy-remote-order.ts", "lib/fix-strategy-remote.ts",
      "lib/fix-strategy-session.ts", "lib/ledger-autostart-resume.ts",
      "lib/ledger-autostart-step.ts", "lib/ledger-autostart.ts", "lib/ledger-dag-write.ts", "lib/ledger-deps-write.ts",
      "lib/ledger-feature-deps-write.ts", "lib/ledger-feature-split.ts", "lib/ledger-feature-write.ts",
      "lib/ledger-human.ts", "lib/ledger-lend-peers.ts", "lib/ledger-lend-queue.ts", "lib/ledger-lend-relay.ts",
      "lib/ledger-lend-result.ts", "lib/ledger-lend.ts", "lib/ledger-scheduler-lease-finished.ts", "lib/ledger-scheduler-pool.ts",
      "lib/ledger-scheduler-resume.ts", "lib/ledger-scheduler-settle.ts", "lib/ledger-scheduler-write.ts", "lib/ledger-steps-write.ts", "lib/ledger-write.ts",
      "lib/lend-arbiter-result.ts", "lib/lend-ask-auth.ts", "lib/lend-fix-reassign-pr.ts", "lib/lend-fix-reassign-start.ts",
      "lib/lend-fix-reassign-tick.ts", "lib/lend-fix-start.ts", "lib/lend-pr-takeover-ledger.ts",
      "lib/lend-pr-takeover-refusal-diagnostic.ts", "lib/lend-reclaim-scheduler.ts",
      "lib/manual-merge-queue.ts", "lib/memory-retrieve-order.ts", "lib/order-gate-heads.ts", "lib/order-mark.ts",
      "lib/recovery-machine-policy.ts", "lib/recovery-policy.ts",
      "lib/review-arbiter-deliver.ts", "lib/review-arbiter-runtime.ts", "lib/review-converge-followup.ts", "lib/review-converge-notice-write.ts",
      "lib/scheduler-apply.ts", "lib/scheduler-deploy.ts", "lib/scheduler-fallback.ts", "lib/scheduler-merge-conflict.ts", "lib/scheduler-merge-handoff.ts",
      "lib/scheduler-merge-train-hold.ts", "lib/scheduler-merge.ts",
      "lib/scheduler-observe.ts",
      "lib/scheduler-recovery-write.ts", "lib/scheduler-sessions.ts", "lib/scheduler-spec-wait-ledger.ts", "lib/scheduler-ui-carry.ts", "lib/scheduler-ui-review-carry.ts",
      "lib/shared-ledger-center-replica-write.ts"]);
    expect(move.sort()).toEqual(["lib/ledger-autostart-step.ts", "lib/ledger-human.ts", "lib/scheduler-apply.ts", "lib/scheduler-spec-resume-write.ts"]);
  });
});
