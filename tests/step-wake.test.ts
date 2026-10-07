/**
 * `ledger step` 给本机 agent 派正式单后叫醒执行者（lib/step-wake.ts）。注入假投递，不连真实 bridge / tmux。
 * 一次投递、文案同调度器；重放 / 重复 / 并发 step 不重发；结果不明不重发；peer / human / merge / verify / PM / master 不发；投递失败 step 照样成功并记事件。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { setStepWakeDeliver, STEP_WAKE_OP, wakeAfterStep, wakeTarget, type WakeFacts } from "../src/lib/step-wake.js";
import { takeOrderResult } from "../src/lib/order-take.js";
import { renderWorkOrder } from "../src/lib/worker-order.js";
import { runLedger } from "../src/manager/ledger.js";
import type { Registry } from "../src/manager/core.js";

const P = "claude-orchestrator";
const PM = "agent-pm";
const EXE = "agent-task-w1";
let db: Database;
let sent: { agent: string; text: string }[];
let fail: { status: "rejected" | "unknown"; error: string } | null;
const reg: Registry = {
  socket: "",
  agents: { [PM]: { status: "active", projectId: P }, [EXE]: { status: "active", projectId: P }, "agent-main": { status: "active", kind: "main" } } as unknown as Registry["agents"],
};

const run = (...args: string[]) => runLedger(args, {
  db, actor: PM, projectIds: [P], loadRegistry: async () => structuredClone(reg), saveRegistry: async () => {}, now: () => 2_000,
}) as Promise<Record<string, any>>;
const wakeNotes = (phase = "result") => listEvents(db, { project: P, target: "W1" }).filter((e) => e.kind === "note" && e.data.op === STEP_WAKE_OP && e.data.phase === phase);

beforeEach(() => {
  db = openLedger(":memory:");
  sent = [];
  fail = null;
  setStepWakeDeliver(async (agent, text) => {
    if (fail?.status === "unknown") sent.push({ agent, text }); // 发出去了、回执丢了
    if (fail) return fail;
    sent.push({ agent, text });
    return { status: "sent" };
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
    expect(notes[0]!.data).toMatchObject({ stepSeq: r.event.seq, status: "sent", executor: EXE, orderId: "W1:write:r2", attempt: 1 });
    expect(wakeNotes("claim")).toHaveLength(1);
  });

  test("review / final_review 叫 take_review；fix 叫 take_order", async () => {
    await run("step", "W1", "review", EXE, "--kind", "agent");
    await run("step", "W1", "final_review", EXE, "--kind", "agent");
    await run("step", "W1", "fix", EXE, "--kind", "agent");
    expect(sent.map((s) => s.text.includes("take_review"))).toEqual([true, true, false]);
    expect(sent[2]!.text).toContain("take_order");
    expect(sent[1]!.text).toContain("W1:final_review:r0");
  });

  test("restate 没有领单工具：照调度器 deliveryFor 发复述单全文（只指向 ledger show，不带规格正文），不叫 take_order", async () => {
    const r = await run("step", "W1", "restate", EXE, "--kind", "agent");
    expect(r).toMatchObject({ ok: true, wake: { sent: true, orderId: "W1:restate:r0" } });
    expect(takeOrderResult(db, { agent: EXE, sessionId: "s", family: null, channelId: "" })).toMatchObject({ ok: true, order: null });
    const text = sent[0]!.text;
    expect(text).not.toContain("take_order");
    expect(text).toContain("W1:restate:r0");
    expect(text).toContain("show W1");
    expect(text).toContain("--to restate");
  });

  test("重复执行同一个 step 不重发（每次是新 seq），note 也只有一条；同一条 step 事件重放也不重发", async () => {
    const a = await run("step", "W1", "write", EXE, "--kind", "agent");
    const b = await run("step", "W1", "write", EXE, "--kind", "agent");
    expect(b.event.seq).toBeGreaterThan(a.event.seq);
    expect(b).toMatchObject({ ok: true, wake: { sent: false, why: "这张单已经唤醒过" } });
    const task = { id: "W1" };
    const replay = await wakeAfterStep({ db, ctx: { actor: PM, now: 3_000 }, project: P, task, event: a.event, duplicate: false,
      agents: async () => reg.agents, deliver: async () => { throw new Error("不该投递"); } });
    expect(replay).toMatchObject({ sent: false });
    expect(sent).toHaveLength(1);
    expect(wakeNotes()).toHaveLength(1);
    const dup = await wakeAfterStep({ db, ctx: { actor: PM, now: 3_000 }, project: P, task, event: a.event, duplicate: true,
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

  test("确定没发出去（rejected）：step 仍成功落账，事件里记「唤醒未送达」；同一事件重放不重发，PM 重跑 step 才重试", async () => {
    fail = { status: "rejected", error: "Bridge 连接出错" };
    const r = await run("step", "W1", "write", EXE, "--kind", "agent");
    expect(r).toMatchObject({ ok: true, duplicate: false, wake: { sent: false, why: expect.stringContaining("唤醒未送达") } });
    expect(r.steps.map((s: any) => [s.step, s.executor, s.state])).toEqual([["write", EXE, "assigned"]]);
    const notes = wakeNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toContain("唤醒未送达");
    expect(notes[0]!.data).toMatchObject({ stepSeq: r.event.seq, status: "rejected", error: "Bridge 连接出错" });
    fail = null;
    const again = await wakeAfterStep({ db, ctx: { actor: PM, now: 3_000 }, project: P, task: { id: "W1" }, event: r.event, duplicate: true,
      agents: async () => reg.agents, deliver: async () => { throw new Error("不该投递"); } });
    expect(again).toMatchObject({ sent: false });
    expect(wakeNotes()).toHaveLength(1);
    expect(await run("step", "W1", "write", EXE, "--kind", "agent")).toMatchObject({ ok: true, wake: { sent: true } });
    expect(sent).toHaveLength(1);
    expect(wakeNotes().map((e) => [e.data.attempt, e.data.status])).toEqual([[1, "rejected"], [2, "sent"]]);
  });

  test("结果不明（发出去了没回执）：记「唤醒结果不明」，重跑 step 不再发", async () => {
    fail = { status: "unknown", error: "Bridge 请求超时" };
    const r = await run("step", "W1", "write", EXE, "--kind", "agent");
    expect(r).toMatchObject({ ok: true, wake: { sent: false, why: expect.stringContaining("结果不明") } });
    expect(wakeNotes()[0]!.text).not.toContain("没收到");
    fail = null;
    expect(await run("step", "W1", "write", EXE, "--kind", "agent")).toMatchObject({ ok: true, wake: { sent: false, why: expect.stringContaining("结果不明") } });
    expect(sent).toHaveLength(1);
    expect(wakeNotes()).toHaveLength(1);
  });

  test("并发两次同单 step：投递前原子认领，只发一次、只记一条结果", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    setStepWakeDeliver(async (agent, text) => {
      sent.push({ agent, text });
      await gate;
      return { status: "sent" };
    });
    const a = run("step", "W1", "write", EXE, "--kind", "agent");
    const b = run("step", "W1", "write", EXE, "--kind", "agent");
    await new Promise((res) => setTimeout(res, 20));
    release();
    const got = (await Promise.all([a, b])).map((r) => r.wake.sent);
    expect(got.sort()).toEqual([false, true]);
    expect(sent).toHaveLength(1);
    expect(wakeNotes()).toHaveLength(1);
    expect(wakeNotes("claim")).toHaveLength(1);
  });

  test("投递函数抛错算结果不明：step 不失败，记一条事件，不自动重发", async () => {
    setStepWakeDeliver(async () => { throw new Error("炸了"); });
    const r = await run("step", "W1", "write", EXE, "--kind", "agent");
    expect(r).toMatchObject({ ok: true, wake: { sent: false } });
    expect(wakeNotes()[0]!.data).toMatchObject({ status: "unknown", error: "炸了" });
  });

  test("没有注入、进程也没有通知通道：不连 bridge，不发", async () => {
    setStepWakeDeliver(null);
    const r = await run("step", "W1", "write", EXE, "--kind", "agent");
    expect(r).toMatchObject({ ok: true, wake: { sent: false, why: "这个进程没有投递通道" } });
    expect(wakeNotes("claim")).toEqual([]);
  });
});

describe("wakeTarget 判定", () => {
  const base: WakeFacts = {
    task: { id: "W1", specRev: 1, headSHA: null }, event: { seq: 9, data: { op: "assign", step: "write", round: 1, executor: EXE, executorKind: "agent" } }, duplicate: false,
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
