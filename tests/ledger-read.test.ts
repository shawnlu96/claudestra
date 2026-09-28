/**
 * lib/ledger-read.ts：bridge 的只读连接、网页视图、每秒 data_version 变更检测。
 * 库一律是临时目录里的真实文件（WAL、跨连接 data_version 只有文件库才有意义），写入走 T8a 的写入层。
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, renameSync } from "node:fs";
import { taskMetrics } from "../src/lib/ledger-metrics.js";
import { activeTasksByAgent, LedgerReader, ledgerFeedTicker, PROJECT_EVENTS_LIMIT, projectView, taskDetail } from "../src/lib/ledger-read.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { addDep } from "../src/lib/ledger-deps-write.js";
import { appendEvent, createItem, createTask, importTask, moveStage, recordReview } from "../src/lib/ledger-write.js";
import { ledgerScript, runLedgerScript, seedLedger, tempLedgerPath } from "./ledger-test-helpers.js";

function withWriter<T>(path: string, fn: (db: Database) => T): T {
  try {
    return fn(openLedger(path));
  } finally {
    closeLedger(path);
  }
}

function moveAside(path: string): void {
  for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) renameSync(f, `${f}.old`);
}

function feed(path: string) {
  const reader = new LedgerReader(path);
  const emitted: string[] = [];
  const logs: string[] = [];
  const tick = ledgerFeedTicker({ reader, emit: (p) => emitted.push(p), log: (m) => logs.push(m) });
  return { reader, emitted, logs, tick };
}

describe("LedgerReader", () => {
  test("库不存在 → null，而且不会建出空库文件", () => {
    const path = tempLedgerPath();
    const r = new LedgerReader(path);
    expect(r.get()).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  test("连接是只读的：任何写语句被 SQLite 拒绝（query_only）", () => {
    const path = tempLedgerPath();
    seedLedger(path);
    const db = new LedgerReader(path).get()!;
    expect(() => db.exec("INSERT INTO meta VALUES ('p', 'k', '\"v\"')")).toThrow(/readonly/);
    expect(() => db.exec("DELETE FROM items")).toThrow(/readonly/);
  });

  test("-wal / -shm 被删掉后照样能开（纯 readonly 在这里会 SQLITE_CANTOPEN）", async () => {
    const path = tempLedgerPath();
    // 先 checkpoint(TRUNCATE) 把 wal 并回主库再挪走这两个文件，相当于 Linux 上最后一个连接关库时把它们删掉
    await runLedgerScript(path, `seedLedger(path);\nconst c = new Database(path);\nc.exec("PRAGMA wal_checkpoint(TRUNCATE)");\nc.close();`);
    for (const f of [`${path}-wal`, `${path}-shm`]) if (existsSync(f)) renameSync(f, `${f}.aside`);
    const db = new LedgerReader(path).get()!;
    expect(projectView(db, "p", 0).items.map((i) => i.id)).toEqual(["i1"]);
  });

  test("还没建表的库（user_version 0）→ null；文件被换掉 → 自动重开、generation +1", async () => {
    const path = tempLedgerPath();
    new Database(path).close(); // 空文件：写者刚创建、还没迁移
    const r = new LedgerReader(path);
    expect(r.get()).toBeNull();
    seedLedger(path);
    const db1 = r.get()!;
    const g1 = r.generation;
    expect(db1).not.toBeNull();
    expect(r.get()).toBe(db1); // 同一个文件复用连接
    moveAside(path); // 换库：主库连同 -wal / -shm 一起挪走（只挪主库会让新库配上旧 wal，SQLite 本身就不支持）
    await runLedgerScript(path, `createItem(openLedger(path), { actor: "owner" }, { project: "z", id: "iz", title: "换过的库" });`);
    const db2 = r.get()!;
    expect(db2).not.toBe(db1);
    expect(r.generation).toBe(g1 + 1);
    expect(projectView(db2, "z", 0).items.map((i) => i.id)).toEqual(["iz"]);
  });
});

describe("视图", () => {
  const path = tempLedgerPath();
  seedLedger(path);
  const db = new LedgerReader(path).get()!;

  test("总览：事项、本项目任务（不含别的项目）、meta 冻结状态", () => {
    const v = projectView(db, "p", 1000);
    expect(v.items.map((i) => [i.id, i.ownerWords])).toEqual([["i1", "随时更新"]]);
    expect(v.tasks.map((t) => [t.id, t.stage, t.round])).toEqual([["T1", "merge", 2], ["T2", "done", 0]]);
    expect(v.meta.queueFrozen).toMatchObject({ frozen: true, reason: "等 T1 上线" });
  });

  test("每个任务的指标与 ledger-metrics 直接算的一致；lastEvent 是该任务最后一条事件", () => {
    const v = projectView(db, "p", 1000);
    const all = listEvents(db, { project: "p" });
    for (const t of v.tasks) {
      expect(t.metrics).toEqual(taskMetrics(t, all, 1000));
      expect(t.lastEvent).toEqual(all.filter((e) => e.target === t.id).at(-1)!);
    }
    expect(v.tasks[0].metrics).toMatchObject({ reviewRounds: 2, reworkCount: 1, p1: 1, p2: 3, reviewWaits: [150, 20] });
  });

  test("stageSince 是进入当前阶段的时刻；lastReview 是最近一轮审查的摘要，没审过为 null", () => {
    const [t1, t2] = projectView(db, "p", 1000).tasks;
    expect(t1.stageSince).toBe(520);
    expect(t1.lastReview).toEqual({ round: 2, verdict: "pass", p0: 0, p1: 0, p2: 1, text: "", ts: 520 });
    expect(t2.stageSince).toBe(600);
    expect(t2.lastReview).toBeNull();
  });

  test("stageSinceApprox：当前阶段由导入推断的时间开出来时为 true；之后真实推进一次就变回 false", () => {
    const p = tempLedgerPath();
    withWriter(p, (w) => {
      const imp = { actor: "import", now: 0 };
      importTask(w, imp, {
        task: { project: "p", id: "TI", title: "导入的", kind: "code", stage: "build", agent: "agent-x" },
        initialStage: "spec",
        createdTs: 50,
        events: [
          { kind: "stage", ts: 100, data: { from: "spec", to: "restate" } },
          { kind: "stage", ts: 200, data: { from: "restate", to: "build", approxTime: true } },
        ],
      });
    });
    const r = new LedgerReader(p);
    expect(projectView(r.get()!, "p", 1000).tasks[0]).toMatchObject({ stageSince: 200, stageSinceApprox: true });
    withWriter(p, (w) => moveStage(w, { actor: "owner", now: 300 }, { taskId: "TI", from: "build", to: "review" }));
    expect(projectView(r.get()!, "p", 1000).tasks[0]).toMatchObject({ stageSince: 300, stageSinceApprox: false });
  });

  test("blocked 往返：stageSince 取回到原阶段的时刻，不是第一次进入的时刻", () => {
    const p = tempLedgerPath();
    withWriter(p, (w) => {
      createTask(w, { actor: "owner", now: 0 }, { project: "p", id: "TB", title: "受阻往返", kind: "ops", stage: "build", agent: "agent-x" });
      moveStage(w, { actor: "owner", now: 100 }, { taskId: "TB", from: "build", to: "blocked" });
      moveStage(w, { actor: "owner", now: 400 }, { taskId: "TB", from: "blocked", to: "build" });
    });
    expect(projectView(new LedgerReader(p).get()!, "p", 1000).tasks[0]).toMatchObject({ stage: "build", stageSince: 400, stageSinceApprox: false });
  });

  test("lastReview.text 只下发首行、按码点截到 120 字", () => {
    const p = tempLedgerPath();
    const long = "意".repeat(130);
    withWriter(p, (w) => {
      createTask(w, { actor: "owner", now: 0 }, { project: "p", id: "TR", title: "审查", kind: "code", stage: "review", agent: "agent-x" });
      recordReview(w, { actor: "owner", now: 10 }, { taskId: "TR", reviewer: "r", verdict: "changes", p0: 0, p1: 1, p2: 0, text: `\n${long}\n第二行细节` });
    });
    const text = projectView(new LedgerReader(p).get()!, "p", 1000).tasks[0].lastReview!.text;
    expect(text).toBe(`${"意".repeat(120)}…`);
  });

  test("项目级事件只带 target 为空的、最近 PROJECT_EVENTS_LIMIT 条、seq 升序", () => {
    const p2 = tempLedgerPath();
    withWriter(p2, (w) => {
      for (let i = 0; i < PROJECT_EVENTS_LIMIT + 5; i++) appendEvent(w, { actor: "owner", now: i }, { project: "p", target: "", kind: "note", text: `n${i}` });
      appendEvent(w, { actor: "owner" }, { project: "q", target: "", kind: "note", text: "别的项目" });
    });
    const ev = projectView(new LedgerReader(p2).get()!, "p", 0).projectEvents;
    expect(ev.length).toBe(PROJECT_EVENTS_LIMIT);
    expect(ev[0].text).toBe("n5");
    expect(ev.at(-1)!.text).toBe(`n${PROJECT_EVENTS_LIMIT + 4}`);
  });

  test("任务详情：全部事件 + 时间线；借别的项目名读不到", () => {
    const d = taskDetail(db, "p", "T1", 1000)!;
    expect(d.events.map((e) => e.kind)).toEqual(["task", "stage", "stage", "stage", "deliver", "review", "stage", "stage", "deliver", "review", "stage"]);
    expect(d.timeline.map((s) => s.stage)).toEqual(["spec", "restate", "build", "review", "fix", "review", "merge"]);
    expect(d.task.metrics).toEqual(taskMetrics(d.task, d.events, 1000));
    expect(taskDetail(db, "q", "T1", 1000)).toBeNull();
    expect(taskDetail(db, "p", "nope", 1000)).toBeNull();
  });

  test("执行中的任务按 agent 裸名索引：终态不算，同一 agent 取最近更新的", () => {
    expect([...activeTasksByAgent(db)]).toEqual([
      ["exec", { id: "T1", stage: "merge", round: 2 }],
      ["other", { id: "T3", stage: "spec", round: 0 }],
    ]);
    const p2 = tempLedgerPath();
    withWriter(p2, (w) => {
      createTask(w, { actor: "owner", now: 1 }, { project: "p", id: "A", title: "a", kind: "code", agent: "agent-x" });
      createTask(w, { actor: "owner", now: 2 }, { project: "p", id: "B", title: "b", kind: "code", agent: "agent-x" });
      moveStage(w, { actor: "agent-x", now: 3 }, { taskId: "A", from: "spec", to: "restate" });
    });
    expect(activeTasksByAgent(new LedgerReader(p2).get()!).get("x")).toEqual({ id: "A", stage: "restate", round: 0 });
  });
});

describe("依赖边视图", () => {
  const path = tempLedgerPath();
  seedLedger(path);
  const w = openLedger(path);
  const owner = { actor: "owner", now: 2000 };
  createTask(w, owner, { project: "p", id: "T4", title: "等 T1", kind: "code" });
  createTask(w, owner, { project: "p", id: "T5", title: "等 T4", kind: "code" });
  addDep(w, owner, { from: "T1", to: "T4", when: "T1 合并后" });
  addDep(w, owner, { from: "T4", to: "T5", when: "T4 合并后" });
  closeLedger(path);
  const db = new LedgerReader(path).get()!;

  test("总览带边（推导值 / 最终状态）；每个任务带 blockedBy 与 runnable；dep 事件不算 lastEvent（不盖掉进展）", () => {
    const v = projectView(db, "p", 3000);
    // T1 停在 merge：过审排队不算满足（code 要到 live），T4 仍被挡
    expect(v.deps.map((d) => [d.from, d.to, d.derived, d.effective])).toEqual([["T1", "T4", "active", "active"], ["T4", "T5", "waiting", "waiting"]]);
    expect(v.tasks.map((t) => [t.id, t.runnable, t.blockedBy])).toEqual([["T1", true, []], ["T2", false, []], ["T4", false, ["T1"]], ["T5", false, ["T4"]]]);
    expect(v.tasks.find((t) => t.id === "T5")!.lastEvent).toMatchObject({ kind: "task", data: { op: "new" } });
  });

  test("任务详情：进边 / 出边分开给；审查分叉现算", () => {
    const d = taskDetail(db, "p", "T4", 3000)!;
    expect([d.deps.in.map((x) => x.from), d.deps.out.map((x) => x.to)]).toEqual([["T1"], ["T5"]]);
    expect(d.reviewBranches).toEqual({ pass: "merge", changes: "fix", taken: null });
    expect(taskDetail(db, "p", "T5", 3000)!.events.map((e) => e.kind)).toEqual(["task", "dep"]);
  });
});

describe("ledgerFeedTicker（每秒一次的 data_version 轮询）", () => {
  test("库不存在：什么都不发、不打日志；之后出现 → 把已写的项目发一次", () => {
    const path = tempLedgerPath();
    const f = feed(path);
    for (let i = 0; i < 5; i++) f.tick();
    expect(f.emitted).toEqual([]);
    expect(f.logs).toEqual([]);
    seedLedger(path);
    f.tick();
    expect(f.emitted).toEqual(["p", "q"]);
  });

  test("启动时已有的库只记游标不发；之后每次写入发对应项目，没写就不发", () => {
    const path = tempLedgerPath();
    seedLedger(path);
    const f = feed(path);
    f.tick();
    f.tick();
    expect(f.emitted).toEqual([]);
    withWriter(path, (w) => appendEvent(w, { actor: "owner" }, { project: "q", target: "", kind: "note", text: "x" }));
    f.tick();
    f.tick();
    expect(f.emitted).toEqual(["q"]);
    withWriter(path, (w) => {
      appendEvent(w, { actor: "owner" }, { project: "p", target: "", kind: "note", text: "y" });
      appendEvent(w, { actor: "owner" }, { project: "q", target: "", kind: "note", text: "z" });
    });
    f.tick();
    expect(f.emitted).toEqual(["q", "p", "q"]);
    expect(f.logs).toEqual([]);
  });

  test("别的进程写入也能看到（data_version 跨进程）", async () => {
    const path = tempLedgerPath();
    seedLedger(path);
    const f = feed(path);
    f.tick();
    await runLedgerScript(path, `appendEvent(openLedger(path), { actor: "owner" }, { project: "p", target: "", kind: "note", text: "子进程" });`);
    f.tick();
    expect(f.emitted).toEqual(["p"]);
  });

  test("库被锁住（写者在 rollback 模式下持 EXCLUSIVE）：只报一次、不刷屏、不抛；解锁后报恢复并补发", async () => {
    const path = tempLedgerPath();
    const f = feed(path);
    f.tick(); // 库还不存在
    // 不走 openLedger（它会切 WAL）：自建一个 rollback 模式、已标 user_version 1 的最小库，持排他锁 1.5s
    const locker = ledgerScript(path, [
      `const db = new Database(path);`,
      `db.exec("PRAGMA journal_mode = DELETE");`,
      `db.exec("CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, actor TEXT, project TEXT, target TEXT, kind TEXT)");`,
      `db.exec("PRAGMA user_version = 1");`,
      `db.exec("BEGIN EXCLUSIVE");`,
      `db.exec("INSERT INTO events (ts, actor, project, target, kind) VALUES (1, 'owner', 'p', '', 'note')");`,
      `console.log("locked");`,
      `await Bun.sleep(1500);`,
      `db.exec("COMMIT");`,
    ].join("\n"));
    const reader = locker.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked");
    for (let i = 0; i < 3; i++) expect(() => f.tick()).not.toThrow();
    // 第一次撞锁必报；之后 macOS 自带的 SQLite 有时在锁未释放时就能读到（实测），所以不断言锁住期间的每一轮，只断言不刷屏
    const errors = () => f.logs.filter((l) => l.includes("台账变更检测出错"));
    expect(errors().length).toBe(1);
    expect(await locker.exited).toBe(0);
    f.tick();
    f.tick();
    expect(errors().length).toBe(1);
    expect(f.logs.at(-1)).toContain("恢复");
    expect(f.emitted).toEqual(["p"]); // 库是检测出错期间才出现的：游标从 0 起，锁住期间写入的项目发且只发一次
  });

  test("库被删掉：不报错；重建后从头发", async () => {
    const path = tempLedgerPath();
    await runLedgerScript(path, "seedLedger(path);");
    const f = feed(path);
    f.tick();
    moveAside(path);
    f.tick();
    expect(f.logs).toEqual([]);
    await runLedgerScript(path, `appendEvent(openLedger(path), { actor: "owner" }, { project: "r", target: "", kind: "note", text: "新库" });`);
    f.tick();
    expect(f.emitted).toEqual(["r"]);
  });
});
