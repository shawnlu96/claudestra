import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { readPriority, readPriorityModes } from "../src/lib/ledger-priority-read.js";
import { setPriority, setPriorityMode, setPriorityOrder } from "../src/lib/ledger-priority-write.js";
import type { PriorityBand, PriorityMode } from "../src/lib/ledger-priority-types.js";
import { claimFirst, liftWithinBand, mergeContest, sortByPriority, type PriorityKey, type PrioritySortEntry,
  type PriorityReader } from "../src/lib/scheduler-priority-order.js";
import { flushPrioritySamples, PRIORITY_SORT_OP, resetPrioritySamples } from "../src/lib/scheduler-priority-order-record.js";
import { priorityOrderCmds } from "../src/lib/scheduler-priority-order-cmd.js";

let db: Database;
const project = "prio", other = "plain";
const evidence = { ownerWords: "owner 原话", ownerAt: 1000, sourceRef: "discord:owner/1" };
let seq = 0;
const ctx = (p = project) => ({ actor: "owner", project: p, now: 2000, dedupKey: `k${++seq}` });

beforeEach(() => {
  resetPrioritySamples();
  db = openLedger(":memory:");
  for (const id of ["L1", "X1", "N1", "W1", "N2", "L2"]) createTask(db, { actor: "owner" }, { project, id, title: id, kind: "code" });
  createTask(db, { actor: "owner" }, { project: other, id: "P1", title: "P1", kind: "code" });
});
afterEach(() => closeLedger(":memory:"));

function band(id: string, b: PriorityBand | null, p = project) {
  const rev = readPriority(db, p, { kind: "task", id }).rev;
  setPriority(db, ctx(p), { target: { kind: "task", id }, rev, band: b, evidence });
}
function mode(m: PriorityMode, p = project) {
  setPriorityMode(db, ctx(p), { mechanism: "prioritySort", mode: m, rev: readPriorityModes(db, p).prioritySort.rev, evidence });
}
const key = (id: string): PriorityKey => ({ project: id === "P1" ? other : project, taskId: id });
/** The scheduler-identity ledger CLI, reduced to the sample command (tests/scheduler-priority-order-wiring.test.ts runs the real one). */
async function sched(...args: string[]): Promise<Record<string, unknown>> {
  const [, cmd = "", ...rest] = args, flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) flags[rest[i]!.slice(2)] = rest[i + 1]!;
  return priorityOrderCmds[cmd as keyof typeof priorityOrderCmds].run({ db, deps: { actor: "scheduler", projectIds: [project, other] },
    p: { pos: [cmd], flags }, ctx: () => ({ actor: "scheduler", now: 9000 }) });
}
/** Samples are queued by the sort and written by the pass's flush through the scheduler CLI; then read back. */
async function samples(p = project) {
  await flushPrioritySamples(sched);
  return listEvents(db, { project: p }).filter((e) => e.data.op === PRIORITY_SORT_OP);
}
/** The legacy queue: low band first, the way the old order hands out the slot. */
const LEGACY = ["L1", "X1", "N1", "W1", "N2", "L2"];
function grade() { band("L1", "later"); band("L2", "later"); band("N1", "now"); band("N2", "now"); band("W1", "now"); }

const ENTRIES: PrioritySortEntry[] = ["author", "review", "local_slot", "lend_slot", "autostart", "train_boarding", "manual_merge"];

test("红：旧次序（off）把 later 卡先派出；on 下每个名额入口都 now → next → later，同档保留旧顺序", async () => {
  grade();
  mode("off");
  for (const entry of ENTRIES) {
    const r = sortByPriority(db, entry, LEGACY, key);
    expect(r.applied[0]).toBe("L1"); // the red line: the old queue serves the later card first
    expect(r.applied).toEqual(LEGACY);
  }
  mode("on");
  for (const entry of ENTRIES) {
    // X1 is unregistered: system default next, between the bands, never promoted
    expect(sortByPriority(db, entry, LEGACY, key).applied).toEqual(["N1", "W1", "N2", "X1", "L1", "L2"]);
  }
});

