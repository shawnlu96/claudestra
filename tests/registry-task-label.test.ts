/**
 * IDLINK1 [验收线 1] [验收线 2]: ledger task-new / task-set --agent write the registry task name led by the card id, so the
 * scheduler's existing-author identity (first word = card id) no longer reads it as a conflict. Synthetic ledger and registry only.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { registryTaskIdError, registryTaskLabel } from "../src/lib/registry-task-label.js";
import { existingAuthorIdentity } from "../src/lib/scheduler-existing-author.js";
import type { RegistryAgent } from "../src/lib/registry.js";
import type { Registry } from "../src/manager/core.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "proj", PM = "agent-pm", EXE = "agent-exe";
let db: Database;
let reg: Registry;

const run = (actor: string, ...args: string[]) => runLedger(args, {
  db, actor, actorProject: reg.agents[actor]?.projectId, projectIds: [P],
  loadRegistry: async () => structuredClone(reg), saveRegistry: async (r) => { reg = r; }, now: () => 1_000,
}) as Promise<Record<string, any>>;

beforeEach(() => {
  db = openLedger(":memory:");
  reg = { socket: "", agents: { [PM]: { status: "active", projectId: P }, [EXE]: { status: "active", projectId: P } } as unknown as Registry["agents"] };
  setMeta(db, { actor: "owner", now: 1_000 }, { project: P, key: "pms", value: [PM] });
});
afterEach(() => closeLedger(":memory:"));

/** The scheduler's identity check on the registry row this ledger wrote; git answers the card's own branch. */
async function identity(taskId: string) {
  const row = { name: EXE, runtime: "claude-code", projectId: P, task: reg.agents[EXE].task, cwd: "/w", sessionId: "s1", status: "active" } as RegistryAgent;
  return existingAuthorIdentity({ id: taskId, project: P, branch: "b", agent: EXE }, row, "claude", async () => ({ code: 0, out: "b" }));
}

describe("registryTaskLabel", () => {
  test("adds the card id unless the title's first word already is it (any case)", () => {
    expect(registryTaskLabel("BGW-1", "后台网关改造")).toBe("BGW-1 后台网关改造");
    expect(registryTaskLabel("BGW-1", "BGW-1 后台网关改造")).toBe("BGW-1 后台网关改造");
    expect(registryTaskLabel("BGW-1", "bgw-1 后台网关改造")).toBe("bgw-1 后台网关改造");
    expect(registryTaskLabel("BGW-1", "BGW-10 别的卡")).toBe("BGW-1 BGW-10 别的卡");
    expect(registryTaskLabel("BGW-1", "BGW-1:冒号相连")).toBe("BGW-1 BGW-1:冒号相连");
    expect(registryTaskLabel("BGW-1", "  ")).toBe("BGW-1");
  });
});

describe("task-set / task-new --agent → registry", () => {
  test("[验收线 1] task-set --agent with a title not led by the card id writes `<id> <title>`; identity is no longer a conflict", async () => {
    expect((await run(PM, "task-new", "BGW-1", "--title", "后台网关改造", "--kind", "code")).ok).toBe(true);
    const r = await run(PM, "task-set", "BGW-1", "--rev", "1", "--agent", EXE);
    expect(r).toMatchObject({ ok: true, registryLinked: true });
    expect(reg.agents[EXE].task).toBe("BGW-1 后台网关改造");
    expect((await identity("BGW-1")).kind).toBe("verified");
    // before IDLINK1 the registry held the bare title, which the same check reads as a conflict
    reg.agents[EXE].task = "后台网关改造";
    expect(await identity("BGW-1")).toMatchObject({ kind: "conflict", reason: expect.stringContaining("不是 BGW-1") });
  });

  test("[验收线 2] a title already led by the card id (any case) is kept; no double prefix; task-new --agent too", async () => {
    await run(PM, "task-new", "AUDQ-1", "--title", "audq-1 审计队列", "--kind", "code", "--agent", EXE);
    expect(reg.agents[EXE].task).toBe("audq-1 审计队列");
    expect((await identity("AUDQ-1")).kind).toBe("verified");
    await run(PM, "task-new", "DNF-1", "--title", "DNF-1 下单流程", "--kind", "code");
    await run(PM, "task-set", "DNF-1", "--rev", "1", "--agent", EXE);
    expect(reg.agents[EXE].task).toBe("DNF-1 下单流程");
    await run(PM, "task-new", "PST-1", "--title", "推送", "--kind", "code", "--agent", EXE);
    expect(reg.agents[EXE].task).toBe("PST-1 推送");
  });

  test("[验收线 2] a long title is truncated after the prefix: the card id stays first", async () => {
    const long = "很长的任务标题".repeat(8);
    const n = await run(PM, "task-new", "LST-2", "--title", long, "--kind", "code", "--agent", EXE);
    expect(n.taskTruncated).toBe(true);
    expect(reg.agents[EXE].task).toBe(`LST-2 ${long}`.slice(0, 40));
    expect((await identity("LST-2")).kind).toBe("verified");
    await run(PM, "task-new", "LST-3", "--title", long, "--kind", "code");
    const s = await run(PM, "task-set", "LST-3", "--rev", "1", "--agent", EXE);
    expect(s.taskTruncated).toBe(true);
    expect(reg.agents[EXE].task?.startsWith("LST-3 ")).toBe(true);
    expect((await identity("LST-3")).kind).toBe("verified");
  });

  test("[验收线 2] a card id longer than the registry limit is never clipped: the task name is skipped, not linked as a cut id", async () => {
    const id = "dispatch-recovery-long-feature-identity-link1", long = "Long title ".repeat(8);
    reg.agents[EXE].task = "旧任务";
    const n = await run(PM, "task-new", id, "--title", long, "--kind", "code", "--agent", EXE);
    expect(n).toMatchObject({ ok: true, taskTruncated: true, taskSkipped: expect.stringContaining(`卡号 ${id}`) });
    expect(reg.agents[EXE].task).toBe("旧任务");
    const id2 = `${id}-b`;
    await run(PM, "task-new", id2, "--title", `${id2} ${long}`, "--kind", "code");
    const s = await run(PM, "task-set", id2, "--rev", "1", "--agent", EXE);
    expect(s).toMatchObject({ ok: true, taskTruncated: true, taskSkipped: expect.stringContaining(`卡号 ${id2}`) });
    expect(reg.agents[EXE].task).toBe("旧任务");
    expect(registryTaskIdError(id, id.slice(0, 40), 40)).toContain("超过 registry 任务名上限 40");
  });

  test("[验收线 2] a card id exactly at the limit survives as the whole task name", async () => {
    const id = "x".repeat(36) + "-id1";
    const n = await run(PM, "task-new", id, "--title", "标题", "--kind", "code", "--agent", EXE);
    expect(n).toMatchObject({ ok: true, taskTruncated: true });
    expect(n.taskSkipped).toBeUndefined();
    expect(reg.agents[EXE].task).toBe(id);
    expect((await identity(id)).kind).toBe("verified");
  });
});
