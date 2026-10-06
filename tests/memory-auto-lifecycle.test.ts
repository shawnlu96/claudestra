import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openLedger, closeLedger, getTask, listEvents, toEvent } from "../src/lib/ledger-store.js";
import { createTask, deliver, recordReview, setMeta } from "../src/lib/ledger-write.js";
import { assignStep } from "../src/lib/ledger-steps-write.js";
import { markMemory, memoryState, listMarks } from "../src/lib/ledger-memory.js";
import { ledgerOrigin, ORIGIN_VALUES, originArgs } from "../src/lib/ledger-origin.js";
import { observeMemory } from "../src/lib/memory-auto.js";
import { projectMemories } from "../src/lib/memory-auto-common.js";
import type { LedgerEvent } from "../src/lib/ledger-stages.js";
import type { ReviewFinding } from "../src/lib/scheduler-review.js";

const P = "demo", H = "a".repeat(40);
let db: Database, now: number;
const ctx = () => ({ actor: "owner", now: ++now });
function card(id: string, kind: "code" | "ops" | "investigate" = "code", files = ["src/lib/widget-store.ts"]) {
  createTask(db, ctx(), { project: P, id, title: `Widget ${id}`, kind });
  db.query("UPDATE tasks SET extra = ?, headSHA = ? WHERE id = ?").run(JSON.stringify({ fileGlobs: files }), H, id);
}
function event(target: string, kind: LedgerEvent["kind"], data: Record<string, unknown>, text = ""): LedgerEvent {
  const r = db.query(`INSERT INTO events (ts, actor, project, target, kind, text, data, origin, originSeq)
    VALUES (?, 'owner', ?, ?, ?, ?, ?, ${ORIGIN_VALUES}) RETURNING *`)
    .get(++now, P, target, kind, text, JSON.stringify(data), ...originArgs(db));
  return toEvent(r as Record<string, unknown>);
}
function review(id: string, family = "widget-tx", pitfall = false, round = 1) {
  db.query("UPDATE tasks SET stage = 'build', round = ? WHERE id = ?").run(round - 1, id);
  deliver(db, ctx(), { taskId: id, headSHA: H, moveFrom: "build" });
  assignStep(db, ctx(), { taskId: id, step: "review", executorKind: "agent", executor: "agent-reviewer", round });
  const finding: ReviewFinding = { findingId: `F-${family}`, family, severity: "P1", probe: "事务边界缺失会使读到的 revision 跳号。根因 src/lib/widget-store.ts 写入未包事务",
    basis: "acceptance:1", ...(pitfall ? { pitfall: true as const } : {}) };
  return recordReview(db, ctx(), { taskId: id, reviewer: "agent-reviewer", verdict: "changes", p0: 0, p1: 1, p2: 0,
    path: "report.md", head: H, reviewerSessionId: "review-session", reviewerFamily: "codex", findings: [finding] }).event;
}
const run = () => observeMemory(db, "scheduler", P, { assertLease: () => {}, hasPath: (p) => p === "src/lib/widget-store.ts" });
const pitfalls = () => projectMemories(db, P).filter((m) => m.kind === "pitfall");
const visible = () => pitfalls().filter((m) => ["open", "fixing"].includes(memoryState(db, m.id)!.status));

beforeEach(() => {
  db = openLedger(":memory:"); now = 1000;
  ledgerOrigin(db, () => "ab12");
  setMeta(db, ctx(), { project: P, key: "pms", value: ["agent-pm"] });
});
afterEach(() => closeLedger(":memory:"));

test("§4.4 full example: N2 reviewer → N1f fixing → merge live fixed → N3 filtered → rollback reopened → live fixed", async () => {
  for (const id of ["N1", "N2", "N1f", "N3"]) card(id);
  db.query("UPDATE tasks SET extra = ? WHERE id = 'N2'").run(JSON.stringify({ fileGlobs: ["src/lib/widget-reader.ts"] }));
  const source = review("N2", "widget-tx", true);
  await run();
  const m = pitfalls()[0]!;
  expect(m).toMatchObject({ authorRole: "reviewer", family: "widgettx", fixable: true, files: ["src/lib/widget-store.ts"],
    sources: [{ origin: "ab12", originSeq: source.originSeq }] });
  expect(memoryState(db, m.id)!.status).toBe("open");
  markMemory(db, { actor: "agent-pm", now: ++now }, { memoryId: m.id, mark: "link_fix", taskId: "N1f" });
  expect(memoryState(db, m.id)).toMatchObject({ status: "fixing", fixTask: "N1f" });
  const live = event("N1f", "stage", { from: "merge", to: "live" });
  await Promise.all([run(), run()]);
  expect(memoryState(db, m.id)!.status).toBe("fixed");
  const marks = listMarks(db, m.id).filter((r) => r.mark === "fixed");
  expect(marks).toHaveLength(1);
  expect(marks[0]).toMatchObject({ source: { origin: "ab12", originSeq: live.originSeq },
    dedupKey: `auto:fixed:${m.id}:N1f:ab12/${live.originSeq}` });
  expect(getTask(db, "N3")!.extra.fileGlobs).toContain("src/lib/widget-store.ts");
  expect(visible()).toEqual([]);
  event("N1f", "stage", { from: "live", to: "fix" });
  await run();
  expect(memoryState(db, m.id)).toMatchObject({ status: "open", fixTask: "N1f" });
  expect(visible().map((m) => m.id)).toEqual([m.id]);
  event("N1f", "stage", { from: "merge", to: "live" });
  await run();
  expect(memoryState(db, m.id)!.status).toBe("fixed");
  expect(listMarks(db, m.id).filter((r) => r.mark === "fixed")).toHaveLength(2);
  expect(pitfalls()).toHaveLength(1);
});

