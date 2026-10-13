/** 多个 feature 共用项目：读侧只扫一次，候选和旧逐 feature 扫描逐字一致。 */
import { expect, test, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { autoFixture } from "./scheduler-auto-helpers.js";
import { join } from "node:path";
import * as lanes from "../src/lib/dag-tools-lanes.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { activeFeatures, currentViews, featureGate, isStop, nodeCandidate, templateLabel } from "../src/lib/scheduler-autostart.js";
import { autostartSnapshot } from "../src/lib/scheduler-autostart-snapshot.js";
import * as slots from "../src/lib/scheduler-slot-hold-autostart.js";
import { autostartTick, type StartTickEnv } from "../src/lib/scheduler-autostart-run.js";

test("一次 tick 的项目 tasks 和各 feature 车道只计算一次；选中相同 claim", async () => {
  const fixture = autoFixture(), { db, dir } = fixture, project = "p", pm = "pm", now = Date.now();
  const svc = { autoDispatch: true, projects: [project], maxWorkers: () => 6, pool: () => ({ remote: null, borrow: [] }) };
  const readSpec = (id: string) => ({ mtimeMs: now - 120_000, text: id === "a-x" ? "# 规格\n自动开卡：关\n" : "# 规格\n" });
  try {
    db.prepare("UPDATE ledger_instance SET value = 'ab12' WHERE key = 'origin'").run();
    setMeta(db, { actor: "owner", now }, { project, key: "pms", value: [pm] });
    for (const slug of ["a", "b", "c"]) {
      const f = createFeature(db, { actor: pm, now }, { project, slug, title: slug }).row;
      initDag(db, { actor: pm, now }, { id: f.id, rev: 1, nodes: [{ key: "x", oneLine: "节点", fileGlobs: [`src/${slug}.ts`] }] });
    }
    // 原算法作为参照：保留排序、各道门、武装键和逐字 claim 参数。
    let expected: string[] = [];
    for (const f of activeFeatures(db, project)) {
      if (featureGate(db, f, svc)) continue;
      const l = lanes.featureLanes(db, f), views = currentViews(db, f);
      for (const key of l?.startNow ?? []) {
        const c = nodeCandidate(db, f, key, l, views, readSpec, now);
        if (isStop(c)) continue;
        expected = ["ledger", "scheduler-autostart", "claim", f.id, key, "--arm", c.arm, "--template", templateLabel(c.head.template),
          "--max-workers", "6", "--pm", pm];
        break;
      }
      if (expected.length) break;
    }
    expect(expected.slice(3, 5)).toEqual(["ab12-b", "x"]);
    let reads = 0;
    const prepare = db.prepare.bind(db);
    const spy = spyOn(db, "prepare").mockImplementation(((sql: string, ...args: any[]) => {
      if (sql === "SELECT * FROM tasks WHERE project = ? ORDER BY id") reads++;
      return prepare(sql, ...args);
    }) as typeof db.prepare);
    const laneSpy = spyOn(lanes, "featureLanes"), projectSpy = spyOn(lanes, "readLaneProject"), capacitySpy = spyOn(slots, "autostartCapacity");
    const calls: string[][] = [];
    const env: StartTickEnv = {
      db, svc, readSpec, now: () => now, memo: new Set(), attempt: () => "test",
      ledger: async (...args) => { calls.push(args); return { ok: false, code: "conflict" }; },
      quota: async () => ({ status: "unknown", source: "none", observedAt: null, plan: null, reason: "测试", windows: [] }),
      notifyPm: async () => {}, plain: async () => { throw new Error("不应开卡"); },
      startEnv: () => ({ ledgerDir: dir, worktreeRoot: dir, projectDirs: async () => [], agentNames: () => [], exists: () => false,
        branchExists: async () => false, autoReady: () => null, template: () => null }),
      stepIO: () => { throw new Error("不应执行"); },
    };
    try {
      expect(await autostartTick(env)).toEqual([]);
      expect(calls).toEqual([expected]);
      expect(reads).toBe(1);
      expect(projectSpy).toHaveBeenCalledTimes(1);
      expect(capacitySpy).toHaveBeenCalledTimes(1);
      expect(laneSpy.mock.calls.map((a) => a[1].id)).toEqual(["ab12-a", "ab12-b", "ab12-c"]);
      // 下轮规格变化立即生效，上一轮快照不应留在进程里。
      reads = 0;
      calls.length = 0;
      laneSpy.mockClear(); projectSpy.mockClear(); capacitySpy.mockClear();
      expect(await autostartTick({ ...env, readSpec: () => ({ mtimeMs: now - 120_000, text: "# 规格\n" }) })).toEqual([]);
      expect(calls[0].slice(3, 5)).toEqual(["ab12-a", "x"]);
      expect(reads).toBe(1);
      expect(capacitySpy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); laneSpy.mockRestore(); projectSpy.mockRestore(); capacitySpy.mockRestore(); }
  } finally { fixture.close(); }
});


test("同连接写、其他连接提交及显式失效都丢弃项目事实和容量", () => {
  const fixture = autoFixture(), { db, dir } = fixture;
  const other = new Database(join(dir, "ledger.sqlite"));
  let calculations = 0;
  const svc = { autoDispatch: true, projects: ["p"], maxWorkers: () => 6,
    capacity: () => { calculations++; return "满"; } };
  const snapshot = autostartSnapshot(db, svc);
  const check = () => {
    const tasks = snapshot.reads.tasks("p");
    expect(snapshot.reads.tasks("p")).toBe(tasks);
    expect(snapshot.svc.capacity!(db, "p", 6)).toBe("满");
    expect(snapshot.svc.capacity!(db, "p", 6)).toBe("满");
    return tasks;
  };
  try {
    const first = check();
    expect(calculations).toBe(1);
    db.query("UPDATE tasks SET title = '本连接写' WHERE id = 'T1'").run();
    const second = check();
    expect(second).not.toBe(first);
    expect(second[0].title).toBe("本连接写");
    expect(calculations).toBe(2);
    other.query("UPDATE tasks SET title = '其他连接写' WHERE id = 'T1'").run();
    const third = check();
    expect(third).not.toBe(second);
    expect(third[0].title).toBe("其他连接写");
    expect(calculations).toBe(3);
    snapshot.invalidate();
    expect(check()).not.toBe(third);
    expect(calculations).toBe(4);
  } finally { other.close(); fixture.close(); }
});
