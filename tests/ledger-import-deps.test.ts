/**
 * 一次性导入脚本 scripts/ledger-import-deps.ts：纯规划（缺任务 / 跨项目 / 重复 / 已有的边、默认不存 state、--keep-state、CLI 参数），
 * 以及在临时状态目录里真跑一遍：参数顺序随意、dry-run 不在库旁留文件、重跑幂等、PM 删掉的边不补回。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { depAddArgs, planDepImport } from "../scripts/ledger-import-deps.js";

const P = "claude-orchestrator";
/** deps.json 的形状（节选自 PM 09-28 手写的那份） */
const JSON_FIXTURE = {
  _note: "PM 手填",
  edges: [
    { from: "T7", to: "T13a", when: "N7 合并（主回合判忙、统一打断闸）", state: "done" },
    { from: "T13a", to: "T11a", when: "T13a 定死 waitForIdle，答复才能「不打断」", state: "active" },
    { from: "T11a", to: "T11b", when: "待你处理第一版上线、owner 用过", state: "waiting" },
    { from: "release-v2.32.0", to: "owner", when: "发版要 owner 点头", state: "waiting" },
    { from: "T12b", to: "T12d", when: "  ", state: "done" },
    { from: "T7", to: "T13a", when: "重复的一条", state: "done" },
    { from: "T7", to: "X1", when: "跨项目", state: "done" },
  ],
  branches_example: { _note: "审查分叉示例", T14: [] },
};
const task = (id: string, stage: string, project = P) => ({ id, project, kind: "code" as const, stage: stage as never });
const TASKS = [
  task("T7", "verified"), task("T13a", "review"), task("T11a", "build"), task("T11b", "spec"), task("T12b", "live"), task("T12d", "build"),
  task("X1", "spec", "other"),
];

describe("planDepImport", () => {
  test("缺任务 / 跨项目 / json 里重复 / 没条件的边跳过并给原因；branches_example 列为不导；默认不存 state，推导值照算", () => {
    const plan = planDepImport(JSON_FIXTURE, P, TASKS);
    expect(plan.add.map((d) => [d.from, d.to, d.kind, d.state, d.jsonState, d.derived])).toEqual([
      ["T7", "T13a", "blocks", null, "done", "done"],
      ["T13a", "T11a", "blocks", null, "active", "active"],
      ["T11a", "T11b", "blocks", null, "waiting", "waiting"],
    ]);
    expect(plan.skipped).toEqual([
      { from: "release-v2.32.0", to: "owner", reason: "台账里没有任务 release-v2.32.0、owner" },
      { from: "T12b", to: "T12d", reason: "没有条件" },
      { from: "T7", to: "T13a", reason: "json 里重复出现，只导第一条" },
      { from: "T7", to: "X1", reason: `跨项目：X1 在 other，依赖只能连本项目 ${P} 的任务` },
    ]);
    expect(plan.ignored).toEqual(["branches_example"]);
  });

  test("台账里已有的边跳过；blocked 的前置按 stageBefore 推", () => {
    const tasks = [...TASKS, { ...task("T9", "blocked"), stageBefore: "live" as never }, task("T10", "spec")];
    const json = { edges: [JSON_FIXTURE.edges[0], { from: "T9", to: "T10", when: "T9 上线" }] };
    const plan = planDepImport(json, P, tasks, [{ from: "T7", to: "T13a" }]);
    expect(plan.skipped.map((s) => s.reason)).toEqual(["台账里已有这条边（要改用 dep-set）"]);
    expect(plan.add.map((d) => [d.from, d.derived])).toEqual([["T9", "done"]]);
  });

  test("--keep-state 把 json 的 state 存成手动值；坏的 state 跳过；没有 edges 直接报错", () => {
    const plan = planDepImport({ edges: [JSON_FIXTURE.edges[0], { from: "T7", to: "T11a", when: "x", state: "maybe" }] }, P, TASKS, [], { keepState: true });
    expect(plan.add.map((d) => d.state)).toEqual(["done"]);
    expect(plan.skipped[0].reason).toContain("state 不认识");
    expect(() => planDepImport({}, P, TASKS)).toThrow("edges");
  });

  test("CLI 参数：带 kind 与 dedupKey，只有手动值时才带 --state", () => {
    const [a] = planDepImport(JSON_FIXTURE, P, TASKS).add;
    expect(depAddArgs(a)).toEqual(["ledger", "dep-add", "T7", "T13a", "--when", "N7 合并（主回合判忙、统一打断闸）", "--kind", "blocks", "--dedup", "deps-json:T7>T13a"]);
    expect(depAddArgs({ ...a, state: "done" })).toContain("--state");
  });
});

