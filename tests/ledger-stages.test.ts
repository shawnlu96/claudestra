/** 台账阶段机（src/lib/ledger-stages.ts）：三种 kind 的全表逐对校验、blocked / cancelled 旁路、角色、推阶段副作用 */
import { describe, expect, test } from "bun:test";
import {
  canTransition,
  endStages,
  isStageOfKind,
  nextTaskState,
  ROLES,
  roleOf,
  STAGES,
  TASK_KINDS,
  type Role,
  type Stage,
  type TaskKind,
} from "../src/lib/ledger-stages.js";

/** 设计稿 §3 的跳转表逐字抄一份，和实现的 TRANSITIONS 独立比对（不含 blocked / cancelled） */
const SHIP: Partial<Record<Stage, Stage[]>> = {
  review: ["fix", "merge", "spec"],
  merge: ["live", "review", "fix"],
  live: ["verified", "fix"],
  verified: ["done"],
};
const EXPECTED: Record<TaskKind, Partial<Record<Stage, Stage[]>>> = {
  code: { spec: ["restate"], restate: ["build", "spec"], build: ["review"], fix: ["review"], ...SHIP },
  investigate: { spec: ["restate"], restate: ["build", "spec"], build: ["review"], review: ["fix", "done", "spec"], fix: ["review"] },
  ops: { spec: ["build"], build: ["review"], fix: ["review"], ...SHIP },
};
const EXECUTOR_OK = new Set(["spec>restate", "build>review", "fix>review"]);
const PM_ROLES: Role[] = ["pm", "master", "owner"];

function task(kind: TaskKind, stage: Stage, stageBefore: Stage | null = null) {
  return { kind, stage, stageBefore };
}

