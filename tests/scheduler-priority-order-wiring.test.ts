/**
 * PRIO2 wiring: the real entries (auto tick author / review cards and its budget lift, drivePool's claim re-read, the autostart
 * pick, manualTurn's queue and contest, the next train's boarding) under off / observe / on, with real ledgers and real write paths.
 * The red lines are the off runs: the old order hands the slot to the later card first. Samples reach the ledger only through
 * flushPrioritySamples and the scheduler-identity `ledger scheduler-priority-sample` (a non-scheduler caller is refused).
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { readPriority, readPriorityModes } from "../src/lib/ledger-priority-read.js";
import { setPriority, setPriorityMode, setPriorityOrder } from "../src/lib/ledger-priority-write.js";
import type { PriorityBand, PriorityMode, PriorityTarget } from "../src/lib/ledger-priority-types.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { autostartTick, type StartTickEnv } from "../src/lib/scheduler-autostart-run.js";
import { manualTurn } from "../src/lib/manual-merge-queue.js";
import { mergeTrainTick } from "../src/lib/scheduler-merge-train-tick.js";
import type { TrainGh, TrainState, TrainStore } from "../src/lib/scheduler-merge-train.js";
import { drivePool } from "../src/lib/scheduler-pool-tick.js";
import type { SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { resetSlotQueues } from "../src/lib/scheduler-priority-order.js";
import { flushPrioritySamples, pendingPrioritySamples, PRIORITY_SORT_OP, resetPrioritySamples } from "../src/lib/scheduler-priority-order-record.js";
import { autoFixture } from "./scheduler-auto-helpers.js";
import { ledgerAs, manualCard, requestArgs, writePolicy } from "./manual-merge-queue-world.test.js";
import { reclaimWorld, type ReclaimWorld } from "./scheduler-merge-reclaim-world.js";

const evidence = { ownerWords: "owner 原话", ownerAt: 1000, sourceRef: "discord:owner/1" };
let seq = 0;
const owner = (project: string) => ({ actor: "owner", project, now: 2000, dedupKey: `prio-wiring-${++seq}` });

function band(db: Database, project: string, target: PriorityTarget, b: PriorityBand) {
  setPriority(db, owner(project), { target, rev: readPriority(db, project, target).rev, band: b, evidence });
}
const task = (id: string): PriorityTarget => ({ kind: "task", id });
function mode(db: Database, project: string, m: PriorityMode) {
  setPriorityMode(db, owner(project), { mechanism: "prioritySort", mode: m, rev: readPriorityModes(db, project).prioritySort.rev, evidence });
}
const sampleEvents = (db: Database, project: string) => listEvents(db, { project }).filter((e) => e.data.op === PRIORITY_SORT_OP);

beforeEach(() => { resetPrioritySamples(); resetSlotQueues(); });

describe("auto tick: author and review cards compete in one list", () => {
  let f: ReturnType<typeof autoFixture>;
  beforeEach(() => {
    f = autoFixture();
    for (const id of ["R1", "R2", "T2", "T3"]) {
      createTask(f.db, f.at("owner"), { project: "p", id, title: id, kind: "code", agent: "agent-task-one" });
      setWorkflow(f.db, f.at("owner"), { taskId: id, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "只报错不修" });
    }
    f.db.query("UPDATE tasks SET stage = 'review' WHERE id IN ('R1', 'R2')").run();
    band(f.db, "p", task("R1"), "later"); band(f.db, "p", task("R2"), "now");
    band(f.db, "p", task("T1"), "later"); band(f.db, "p", task("T2"), "now"); // T3: never registered, system next
  });
  afterEach(() => f.close());

  /** The loop's real order: every card reaches prepareAuthor first; deferring it holds the card without stepping it. */
  async function order(pace?: Parameters<typeof schedulerAutoTick>[3]): Promise<string[]> {
    const seen: string[] = [];
    await schedulerAutoTick(f.reader.get()!, { p: { maxActiveWorkers: 2 } }, { ...f.tickDeps,
      prepareAuthor: async (t) => { seen.push(t.id); return { deferred: true, reason: "测试：只看次序" } as never; } }, pace);
    return seen;
  }

  test("红 off：旧次序 finish-first 后按卡号，later 的 R1 先拿名额；on：now → next → later，同档保留 finish-first", async () => {
    mode(f.db, "p", "off");
    expect(await order()).toEqual(["R1", "R2", "T1", "T2", "T3"]);
    expect(pendingPrioritySamples()).toEqual([]);
    mode(f.db, "p", "on");
    expect(await order()).toEqual(["R2", "T2", "T3", "R1", "T1"]);
  });

  test("owner 同档显式顺序在 finish-first 之前；未列出的按旧次序", async () => {
    mode(f.db, "p", "on");
    setPriorityOrder(f.db, owner("p"), { queue: "project", band: "now", rev: 0, evidence, targets: [task("T2"), task("R2")] });
    expect(await order()).toEqual(["T2", "R2", "T3", "R1", "T1"]);
  });

  test("observe：实际次序与旧实现一致；author 与 review 同一份样本，经调度身份 CLI 落库，重复 tick 不刷", async () => {
    expect(await order()).toEqual(["R1", "R2", "T1", "T2", "T3"]);
    const queued = pendingPrioritySamples();
    expect(queued.map((s) => s.data.entry)).toEqual(["author+review"]);
    expect([queued[0]!.data.legacy, queued[0]!.data.would]).toEqual([["R1", "R2", "T1", "T2", "T3"], ["R2", "T2", "T3", "R1", "T1"]]);
    expect(await flushPrioritySamples((...a) => f.cli("scheduler", ...a.slice(1)))).toBe(1);
    expect(sampleEvents(f.db, "p").map((e) => e.data.entry)).toEqual(["author+review"]);
    expect(await order()).toEqual(["R1", "R2", "T1", "T2", "T3"]);
    expect(pendingPrioritySamples()).toEqual([]);
  });

  test("复现 observe-cross-entry-1：各一张 author / review 跨组翻转也有样本，记共享列表完整新旧次序并标注两种覆盖", async () => {
    f.db.query("DELETE FROM task_workflows WHERE taskId IN ('R2', 'T2', 'T3')").run();
    band(f.db, "p", task("T1"), "now");
    expect(await order()).toEqual(["R1", "T1"]);
    const s = pendingPrioritySamples();
    expect(s.map((x) => x.data.entry)).toEqual(["author+review"]);
    expect([s[0]!.data.legacy, s[0]!.data.would]).toEqual([["R1", "T1"], ["T1", "R1"]]);
    expect(s[0]!.data.candidates.map((c) => [c.id, c.entry])).toEqual([["R1", "review"], ["T1", "author"]]);
  });

  test("预算补偿：off 把欠的 later 卡提到队首；on 只在同档内提前，单卡名额也不越过 now", async () => {
    const owed = () => ({ yieldNow: () => false, budgetEnded: () => false, cursor: { autoBudget: "p/R2" } as Record<string, string | undefined> });
    mode(f.db, "p", "off");
    expect(await order(owed())).toEqual(["T1", "R1", "R2", "T2", "T3"]); // fair = T1, the next in rotation after R2
    mode(f.db, "p", "on");
    expect(await order(owed())).toEqual(["R2", "T2", "T3", "T1", "R1"]); // T1 leads its band only
    const one = { ...owed(), lastCard: () => true };
    const seen = await order(one);
    expect(seen[0]).toBe("R2");
    expect(one.cursor.autoBudget).toBe("p/R2"); // the owed card was not served: still owed
  });
});