test("同档先看 owner 显式顺序，未列出的按调用方旧顺序", async () => {
  grade();
  mode("on");
  setPriorityOrder(db, ctx(), { queue: "project", band: "now", rev: 0, evidence,
    targets: [{ kind: "task", id: "N2" }, { kind: "task", id: "N1" }] });
  expect(sortByPriority(db, "author", LEGACY, key).applied).toEqual(["N2", "N1", "W1", "X1", "L1", "L2"]);
  // a queue the owner never ordered keeps the caller's order inside the band
  expect(sortByPriority(db, "author", LEGACY, key, { queue: "build" }).applied).toEqual(["N1", "W1", "N2", "X1", "L1", "L2"]);
});

test("off 完全沿用旧行为：不读档位、不写样本", async () => {
  grade();
  mode("off");
  const reads: string[] = [];
  const reader: PriorityReader = { mode: () => "off", rank: (_p, id) => { reads.push(String(id)); return { band: "now", source: "x", rev: 1, order: null }; } };
  const r = sortByPriority(db, "author", LEGACY, key, { reader });
  expect(r.applied).toBe(r.legacy);
  expect(r.changed).toBe(false);
  expect(reads).toEqual([]);
  sortByPriority(db, "author", LEGACY, key);
  claimFirst(db, "local_slot", LEGACY, key, () => null);
  expect(mergeContest(db, project, "L1", ["N1"])).toEqual({ winner: "tie", would: "tie", manual: null, auto: null });
  expect((await samples())).toHaveLength(0);
});

test("observe：实际次序与旧实现一致，新旧次序可核对，重复 tick 不刷记录，事实变化才新记一条", async () => {
  grade(); // default mode is observe (PRIO1)
  const first = sortByPriority(db, "review", LEGACY, key, { now: 3000 });
  expect(first.applied).toEqual(LEGACY);
  expect(first.would).toEqual(["N1", "W1", "N2", "X1", "L1", "L2"]);
  expect(first.changed).toBe(true);
  sortByPriority(db, "review", LEGACY, key, { now: 4000 });
  sortByPriority(db, "review", [...LEGACY], key, { now: 5000 });
  const got = (await samples());
  expect(got).toHaveLength(1);
  expect(got[0]!.data).toMatchObject({ entry: "review", mode: "observe", legacy: LEGACY, would: first.would, changed: true });
  expect((got[0]!.data.candidates as { id: string; band: string }[]).find((c) => c.id === "X1")).toMatchObject({ band: "next" });
  expect(got[0]!.text).toContain("旧 L1→X1");
  band("L2", "now"); // band version changed → one new sample
  sortByPriority(db, "review", LEGACY, key);
  sortByPriority(db, "review", LEGACY, key);
  expect((await samples())).toHaveLength(2);
  sortByPriority(db, "author", LEGACY, key); // a different entry is its own sample
  expect((await samples()).map((e) => e.data.entry)).toEqual(["review", "review", "author"]);
});

test("observe 认领：实际按旧次序，记下本会认领的卡", async () => {
  grade();
  const r = claimFirst(db, "lend_slot", LEGACY, key, () => null);
  expect(r.chosen).toBe("L1");
  expect(r.legacyChosen).toBe("L1");
  expect(r.wouldChosen).toBe("N1");
  expect((await samples())[0]!.data).toMatchObject({ entry: "lend_slot", claim: { legacy: "L1", would: "N1", blocked: [] } });
});

