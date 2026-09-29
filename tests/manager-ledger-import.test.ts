/**
 * ledger import（src/manager/ledger-import.ts）：老台账字段对照、合成事件、重跑幂等。
 * 夹具 tests/fixtures/ledger-legacy.json 是线上 ledger.json 的脱敏样本（只留结构与少量行）；线上副本的对照数据见 T8b 报告。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { taskMetrics } from "../src/lib/ledger-metrics.js";
import { closeLedger, getItem, getMeta, getTask, listEvents, listTasks, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { runLedger } from "../src/manager/ledger.js";
import { applyImport, parseOwnerField, parseReviewCounts, parseTs, planImport, taskTimes, type ImportMap } from "../src/manager/ledger-import.js";

const SRC = JSON.parse(readFileSync(resolve(import.meta.dir, "fixtures/ledger-legacy.json"), "utf8")) as Record<string, unknown>;
const P = "claude-orchestrator";
const NOW = Date.parse("2026-09-28T20:00:00+09:00");
/** 源文件的 updatedAt：缺完成时间的任务退到它（最近一个已知时间），不退到导入时刻 */
const FILE_TS = parseTs("2026-09-28T18:21:16+0900") as number;
const MAP: ImportMap = {
  project: P,
  defaultPm: "agent-claudestra",
  pms: ["claudestra"],
  newItems: [{ id: "i21", title: "新事项", status: "doing" }],
  tasks: {
    T0: { item: "i07", kind: "ops", stage: "done" },
    T3: { item: "i17", kind: "code", stage: "done" },
    T8: { kind: "code", stage: "spec", skip: true, intoItemExtra: "i10" },
  },
  extraTasks: [{ id: "T8a", title: "纯库", item: "i10", kind: "code", stage: "build", agent: "task-t8b", dispatchedAt: "2026-09-28T17:31:01+09:00" }],
};

describe("解析小工具", () => {
  test("parseTs：+0900 与 +09:00 两种写法；坏值 null", () => {
    expect(parseTs("2026-09-28T16:01:55+0900")).toBe(parseTs("2026-09-28T16:01:55+09:00"));
    expect(parseTs("bad-ts")).toBeNull();
    expect(parseTs(undefined)).toBeNull();
  });
  test("parseReviewCounts：「无 P0」「N 个 P1」；没提到的 null", () => {
    expect(parseReviewCounts("无 P0，3 个 P1（…）、8 个 P2")).toEqual({ p0: 0, p1: 3, p2: 8 });
    expect(parseReviewCounts("无新 P0/P1")).toEqual({ p0: null, p1: null, p2: null });
    expect(parseReviewCounts("1 个 P0")).toEqual({ p0: 1, p1: null, p2: null });
  });
  test("parseOwnerField：agent 名、（PM）、待派 / null", () => {
    expect(parseOwnerField("agent-claudestra（PM）")).toEqual({ agent: "agent-claudestra", pm: "agent-claudestra" });
    expect(parseOwnerField("agent-task-t3")).toEqual({ agent: "agent-task-t3", pm: null });
    expect(parseOwnerField("待派")).toEqual({ agent: null, pm: null });
    expect(parseOwnerField(null)).toEqual({ agent: null, pm: null });
  });
});