describe("drivePool：认领前重读档位", () => {
  let f: ReturnType<typeof autoFixture>;
  beforeEach(() => {
    f = autoFixture();
    createTask(f.db, f.at("owner"), { project: "p", id: "T2", title: "T2", kind: "code", agent: "agent-task-one" });
    setWorkflow(f.db, f.at("owner"), { taskId: "T2", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "只报错不修" });
  });
  afterEach(() => f.close());

  async function claimAfterSwap(m: PriorityMode, after?: () => void) {
    mode(f.db, "p", m);
    band(f.db, "p", task("T1"), "now"); band(f.db, "p", task("T2"), "later");
    await schedulerAutoTick(f.reader.get()!, { p: { maxActiveWorkers: 2 } }, { ...f.tickDeps,
      prepareAuthor: async () => ({ deferred: true, reason: "只排序" }) as never });
    band(f.db, "p", task("T1"), "later"); band(f.db, "p", task("T2"), "now"); // the owner swaps the bands after the sort
    after?.();
    const calls: string[][] = [];
    const t1 = f.task();
    const r = await drivePool({ db: f.db, manager: async (...a) => { calls.push(a); return { ok: true, outcome: "queued", text: "挂池" }; },
      notifyPm: async () => {}, lost: () => () => {}, recoveryPolicy: () => ({ mode: "off" }) as never },
    t1, { id: "i-1", taskId: "T1", project: "p" } as SchedulerIntent, 2, undefined);
    return { r, pooled: calls.some((a) => a[1] === "scheduler-pool") };
  }

  test("on：排在后面的卡现在档位更高，本卡让出名额（held 记卡点），不调 scheduler-pool", async () => {
    const { r, pooled } = await claimAfterSwap("on");
    expect(r).toMatchObject({ step: "held", detail: expect.stringContaining("T2（now）") });
    expect(pooled).toBe(false);
  });

  test("复现 claim-eligibility-1：排在后面的高档卡已不合法（done / 被挡），本卡照常认领并记卡点", async () => {
    const { r, pooled } = await claimAfterSwap("on", () => f.db.query("UPDATE tasks SET stage = 'done' WHERE id = 'T2'").run());
    expect(r.step).not.toBe("held");
    expect(pooled).toBe(true);
    expect(pendingPrioritySamples().find((s) => s.data.entry === "local_slot")!.data.claim)
      .toMatchObject({ legacy: "T1", would: "T1", blocked: [{ id: "T2", band: "now", why: expect.stringContaining("done") }] });
  });

  test("observe：照旧认领，只记「本会让出」；off：不重读", async () => {
    const o = await claimAfterSwap("observe");
    expect(o.pooled).toBe(true);
    expect(pendingPrioritySamples().find((s) => s.data.entry === "local_slot")!.data.claim).toMatchObject({ legacy: "T1", would: "T2" });
    resetPrioritySamples();
    const off = await claimAfterSwap("off");
    expect(off.pooled).toBe(true);
    expect(pendingPrioritySamples()).toEqual([]);
  });
});

