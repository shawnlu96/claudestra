/**
 * merge-arch-VIEW1 history of manual episodes: the full event history replayed through manualEntry, episodes counted by entry time,
 * hold replacement / workflow_resume / a person finishing the card / right truncation kept apart, nearest-rank quantiles over ended
 * episodes only. Entries go through the formal writers (workflow-set, workflow-resume); stage moves are fixture shortcuts.
 */
import { describe, expect, test } from "bun:test";
import { getWorkflow, type TaskWorkflow } from "../src/lib/ledger-scheduler.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask } from "../src/lib/ledger-write.js";
import { manualHistory, nearestRank } from "../src/lib/manual-case-history.js";
import { manualCaseView } from "../src/lib/manual-case-view.js";
import { autoFixture } from "./scheduler-auto-helpers.js";

type F = ReturnType<typeof autoFixture>;
const MIN = 60_000;

const wf = (f: F, id: string) => getWorkflow(f.db, id) as TaskWorkflow;
const rev = (f: F, id: string) => (f.db.query("SELECT rev FROM tasks WHERE id = ?").get(id) as { rev: number }).rev;
const toManual = async (f: F, id: string, reason: string) => expect(await f.cli("pm", "workflow-set", id, "--rev", String(rev(f, id)),
  "--workflow-rev", String(wf(f, id).rev), "--template", "code", "--version", "2", "--mode", "manual", "--author-family", "claude", "--fallback", "人工",
  "--reason", reason)).toMatchObject({ ok: true });
const resume = async (f: F, id: string) => expect(await f.cli("pm", "workflow-resume", id, "--rev", String(rev(f, id)),
  "--workflow-rev", String(wf(f, id).rev), "--reason", "PM 核对后交回")).toMatchObject({ ok: true });
const lastSeq = (f: F) => (f.db.query("SELECT MAX(seq) AS s FROM events").get() as { s: number }).s;
function card(f: F, id: string) {
  createTask(f.db, f.at("owner"), { project: "p", id, title: id, kind: "code", agent: "agent-task-one" });
  setWorkflow(f.db, f.at("owner"), { taskId: id, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "人工" });
}

describe("nearestRank", () => {
  test("nearest-rank on sorted samples; empty = null", () => {
    expect(nearestRank([], 50)).toBeNull();
    expect(nearestRank([7], 90)).toBe(7);
    const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect([nearestRank(ten, 50), nearestRank(ten, 90), nearestRank(ten, 100)]).toEqual([5, 9, 10]);
    expect(nearestRank([1, 2, 3], 50)).toBe(2);
  });
});