describe("planImport 字段对照", () => {
  const plan = planImport(SRC, MAP, P, NOW);
  const item = (id: string) => plan.items.find((i) => i.input.id === id)?.input;
  const task = (id: string) => plan.tasks.find((t) => t.task.id === id);

  test("事项：ask → ownerWords；n / summary / links / codex / decisions / decision / updatedAt 原样进 extra；trial 去掉 tasks 进 extra", () => {
    expect(item("i07")).toMatchObject({ ownerWords: "先定编排方式", status: "doing", priority: "P1", oneLine: "编排试跑", next: "扩大第二批" });
    expect(item("i07")?.extra).toMatchObject({ n: 7, summary: "样本摘要", codex: "样本复核", decisions: [], updatedAt: "2026-09-28T16:00:00+09:00", trial: { reviewPolicy: "样本策略" } });
    expect((item("i07")?.extra?.trial as Record<string, unknown>).tasks).toBeUndefined();
    expect(item("i10")?.extra).toMatchObject({ decision: "09-28 17:01 owner 表单" });
    expect(item("i21")).toMatchObject({ project: P, title: "新事项" });
  });
  test("skip 的任务整条挂进指定事项的 extra.skippedTasks，不建任务", () => {
    expect(item("i10")?.extra?.skippedTasks).toEqual({ T8: { id: "T8", title: "台账内置（伞形）", owner: null, status: "T8a 已合并" } });
    expect(task("T8")).toBeUndefined();
  });
  test("任务列：owner 拆成 agent / pm（缺 pm 用 defaultPm）；round = reviews 条数；其余字段进 extra", () => {
    expect(task("T0")?.task).toMatchObject({ kind: "ops", stage: "done", round: 2, agent: "agent-claudestra", pm: "agent-claudestra", branch: "task/t0", itemId: "i07" });
    expect(task("T0")?.task.extra).toMatchObject({ status: "完成（已上线）", metrics: "墙钟约 1 小时", merge: "PR #1 → main abc1234" });
    expect(task("T3")?.task).toMatchObject({ agent: "agent-task-t3", pm: "agent-claudestra", spec: "docs/tasks/T3.md", specRev: 1, model: "claude-opus-5-5 medium" });
    expect(task("T8a")?.task).toMatchObject({ agent: "agent-task-t8b", stage: "build", itemId: "i10" });
  });
  test("合成事件：原话 → decision；spec → 开工阶段（startedAt）→ 最终阶段（finishedAt，缺了退到源文件 updatedAt 并标 approxTime）；reviews → review；merge → deploy", () => {
    const t0 = task("T0")!;
    const fin = parseTs("2026-09-28T15:40:25+09:00");
    expect(t0.createdTs).toBe(fin as number);
    expect(t0.events.map((e) => [e.kind, e.data?.from ?? null, e.data?.to ?? null])).toEqual([
      ["stage", "spec", "build"], ["review", null, null], ["review", null, null], ["deploy", null, null], ["stage", "build", "done"],
    ]);
    expect(t0.events[1].data).toMatchObject({ round: 1, p0: 0, p1: 3, p2: null, reviewer: null, verdict: null });
    expect(t0.events[3].data).toEqual({ version: "PR #1 → main abc1234", rollbackPoint: "main 0000000" });
    const t3 = task("T3")!;
    const at = (s: string) => parseTs(s) as number;
    expect(t3.events.map((e): [string, number] => [e.kind, e.ts])).toEqual([["decision", at("2026-09-28T15:40:45+09:00")], ["stage", at("2026-09-28T16:01:55+09:00")], ["stage", FILE_TS]]);
    expect(t3.events.map((e) => e.data?.approxTime ?? false)).toEqual([false, false, true]);
    expect(t0.createdApprox).toBe(true);
    expect(t0.events[0].data).toMatchObject({ approxTime: true });
  });
  test("log 按时间稳定排序；没导入的事项 → 项目级并保留原 item；ownerInbox 只指一个已导入任务的挂任务，其余项目级", () => {
    const notes = plan.events.filter((e) => e.kind === "note" && e.data.source !== "morning");
    expect(notes.map((e) => e.text)).toEqual(["第一条（原文件里排在后面）", "第二条（与第三条同一时刻）", "指向没导入的事项", "项目级", "项目级"]);
    expect(notes[2]).toMatchObject({ target: "", data: { item: "i12" } });
    const inbox = plan.events.filter((e) => e.kind === "decision");
    expect(inbox.map((e) => e.target)).toEqual(["T3", "", ""]);
    expect(inbox[0].data).toMatchObject({ source: "ownerInbox", transcribed: true, status: "done", to: "T3" });
    expect(plan.events.find((e) => e.data.source === "morning")?.text).toBe("早上先看这里\n- 要点一\n- 要点二");
  });
  test("源文件里有、映射没写的任务列进 unmapped；映射到不存在的事项直接报错", () => {
    const { T3: _t3, ...rest } = MAP.tasks;
    expect(planImport(SRC, { ...MAP, tasks: rest }, P, NOW).unmapped).toEqual(["T3"]);
    expect(() => planImport(SRC, { ...MAP, tasks: { ...MAP.tasks, T3: { item: "i99", kind: "code", stage: "done" } } }, P, NOW)).toThrow("i99");
  });
});

