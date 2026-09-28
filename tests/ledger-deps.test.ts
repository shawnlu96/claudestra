/** 台账依赖边：纯推导（src/lib/ledger-deps.ts）、写入与权限 / 环 / CAS（ledger-deps-write.ts）、负责人类型联动（ledger-checks.ts resolveAssignee） */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { addDep, removeDep, setDep } from "../src/lib/ledger-deps-write.js";
import { blockedBy, depViews, derivedState, findPath, isSatisfied, reviewBranches, runnableTasks, type LedgerDep } from "../src/lib/ledger-deps.js";
import type { LedgerTask, Stage, TaskKind } from "../src/lib/ledger-stages.js";
import { closeLedger, getDep, getTask, LedgerError, listDeps, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, moveStage, renameAgentRefs, setMeta, setTask } from "../src/lib/ledger-write.js";

const P = "claude-orchestrator";
const PM = { actor: "agent-claudestra", now: 10 };
const EXE = { actor: "agent-task-t8h", now: 10 };
const OWNER = { actor: "owner", now: 10 };

function errOf(fn: () => unknown): LedgerError {
  try {
    fn();
  } catch (e) {
    if (e instanceof LedgerError) return e;
    throw e;
  }
  throw new Error("expected LedgerError");
}

const t = (id: string, stage: Stage, kind: TaskKind = "code") => ({ id, stage, kind });
const dep = (from: string, to: string, over: Partial<LedgerDep> = {}): LedgerDep => ({
  project: P, from, to, kind: "blocks", when: "x", state: null, rev: 1, createdBy: "owner", createdAt: 0, updatedAt: 0, ...over,
});

describe("推导（纯函数）", () => {
  test("满足：code / ops 从 merge 起，investigate 只认 done；cancelled 不算", () => {
    const code: [Stage, boolean][] = [["review", false], ["merge", true], ["live", true], ["verified", true], ["done", true], ["cancelled", false], ["blocked", false]];
    for (const [s, ok] of code) expect([s, isSatisfied(t("a", s))]).toEqual([s, ok]);
    expect(isSatisfied(t("a", "merge", "ops"))).toBe(true);
    expect(isSatisfied(t("a", "review", "investigate"))).toBe(false);
    expect(isSatisfied(t("a", "done", "investigate"))).toBe(true);
  });

  test("blocks：满足 → done，前置在 review → active，其余 waiting；branch：满足 → active，否则 waiting；前置不存在 → waiting", () => {
    expect(derivedState("blocks", t("a", "merge"))).toBe("done");
    expect(derivedState("blocks", t("a", "review"))).toBe("active");
    expect(derivedState("blocks", t("a", "build"))).toBe("waiting");
    expect(derivedState("branch", t("a", "live"))).toBe("active");
    expect(derivedState("branch", t("a", "review"))).toBe("waiting");
    expect(derivedState("blocks", undefined)).toBe("waiting");
  });

  test("手动值优先于推导；前置取消时标 fromCancelled", () => {
    const tasks = [t("A", "build"), t("B", "spec"), t("C", "cancelled")];
    const v = depViews([dep("A", "B", { state: "done" }), dep("C", "B")], tasks);
    expect(v.map((d) => [d.derived, d.effective, d.fromCancelled])).toEqual([["waiting", "done", false], ["waiting", "waiting", true]]);
  });

  test("blockedBy / runnableTasks：blocks 全到 done 才放行；有 branch 进边时至少选中一条；终态任务不算可执行", () => {
    const tasks = [t("A", "done"), t("B", "build"), t("C", "spec"), t("D", "spec"), t("E", "spec"), t("F", "done")];
    const views = depViews([
      dep("A", "C"), // A done → 满足
      dep("B", "D"), // B 还在 build → 挡 D
      dep("A", "E", { kind: "branch" }), // 分叉到了但没人选 → 挡 E
      dep("B", "E", { kind: "branch" }),
    ], tasks);
    expect(blockedBy("C", views)).toEqual([]);
    expect(blockedBy("D", views).map((d) => d.from)).toEqual(["B"]);
    expect(blockedBy("E", views).map((d) => d.from)).toEqual(["A", "B"]);
    expect(runnableTasks(tasks, views).map((x) => x.id)).toEqual(["B", "C"]);
    const chosen = depViews([dep("A", "E", { kind: "branch", state: "done" }), dep("B", "E", { kind: "branch" })], tasks);
    expect(blockedBy("E", chosen)).toEqual([]);
  });

  test("findPath：沿出边找路径，含两端；走不到为 null；有环的图不死循环", () => {
    const edges = [{ from: "A", to: "B" }, { from: "B", to: "C" }, { from: "C", to: "A" }, { from: "C", to: "D" }];
    expect(findPath(edges, "A", "D")).toEqual(["A", "B", "C", "D"]);
    expect(findPath(edges, "D", "A")).toBeNull();
    expect(findPath(edges, "B", "B")).toEqual(["B"]);
  });

  test("reviewBranches：investigate 通过去 done，其余 merge；只认本轮的结论", () => {
    expect(reviewBranches({ kind: "code", round: 2 }, { round: 2, verdict: "pass" })).toEqual({ pass: "merge", changes: "fix", taken: "pass" });
    expect(reviewBranches({ kind: "investigate", round: 1 }, { round: 1, verdict: "block" })).toEqual({ pass: "done", changes: "fix", taken: "changes" });
    expect(reviewBranches({ kind: "code", round: 2 }, { round: 1, verdict: "changes" }).taken).toBeNull();
    expect(reviewBranches({ kind: "code", round: 0 }, null).taken).toBeNull();
  });
});

