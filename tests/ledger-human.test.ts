/**
 * 台账 v3.2 例外（src/lib/ledger-human.ts）与对应 CLI：人工交付同事务推 review、按 askId 幂等、门不过整笔不写；
 * PM 重开指派记 assign_reopen、开单序号递增、旧 ask 随之过时；过时的指派挑得出来；task-set / task-new 的 --brief 存 extra.brief。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HUMAN_NODE_CREATOR } from "../src/lib/human-node.js";
import { openAsk } from "../src/lib/ledger-asks.js";
import { humanDeliver, humanDeliverKey, isCurrentAssignment, pendingAssignments, reopenAssignment, staleAssignments, type HumanDeliverInput } from "../src/lib/ledger-human.js";
import { isAskEvent } from "../src/lib/ledger-stages.js";
import { closeLedger, getTask, LedgerError, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, moveStage, recordReview, setMeta, setTask } from "../src/lib/ledger-write.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "p";
const PM = { actor: "agent-pm" };
const GUEST = "local:guest:ab12";
const OTHER_DEVICE = "local:guest:cd34";
const key = (round: number, seq: number, who = GUEST) => `assign:T1:${round}:${seq}:${who}`;
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

const input = (over: Partial<HumanDeliverInput> = {}): HumanDeliverInput => ({
  taskId: "T1", askId: "a1", ask: { dedupKey: key(0, 1), kind: "assigned" },
  answerer: { persons: [GUEST, OTHER_DEVICE], isOwner: false }, note: "改好了，截图见附件", atts: ["a".repeat(64)], ...over,
});
const kinds = () => listEvents(db, { project: P, target: "T1" }).map((e) => e.kind);

beforeEach(() => {
  db = openLedger(":memory:");
  setMeta(db, { actor: "owner" }, { project: P, key: "pms", value: ["agent-pm"] });
  createTask(db, PM, { project: P, id: "T1", title: "登录页改文案", kind: "code", assigneeKind: "human", assignee: GUEST, pm: "agent-pm" });
  createTask(db, PM, { project: P, id: "T2", title: "agent 的活", kind: "code", agent: "agent-x" });
  moveStage(db, PM, { taskId: "T1", from: "spec", to: "restate" });
  moveStage(db, PM, { taskId: "T1", from: "restate", to: "build" });
});
afterEach(() => closeLedger(":memory:"));

describe("人工交付", () => {
  test("被指派的人点完成：同一事务 build → review（round+1），actor 记人；text 固定模板，说明与附图进 data 标外部", () => {
    const r = humanDeliver(db, GUEST, input(), 5_000);
    expect(r.duplicate).toBe(false);
    expect(r.row).toMatchObject({ stage: "review", round: 1, assigneeKind: "human", agent: null });
    expect(r.event).toMatchObject({ actor: GUEST, kind: "deliver", text: "T1 人工交付：完成", dedupKey: humanDeliverKey("a1"), ts: 5_000 });
    expect(r.event.data).toEqual({ round: 1, headSHA: null, evidence: null, askId: "a1", external: true, note: "改好了，截图见附件", atts: ["a".repeat(64)] });
    const stage = listEvents(db, { target: "T1" }).find((e) => e.kind === "stage" && e.data.to === "review")!;
    expect(stage).toMatchObject({ actor: GUEST, dedupKey: null, data: { from: "build", to: "review", round: 1 } });
  });
  test("同一条 ask 重复作答 / 重放：返回原事件，只记一条交付", () => {
    humanDeliver(db, GUEST, input());
    const again = humanDeliver(db, OTHER_DEVICE, input({ note: "又点了一次" }));
    expect(again.duplicate).toBe(true);
    expect(kinds().filter((k) => k === "deliver")).toHaveLength(1);
    expect(getTask(db, "T1")!.stage).toBe("review");
  });
  test("合并后同一个人名下的另一台设备、owner 代答都能交付", () => {
    expect(humanDeliver(db, OTHER_DEVICE, input()).row.stage).toBe("review");
    moveStage(db, PM, { taskId: "T1", from: "review", to: "fix" });
    const owner = input({ askId: "a2", ask: { dedupKey: key(1, 2), kind: "assigned" }, answerer: { persons: ["local:owner:self"], isOwner: true } });
    expect(humanDeliver(db, "local:owner:self", owner).row).toMatchObject({ stage: "review", round: 2 });
  });
  test("门不过整笔不写：别的人 forbidden；阶段已变、ask 过时、不是 assigned conflict；actor 不在作答人名下 forbidden", () => {
    const before = kinds();
    expect(errOf(() => humanDeliver(db, "local:guest:ffff", input({ answerer: { persons: ["local:guest:ffff"], isOwner: false } }))).code).toBe("forbidden");
    expect(errOf(() => humanDeliver(db, "local:guest:ffff", input())).code).toBe("forbidden");
    expect(errOf(() => humanDeliver(db, GUEST, input({ ask: { dedupKey: key(0, 2), kind: "assigned" } }))).code).toBe("conflict");
    expect(errOf(() => humanDeliver(db, GUEST, input({ ask: { dedupKey: key(0, 1), kind: "decide" } }))).code).toBe("conflict");
    moveStage(db, PM, { taskId: "T1", from: "build", to: "blocked" });
    expect(errOf(() => humanDeliver(db, GUEST, input())).code).toBe("conflict");
    expect(kinds()).toEqual([...before, "stage"]);
    expect(errOf(() => humanDeliver(db, GUEST, input({ taskId: "T2", ask: { dedupKey: "assign:T2:0:1:agent-x", kind: "assigned" } }))).code).toBe("conflict");
  });
  test("说明太长、附件不是 sha256 或超 9 张：invalid", () => {
    expect(errOf(() => humanDeliver(db, GUEST, input({ note: "字".repeat(4001) }))).code).toBe("invalid");
    expect(errOf(() => humanDeliver(db, GUEST, input({ atts: ["../x"] }))).code).toBe("invalid");
    expect(errOf(() => humanDeliver(db, GUEST, input({ atts: Array.from({ length: 10 }, (_, i) => String(i).repeat(64)) }))).code).toBe("invalid");
    expect(getTask(db, "T1")!.stage).toBe("build");
  });
});

describe("重开指派", () => {
  test("PM 重开：assign_reopen 带 round 与递增的开单序号；旧 ask 过时，新 ask 能交付", () => {
    const r1 = reopenAssignment(db, PM, "T1");
    expect(r1.event).toMatchObject({ kind: "assign_reopen", actor: "agent-pm", data: { round: 0, seq: 2 } });
    expect(reopenAssignment(db, PM, "T1").event.data.seq).toBe(3);
    expect(isAskEvent(r1.event)).toBe(true);
    expect(errOf(() => humanDeliver(db, GUEST, input())).code).toBe("conflict");
    expect(humanDeliver(db, GUEST, input({ askId: "a3", ask: { dedupKey: key(0, 3), kind: "assigned" } })).row.stage).toBe("review");
  });
  test("只有 PM / master / owner；只在 human 节点的 build / fix", () => {
    expect(errOf(() => reopenAssignment(db, { actor: GUEST }, "T1")).code).toBe("forbidden");
    expect(errOf(() => reopenAssignment(db, PM, "T2")).code).toBe("invalid");
    humanDeliver(db, GUEST, input());
    expect(errOf(() => reopenAssignment(db, PM, "T1")).code).toBe("invalid");
    recordReview(db, PM, { taskId: "T1", reviewer: "r", verdict: "changes", p0: 0, p1: 1, p2: 0, move: { from: "review", to: "fix" } });
    expect(reopenAssignment(db, { actor: "owner" }, "T1").event.data).toEqual({ round: 1, seq: 3 });
  });
});

describe("眼下该有的指派 / 过时的指派", () => {
  const open = (dedupKey: string, createdBy = HUMAN_NODE_CREATOR) =>
    openAsk(db, { project: P, taskId: "T1", source: "system", createdBy, kind: "assigned", title: "t", assignee: GUEST, dedupKey });
  const stale = () => staleAssignments(db).map((a) => a.dedupKey);
  test("对得上的不动；离开 build 过时，回到 build 换新 key（不撞上旧的）", () => {
    const a = open(key(0, 1));
    expect(pendingAssignments(db).map((x) => x.plan.dedupKey)).toEqual([key(0, 1)]);
    expect([isCurrentAssignment(db, a), stale()]).toEqual([true, []]);
    moveStage(db, PM, { taskId: "T1", from: "build", to: "blocked" });
    expect([isCurrentAssignment(db, a), stale()]).toEqual([false, [key(0, 1)]]);
    moveStage(db, PM, { taskId: "T1", from: "blocked", to: "build" });
    expect(pendingAssignments(db).map((x) => x.plan.dedupKey)).toEqual([key(0, 2)]);
    expect(stale()).toEqual([key(0, 1)]);
  });
  test("改派：key 换成新的人；改回原来的人也不撞上最早那条", () => {
    open(key(0, 1));
    setTask(db, PM, { id: "T1", rev: getTask(db, "T1")!.rev, patch: { assignee: OTHER_DEVICE } });
    expect(pendingAssignments(db).map((x) => x.plan.dedupKey)).toEqual([key(0, 2, OTHER_DEVICE)]);
    expect(stale()).toEqual([key(0, 1)]);
    setTask(db, PM, { id: "T1", rev: getTask(db, "T1")!.rev, patch: { assignee: GUEST } });
    expect(pendingAssignments(db).map((x) => x.plan.dedupKey)).toEqual([key(0, 3)]);
  });
  test("手工开的 assigned ask 不归这里；项目对不上任务的算过时", () => {
    open("manual-1", "owner:self");
    openAsk(db, { project: "q", taskId: "T1", source: "system", createdBy: HUMAN_NODE_CREATOR, kind: "assigned", title: "t", assignee: GUEST, dedupKey: "q-1" });
    expect(stale()).toEqual(["q-1"]);
    expect(isCurrentAssignment(db, { project: "q", taskId: "T1", dedupKey: key(0, 1) })).toBe(false);
  });
});

describe("CLI：ask-reopen 与 --brief", () => {
  const run = (actor: string, ...args: string[]) =>
    runLedger(args, { db, actor, actorProject: P, projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => 1_000 }) as Promise<
      Record<string, any>
    >;

  test("ask-reopen：PM 能跑、回开单序号，带 --dedup 幂等；执行者不行", async () => {
    expect(await run("agent-pm", "ask-reopen", "T1", "--dedup", "k1")).toMatchObject({ ok: true, seq: 2, duplicate: false });
    expect(await run("agent-pm", "ask-reopen", "T1", "--dedup", "k1")).toMatchObject({ ok: true, duplicate: true });
    expect(await run("agent-x", "ask-reopen", "T1")).toMatchObject({ ok: false, code: "forbidden" });
  });
  test("--brief 并进现有 extra、空串清掉；和 --extra 同给时并进 --extra；超长拒；执行者不能改", async () => {
    const rev = () => String(getTask(db, "T1")!.rev);
    expect((await run("agent-pm", "task-set", "T1", "--rev", rev(), "--extra", '{"talk":{"room":"r"}}')).ok).toBe(true);
    expect((await run("agent-pm", "task-set", "T1", "--rev", rev(), "--brief", "  背景一。背景二。  ")).task.extra).toEqual({ talk: { room: "r" }, brief: "背景一。背景二。" });
    expect((await run("agent-pm", "task-set", "T1", "--rev", rev(), "--extra", '{"x":1}', "--brief", "新背景")).task.extra).toEqual({ x: 1, brief: "新背景" });
    expect((await run("agent-pm", "task-set", "T1", "--rev", rev(), "--brief", "")).task.extra).toEqual({ x: 1 });
    expect(await run("agent-pm", "task-set", "T1", "--rev", rev(), "--brief", "字".repeat(601))).toMatchObject({ ok: false, code: "invalid" });
    expect(await run("agent-x", "task-set", "T2", "--rev", "1", "--brief", "x")).toMatchObject({ ok: false, code: "forbidden" });
    const created = await run("agent-pm", "task-new", "T3", "--title", "t", "--kind", "ops", "--assignee-kind", "human", "--assignee", GUEST, "--brief", "三句背景");
    expect(created.task).toMatchObject({ assigneeKind: "human", assignee: GUEST, agent: null, extra: { brief: "三句背景" } });
  });
});
