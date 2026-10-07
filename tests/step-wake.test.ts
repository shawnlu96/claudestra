/**
 * WAKE1：`ledger step` 给本机 agent 派正式单后叫醒执行者（lib/step-wake.ts）。注入假投递，不连真实 bridge / tmux。
 * 旧代码 step 之后零投递、新代码一次；重放 / 重复 step 不重发；peer / human / merge / verify / PM / master 不发；投递失败 step 照样成功并记一条 note。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { setStepWakeDeliver, STEP_WAKE_OP, wakeAfterStep, wakeTarget, type WakeFacts } from "../src/lib/step-wake.js";
import { renderWorkOrder } from "../src/lib/worker-order.js";
import { runLedger } from "../src/manager/ledger.js";
import type { Registry } from "../src/manager/core.js";

const P = "claude-orchestrator";
const PM = "agent-pm";
const EXE = "agent-task-w1";
let db: Database;
let sent: { agent: string; text: string }[];
let fail: string | null;
const reg: Registry = {
  socket: "",
  agents: { [PM]: { status: "active", projectId: P }, [EXE]: { status: "active", projectId: P }, "agent-main": { status: "active", kind: "main" } } as unknown as Registry["agents"],
};

const run = (...args: string[]) => runLedger(args, {
  db, actor: PM, projectIds: [P], loadRegistry: async () => structuredClone(reg), saveRegistry: async () => {}, now: () => 2_000,
}) as Promise<Record<string, any>>;
const wakeNotes = () => listEvents(db, { project: P, target: "W1" }).filter((e) => e.kind === "note" && e.data.op === STEP_WAKE_OP);

beforeEach(() => {
  db = openLedger(":memory:");
  sent = [];
  fail = null;
  setStepWakeDeliver(async (agent, text) => {
    if (fail) return { ok: false, error: fail };
    sent.push({ agent, text });
    return { ok: true };
  });
  setMeta(db, { actor: "owner", now: 1_000 }, { project: P, key: "pms", value: [PM] });
  createTask(db, { actor: "owner", now: 1_000 }, { project: P, id: "W1", title: "唤醒", kind: "code" });
});
afterEach(() => {
  setStepWakeDeliver(null);
  closeLedger(":memory:");
});

describe("step 之后唤醒本机执行者", () => {
  test("本机 agent 的 write：投递一次，文案就是调度器的 wake 行（手动单号、不带正文），记一条 note", async () => {
    const r = await run("step", "W1", "write", EXE, "--kind", "agent", "--round", "2");
    expect(r).toMatchObject({ ok: true, wake: { sent: true, agent: EXE, orderId: "W1:write:r2" } });
    expect(sent).toEqual([{ agent: EXE, text: renderWorkOrder({ taskId: "W1", step: "write", round: 2, dedupKey: "W1:write:r2", delivery: { mode: "wake" },
      specRev: 0, head: null, node: "write", inputs: [], outputs: [], acceptance: [], writeBack: "" }) }]);
    expect(sent[0]!.text).toContain("take_order");
    const notes = wakeNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.data).toMatchObject({ stepSeq: r.event.seq, delivered: true, executor: EXE, orderId: "W1:write:r2" });
  });

  test("review / final_review 叫 take_review；restate / fix 叫 take_order", async () => {
    await run("step", "W1", "review", EXE, "--kind", "agent");
    await run("step", "W1", "final_review", EXE, "--kind", "agent");
    await run("step", "W1", "restate", EXE, "--kind", "agent");
    await run("step", "W1", "fix", EXE, "--kind", "agent");
    expect(sent.map((s) => s.text.includes("take_review"))).toEqual([true, true, false, false]);
    expect(sent[1]!.text).toContain("W1:final_review:r0");
  });

  test("重复执行同一个 step 不重发（每次是新 seq），note 也只有一条；同一条 step 事件重放也不重发", async () => {
    const a = await run("step", "W1", "write", EXE, "--kind", "agent");
    const b = await run("step", "W1", "write", EXE, "--kind", "agent");
    expect(b.event.seq).toBeGreaterThan(a.event.seq);
    expect(b).toMatchObject({ ok: true, wake: { sent: false, why: "这张单已经唤醒过" } });
    const replay = await wakeAfterStep({ db, ctx: { actor: PM, now: 3_000 }, project: P, task: { id: "W1" }, event: a.event, duplicate: false,
      agents: async () => reg.agents, deliver: async () => { throw new Error("不该投递"); } });
    expect(replay).toMatchObject({ sent: false });
    expect(sent).toHaveLength(1);
    expect(wakeNotes()).toHaveLength(1);
    const dup = await wakeAfterStep({ db, ctx: { actor: PM, now: 3_000 }, project: P, task: { id: "W1" }, event: a.event, duplicate: true,
      agents: async () => reg.agents, deliver: async () => { throw new Error("不该投递"); } });
    expect(dup).toMatchObject({ sent: false, why: "step 是重放，不重发" });
    await run("step", "W1", "write", EXE, "--kind", "agent", "--round", "1"); // 新一轮是新单，照叫
    expect(sent).toHaveLength(2);
  });

  test("peer / human、merge / verify、PM / master / main agent、registry 里没有的都不发", async () => {
    expect((await run("step", "W1", "write", "agent-x@Peer", "--kind", "peer")).ok).toBe(true);
    expect((await run("step", "W1", "review", "local:owner", "--kind", "human")).ok).toBe(true);
    expect((await run("step", "W1", "merge", EXE, "--kind", "agent")).ok).toBe(true);
    expect((await run("step", "W1", "verify", EXE, "--kind", "agent")).ok).toBe(true);
    expect((await run("step", "W1", "ui_check", EXE, "--kind", "agent")).ok).toBe(true);
    expect((await run("step", "W1", "fix", PM, "--kind", "agent")).ok).toBe(true);
    expect((await run("step", "W1", "fix", "master", "--kind", "agent")).ok).toBe(true);
    expect((await run("step", "W1", "fix", "agent-main", "--kind", "agent")).ok).toBe(true);
    expect((await run("step", "W1", "fix", "agent-gone", "--kind", "agent")).ok).toBe(true);
    expect(sent).toEqual([]);
    expect(wakeNotes()).toEqual([]);
  });

  test("投递失败：step 仍成功落账，事件里记「唤醒未送达」；同一事件重放不重发，PM 重跑 step 才重试", async () => {
    fail = "Bridge 连接出错";
    const r = await run("step", "W1", "write", EXE, "--kind", "agent");
    expect(r).toMatchObject({ ok: true, duplicate: false, wake: { sent: false, why: expect.stringContaining("唤醒未送达") } });
    expect(r.steps.map((s: any) => [s.step, s.executor, s.state])).toEqual([["write", EXE, "assigned"]]);
    const notes = wakeNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toContain("唤醒未送达");
    expect(notes[0]!.data).toMatchObject({ stepSeq: r.event.seq, delivered: false, error: "Bridge 连接出错" });
    fail = null;
    const again = await wakeAfterStep({ db, ctx: { actor: PM, now: 3_000 }, project: P, task: { id: "W1" }, event: r.event, duplicate: false,
      agents: async () => reg.agents, deliver: async () => { throw new Error("不该投递"); } });
    expect(again).toMatchObject({ sent: false });
    expect(wakeNotes()).toHaveLength(1);
    expect(await run("step", "W1", "write", EXE, "--kind", "agent")).toMatchObject({ ok: true, wake: { sent: true } });
    expect(sent).toHaveLength(1);
  });

  test("投递函数抛错也不让 step 失败", async () => {
    setStepWakeDeliver(async () => { throw new Error("炸了"); });
    const r = await run("step", "W1", "write", EXE, "--kind", "agent");
    expect(r).toMatchObject({ ok: true, wake: { sent: false } });
    expect(wakeNotes()[0]!.data).toMatchObject({ delivered: false, error: "炸了" });
  });

  test("没有注入、进程也没有通知通道：不连 bridge，不发", async () => {
    setStepWakeDeliver(null);
    const r = await run("step", "W1", "write", EXE, "--kind", "agent");
    expect(r).toMatchObject({ ok: true, wake: { sent: false, why: "这个进程没有投递通道" } });
    expect(wakeNotes()).toEqual([]);
  });
});

describe("wakeTarget 判定", () => {
  const base: WakeFacts = {
    task: { id: "W1" }, event: { seq: 9, data: { op: "assign", step: "write", round: 1, executor: EXE, executorKind: "agent" } }, duplicate: false,
    agents: { [EXE]: {} }, pms: [PM], dispatcher: "agent-disp", workflowMode: "manual",
  };
  test("auto 卡归调度器、dispatcher / role=pm 受保护", () => {
    expect(wakeTarget(base)).toMatchObject({ agent: EXE, orderId: "W1:write:r1" });
    expect(wakeTarget({ ...base, workflowMode: "auto" })).toMatchObject({ skip: expect.stringContaining("调度器") });
    expect(wakeTarget({ ...base, agents: { [EXE]: { role: "pm" } } })).toHaveProperty("skip");
    expect(wakeTarget({ ...base, dispatcher: EXE })).toHaveProperty("skip");
    expect(wakeTarget({ ...base, duplicate: true })).toHaveProperty("skip");
  });
});
