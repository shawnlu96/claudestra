/** ledger 的依赖边子命令（src/manager/ledger-dep-cmds.ts）与 task-new / task-set 的负责人旗标；角色矩阵与 manager-ledger.test.ts 同一套注入 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import type { Registry } from "../src/manager/core.js";
import { runLedger } from "../src/manager/ledger.js";
import { isWriteInvocation, needsWriteLock } from "../src/manager/write-commands.js";

const P = "claude-orchestrator";
const PM = "agent-claudestra";
const EXE = "agent-task-t8h";
let db: Database;
let reg: Registry;

async function run(actor: string, ...args: string[]) {
  return runLedger(args, {
    db, actor, actorProject: reg.agents[actor]?.projectId, projectIds: [P, "other"],
    loadRegistry: async () => structuredClone(reg),
    saveRegistry: async (r) => {
      reg = r;
    },
    now: () => 1_000,
  }) as Promise<Record<string, any>>;
}

beforeEach(async () => {
  db = openLedger(":memory:");
  const a = { status: "active", projectId: P } as Registry["agents"][string];
  reg = { socket: "", agents: { [PM]: a, [EXE]: { ...a }, "agent-task-x": { ...a } } };
  expect((await run("owner", "meta", "--project", P, "--pms", "claudestra")).ok).toBe(true);
  for (const id of ["T1", "T2", "T3"]) expect((await run(PM, "task-new", id, "--title", id, "--kind", "code", "--agent", "task-t8h")).ok).toBe(true);
});
afterEach(() => closeLedger(":memory:"));

describe("dep-add / dep-set / dep-rm / deps", () => {
  test("PM 加边、查边（带推导与可执行）、改状态、清回推导、删边", async () => {
    expect(await run(PM, "dep-add", "T1", "T2", "--when", "T1 合并后")).toMatchObject({ ok: true, dep: { from: "T1", to: "T2", kind: "blocks", rev: 1 } });
    expect(await run(PM, "dep-add", "T2", "T3", "--when", "看了不满意", "--kind", "branch")).toMatchObject({ ok: true, dep: { kind: "branch" } });
    const list = await run(EXE, "deps");
    expect(list.deps.map((d: any) => [d.from, d.to, d.effective])).toEqual([["T1", "T2", "waiting"], ["T2", "T3", "waiting"]]);
    expect(list.runnable).toEqual(["T1"]);
    expect((await run(EXE, "deps", "T3")).deps.map((d: any) => d.from)).toEqual(["T2"]);
    expect(await run(PM, "dep-set", "T1", "T2", "--rev", "1", "--state", "done")).toMatchObject({ ok: true, dep: { state: "done", rev: 2 } });
    expect((await run(PM, "deps")).runnable).toEqual(["T1", "T2"]);
    expect(await run(PM, "dep-set", "T1", "T2", "--rev", "2", "--state", "auto")).toMatchObject({ ok: true, dep: { state: null } });
    expect(await run(PM, "dep-rm", "T1", "T2")).toMatchObject({ ok: true });
    expect((await run(PM, "deps")).deps).toHaveLength(1);
  });

  test("执行者 / 陌生 agent 改依赖 forbidden；master / owner 可以", async () => {
    expect(await run(EXE, "dep-add", "T1", "T2", "--when", "x")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await run("agent-task-x", "dep-add", "T1", "T2", "--when", "x")).toMatchObject({ ok: false, code: "forbidden" });
    expect((await run("master", "dep-add", "T1", "T2", "--when", "x")).ok).toBe(true);
    expect(await run(EXE, "dep-set", "T1", "T2", "--rev", "1", "--state", "done")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await run(EXE, "dep-rm", "T1", "T2")).toMatchObject({ ok: false, code: "forbidden" });
    expect((await run("owner", "dep-rm", "T1", "T2")).ok).toBe(true);
  });

  test("参数错：缺 --when、坏的 --kind / --state、dep-set 缺 --rev、成环带路径", async () => {
    expect(await run(PM, "dep-add", "T1", "T2")).toMatchObject({ ok: false, code: "invalid", usage: expect.stringContaining("dep-add") });
    expect(await run(PM, "dep-add", "T1", "T2", "--when", "x", "--kind", "soft")).toMatchObject({ ok: false, code: "invalid" });
    expect(await run(PM, "dep-add", "T1", "T2", "--when", "x", "--state", "auto")).toMatchObject({ ok: true, dep: { state: null } });
    expect(await run(PM, "dep-set", "T1", "T2", "--state", "done")).toMatchObject({ ok: false, code: "invalid" });
    expect(await run(PM, "dep-set", "T1", "T2", "--rev", "1", "--state", "maybe")).toMatchObject({ ok: false, code: "invalid" });
    expect(await run(PM, "dep-add", "T2", "T1", "--when", "x")).toMatchObject({ ok: false, code: "invalid", current: { cycle: ["T2", "T1", "T2"] } });
  });

  test("deps 是读命令（不过认主守卫、不拿写锁）；dep-* 是写命令但不拿 registry 写锁", () => {
    expect(isWriteInvocation("ledger", ["deps"])).toBe(false);
    expect(isWriteInvocation("ledger", ["dep-add", "T1", "T2"])).toBe(true);
    expect(needsWriteLock("ledger", ["dep-add", "T1", "T2"])).toBe(false);
  });
});

describe("负责人旗标", () => {
  test("task-new --assignee-kind human：agent 为空、不碰 registry；不合格式直接拒绝、任务不建", async () => {
    const r = await run(PM, "task-new", "R1", "--title", "发版", "--kind", "ops", "--assignee-kind", "human", "--assignee", "local:owner:self");
    expect(r.task).toMatchObject({ agent: null, assigneeKind: "human", assignee: "local:owner:self" });
    expect(r.registryLinked).toBeUndefined();
    expect(await run(PM, "task-new", "R2", "--title", "x", "--kind", "ops", "--assignee-kind", "human", "--assignee", "owner")).toMatchObject({ ok: false, code: "invalid" });
    expect(await run(PM, "task-new", "R3", "--title", "x", "--kind", "code", "--assignee-kind", "peer_agent", "--assignee", "future_data@ahh")).toMatchObject({ ok: false, code: "invalid" });
    expect(getTask(db, "R2") ?? getTask(db, "R3")).toBeNull();
  });

  test("task-set --assignee-kind agent 归一成 registry 键并联动 registry；执行者改负责人 forbidden；与 --agent 同用报 invalid", async () => {
    const rev = () => String(getTask(db, "T1")!.rev);
    expect(await run(EXE, "task-set", "T1", "--rev", rev(), "--assignee-kind", "human", "--assignee", "local:owner:self")).toMatchObject({ ok: false, code: "forbidden" });
    const r = await run(PM, "task-set", "T1", "--rev", rev(), "--assignee-kind", "agent", "--assignee", "Task-X");
    expect(r).toMatchObject({ ok: true, task: { agent: "agent-task-x", assigneeKind: "agent", assignee: "agent-task-x" }, registryLinked: true });
    expect(reg.agents["agent-task-x"]).toMatchObject({ parent: PM, task: "T1" });
    // 指纹大小写不敏感：CLI 转小写后入库
    expect(await run(PM, "task-set", "T1", "--rev", rev(), "--assignee-kind", "peer_agent", "--assignee", "1A2B-3C4D-5E6F-7A8B/future_data")).toMatchObject({
      ok: true, task: { agent: null, assigneeKind: "peer_agent", assignee: "1a2b-3c4d-5e6f-7a8b/future_data" },
    });
    expect(await run(PM, "task-set", "T1", "--rev", rev(), "--agent", "task-x", "--assignee", "y")).toMatchObject({ ok: false, code: "invalid" });
    expect(await run(PM, "task-set", "T1", "--rev", rev(), "--assignee", "")).toMatchObject({ ok: true, task: { agent: null, assigneeKind: null, assignee: null } });
  });
});