test("高档卡被闸门挡住：记卡点，下一张合法候选拿名额，闸门不放宽", async () => {
  grade();
  mode("on");
  const gate = (id: string) => id === "N1" ? "依赖未完成" : id === "W1" ? "文件锁被占" : null;
  const r = claimFirst(db, "author", LEGACY, key, gate);
  expect(r.chosen).toBe("N2");
  expect(r.blocked).toEqual([
    { project, taskId: "N1", band: "now", why: "依赖未完成" }, { project, taskId: "W1", band: "now", why: "文件锁被占" }]);
  // every now card blocked: the next legal card in band order, never a gated one
  const all = claimFirst(db, "author", LEGACY, key, (id) => id.startsWith("N") || id === "W1" ? "容量满" : null);
  expect(all.chosen).toBe("X1");
  expect(claimFirst(db, "author", LEGACY, key, () => "审查闸未过").chosen).toBeNull();
  const s = (await samples()).at(-1)!;
  expect(s.data.claim).toMatchObject({ would: null });
});

test("认领前档位或资格变化：按最新记录处理（不吃排序快照）", async () => {
  grade();
  mode("on");
  const snap = sortByPriority(db, "local_slot", LEGACY, key, { record: false });
  expect(snap.applied[0]).toBe("N1");
  band("N1", "later");
  band("L2", "now");
  let ready = false;
  const r = claimFirst(db, "local_slot", LEGACY, key, (id) => id === "W1" && !ready ? "等审查" : null);
  expect(r.chosen).toBe("N2");
  ready = true;
  expect(claimFirst(db, "local_slot", LEGACY, key, (id) => id === "W1" && !ready ? "等审查" : null).chosen).toBe("W1");
  mode("off"); // switching off right before the claim restores the old pick
  expect(claimFirst(db, "local_slot", LEGACY, key, () => null).chosen).toBe("L1");
});

test("调档不打断在途：pinned（运行中 / 已上车）原位不动，只重排未认领候选", async () => {
  grade();
  mode("on");
  const running = new Set(["L1"]);
  const r = sortByPriority(db, "train_boarding", LEGACY, key, { pinned: (id) => running.has(id) });
  expect(r.applied).toEqual(["L1", "N1", "W1", "N2", "X1", "L2"]);
  expect(claimFirst(db, "train_boarding", LEGACY, key, (id) => running.has(id) ? "已在车上" : null).chosen).toBe("N1");
});

test("预算补偿 / 公平提升只在同档内：later 不会被提到合法 now 前面", async () => {
  grade();
  mode("on");
  const r = sortByPriority(db, "author", ["N1", "X1", "L1", "N2"], key, { record: false });
  expect(r.applied).toEqual(["N1", "N2", "X1", "L1"]);
  expect(liftWithinBand(r, "L1")).toEqual(["N1", "N2", "X1", "L1"]);
  expect(liftWithinBand(r, "X1")).toEqual(["N1", "N2", "X1", "L1"]);
  expect(liftWithinBand(r, "N2")).toEqual(["N2", "N1", "X1", "L1"]);
  // observe / off keep the old lift: straight to the front
  mode("observe");
  const o = sortByPriority(db, "author", ["N1", "X1", "L1", "N2"], key, { record: false });
  expect(liftWithinBand(o, "L1")).toEqual(["L1", "N1", "X1", "N2"]);
});

test("人工 / 自动合并竞争：严格更高档才决定，同档交回原有公平规则", async () => {
  grade();
  mode("on");
  expect(mergeContest(db, project, "L1", ["X1", "N1"])).toMatchObject({ winner: "auto", manual: "later", auto: "now" });
  expect(mergeContest(db, project, "N2", ["X1", "L2"])).toMatchObject({ winner: "manual" });
  expect(mergeContest(db, project, "N2", ["N1"])).toMatchObject({ winner: "tie" });
  expect(mergeContest(db, project, null, ["N1"]).winner).toBe("tie");
  mode("observe");
  expect(mergeContest(db, project, "L1", ["N1"])).toMatchObject({ winner: "tie", would: "auto" });
  expect((await samples()).filter((e) => e.data.entry === "merge_contest").at(-1)!.data).toMatchObject({ contest: "auto", mode: "observe" });
  // the auto candidates the contest sees are the train's legal ones; an ineligible high card is simply not passed in
  mode("on");
  expect(mergeContest(db, project, "X1", ["L2"]).winner).toBe("manual");
});