describe("时间与轮次（审查第 1 轮 P1-3 / P2-6）", () => {
  test("taskTimes：映射覆盖 > 源字段 > 最近已知时间；推断的标 approx", () => {
    const src = { dispatchedAt: "2026-09-28T15:00:00+09:00" };
    const m = { kind: "code" as const, stage: "done" as const, finishedAt: "2026-09-28T17:00:00+09:00" };
    const t = taskTimes(src, m, FILE_TS);
    const at = (v: string) => parseTs(v) as number;
    expect(t.created).toEqual({ ts: at("2026-09-28T15:00:00+09:00"), approx: false });
    expect(t.started).toEqual({ ts: at("2026-09-28T15:00:00+09:00"), approx: true });
    expect(t.ended).toEqual({ ts: at("2026-09-28T17:00:00+09:00"), approx: false });
    expect(taskTimes({}, { kind: "code", stage: "spec" }, FILE_TS)).toEqual({
      created: { ts: FILE_TS, approx: true }, started: { ts: FILE_TS, approx: true }, ended: { ts: FILE_TS, approx: true },
    });
    const override = taskTimes({ dispatchedAt: "2026-09-28T15:00:00+09:00" }, { ...m, dispatchedAt: "2026-09-28T14:00:00+09:00" }, FILE_TS);
    expect(override.created.ts).toBe(parseTs("2026-09-28T14:00:00+09:00") as number);
  });
  test("到过 review 的任务 round 至少 1（源里没有 reviews 也一样）", () => {
    const plan = planImport(SRC, MAP, P, NOW);
    expect(plan.tasks.find((t) => t.task.id === "T3")?.task.round).toBe(1);
    expect(plan.tasks.find((t) => t.task.id === "T0")?.task.round).toBe(2);
    expect(plan.tasks.find((t) => t.task.id === "T8a")?.task.round).toBe(0);
  });
});

/** 时间线无倒序：每个目标的第一条事件就是它的建立事件；任务不早于它挂的事项；任务的阶段事件时间不回退 */
function timelineProblems(db: ReturnType<typeof openLedger>): string[] {
  const out: string[] = [];
  const firstTs = new Map<string, number>();
  for (const e of listEvents(db)) {
    if (!e.target) continue;
    const created = e.kind === "item" || (e.kind === "task" && e.data.op === "new");
    if (created && !firstTs.has(e.target)) firstTs.set(e.target, e.ts);
    else if (!firstTs.has(e.target)) out.push(`${e.target} 的 ${e.kind} 早于它的建立事件`);
    else if (e.ts < (firstTs.get(e.target) as number)) out.push(`${e.target} 的 ${e.kind} 时间早于建立`);
  }
  for (const t of listTasks(db, P)) {
    if (t.itemId && (firstTs.get(t.id) ?? 0) < (firstTs.get(t.itemId) ?? 0)) out.push(`${t.id} 早于事项 ${t.itemId}`);
    const stages = listEvents(db, { target: t.id }).filter((e) => e.kind === "stage").map((e) => e.ts);
    if (stages.some((ts, i) => i > 0 && ts < stages[i - 1])) out.push(`${t.id} 阶段时间回退`);
  }
  return out;
}

describe("时间线顺序（审查复验 P2）", () => {
  test("事项创建时间取 updatedAt / 最早 log / 最早挂上的任务里最早的，一律标 approxTime；没有任何线索的取源文件 updatedAt", () => {
    const plan = planImport(SRC, MAP, P, NOW);
    const ts = (id: string) => plan.items.find((i) => i.input.id === id)?.ts;
    expect(ts("i10")).toBe(parseTs("2026-09-28T03:30:00+09:00") as number);
    expect(ts("i07")).toBe(plan.tasks.find((t) => t.task.id === "T0")?.createdTs as number);
    expect(ts("i21")).toBe(FILE_TS);
  });
  test("挂到任务上的决定早于派发：建任务提前到决定那一刻并标 approxTime", () => {
    const late = { ...MAP, tasks: { ...MAP.tasks, T3: { ...MAP.tasks.T3, dispatchedAt: "2026-09-28T17:30:00+09:00", startedAt: "2026-09-28T17:40:00+09:00" } } };
    const t3 = planImport(SRC, late, P, NOW).tasks.find((t) => t.task.id === "T3")!;
    expect(t3.createdTs).toBe(parseTs("2026-09-28T17:23:38+0900") as number);
    expect(t3.createdApprox).toBe(true);
  });
  test("导入后整条时间线没有倒序，事项事件都标 approxTime", () => {
    const db = openLedger(":memory:");
    try {
      applyImport(db, planImport(SRC, MAP, P, NOW));
      expect(timelineProblems(db)).toEqual([]);
      expect(listEvents(db).filter((e) => e.kind === "item").every((e) => e.data.approxTime === true)).toBe(true);
    } finally {
      closeLedger(":memory:");
    }
  });
  test("映射里只改了时间：重跑报 conflict（任务时间线指纹、事项创建时间都算变化）", () => {
    const db = openLedger(":memory:");
    try {
      applyImport(db, planImport(SRC, MAP, P, NOW));
      const moved = { ...MAP, tasks: { ...MAP.tasks, T3: { ...MAP.tasks.T3, finishedAt: "2026-09-28T17:00:00+09:00" } } };
      expect(() => applyImport(db, planImport(SRC, moved, P, NOW))).toThrow(/任务 T3（fingerprint）/);
    } finally {
      closeLedger(":memory:");
    }
  });
});