describe("在临时状态目录里真跑", () => {
  const SCRIPT = resolve(import.meta.dir, "../scripts/ledger-import-deps.ts");

  function run(dir: string, ...args: string[]): { code: number; out: string } {
    const env: Record<string, string> = { ...(process.env as Record<string, string>), CLAUDESTRA_STATE_DIR: dir };
    delete env.DISCORD_CHANNEL_ID; // 终端身份 = owner；别让跑测试的 agent 的频道号把身份带成它自己
    const p = Bun.spawnSync([process.execPath, SCRIPT, ...args], { env, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode ?? -1, out: p.stdout.toString() + p.stderr.toString() };
  }

  /** 库操作放子进程：本进程里开过的连接会记住 -shm 的 inode，删掉 -wal / -shm 后再开会 disk I/O error */
  function sub(path: string, body: string): string {
    const lib = (f: string) => JSON.stringify(resolve(import.meta.dir, `../src/lib/${f}`));
    const code = [
      `const { openLedger, closeLedger, listDeps, getDep } = await import(${lib("ledger-store.ts")});`,
      `const { createTask, setMeta } = await import(${lib("ledger-write.ts")});`,
      `const { removeDep } = await import(${lib("ledger-deps-write.ts")});`,
      `const path = ${JSON.stringify(path)}; const P = ${JSON.stringify(P)}; const db = openLedger(path);`,
      body,
      "closeLedger(path);",
    ].join("\n");
    const p = Bun.spawnSync([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(p.stderr.toString());
    return p.stdout.toString().trim();
  }

  test("--project 写在文件前也行；dry-run 不在库旁留 -wal / -shm；导入、重跑幂等、PM 删掉的边不补回", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-import-deps-"));
    try {
      writeFileSync(join(dir, "projects.json"), JSON.stringify({ projects: [{ id: P, name: "C", dirs: [] }] }));
      const path = join(dir, "ledger.sqlite");
      const ids = TASKS.filter((x) => x.project === P).map((x) => x.id);
      sub(path, `setMeta(db, { actor: "owner" }, { project: P, key: "pms", value: ["agent-claudestra"] });
        for (const id of ${JSON.stringify(ids)}) createTask(db, { actor: "owner" }, { project: P, id, title: id, kind: "code" });
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");`);
      // 本进程从没开过这个库，删掉检查点后的 -wal / -shm 是安全的：模拟「库旁没有这两个文件」的初始状态
      for (const f of ["-wal", "-shm"]) rmSync(path + f, { force: true });
      const json = join(dir, "deps.json");
      writeFileSync(json, JSON.stringify(JSON_FIXTURE));

      const dry = run(dir, "--project", P, json, "--dry-run");
      expect([dry.code, dry.out.includes("要导 3 条")]).toEqual([0, true]);
      expect([existsSync(`${path}-wal`), existsSync(`${path}-shm`)]).toEqual([false, false]);

      expect(run(dir, json, "--project", P).code).toBe(0);
      const again = run(dir, json, "--project", P);
      expect([again.code, again.out.includes("要导 0 条")]).toEqual([0, true]);

      expect(sub(path, `console.log(listDeps(db, P).length); removeDep(db, { actor: "owner" }, { from: "T7", to: "T13a" });`)).toBe("3");
      const third = run(dir, json, "--project", P);
      expect([third.code, third.out.includes("曾导入、后来被删，不补回")]).toEqual([0, true]);
      expect(sub(path, `console.log(getDep(db, "T7", "T13a") === null);`)).toBe("true");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("参数错：缺 --project、多余位置参数、未知旗标都给用法、退出码 2", () => {
    expect(run(tmpdir(), "a.json").code).toBe(2);
    expect(run(tmpdir(), "a.json", "b.json", "--project", P).code).toBe(2);
    expect(run(tmpdir(), "a.json", "--project", P, "--nope").code).toBe(2);
  });
});
