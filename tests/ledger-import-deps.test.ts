/** 一次性导入脚本 scripts/ledger-import-deps.ts 的纯规划：跳过缺任务的边、默认不存 state、--keep-state、dedupKey、CLI 参数 */
import { describe, expect, test } from "bun:test";
import { depAddArgs, planDepImport } from "../scripts/ledger-import-deps.js";

/** deps.json 的形状（节选自 PM 09-28 手写的那份） */
const JSON_FIXTURE = {
  _note: "PM 手填",
  edges: [
    { from: "T7", to: "T13a", when: "N7 合并（主回合判忙、统一打断闸）", state: "done" },
    { from: "T13a", to: "T11a", when: "T13a 定死 waitForIdle，答复才能「不打断」", state: "active" },
    { from: "T11a", to: "T11b", when: "待你处理第一版上线、owner 用过", state: "waiting" },
    { from: "release-v2.32.0", to: "owner", when: "发版要 owner 点头", state: "waiting" },
    { from: "T12b", to: "T12d", when: "  ", state: "done" },
  ],
  branches_example: { _note: "审查分叉示例", T14: [] },
};
const TASKS = [
  { id: "T7", kind: "code" as const, stage: "verified" as const },
  { id: "T13a", kind: "code" as const, stage: "review" as const },
  { id: "T11a", kind: "code" as const, stage: "build" as const },
  { id: "T11b", kind: "code" as const, stage: "spec" as const },
  { id: "T12b", kind: "code" as const, stage: "live" as const },
  { id: "T12d", kind: "code" as const, stage: "build" as const },
];

describe("planDepImport", () => {
  test("缺任务 / 没条件的边跳过并给原因；branches_example 列为不导；默认不存 state，推导值照算", () => {
    const plan = planDepImport(JSON_FIXTURE, TASKS);
    expect(plan.add.map((d) => [d.from, d.to, d.kind, d.state, d.jsonState, d.derived])).toEqual([
      ["T7", "T13a", "blocks", null, "done", "done"],
      ["T13a", "T11a", "blocks", null, "active", "active"],
      ["T11a", "T11b", "blocks", null, "waiting", "waiting"],
    ]);
    expect(plan.skipped).toEqual([
      { from: "release-v2.32.0", to: "owner", reason: "台账里没有任务 release-v2.32.0、owner" },
      { from: "T12b", to: "T12d", reason: "没有条件" },
    ]);
    expect(plan.ignored).toEqual(["branches_example"]);
  });

  test("--keep-state 把 json 的 state 存成手动值；坏的 state 跳过；没有 edges 直接报错", () => {
    const plan = planDepImport({ edges: [JSON_FIXTURE.edges[0], { from: "T7", to: "T11a", when: "x", state: "maybe" }] }, TASKS, { keepState: true });
    expect(plan.add.map((d) => d.state)).toEqual(["done"]);
    expect(plan.skipped[0].reason).toContain("state 不认识");
    expect(() => planDepImport({}, TASKS)).toThrow("edges");
  });

  test("CLI 参数：带 kind 与 dedupKey，只有手动值时才带 --state", () => {
    const [a] = planDepImport(JSON_FIXTURE, TASKS).add;
    expect(depAddArgs(a)).toEqual(["ledger", "dep-add", "T7", "T13a", "--when", "N7 合并（主回合判忙、统一打断闸）", "--kind", "blocks", "--dedup", "deps-json:T7>T13a"]);
    expect(depAddArgs({ ...a, state: "done" })).toContain("--state");
  });
});