describe("autostart：开卡候选按 feature 档位", () => {
  async function firstClaim(m: PriorityMode | null, nodes: Record<string, PriorityBand> = {}): Promise<string | null> {
    const f = autoFixture(), { db, dir } = f, project = "p", now = Date.now();
    try {
      db.prepare("UPDATE ledger_instance SET value = 'ab12' WHERE key = 'origin'").run();
      setMeta(db, { actor: "owner", now }, { project, key: "pms", value: ["pm"] });
      for (const slug of ["a", "b", "c"]) {
        const ft = createFeature(db, { actor: "pm", now }, { project, slug, title: slug }).row;
        initDag(db, { actor: "pm", now }, { id: ft.id, rev: 1, nodes: [{ key: "x", oneLine: "节点", fileGlobs: [`src/${slug}.ts`] }] });
      }
      band(db, project, { kind: "feature", id: "ab12-a" }, "later");
      band(db, project, { kind: "feature", id: "ab12-c" }, "now");
      for (const [slug, b] of Object.entries(nodes)) band(db, project, { kind: "node", id: `ab12-${slug}`, nodeKey: "x" }, b);
      if (m) mode(db, project, m);
      const calls: string[][] = [];
      const env: StartTickEnv = {
        db, svc: { autoDispatch: true, projects: [project], maxWorkers: () => 6, pool: () => ({ remote: null, borrow: [] }) } as never,
        readSpec: () => ({ mtimeMs: now - 120_000, text: "# 规格\n" }), now: () => now, memo: new Set(), attempt: () => "test",
        ledger: async (...args) => { calls.push(args); return { ok: false, code: "conflict" }; },
        quota: async () => ({ status: "unknown", source: "none", observedAt: null, plan: null, reason: "测试", windows: [] }),
        notifyPm: async () => {}, plain: async () => { throw new Error("不应开卡"); },
        startEnv: () => ({ ledgerDir: dir, worktreeRoot: dir, projectDirs: async () => [], agentNames: () => [], exists: () => false,
          branchExists: async () => false, autoReady: () => null, template: () => null }),
        stepIO: () => { throw new Error("不应执行"); },
      };
      await autostartTick(env);
      return calls.find((a) => a[1] === "scheduler-autostart" && a[2] === "claim")?.[3] ?? null;
    } finally { f.close(); }
  }

  test("红 off：按 feature 号先开 later 的 a；on：先开 now 的 c；observe：照旧开 a，记本会开 c", async () => {
    expect(await firstClaim("off")).toBe("ab12-a");
    expect(await firstClaim("on")).toBe("ab12-c");
    expect(await firstClaim("observe")).toBe("ab12-a");
    expect(pendingPrioritySamples().find((s) => s.data.entry === "autostart")!.data.would).toEqual(["ab12-c/x", "ab12-b/x", "ab12-a/x"]);
  });

  test("复现 autostart-node-rank-1：节点显式档位覆盖 feature 档位，按可开工节点的有效优先级竞争", async () => {
    const nodes = { a: "now", c: "later" } as const;
    expect(await firstClaim("off", nodes)).toBe("ab12-a");
    expect(await firstClaim("on", nodes)).toBe("ab12-a");
    expect(await firstClaim("on", { c: "next" })).toBe("ab12-b"); // c/x next, b/x next by default: the old feature order decides
  });
});