let db: Database;

beforeEach(() => {
  db = openLedger(":memory:");
  setMeta(db, OWNER, { project: P, key: "pms", value: ["agent-claudestra"] });
  for (const id of ["A", "B", "C"]) createTask(db, PM, { project: P, id, title: id, kind: "code", agent: "agent-task-t8h" });
  createTask(db, OWNER, { project: "other", id: "X", title: "别的项目", kind: "code" });
});
afterEach(() => closeLedger(":memory:"));

describe("写入：加 / 改 / 删", () => {
  test("加边：默认 blocks、条件去首尾空白、createdBy 记 actor；同一事务追加 dep 事件（target = 后续任务）", () => {
    const r = addDep(db, PM, { from: "A", to: "B", when: "  A 合并后 " });
    expect(r.row).toMatchObject({ project: P, from: "A", to: "B", kind: "blocks", when: "A 合并后", state: null, rev: 1, createdBy: "agent-claudestra" });
    const ev = listEvents(db, { target: "B" }).at(-1)!;
    expect(ev).toMatchObject({ kind: "dep", actor: "agent-claudestra", data: { op: "add", from: "A", to: "B", kind: "blocks" } });
  });

  test("改边带 rev CAS：state 可清回推导；只能改 kind / when / state；删边后事件留痕", () => {
    addDep(db, PM, { from: "A", to: "B", when: "c" });
    expect(setDep(db, PM, { from: "A", to: "B", rev: 1, patch: { state: "done", kind: "branch" } }).row).toMatchObject({ state: "done", kind: "branch", rev: 2 });
    expect(errOf(() => setDep(db, PM, { from: "A", to: "B", rev: 1, patch: { state: null } }))).toMatchObject({ code: "conflict", current: { rev: 2 } });
    expect(setDep(db, PM, { from: "A", to: "B", rev: 2, patch: { state: null } }).row?.state).toBeNull();
    expect(errOf(() => setDep(db, PM, { from: "A", to: "B", rev: 3, patch: { from: "C" } as never })).code).toBe("invalid");
    expect(errOf(() => removeDep(db, PM, { from: "A", to: "B", rev: 1 })).code).toBe("conflict");
    removeDep(db, PM, { from: "A", to: "B" });
    expect(getDep(db, "A", "B")).toBeNull();
    expect(listEvents(db, { target: "B" }).filter((e) => e.kind === "dep").map((e) => e.data.op)).toEqual(["add", "set", "set", "rm"]);
    expect(errOf(() => removeDep(db, PM, { from: "A", to: "B" })).code).toBe("not_found");
  });

  test("校验：条件必填且 ≤ 60 字、kind / state 枚举、自环、重复边、不存在的任务、跨项目", () => {
    expect(errOf(() => addDep(db, PM, { from: "A", to: "B", when: " " })).code).toBe("invalid");
    expect(errOf(() => addDep(db, PM, { from: "A", to: "B", when: "字".repeat(61) })).code).toBe("invalid");
    expect(addDep(db, PM, { from: "A", to: "B", when: "字".repeat(60) }).row?.when).toHaveLength(60);
    expect(errOf(() => addDep(db, PM, { from: "B", to: "C", when: "x", kind: "soft" as never })).code).toBe("invalid");
    expect(errOf(() => addDep(db, PM, { from: "B", to: "C", when: "x", state: "maybe" as never })).code).toBe("invalid");
    expect(errOf(() => addDep(db, PM, { from: "A", to: "A", when: "x" })).code).toBe("invalid");
    expect(errOf(() => addDep(db, PM, { from: "A", to: "B", when: "x" })).code).toBe("conflict");
    expect(errOf(() => addDep(db, PM, { from: "A", to: "Z", when: "x" })).code).toBe("not_found");
    expect(errOf(() => addDep(db, OWNER, { from: "A", to: "X", when: "x" })).code).toBe("invalid");
    expect(listDeps(db, P)).toHaveLength(1);
  });

  test("环：直接回边与多跳回边都拒绝，报错带环路径，库不变", () => {
    addDep(db, PM, { from: "A", to: "B", when: "x" });
    addDep(db, PM, { from: "B", to: "C", when: "x", kind: "branch" });
    expect(errOf(() => addDep(db, PM, { from: "B", to: "A", when: "x" })).current).toEqual({ cycle: ["B", "A", "B"] });
    const e = errOf(() => addDep(db, PM, { from: "C", to: "A", when: "x" }));
    expect([e.code, e.current]).toEqual(["invalid", { cycle: ["C", "A", "B", "C"] }]);
    expect(listDeps(db, P)).toHaveLength(2);
  });

  test("权限：执行者 / 陌生 agent 加改删都 forbidden；master / owner 不在名单也行", () => {
    expect(errOf(() => addDep(db, EXE, { from: "A", to: "B", when: "x" })).code).toBe("forbidden");
    expect(errOf(() => addDep(db, { actor: "agent-stranger" }, { from: "A", to: "B", when: "x" })).code).toBe("forbidden");
    addDep(db, { actor: "master" }, { from: "A", to: "B", when: "x" });
    expect(errOf(() => setDep(db, EXE, { from: "A", to: "B", rev: 1, patch: { state: "done" } })).code).toBe("forbidden");
    expect(errOf(() => removeDep(db, EXE, { from: "A", to: "B" })).code).toBe("forbidden");
    expect(setDep(db, OWNER, { from: "A", to: "B", rev: 1, patch: { state: "done" } }).row?.state).toBe("done");
  });

  test("dedupKey：同 key 重复加边返回原事件、不重复写；推阶段后边的推导状态跟着变", () => {
    const a = addDep(db, { ...PM, dedupKey: "deps-json:A>B" }, { from: "A", to: "B", when: "x" });
    const b = addDep(db, { ...PM, dedupKey: "deps-json:A>B" }, { from: "A", to: "B", when: "x" });
    expect([b.duplicate, b.event.seq]).toEqual([true, a.event.seq]);
    const derived = () => depViews(listDeps(db, P), [getTask(db, "A")!])[0].derived;
    expect(derived()).toBe("waiting");
    moveStage(db, EXE, { taskId: "A", from: "spec", to: "restate" });
    moveStage(db, PM, { taskId: "A", from: "restate", to: "build" });
    moveStage(db, EXE, { taskId: "A", from: "build", to: "review" });
    expect(derived()).toBe("active");
    moveStage(db, PM, { taskId: "A", from: "review", to: "merge" });
    expect(derived()).toBe("done");
  });
});