describe("canTransition 全表", () => {
  for (const kind of TASK_KINDS) {
    const active = Object.keys(EXPECTED[kind]) as Stage[];
    test(`${kind}：每个在用阶段 × 每个目标阶段，合法与否与设计稿一致`, () => {
      for (const from of active) {
        for (const to of STAGES) {
          const legal = (EXPECTED[kind][from] ?? []).includes(to) || to === "blocked" || to === "cancelled";
          const r = canTransition(task(kind, from), to, "owner");
          expect({ kind, from, to, ok: r.ok }).toEqual({ kind, from, to, ok: legal && to !== from });
        }
      }
    });
    test(`${kind}：合法跳转里执行者只能推 spec→restate、build/fix→review，其余拒为 forbidden；PM / master / owner 全放行`, () => {
      for (const from of active) {
        for (const to of [...(EXPECTED[kind][from] ?? []), "blocked", "cancelled"] as Stage[]) {
          for (const role of PM_ROLES) expect(canTransition(task(kind, from), to, role).ok).toBe(true);
          const r = canTransition(task(kind, from), to, "executor");
          if (EXECUTOR_OK.has(`${from}>${to}`)) expect(r.ok).toBe(true);
          else expect(r).toMatchObject({ ok: false, code: "forbidden" });
        }
      }
    });
  }

  test("代表性非法跳转：code 跳过审查直接合并、investigate 不经 merge / live、ops 没有 restate", () => {
    expect(canTransition(task("code", "build"), "merge", "owner")).toMatchObject({ ok: false, code: "illegal" });
    expect(canTransition(task("code", "spec"), "build", "owner")).toMatchObject({ ok: false, code: "illegal" });
    expect(canTransition(task("code", "live"), "review", "owner")).toMatchObject({ ok: false, code: "illegal" });
    expect(canTransition(task("investigate", "review"), "merge", "owner")).toMatchObject({ ok: false, code: "illegal" });
    expect(canTransition(task("ops", "spec"), "restate", "owner")).toMatchObject({ ok: false, code: "illegal" });
    expect(canTransition(task("code", "review"), "review", "owner")).toMatchObject({ ok: false, code: "illegal" });
  });

  test("非法跳转无论谁推都报 illegal（不先报 forbidden）", () => {
    expect(canTransition(task("code", "build"), "merge", "executor")).toMatchObject({ ok: false, code: "illegal" });
  });

  test("终态 done / cancelled 哪儿也去不了，包括 blocked", () => {
    for (const kind of TASK_KINDS) {
      for (const from of ["done", "cancelled"] as Stage[]) {
        for (const to of STAGES) expect(canTransition(task(kind, from), to, "owner")).toMatchObject({ ok: false, code: "terminal" });
      }
    }
  });

  test("blocked 只能回 stageBefore 或 cancelled，之前在 merge 的还能退回 review；执行者不能进出 blocked", () => {
    for (const kind of TASK_KINDS) {
      for (const before of Object.keys(EXPECTED[kind]) as Stage[]) {
        const t = task(kind, "blocked", before);
        for (const to of STAGES) {
          const ok = to === before || to === "cancelled" || (before === "merge" && to === "review");
          expect({ kind, before, to, ok: canTransition(t, to, "pm").ok }).toEqual({ kind, before, to, ok });
        }
        expect(canTransition(t, before, "executor")).toMatchObject({ ok: false, code: "forbidden" });
      }
    }
    expect(canTransition(task("code", "blocked", "merge"), "review", "executor")).toMatchObject({ ok: false, code: "forbidden" });
    expect(canTransition(task("code", "build"), "blocked", "executor")).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("nextTaskState", () => {
  const base = { kind: "code" as const, stageBefore: null, round: 0, specRev: 1 };
  test("每次进 review 都 round+1：build→review、fix→review、merge→review（rebase 重审）", () => {
    expect(nextTaskState({ ...base, stage: "build" }, "review").round).toBe(1);
    expect(nextTaskState({ ...base, stage: "fix", round: 1 }, "review").round).toBe(2);
    expect(nextTaskState({ ...base, stage: "merge", round: 2 }, "review").round).toBe(3);
    expect(nextTaskState({ ...base, stage: "review", round: 2 }, "fix").round).toBe(2);
  });
  test("从 blocked 回 review 不加 round，出 blocked 清空 stageBefore", () => {
    const into = nextTaskState({ ...base, stage: "review", round: 2 }, "blocked");
    expect(into).toEqual({ stage: "blocked", stageBefore: "review", round: 2, specRev: 1 });
    expect(nextTaskState({ ...base, ...into }, "review")).toEqual({ stage: "review", stageBefore: null, round: 2, specRev: 1 });
  });
  test("之前在 merge 的 blocked 退回 review：和 merge → review 一样 round+1", () => {
    expect(nextTaskState({ ...base, stage: "blocked", stageBefore: "merge", round: 2 }, "review")).toEqual({ stage: "review", stageBefore: null, round: 3, specRev: 1 });
  });
  test("review→spec、restate→spec 让 specRev+1，round 不清零；从 blocked 回 spec 不加 specRev", () => {
    expect(nextTaskState({ ...base, stage: "review", round: 3 }, "spec")).toEqual({ stage: "spec", stageBefore: null, round: 3, specRev: 2 });
    expect(nextTaskState({ ...base, stage: "restate", specRev: 2 }, "spec").specRev).toBe(3);
    expect(nextTaskState({ ...base, stage: "blocked", stageBefore: "spec" }, "spec").specRev).toBe(1);
  });
});

describe("roleOf / 起止阶段", () => {
  const t = { agent: "agent-task-t8a" };
  test("master / owner 按名字；只有项目 PM 名单 → pm；任务 agent → executor；其余 null", () => {
    expect(roleOf("master", t, [])).toBe("master");
    expect(roleOf("owner", t, [])).toBe("owner");
    expect(roleOf("agent-claudestra", t, ["agent-claudestra"])).toBe("pm");
    expect(roleOf("agent-claudestra", t, [])).toBeNull();
    expect(roleOf("agent-task-t8a", t, [])).toBe("executor");
    expect(roleOf("agent-task-t4", t, [])).toBeNull();
    expect(ROLES).toContain(roleOf("agent-task-t8a", t, []) as Role);
  });
  test("PM 自做的 ops 任务（agent 在 PM 名单里）按 pm 算", () => {
    expect(roleOf("agent-claudestra", { agent: "agent-claudestra" }, ["agent-claudestra"])).toBe("pm");
  });
  test("isStageOfKind：跳转表里有出边的阶段与终态算，blocked 不算；investigate 没有 merge / live / verified", () => {
    expect(isStageOfKind("code", "live")).toBe(true);
    expect(isStageOfKind("code", "done")).toBe(true);
    expect(isStageOfKind("code", "blocked")).toBe(false);
    expect(isStageOfKind("investigate", "merge")).toBe(false);
    expect(isStageOfKind("ops", "restate")).toBe(false);
    expect(isStageOfKind("code", "toString" as never)).toBe(false);
  });
  test("终点：investigate 看 done，code / ops 先看 verified", () => {
    expect(endStages("investigate")[0]).toBe("done");
    expect(endStages("code")[0]).toBe("verified");
  });
});