describe("人工 / 自动合并竞争（manualTurn）", () => {
  let w: ReclaimWorld;
  beforeEach(() => {
    w = reclaimWorld({ store: "memory" });
    setMeta(w.db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: ["agent-pm", "agent-disp"] });
    setMeta(w.db, { actor: "owner", now: 1 }, { project: "p", key: "team", value: { dispatcher: "agent-disp", audit: true } });
    writePolicy("on");
  });
  afterEach(() => { w.close(); rmSync(RECOVERY_POLICY_PATH, { force: true }); });

  test("人工请求队列：红 off 按 eventSeq 先轮 later 的 M1；on 先轮 now 的 M2", async () => {
    for (const id of ["M1", "M2"]) expect((await ledgerAs(w, "agent-pm", ...requestArgs(await manualCard(w, id)))).ok).toBe(true);
    band(w.db, "p", task("M1"), "later"); band(w.db, "p", task("M2"), "now");
    mode(w.db, "p", "off");
    expect(manualTurn(w.db, "p", "none", Date.now())).toMatchObject({ req: { taskId: "M1" } });
    mode(w.db, "p", "on");
    expect(manualTurn(w.db, "p", "none", Date.now())).toMatchObject({ req: { taskId: "M2" } });
    mode(w.db, "p", "observe");
    expect(manualTurn(w.db, "p", "none", Date.now())).toMatchObject({ req: { taskId: "M1" } });
    expect(pendingPrioritySamples().find((s) => s.data.entry === "manual_merge")!.data.would).toEqual(["M2", "M1"]);
  });

  test("自动卡档位更高：on 人工队首让给自动（owed）；off / 同档照旧；owner 同档顺序两个方向都生效", async () => {
    w.card("A");
    expect((await ledgerAs(w, "agent-pm", ...requestArgs(await manualCard(w, "M1")))).ok).toBe(true);
    band(w.db, "p", task("M1"), "later"); band(w.db, "p", task("A"), "now");
    mode(w.db, "p", "off");
    expect(manualTurn(w.db, "p", "none", Date.now()).kind).toBe("due");
    mode(w.db, "p", "on");
    expect(manualTurn(w.db, "p", "none", Date.now())).toMatchObject({ kind: "owed", why: expect.stringContaining("自动卡 A") });
    band(w.db, "p", task("M1"), "now");
    expect(manualTurn(w.db, "p", "none", Date.now()).kind).toBe("due"); // same band, no owner order: the old fairness
    setPriorityOrder(w.db, owner("p"), { queue: "project", band: "now", rev: 0, evidence, targets: [task("A"), task("M1")] });
    expect(manualTurn(w.db, "p", "none", Date.now()).kind).toBe("owed");
    setPriorityOrder(w.db, owner("p"), { queue: "project", band: "now", rev: 1, evidence, targets: [task("M1"), task("A")] });
    expect(manualTurn(w.db, "p", "none", Date.now()).kind).toBe("due");
  });
});