describe("applyImport", () => {
  test("PM 名单只在为空时写：已有别的名单就整批拒绝，提示走 team-apply；名单相同（重跑）照常幂等", () => {
    const db = openLedger(":memory:");
    try {
      setMeta(db, { actor: "owner", now: 1 }, { project: P, key: "pms", value: ["agent-other"] });
      const plan = planImport(SRC, MAP, P, NOW);
      expect(() => applyImport(db, plan)).toThrow("team-apply");
      expect(getMeta(db, P).pms).toEqual(["agent-other"]);
      expect(listTasks(db, P)).toEqual([]); // 整批回滚
      setMeta(db, { actor: "owner", now: 2 }, { project: P, key: "pms", value: ["agent-claudestra"] });
      expect(applyImport(db, plan).tasks.created).toBe(3);
    } finally {
      closeLedger(":memory:");
    }
  });

  test("写库计数、重跑全部 duplicate；完全相同的两条 log 只记一条；导入的任务指标能算", () => {
    const db = openLedger(":memory:");
    try {
      const plan = planImport(SRC, MAP, P, NOW);
      const first = applyImport(db, plan);
      expect(first).toEqual({ items: { created: 4, duplicate: 0 }, tasks: { created: 3, duplicate: 0 }, events: { created: 8, duplicate: 1 } });
      expect(applyImport(db, plan)).toEqual({ items: { created: 0, duplicate: 4 }, tasks: { created: 0, duplicate: 3 }, events: { created: 0, duplicate: 9 } });
      expect(getMeta(db, P).pms).toEqual(["agent-claudestra"]);
      expect(getItem(db, P, "i17")?.ownerWords).toBe("你的截止 4:45");
      expect(listTasks(db, P).map((t) => [t.id, t.stage])).toEqual([["T0", "done"], ["T3", "done"], ["T8a", "build"]]);
      const t3 = getTask(db, "T3")!;
      const m = taskMetrics(t3, listEvents(db, { target: "T3" }), NOW);
      expect(m).toMatchObject({ startTs: parseTs("2026-09-28T16:01:55+09:00"), endTs: FILE_TS });
      const all = listEvents(db, { project: P });
      expect(all.every((e) => e.actor === "import" && e.data.imported === true)).toBe(true);
    } finally {
      closeLedger(":memory:");
    }
  });
  test("整批一个事务：半路失败全部回滚；dry-run 跑同样的库内校验、跑完也回滚", () => {
    const db = openLedger(":memory:");
    try {
      const bad = planImport(SRC, { ...MAP, tasks: { ...MAP.tasks, T3: { item: "i17", kind: "investigate", stage: "live" } } }, P, NOW);
      expect(() => applyImport(db, bad, true)).toThrow("任务 T3");
      expect(() => applyImport(db, bad)).toThrow("任务 T3");
      expect([listTasks(db, P).length, listEvents(db).length]).toEqual([0, 0]);
      const good = planImport(SRC, MAP, P, NOW);
      expect(applyImport(db, good, true).tasks).toEqual({ created: 3, duplicate: 0 });
      expect(listEvents(db)).toHaveLength(0);
    } finally {
      closeLedger(":memory:");
    }
  });
  test("改了映射后重跑：dedup 命中但值不同就报 conflict 并回滚，不静默沿用旧值", () => {
    const db = openLedger(":memory:");
    try {
      applyImport(db, planImport(SRC, MAP, P, NOW));
      const before = listEvents(db).length;
      const changed = planImport(SRC, { ...MAP, tasks: { ...MAP.tasks, T3: { item: "i17", kind: "code", stage: "live" } } }, P, NOW);
      expect(() => applyImport(db, changed)).toThrow(/任务 T3（stage/);
      expect([getTask(db, "T3")?.stage, listEvents(db).length]).toEqual(["done", before]);
    } finally {
      closeLedger(":memory:");
    }
  });
  test("CLI：dry-run 只报计划；映射漏任务拒绝导入", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-import-"));
    const db = openLedger(":memory:");
    try {
      const src = join(dir, "ledger.json");
      writeFileSync(src, JSON.stringify(SRC));
      const map = join(dir, "map.json");
      writeFileSync(map, JSON.stringify(MAP));
      const deps = { db, actor: "owner", projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => NOW };
      expect(await runLedger(["import", src, "--map", map, "--dry-run"], deps)).toMatchObject({ ok: true, dryRun: true, planned: { items: 4, tasks: 3 }, result: { tasks: { created: 3 } } });
      expect(listTasks(db, P)).toHaveLength(0);
      writeFileSync(map, JSON.stringify({ ...MAP, tasks: { T0: MAP.tasks.T0 } }));
      expect(await runLedger(["import", src, "--map", map], deps)).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("T3, T8") });
    } finally {
      closeLedger(":memory:");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