test("owner 同档显式顺序：提升与合并竞争都不能推翻（lift-order-1 / merge-order-1）", async () => {
  grade();
  mode("on");
  setPriorityOrder(db, ctx(), { queue: "project", band: "now", rev: 0, evidence,
    targets: [{ kind: "task", id: "N2" }, { kind: "task", id: "N1" }] });
  const r = sortByPriority(db, "author", ["N1", "N2", "W1", "L1"], key, { record: false });
  expect(r.applied).toEqual(["N2", "N1", "W1", "L1"]);
  // the owed card N1 stays behind N2 (owner listed it ahead); it still passes the unlisted W1 and the later L1
  expect(liftWithinBand(r, "N1")).toEqual(["N2", "N1", "W1", "L1"]);
  // the unlisted W1 passes nobody the owner ordered; the owner head lifts as before
  expect(liftWithinBand(r, "W1")).toEqual(["N2", "N1", "W1", "L1"]);
  expect(liftWithinBand(r, "N2")).toEqual(["N2", "N1", "W1", "L1"]);
  // merge contest: owner order decides in both directions, ties only when the ranking cannot tell them apart
  expect(mergeContest(db, project, "N1", ["N2"], { record: false })).toEqual({ winner: "auto", would: "auto", manual: "now", auto: "now", autoTaskId: "N2" });
  expect(mergeContest(db, project, "N2", ["N1"], { record: false })).toEqual({ winner: "manual", would: "manual", manual: "now", auto: "now", autoTaskId: "N1" });
  expect(mergeContest(db, project, "N1", ["W1"], { record: false }).winner).toBe("manual");
  expect(mergeContest(db, project, "W1", ["N1", "L1"], { record: false }).winner).toBe("auto");
  expect(mergeContest(db, project, "W1", ["W1"], { record: false }).winner).toBe("tie");
  mode("observe");
  expect(mergeContest(db, project, "N1", ["N2"])).toMatchObject({ winner: "tie", would: "auto" });
  const o = sortByPriority(db, "author", ["N1", "N2", "W1", "L1"], key, { record: false });
  expect(liftWithinBand(o, "L1")).toEqual(["L1", "N1", "N2", "W1"]);
});

test("人工合并请求队列按档位重排，同档保持 eventSeq 次序", async () => {
  grade();
  mode("on");
  const reqs = [{ seq: 1, taskId: "L1" }, { seq: 2, taskId: "N2" }, { seq: 3, taskId: "X1" }, { seq: 4, taskId: "N1" }];
  const r = sortByPriority(db, "manual_merge", reqs, (q) => ({ project, taskId: q.taskId }));
  expect(r.applied.map((q) => q.seq)).toEqual([2, 4, 3, 1]);
});

test("跨项目列表：off 项目的卡原位不动，on 项目只在自己的位置间重排", async () => {
  grade();
  mode("on");
  mode("off", other);
  const r = sortByPriority(db, "autostart", ["L1", "P1", "N1"], key);
  expect(r.applied).toEqual(["N1", "P1", "L1"]);
  expect((await samples(other))).toHaveLength(0);
  expect((await samples())).toHaveLength(1);
});

test("读不到的卡按系统缺省 next，不会被提档；无 db 也照旧", async () => {
  grade();
  mode("on");
  const r = sortByPriority(db, "author", ["L1", "GHOST", "N1"], (id) => ({ project, taskId: id }));
  expect(r.applied).toEqual(["N1", "GHOST", "L1"]);
  expect(r.rankOf("GHOST")?.rank).toMatchObject({ band: "next", source: "unreadable" });
  expect(sortByPriority(null, "author", LEGACY, key).applied).toEqual(LEGACY);
});