describe("下一班列车选员", () => {
  test("红 off：先到的 later 卡占住文件、now 卡上不了车；on：now 卡先上；在途列车不重排", async () => {
    const run = async (m: PriorityMode) => {
      const w = reclaimWorld({ store: "memory" });
      try {
        const cards = ["T1", "T2", "T3"].map((id) => w.card(id));
        band(w.db, "p", task("T1"), "later"); band(w.db, "p", task("T3"), "now");
        mode(w.db, "p", m);
        let state: TrainState | null = null;
        const store: TrainStore = { load: () => state, all: () => (state ? [state] : []), save: (s) => { state = structuredClone(s); },
          event: () => {}, nextSeq: () => 1 };
        const files: Record<string, string[]> = { T1: ["src/x.ts"], T2: ["src/y.ts"], T3: ["src/x.ts"] };
        const gh = { mainHead: async () => "f".repeat(40), prFiles: async (pr: string) => files[cards.find((c) => c.prRef === pr)!.taskId] ?? [],
          createBranch: async () => {}, mergeInto: async () => "merged" as const, openDraft: async () => 1,
          checks: async () => [{ name: "check", bucket: "pending" as const }] } as unknown as TrainGh;
        await mergeTrainTick(w.db, ["p"], { notifyPm: async () => {}, now: () => 1 }, { gh, store }, () => ["check"]);
        const formed = state as TrainState | null;
        band(w.db, "p", task("T1"), "now"); band(w.db, "p", task("T3"), "later"); // re-band while the train runs
        await mergeTrainTick(w.db, ["p"], { notifyPm: async () => {}, now: () => 1 }, { gh, store }, () => ["check"]);
        return { first: formed?.members.map((x) => x.taskId), after: (state as TrainState | null)?.members.map((x) => x.taskId) };
      } finally { w.close(); }
    };
    expect(await run("off")).toEqual({ first: ["T1", "T2"], after: ["T1", "T2"] });
    expect(await run("on")).toEqual({ first: ["T3", "T2"], after: ["T3", "T2"] });
  });
});

describe("scheduler-priority-sample 写口", () => {
  test("只认调度身份；同一 dedup 只记一次", async () => {
    const f = autoFixture();
    try {
      const data = { op: PRIORITY_SORT_OP, entry: "author", mode: "observe", legacy: ["A"], would: ["A"], changed: false, candidates: [] };
      const args = ["scheduler-priority-sample", "--project", "p", "--dedup", `priority-sort:${"a".repeat(40)}`, "--data", JSON.stringify(data)];
      expect(await f.cli("pm", ...args)).toMatchObject({ ok: false, code: "forbidden" });
      expect(await f.cli("agent-task-one", ...args)).toMatchObject({ ok: false, code: "forbidden" });
      expect(sampleEvents(f.db, "p")).toHaveLength(0);
      expect(await f.cli("scheduler", ...args)).toMatchObject({ ok: true, duplicate: false });
      expect(await f.cli("scheduler", ...args)).toMatchObject({ ok: true, duplicate: true });
      expect(await f.cli("scheduler", ...args.slice(0, -1), "{}")).toMatchObject({ ok: false, code: "invalid" });
      expect(sampleEvents(f.db, "p")).toHaveLength(1);
    } finally { f.close(); }
  });
});