describe("负责人类型", () => {
  const who = (id: string) => {
    const x = getTask(db, id) as LedgerTask;
    return [x.agent, x.assigneeKind, x.assignee];
  };

  test("建任务带 agent → assigneeKind=agent；带 human / peer_agent → agent 为空（本机没有执行者身份）", () => {
    expect(who("A")).toEqual(["agent-task-t8h", "agent", "agent-task-t8h"]);
    createTask(db, PM, { project: P, id: "R", title: "发版", kind: "ops", assigneeKind: "human", assignee: "owner" });
    expect(who("R")).toEqual([null, "human", "owner"]);
    createTask(db, PM, { project: P, id: "S", title: "对面", kind: "code", assigneeKind: "peer_agent", assignee: "future_data@ahh" });
    expect(who("S")).toEqual([null, "peer_agent", "future_data@ahh"]);
    createTask(db, PM, { project: P, id: "U", title: "未派", kind: "code" });
    expect(who("U")).toEqual([null, null, null]);
  });

  test("改负责人：只有 PM 能改；换到 agent 同步 agent 列；清空三列都空；与 agent 同时改报 invalid；格式校验", () => {
    const rev = () => (getTask(db, "A") as LedgerTask).rev;
    expect(errOf(() => setTask(db, EXE, { id: "A", rev: rev(), patch: { assigneeKind: "human", assignee: "owner" } })).code).toBe("forbidden");
    setTask(db, PM, { id: "A", rev: rev(), patch: { assigneeKind: "human", assignee: "owner" } });
    expect(who("A")).toEqual([null, "human", "owner"]);
    setTask(db, PM, { id: "A", rev: rev(), patch: { assigneeKind: "agent", assignee: "agent-x" } });
    expect(who("A")).toEqual(["agent-x", "agent", "agent-x"]);
    setTask(db, PM, { id: "A", rev: rev(), patch: { agent: null } });
    expect(who("A")).toEqual([null, null, null]);
    const bad: Record<string, unknown>[] = [
      { agent: "agent-y", assignee: "agent-y" },
      { assigneeKind: "robot", assignee: "r" },
      { assigneeKind: "peer_agent", assignee: "no-at-sign" },
      { assigneeKind: "human", assignee: "has space" },
      { assigneeKind: "human" },
    ];
    for (const patch of bad) expect([patch, errOf(() => setTask(db, PM, { id: "A", rev: rev(), patch: patch as never })).code]).toEqual([patch, "invalid"]);
  });

  test("改名钩子：kind=agent 的 assignee 跟着 agent 一起改", () => {
    renameAgentRefs(db, OWNER, "agent-task-t8h", "agent-t8h-new");
    expect(who("B")).toEqual(["agent-t8h-new", "agent", "agent-t8h-new"]);
  });
});
