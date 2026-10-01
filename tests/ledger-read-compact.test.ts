import { afterEach, expect, test } from "bun:test";
import { openLedger, closeLedger, LEDGER_SCHEMA_VERSION } from "../src/lib/ledger-store";
import { importTask, createItem } from "../src/lib/ledger-write";
import { assignStep } from "../src/lib/ledger-steps-write";
import { projectView, taskDetail, PROJECT_EVENTS_LIMIT } from "../src/lib/ledger-read";
import { homeView, type LedgerOverview } from "../web/features/collab/collab-model";
import { metricsOf, stageCounts, outlineOf } from "../web/features/collab/v4/v4-model";
import { addDep } from "../src/lib/ledger-deps-write";
import { schedulerProjectView } from "../src/lib/ledger-scheduler";

const now = 1_790_875_000_000;
afterEach(() => closeLedger(":memory:"));

test("213-card overview stays below 150KB; terminal details retain steps, metrics and metadata", () => {
  const db = openLedger(":memory:");
  for (let i = 0; i < 3; i++) createItem(db, { actor: "owner", now }, { project: "p", id: `i${i}`, title: `事项 ${i}`, oneLine: "完整协作视图" });
  for (let n = 0; n < 213; n++) {
    const id = `i28-${n}`;
    const stage = n < 184 ? (["done", "verified", "cancelled"] as const)[n % 3] : "build";
    importTask(db, { actor: "owner" }, { createdTs: now - 100_000, initialStage: "review", task: {
      project: "p", id, itemId: `i${n % 3}`, stage, title: `协作功能 ${n}`, kind: "code", agent: `agent-worker-${n}`, pm: "agent-pm",
      extra: { goal: "完整规格和指标".repeat(4), delegate: "worker@peer", notes: "详情材料".repeat(n < 184 ? 55 : 5) },
    }, events: [
      { kind: "review", ts: now - 60_000, text: "审查记录".repeat(20), data: { round: 2, verdict: "pass", p0: 1, p1: 2, p2: 3 } },
      { kind: "stage", ts: now - 50_000, data: { from: "review", to: stage } },
      { kind: "note", ts: now, text: "完成记录".repeat(n < 184 ? 60 : 10), data: { proof: "证据".repeat(n < 184 ? 80 : 5) } },
    ] });
    for (const step of ["write", "review", "fix", "final_review", "ui_check", "merge", "verify"] as const) {
      if (n >= 184 && ["fix", "final_review", "ui_check"].includes(step)) continue;
      assignStep(db, { actor: "owner", now: now - 80_000 }, { taskId: id, step, executor: `agent-worker-${step}`, executorKind: "agent" });
    }
    db.run("UPDATE tasks SET updatedAt = ? WHERE id = ?", [now, id]);
  }
  for (const from of ["i28-0", "i28-1"]) addDep(db, { actor: "owner", now }, { from, to: "i28-212", when: "前置完成" });
  const view = projectView(db, "p", now);
  const details = view.tasks.map((t) => taskDetail(db, "p", t.id, now)!);
  const previous = { ...view, scheduler: schedulerProjectView(db, "p"), tasks: details.map((d) => ({ ...d.task, stepLine: d.stepLine })) };
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify({
    ok: true, exists: true, project: "p", schema: LEDGER_SCHEMA_VERSION, projectEventsLimit: PROJECT_EVENTS_LIMIT, now, ...value as object,
  }));
  console.log(`213 cards: before=${bytes(previous)} after=${bytes(view)} bytes`);
  expect(bytes(previous)).toBeGreaterThan(710_000);
  expect(bytes(view)).toBeLessThanOrEqual(150_000);
  expect(view.tasks).toHaveLength(213);
  expect(view.deps).toHaveLength(2);
  expect(view.items).toHaveLength(3);
  expect(view.scheduler.tasks).toHaveLength(29);
  const wire = (value: unknown) => JSON.parse(JSON.stringify({ exists: true, now, ...value as object })) as LedgerOverview;
  const full = wire(previous), slim = wire(view);
  expect(homeView(slim, now).todayDone).toEqual(homeView(full, now).todayDone);
  expect(metricsOf(slim, 0, 0)).toEqual(metricsOf(full, 0, 0));
  expect(stageCounts(slim)).toEqual(stageCounts(full));
  for (const filter of ["all", "runnable", "waiting", "done", "p0"] as const) {
    const ids = (ov: LedgerOverview) => outlineOf(ov, filter).map((g) => [g.id, g.tasks.map((t) => t.id)]);
    expect(ids(slim)).toEqual(ids(full));
  }
  for (const [i, card] of view.tasks.entries()) {
    const detail = details[i];
    const n = Number(card.id.slice(4));
    if (["done", "verified", "cancelled"].includes(card.stage)) {
      for (const key of ["stepLine", "extra", "lastEvent", "lastReview"]) expect(card).not.toHaveProperty(key);
      expect(card.metrics).toEqual({ endTs: detail.task.metrics.endTs, reviewRounds: 1, reviewWaitPendingMs: undefined, p0: 1, p1: 2 });
      expect(card.metrics.endTs).not.toBe(card.updatedAt); // A later note must not move the completion day.
    } else expect(card.stepLine).toEqual(detail.stepLine);
    expect(detail.task.extra.goal).toBe("完整规格和指标".repeat(4));
    expect(detail.task.metrics.p2).toBe(3);
    expect(detail.stepLine.steps.length).toBeGreaterThanOrEqual(n < 184 ? 7 : 4);
    expect(detail.events.find((e) => e.kind === "note")?.text).toBe("完成记录".repeat(n < 184 ? 60 : 10));
  }
});