describe("[验收线 2] episodes do not run together; a person finishing is not a recovery; truncation stays out of quantiles", () => {
  test("two manual entries, a hold on top, a manual merge to verified, an automatic resume and one never resumed", async () => {
    const f = autoFixture();
    try {
      // T1: manual (E1) → PM resume → manual (E2) → hold (E3 replaces E2) → verified by hand while manual
      await toManual(f, "T1", "pm_takeover: PM 接手核对");
      const e1 = lastSeq(f);
      f.advance(10 * MIN);
      await resume(f, "T1");
      f.advance(MIN);
      await toManual(f, "T1", "deps_not_live: 等 T0 上线");
      const e2 = lastSeq(f);
      f.advance(5 * MIN);
      await toManual(f, "T1", "owner 要亲自盯");
      const e3 = lastSeq(f);
      f.advance(30 * MIN);
      f.db.query("UPDATE tasks SET stage = 'verified' WHERE id = 'T1'").run();
      insertEvent(f.db, f.at("pm"), { project: "p", target: "T1", kind: "stage", text: "人工合并后验收", data: { from: "live", to: "verified" } }, false);
      // T2: manual, the scheduler's own resume (the only automatic recovery)
      card(f, "T2");
      await toManual(f, "T2", "deps_not_live: 等 T1");
      f.advance(20 * MIN);
      insertEvent(f.db, f.at("scheduler"), { project: "p", target: "T2", kind: "scheduler", text: "自动交回", data: { op: "workflow_resume", manual: false } }, false);
      // T3: manual and still open
      card(f, "T3");
      await toManual(f, "T3", "spec_drift: 规格待核");
      const e5 = lastSeq(f);
      f.advance(40 * MIN);

      const h = manualHistory(f.db, "p", 24, f.at("x").now);
      const t1 = h.episodes.filter((x) => x.taskId === "T1");
      expect(t1.map((x) => [x.episodeId, x.end, x.durationMin, x.auto])).toEqual([[e1, "resumed", 10, false], [e2, "hold_replaced", 5, false],
        [e3, "manual_done", 30, false]]);
      expect(new Set(h.episodes.map((x) => `${x.taskId}:${x.episodeId}`)).size).toBe(h.episodes.length);
      expect(h.episodes.find((x) => x.taskId === "T2")).toMatchObject({ end: "resumed", auto: true, durationMin: 20 });
      expect(h.episodes.find((x) => x.taskId === "T3")).toMatchObject({ episodeId: e5, end: "truncated", durationMin: null, endSeq: null });
      expect(h).toMatchObject({ entered: 5, truncated: 1,
        ended: { total: 4, holdReplaced: 1, resumed: 2, autoResumed: 1, modeChanged: 0, manualDone: 1 },
        durationMin: { n: 4, p50: 10, p90: 30 },
        byCode: { pm_takeover: 1, deps_not_live: 2, owner_hold: 1, spec_drift: 1 } });

      // the live view's episodeId is the same entry seq the history ends with
      const v = manualCaseView(f.db, "p", "none", f.at("x").now);
      expect(v.terminal.find((x) => x.taskId === "T1")?.episodeId).toBe(e3);
      expect(v.active.find((x) => x.taskId === "T3")?.episodeId).toBe(e5);

      // the CLI carries the same report
      const r = await f.cli("pm", "manual-queue", "--project", "p", "--history-hours", "24") as Record<string, any>;
      expect(r.history).toMatchObject({ entered: 5, truncated: 1, ended: { total: 4, autoResumed: 1, manualDone: 1 } });
    } finally { f.close(); }
  });

  test("a plain workflow-set out of manual (observe / auto) is a mode change, not a workflow_resume nor a recovery", async () => {
    const f = autoFixture();
    try {
      const set = async (id: string, mode: string) => expect(await f.cli("pm", "workflow-set", id, "--rev", String(rev(f, id)), "--workflow-rev",
        String(wf(f, id).rev), "--template", "code", "--version", "2", "--mode", mode, "--author-family", "claude", "--fallback", "人工")).toMatchObject({ ok: true });
      await toManual(f, "T1", "pm_takeover: PM 接手");
      f.advance(7 * MIN);
      await set("T1", "observe");
      card(f, "T2");
      await toManual(f, "T2", "pm_hold: 先停");
      f.advance(3 * MIN);
      await set("T2", "auto");
      const h = manualHistory(f.db, "p", 24, f.at("x").now);
      expect(h.episodes.map((x) => [x.taskId, x.end, x.endMode, x.auto, x.durationMin])).toEqual([["T1", "mode_changed", "observe", false, 7],
        ["T2", "mode_changed", "auto", false, 3]]);
      expect(h.ended).toEqual({ total: 2, holdReplaced: 0, resumed: 0, autoResumed: 0, modeChanged: 2, manualDone: 0 });
      const r = await f.cli("pm", "manual-queue", "--project", "p", "--history-hours", "24") as { lines: string[] };
      expect(r.lines.at(-1)).toContain("workflow_resume 0");
      expect(r.lines.at(-1)).toContain("改设其他模式 2");
    } finally { f.close(); }
  });

  test("window counts by entry time over the full prehistory; empty window quantiles are null", async () => {
    const f = autoFixture();
    try {
      await toManual(f, "T1", "pm_takeover: PM 接手");
      f.advance(3 * 60 * MIN);
      await resume(f, "T1");
      f.advance(MIN);
      await toManual(f, "T1", "pm_hold: 先停");
      f.advance(MIN);
      const now = f.at("x").now;
      // 2-hour window: the first episode entered 3h ago is out even though it ended inside; the second is open → truncated only
      expect(manualHistory(f.db, "p", 2, now)).toMatchObject({ entered: 1, truncated: 1, ended: { total: 0 }, durationMin: { n: 0, p50: null, p90: null } });
      expect(manualHistory(f.db, "p", 4, now)).toMatchObject({ entered: 2, ended: { total: 1, resumed: 1 }, durationMin: { n: 1, p50: 180, p90: 180 } });
      // events after `now` are not history yet: cut before the second entry, cut before the resume (the first is then still open)
      expect(manualHistory(f.db, "p", 4, now - 2 * MIN)).toMatchObject({ entered: 1, truncated: 0, ended: { resumed: 1 } });
      expect(manualHistory(f.db, "p", 4, now - 3 * MIN)).toMatchObject({ entered: 1, truncated: 1, ended: { total: 0 } });
    } finally { f.close(); }
  });
});
