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
import { runLedger } from "../src/manager/ledger.js";
import { applyImport, parseOwnerField, parseReviewCounts, parseTs, planImport, type ImportMap } from "../src/manager/ledger-import.js";

const SRC = JSON.parse(readFileSync(resolve(import.meta.dir, "fixtures/ledger-legacy.json"), "utf8")) as Record<string, unknown>;
const P = "claude-orchestrator";
const NOW = Date.parse("2026-09-28T20:00:00+09:00");
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
  test("合成事件：原话 → decision；spec → 开工阶段（startedAt）→ 最终阶段（finishedAt / 导入时刻）；reviews → review（round、计数）；merge → deploy", () => {
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
    expect(t3.events.map((e): [string, number] => [e.kind, e.ts])).toEqual([["decision", at("2026-09-28T15:40:45+09:00")], ["stage", at("2026-09-28T16:01:55+09:00")], ["stage", NOW]]);
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

describe("applyImport", () => {
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
      expect(m).toMatchObject({ startTs: parseTs("2026-09-28T16:01:55+09:00"), endTs: NOW });
      expect(listEvents(db, { target: "T0" }).every((e) => e.data.imported === true)).toBe(true);
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
      expect(await runLedger(["import", src, "--map", map, "--dry-run"], deps)).toMatchObject({ ok: true, dryRun: true, planned: { items: 4, tasks: 3 } });
      expect(listTasks(db, P)).toHaveLength(0);
      writeFileSync(map, JSON.stringify({ ...MAP, tasks: { T0: MAP.tasks.T0 } }));
      expect(await runLedger(["import", src, "--map", map], deps)).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("T3, T8") });
    } finally {
      closeLedger(":memory:");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
