/** 台账写入（src/lib/ledger-write.ts）：改行与事件同事务、rev / from CAS、dedupKey 幂等、阶段角色、round / specRev、项目级写入 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeLedger, getItem, getMeta, getTask, LedgerError, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { appendEvent, createItem, createTask, deliver, importTask, moveStage, recordReview, renameAgentRefs, setFrozen, setItem, setMeta, setTask } from "../src/lib/ledger-write.js";
import { taskMetrics } from "../src/lib/ledger-metrics.js";

const P = "claude-orchestrator";
const PM = { actor: "agent-claudestra" };
const EXE = { actor: "agent-task-t8a" };
const OWNER = { actor: "owner" };
let db: Database;

function errOf(fn: () => unknown): LedgerError {
  try {
    fn();
  } catch (e) {
    if (e instanceof LedgerError) return e;
    throw e;
  }
  throw new Error("expected LedgerError");
}

function events(target = "T8a") {
  return listEvents(db, { project: P, target });
}

beforeEach(() => {
  db = openLedger(":memory:");
  setMeta(db, OWNER, { project: P, key: "pms", value: ["agent-claudestra"] });
  createItem(db, PM, { project: P, id: "i10", title: "台账内置", status: "doing" });
  createTask(db, PM, { project: P, id: "T8a", itemId: "i10", title: "纯库", kind: "code", agent: "agent-task-t8a", pm: "agent-claudestra" });
});
afterEach(() => closeLedger(":memory:"));

describe("事项与任务字段（rev CAS）", () => {
  test("建事项 / 任务各追加一条事件；新任务默认 spec、round 0、specRev 1、rev 1", () => {
    expect(getTask(db, "T8a")).toMatchObject({ stage: "spec", round: 0, specRev: 1, rev: 1, itemId: "i10" });
    expect(events("i10").map((e) => [e.kind, e.data.op])).toEqual([["item", "new"]]);
    expect(events().map((e) => [e.kind, e.data.op])).toEqual([["task", "new"]]);
  });
  test("setItem / setTask 带对 rev 才写，rev+1 且事件记 patch 与新 rev；带错 rev 报 conflict、库不变", () => {
    const r = setItem(db, PM, { project: P, id: "i10", rev: 1, patch: { next: "派 T8b", extra: { a: 1 } } });
    expect(r.row).toMatchObject({ rev: 2, next: "派 T8b", extra: { a: 1 } });
    expect(r.event.data).toEqual({ op: "set", patch: { next: "派 T8b", extra: { a: 1 } }, rev: 2 });
    const e = errOf(() => setItem(db, PM, { project: P, id: "i10", rev: 1, patch: { next: "x" } }));
    expect(e.code).toBe("conflict");
    expect(e.current).toEqual({ rev: 2 });
    expect(getItem(db, P, "i10")?.next).toBe("派 T8b");

    expect(setTask(db, EXE, { id: "T8a", rev: 1, patch: { branch: "task/t8a-ledger-lib" } }).row.rev).toBe(2);
    expect(errOf(() => setTask(db, EXE, { id: "T8a", rev: 1, patch: { pr: "#130" } })).code).toBe("conflict");
    expect(events().filter((e) => e.kind === "task")).toHaveLength(2);
  });
  test("setTask 不能改 stage / round / kind；事项状态必须在枚举里；挂不存在的事项报 not_found", () => {
    expect(errOf(() => setTask(db, PM, { id: "T8a", rev: 1, patch: { stage: "done" } as never })).code).toBe("invalid");
    expect(errOf(() => setItem(db, PM, { project: P, id: "i10", rev: 1, patch: { status: "wip" as never } })).code).toBe("invalid");
    expect(errOf(() => setTask(db, PM, { id: "T8a", rev: 1, patch: { itemId: "i99" } })).code).toBe("not_found");
    expect(errOf(() => createTask(db, PM, { project: P, id: "T8a", title: "重复", kind: "code" })).code).toBe("conflict");
    expect(getTask(db, "T8a")?.rev).toBe(1);
  });
});

describe("moveStage", () => {
  test("from 不符报 conflict 并带当前阶段，不追加事件", () => {
    const e = errOf(() => moveStage(db, PM, { taskId: "T8a", from: "build", to: "review" }));
    expect(e.code).toBe("conflict");
    expect(e.current).toMatchObject({ stage: "spec" });
    expect(events()).toHaveLength(1);
  });
  test("执行者只能推 spec→restate、build/fix→review；越权 forbidden；陌生 agent forbidden", () => {
    moveStage(db, EXE, { taskId: "T8a", from: "spec", to: "restate" });
    expect(errOf(() => moveStage(db, EXE, { taskId: "T8a", from: "restate", to: "build" })).code).toBe("forbidden");
    moveStage(db, PM, { taskId: "T8a", from: "restate", to: "build" });
    moveStage(db, EXE, { taskId: "T8a", from: "build", to: "review" });
    expect(errOf(() => moveStage(db, EXE, { taskId: "T8a", from: "review", to: "merge" })).code).toBe("forbidden");
    expect(errOf(() => moveStage(db, EXE, { taskId: "T8a", from: "review", to: "blocked" })).code).toBe("forbidden");
    expect(errOf(() => moveStage(db, { actor: "agent-task-t4" }, { taskId: "T8a", from: "review", to: "fix" })).code).toBe("forbidden");
    moveStage(db, PM, { taskId: "T8a", from: "review", to: "fix" });
    moveStage(db, EXE, { taskId: "T8a", from: "fix", to: "review" });
    expect(getTask(db, "T8a")).toMatchObject({ stage: "review", round: 2 });
  });
  test("非法跳转报 invalid；master 不在 PM 名单也能推", () => {
    expect(errOf(() => moveStage(db, PM, { taskId: "T8a", from: "spec", to: "merge" })).code).toBe("invalid");
    expect(moveStage(db, { actor: "master" }, { taskId: "T8a", from: "spec", to: "restate" }).row.stage).toBe("restate");
  });
  test("code 全流程：merge→review 与 live→fix→review 接着数 round；review→spec 让 specRev+1；事件一步一条", () => {
    const path: [string, string, string][] = [
      ["spec", "restate", EXE.actor], ["restate", "build", PM.actor], ["build", "review", EXE.actor], ["review", "spec", PM.actor],
      ["spec", "restate", EXE.actor], ["restate", "build", PM.actor], ["build", "review", EXE.actor], ["review", "merge", PM.actor],
      ["merge", "review", PM.actor], ["review", "merge", PM.actor], ["merge", "live", PM.actor], ["live", "fix", PM.actor],
      ["fix", "review", EXE.actor], ["review", "merge", PM.actor], ["merge", "live", PM.actor], ["live", "verified", PM.actor],
      ["verified", "done", PM.actor],
    ];
    for (const [from, to, actor] of path) moveStage(db, { actor }, { taskId: "T8a", from: from as never, to: to as never });
    expect(getTask(db, "T8a")).toMatchObject({ stage: "done", round: 4, specRev: 2 });
    const stages = events().filter((e) => e.kind === "stage");
    expect(stages).toHaveLength(path.length);
    expect(stages.map((e) => e.data.round)).toEqual([0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 4]);
    expect(errOf(() => moveStage(db, OWNER, { taskId: "T8a", from: "done", to: "blocked" })).code).toBe("invalid");
  });
  test("blocked 记 stageBefore，只能回原阶段，回来不加 round", () => {
    moveStage(db, EXE, { taskId: "T8a", from: "spec", to: "restate" });
    moveStage(db, PM, { taskId: "T8a", from: "restate", to: "build" });
    moveStage(db, EXE, { taskId: "T8a", from: "build", to: "review" });
    moveStage(db, PM, { taskId: "T8a", from: "review", to: "blocked", text: "等 owner" });
    expect(getTask(db, "T8a")).toMatchObject({ stage: "blocked", stageBefore: "review", round: 1 });
    expect(errOf(() => moveStage(db, PM, { taskId: "T8a", from: "blocked", to: "fix" })).code).toBe("invalid");
    moveStage(db, PM, { taskId: "T8a", from: "blocked", to: "review" });
    expect(getTask(db, "T8a")).toMatchObject({ stage: "review", stageBefore: null, round: 1 });
  });
});

describe("dedupKey 幂等", () => {
  test("同 key 重复推阶段：返回原事件与当前行、duplicate，不重复记、不再校验 from", () => {
    const a = moveStage(db, { ...EXE, dedupKey: "k1" }, { taskId: "T8a", from: "spec", to: "restate" });
    moveStage(db, PM, { taskId: "T8a", from: "restate", to: "build" });
    const b = moveStage(db, { ...EXE, dedupKey: "k1" }, { taskId: "T8a", from: "spec", to: "restate" });
    expect(b.duplicate).toBe(true);
    expect(b.event.seq).toBe(a.event.seq);
    expect(b.row.stage).toBe("build");
    expect(events().filter((e) => e.kind === "stage")).toHaveLength(2);
  });
  test("同 key 用到别的动作 / 别的目标报 dedup_mismatch；建事项重复提交不重复建", () => {
    createItem(db, { ...PM, dedupKey: "k2" }, { project: P, id: "i11", title: "x" });
    expect(createItem(db, { ...PM, dedupKey: "k2" }, { project: P, id: "i11", title: "x" }).duplicate).toBe(true);
    expect(errOf(() => createItem(db, { ...PM, dedupKey: "k2" }, { project: P, id: "i12", title: "y" })).code).toBe("dedup_mismatch");
    expect(errOf(() => appendEvent(db, { ...PM, dedupKey: "k2" }, { project: P, target: "i11", kind: "note" })).code).toBe("dedup_mismatch");
    expect(events("i11")).toHaveLength(1);
  });
  test("被拒的写入不占用 dedupKey（事务回滚），改正后同 key 可以成功", () => {
    expect(errOf(() => moveStage(db, { ...PM, dedupKey: "k3" }, { taskId: "T8a", from: "build", to: "review" })).code).toBe("conflict");
    expect(moveStage(db, { ...PM, dedupKey: "k3" }, { taskId: "T8a", from: "spec", to: "restate" }).duplicate).toBe(false);
  });
});

describe("deliver / recordReview（与推阶段同事务）", () => {
  function toBuild() {
    moveStage(db, EXE, { taskId: "T8a", from: "spec", to: "restate" });
    moveStage(db, PM, { taskId: "T8a", from: "restate", to: "build" });
  }
  test("deliver 记 headSHA 与证据、同事务推到 review；moveFrom 不符则整笔回滚", () => {
    toBuild();
    expect(errOf(() => deliver(db, EXE, { taskId: "T8a", headSHA: "abc", moveFrom: "fix" })).code).toBe("conflict");
    expect(events().filter((e) => e.kind === "deliver")).toHaveLength(0);
    expect(getTask(db, "T8a")?.headSHA).toBeNull();
    const r = deliver(db, EXE, { taskId: "T8a", headSHA: "abc", evidence: "docs/tasks/T8a.report.md", moveFrom: "build" });
    expect(r.row).toMatchObject({ stage: "review", round: 1, headSHA: "abc" });
    expect(r.event).toMatchObject({ kind: "deliver", data: { round: 1, headSHA: "abc", evidence: "docs/tasks/T8a.report.md" } });
  });
  test("review 事件带 round / reviewer / verdict / P 计数，可同事务推 review→fix；计数非法报 invalid", () => {
    toBuild();
    deliver(db, EXE, { taskId: "T8a", headSHA: "abc", moveFrom: "build" });
    const input = { taskId: "T8a", reviewer: "claude-reviewer", verdict: "changes" as const, p0: 0, p1: 2, p2: 3 };
    expect(errOf(() => recordReview(db, PM, { ...input, p1: -1 })).code).toBe("invalid");
    const r = recordReview(db, PM, { ...input, path: "r1.md", move: { from: "review", to: "fix" } });
    expect(r.event.data).toEqual({ round: 1, reviewer: "claude-reviewer", verdict: "changes", p0: 0, p1: 2, p2: 3, path: "r1.md" });
    expect(r.row.stage).toBe("fix");
    expect(events().map((e) => e.kind).slice(-2)).toEqual(["review", "stage"]);
  });
});

describe("项目级与追加事件", () => {
  test("PM 名单 / docsDir 只有 owner 能设", () => {
    expect(errOf(() => setMeta(db, PM, { project: P, key: "pms", value: ["agent-claudestra", "x"] })).code).toBe("forbidden");
    expect(setMeta(db, OWNER, { project: P, key: "docsDir", value: "/tmp/docs" }).row).toMatchObject({ docsDir: "/tmp/docs", pms: ["agent-claudestra"] });
  });
  test("冻结 / 解冻合并队列各记一条项目级事件；重复冻结报 conflict", () => {
    setFrozen(db, { ...PM, now: 5 }, { project: P, frozen: true, reason: "线上验证失败" });
    expect(getMeta(db, P).queueFrozen).toEqual({ frozen: true, reason: "线上验证失败", since: 5 });
    expect(errOf(() => setFrozen(db, PM, { project: P, frozen: true })).code).toBe("conflict");
    setFrozen(db, PM, { project: P, frozen: false });
    expect(listEvents(db, { project: P, target: "" }).map((e) => e.kind)).toEqual(["meta", "freeze", "unfreeze"]);
  });
  test("appendEvent 只接受 note / decision / deploy / verify / rollback；目标要在本项目里", () => {
    expect(appendEvent(db, { ...OWNER, now: 7 }, { project: P, target: "i10", kind: "decision", text: "你开工吧" }).event).toMatchObject({ ts: 7, actor: "owner" });
    expect(errOf(() => appendEvent(db, PM, { project: P, target: "T8a", kind: "stage" as never })).code).toBe("invalid");
    expect(errOf(() => appendEvent(db, PM, { project: "other", target: "T8a", kind: "note" })).code).toBe("not_found");
  });
});

describe("审查第 1 轮", () => {
  function toReview() {
    moveStage(db, EXE, { taskId: "T8a", from: "spec", to: "restate" });
    moveStage(db, PM, { taskId: "T8a", from: "restate", to: "build" });
    return deliver(db, EXE, { taskId: "T8a", headSHA: "abc", moveFrom: "build" });
  }
  test("P1 自封 PM：task.pm 不给角色；执行者改不了 agent / pm；PM 可以改", () => {
    createTask(db, PM, { project: P, id: "T9", title: "t", kind: "code", agent: "agent-task-t9", pm: "agent-task-t9" });
    moveStage(db, { actor: "agent-task-t9" }, { taskId: "T9", from: "spec", to: "restate" });
    expect(errOf(() => moveStage(db, { actor: "agent-task-t9" }, { taskId: "T9", from: "restate", to: "build" })).code).toBe("forbidden");
    expect(errOf(() => setTask(db, EXE, { id: "T8a", rev: 1, patch: { pm: "agent-task-t8a" } })).code).toBe("forbidden");
    expect(errOf(() => setTask(db, EXE, { id: "T8a", rev: 1, patch: { agent: "agent-task-t4" } })).code).toBe("forbidden");
    expect(setTask(db, PM, { id: "T8a", rev: 1, patch: { pm: "agent-claudestra" } }).row.rev).toBe(2);
    expect(setTask(db, EXE, { id: "T8a", rev: 2, patch: { branch: "b" } }).row.branch).toBe("b");
  });
  test("P1 导入口：非 owner 不能建在非 spec 阶段或带 round；round / specRev 须为非负整数；owner 导入的事件标 imported", () => {
    const base = { project: P, title: "t", kind: "code" as const };
    expect(errOf(() => createTask(db, PM, { ...base, id: "X1", stage: "live" })).code).toBe("forbidden");
    expect(errOf(() => createTask(db, PM, { ...base, id: "X2", round: 2 })).code).toBe("forbidden");
    expect(errOf(() => createTask(db, OWNER, { ...base, id: "X3", stage: "live", round: -3 })).code).toBe("invalid");
    expect(errOf(() => createTask(db, OWNER, { ...base, id: "X4", specRev: 1.5 })).code).toBe("invalid");
    const r = createTask(db, OWNER, { ...base, id: "X5", stage: "review", round: 2 });
    expect(r.row).toMatchObject({ stage: "review", round: 2 });
    expect(r.event.data.imported).toBe(true);
    expect(createTask(db, PM, { ...base, id: "X6", stage: "spec", round: 0 }).event.data.imported).toBeUndefined();
  });
  test("P2 阶段须与 kind 匹配：investigate 不能建在 merge，谁都不能建在 blocked", () => {
    expect(errOf(() => createTask(db, OWNER, { project: P, id: "X7", title: "t", kind: "investigate", stage: "merge" })).code).toBe("invalid");
    expect(errOf(() => createTask(db, OWNER, { project: P, id: "X8", title: "t", kind: "code", stage: "blocked" })).code).toBe("invalid");
    expect(createTask(db, OWNER, { project: P, id: "X9", title: "t", kind: "investigate", stage: "done" }).row.stage).toBe("done");
  });
  test("P2 dedupKey 空串报 invalid，不落成空串 key", () => {
    expect(errOf(() => appendEvent(db, { ...PM, dedupKey: "" }, { project: P, target: "T8a", kind: "note" })).code).toBe("invalid");
    expect(errOf(() => moveStage(db, { ...EXE, dedupKey: "" }, { taskId: "T8a", from: "spec", to: "restate" })).code).toBe("invalid");
    expect(listEvents(db).filter((e) => e.dedupKey === "")).toHaveLength(0);
  });
  test("P2 审查只能在 review 阶段记；终态任务不能再交付", () => {
    const input = { taskId: "T8a", reviewer: "r", verdict: "pass" as const, p0: 0, p1: 0, p2: 0 };
    expect(errOf(() => recordReview(db, PM, input)).code).toBe("invalid");
    toReview();
    recordReview(db, PM, input);
    moveStage(db, PM, { taskId: "T8a", from: "review", to: "cancelled" });
    expect(errOf(() => deliver(db, EXE, { taskId: "T8a", headSHA: "x" })).code).toBe("invalid");
  });
  test("P2 deliver 记的 round 与同一轮 review 一致", () => {
    const d = toReview();
    const r = recordReview(db, PM, { taskId: "T8a", reviewer: "r", verdict: "changes", p0: 0, p1: 1, p2: 0, move: { from: "review", to: "fix" } });
    expect([d.event.data.round, r.event.data.round]).toEqual([1, 1]);
    const d2 = deliver(db, EXE, { taskId: "T8a", headSHA: "def", moveFrom: "fix" });
    expect(d2.event.data.round).toBe(2);
  });
  test("复验 P2：specRev 不能经 setTask 改（只由阶段机回退到 spec 时加 1）", () => {
    expect(errOf(() => setTask(db, OWNER, { id: "T8a", rev: 1, patch: { specRev: -5 } as never })).code).toBe("invalid");
    expect(getTask(db, "T8a")?.specRev).toBe(1);
  });
  test("P2 事项 id 与任务 id 不能撞", () => {
    expect(errOf(() => createItem(db, PM, { project: P, id: "T8a", title: "x" })).code).toBe("conflict");
    expect(errOf(() => createTask(db, PM, { project: P, id: "i10", title: "x", kind: "code" })).code).toBe("conflict");
    expect(errOf(() => createTask(db, PM, { project: "other", id: "i10", title: "x", kind: "code" })).code).toBe("conflict");
  });
});

describe("importTask（T8b 导入口）", () => {
  const task = { project: P, id: "H1", title: "历史任务", kind: "code" as const, itemId: "i10", agent: "agent-task-t3", stage: "done" as const, round: 1 };
  const events = [
    { kind: "stage" as const, ts: 200, data: { from: "spec", to: "restate" } },
    { kind: "review" as const, ts: 800, text: "无 P0，2 个 P1", data: { round: 1, p0: 0, p1: 2, p2: null } },
    { kind: "stage" as const, ts: 900, data: { from: "restate", to: "done" } },
  ];
  test("只给 owner；行落在最终阶段，建任务事件记起始阶段，合成事件全带 imported、时间取原值，指标能算", () => {
    expect(errOf(() => importTask(db, PM, { task, initialStage: "spec", createdTs: 100, events })).code).toBe("forbidden");
    const r = importTask(db, { ...OWNER, dedupKey: "imp:H1" }, { task, initialStage: "spec", createdTs: 100, events });
    expect(r.row).toMatchObject({ stage: "done", round: 1, agent: "agent-task-t3" });
    const ev = events_("H1");
    expect(ev.map((e) => [e.kind, e.ts, e.data.imported])).toEqual([["task", 100, true], ["stage", 200, true], ["review", 800, true], ["stage", 900, true]]);
    expect(ev[0].data.patch).toMatchObject({ stage: "spec" });
    expect(taskMetrics(r.row, ev, 1000)).toMatchObject({ startTs: 200, endTs: 900, totalMs: 700, reviewRounds: 1, p1: 2 });
    expect(importTask(db, { ...OWNER, dedupKey: "imp:H1" }, { task, initialStage: "spec", createdTs: 100, events }).duplicate).toBe(true);
    expect(events_("H1")).toHaveLength(4);
  });
  test("阶段事件接不上、最后没落到行的阶段、种类不在白名单：整笔拒绝不留残行", () => {
    const bad = [
      [{ kind: "stage" as const, ts: 1, data: { from: "build", to: "done" } }],
      [{ kind: "stage" as const, ts: 1, data: { from: "spec", to: "restate" } }],
      [{ kind: "item" as never, ts: 1 }],
      [{ kind: "stage" as const, ts: Number.NaN, data: { from: "spec", to: "done" } }],
    ];
    for (const evs of bad) expect(errOf(() => importTask(db, OWNER, { task, initialStage: "spec", createdTs: 1, events: evs })).code).toBe("invalid");
    expect(getTask(db, "H1")).toBeNull();
  });
});

function events_(target: string) {
  return listEvents(db, { project: P, target });
}

describe("renameAgentRefs（manager rename 钩子）", () => {
  test("tasks.agent / pm 与 PM 名单里的旧名换成新名，各记一条事件；改名后原执行者仍能推自己的步骤", () => {
    createTask(db, PM, { project: P, id: "T9", title: "t", kind: "code", agent: "agent-claudestra", pm: "agent-claudestra" });
    const r = renameAgentRefs(db, { actor: "master" }, "agent-task-t8a", "agent-task-t8b");
    expect(r).toEqual({ tasks: ["T8a"], projects: [] });
    expect(getTask(db, "T8a")?.agent).toBe("agent-task-t8b");
    moveStage(db, { actor: "agent-task-t8b" }, { taskId: "T8a", from: "spec", to: "restate" });
    const r2 = renameAgentRefs(db, { actor: "master" }, "agent-claudestra", "agent-pm");
    expect(r2).toEqual({ tasks: ["T8a", "T9"], projects: [P] });
    expect(getTask(db, "T9")).toMatchObject({ agent: "agent-pm", pm: "agent-pm" });
    expect(getMeta(db, P).pms).toEqual(["agent-pm"]);
    expect(events_("T9").at(-1)?.data).toMatchObject({ op: "set", patch: { agent: "agent-pm", pm: "agent-pm" }, rename: { from: "agent-claudestra", to: "agent-pm" } });
  });
});