test("cancelled fix unlinks, unrelated/project-external/stale pre-link stages do not fix it", async () => {
  for (const id of ["N2", "FIX", "OTHER"]) card(id);
  review("N2", "widget-tx", true); await run();
  const m = pitfalls()[0]!;
  event("FIX", "stage", { from: "merge", to: "live" });
  markMemory(db, { actor: "owner", now: ++now }, { memoryId: m.id, mark: "link_fix", taskId: "FIX" });
  event("OTHER", "stage", { from: "merge", to: "live" });
  await run(); expect(memoryState(db, m.id)!.status).toBe("fixing");
  event("FIX", "stage", { to: "cancelled" }); await run();
  expect(memoryState(db, m.id)).toMatchObject({ status: "open", fixTask: null });
});

test("same normalized family on two cards is candidate; third confirms without a second pitfall; replay adds nothing", async () => {
  for (const [id, family] of [["A", "Widget-Tx"], ["B", "widget_tx"], ["C", "widget.tx"]]) {
    card(id); review(id, family); await run();
    expect(pitfalls()).toHaveLength(id === "A" ? 0 : 1);
    if (id === "B") expect(memoryState(db, pitfalls()[0]!.id)!.status).toBe("candidate");
  }
  const m = pitfalls()[0]!;
  expect(memoryState(db, m.id)!.status).toBe("open");
  expect(m.sources).toHaveLength(2);
  const before = listEvents(db, { project: P }).length;
  await run(); expect(listEvents(db, { project: P })).toHaveLength(before);
  card("D"); review("D", "widget-tx"); await run();
  expect(pitfalls()).toHaveLength(1);
  expect(listMarks(db, m.id).filter((r) => r.mark === "confirm")).toHaveLength(2);
});

test("one card consecutive P1 streak creates candidate, a gap and thirty-day-old card do not", async () => {
  card("A"); review("A"); await run(); review("A", "widget-tx", false, 2); await run();
  expect(pitfalls()).toHaveLength(1);
  expect(memoryState(db, pitfalls()[0]!.id)!.status).toBe("candidate");
  card("OLD"); review("OLD", "other-family"); await run();
  now += 31 * 86400_000;
  card("NEW"); review("NEW", "other-family"); await run();
  expect(pitfalls().filter((m) => m.family === "otherfamily")).toHaveLength(0);
});

test("ops done fixes a linked pitfall and produces a factual summary", async () => {
  card("A"); review("A", "widget-tx", true); await run();
  const m = pitfalls()[0]!; card("OPS", "ops");
  markMemory(db, { actor: "owner", now: ++now }, { memoryId: m.id, mark: "link_fix", taskId: "OPS" });
  event("OPS", "stage", { to: "done" }); await run();
  expect(memoryState(db, m.id)!.status).toBe("fixed");
  expect(projectMemories(db, P).filter((m) => m.kind === "summary")).toHaveLength(1);
});

test("receipt failure rolls back the pitfall and memory timeline in the same transaction", async () => {
  card("A"); review("A", "widget-tx", true);
  db.query(`CREATE TRIGGER fail_auto_receipt BEFORE INSERT ON events
    WHEN json_extract(NEW.data, '$.op') = 'auto_observed' BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END`).run();
  await expect(run()).rejects.toThrow("fixture receipt failure");
  expect(pitfalls()).toEqual([]);
  expect(listEvents(db, { project: P }).filter((e) => e.kind === "memory")).toEqual([]);
  db.query("DROP TRIGGER fail_auto_receipt").run(); await run(); expect(pitfalls()).toHaveLength(1);
});

test("automatic family files intersect collected PR changes, persisted receipts preserve them for a later pass", async () => {
  card("A", "code", ["src/lib/declared-a.ts"]); review("A");
  await observeMemory(db, "scheduler", P, { assertLease: () => {}, files: async () => ["src/lib/shared.ts", "src/lib/a.ts"] });
  card("B", "code", ["src/lib/declared-b.ts"]); review("B");
  await observeMemory(db, "scheduler", P, { assertLease: () => {}, files: async () => ["src/lib/shared.ts", "src/lib/b.ts"] });
  expect(pitfalls()[0]!.files).toEqual(["src/lib/shared.ts"]);
});

test("historical reviewer pitfalls retain the source review's specification revision", async () => {
  card("A"); review("A", "widget-tx", true);
  db.query("UPDATE tasks SET specRev = 2 WHERE id = 'A'").run();
  await run(); expect(pitfalls()[0]).toMatchObject({ head: H, specRev: 1 });
});
