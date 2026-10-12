/**
 * merge-arch-VIEW1 `ledger manual-queue` on a real temp ledger through the formal entries (workflow-set, scheduler-fallback-manual):
 * every manual card listed with active / terminal apart, fields equal to the entry event's facts, unknown history shown as unknown with
 * a PM check, the three merge_unknown situations with three different exits, and reads that change nothing.
 */
import { readdirSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask } from "../src/lib/ledger-write.js";
import { MANUAL_CASE_SLA_HOURS } from "../src/lib/manual-case-defaults.js";
import type { ManualCaseRow } from "../src/lib/manual-case-view.js";
import { autoFixture } from "./scheduler-auto-helpers.js";

type F = ReturnType<typeof autoFixture>;
const HOUR = 3_600_000;

/** A code card created after activation, configured auto, then put into manual at spec and moved to `stage` (fixture shortcut). */
async function manualCard(f: F, id: string, stage: string, reason: string, via: "pm" | "fallback" = "pm") {
  createTask(f.db, f.at("owner"), { project: "p", id, title: id, kind: "code", agent: "agent-task-one" });
  setWorkflow(f.db, f.at("owner"), { taskId: id, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "人工" });
  const r = via === "pm"
    ? await f.cli("pm", "workflow-set", id, "--rev", "1", "--workflow-rev", "1", "--template", "code", "--version", "2", "--mode", "manual",
      "--author-family", "claude", "--fallback", "人工", "--reason", reason)
    : await f.cli("scheduler", "scheduler-fallback-manual", id, "--reason", reason);
  expect(r).toMatchObject({ ok: true });
  if (stage !== "spec") f.db.query("UPDATE tasks SET stage = ? WHERE id = ?").run(stage, id);
  return listEvents(f.db, { project: "p", target: id }).findLast((e) => e.kind === "scheduler")!;
}

const queue = async (f: F, ...extra: string[]) => {
  const r = await f.cli("pm", "manual-queue", "--project", "p", ...extra) as { ok: boolean; active: ManualCaseRow[]; terminal: ManualCaseRow[] };
  expect(r).toMatchObject({ ok: true });
  return r;
};
const row = (r: Awaited<ReturnType<typeof queue>>, id: string) => [...r.active, ...r.terminal].find((x) => x.taskId === id)!;

/** Everything a write would touch: every table's rows (events, workflows, intents, resources …) and the files next to the ledger. */
function world(db: Database, dir: string) {
  const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
  return { rows: Object.fromEntries(tables.map((t) => [t, db.query(`SELECT * FROM "${t}"`).all()])), files: readdirSync(dir).sort() };
}

describe("[验收线 1] every manual card is listed, active and terminal apart, fields from the entry event", () => {
  test("review / fix / merge / blocked / live / verified manual cards", async () => {
    const f = autoFixture();
    try {
      const stages = ["review", "fix", "merge", "blocked", "live", "verified"];
      const entries = new Map<string, Awaited<ReturnType<typeof manualCard>>>();
      for (const s of stages) { entries.set(s, await manualCard(f, `C-${s}`, s, `deps_not_live: 等 T0 上线；解除：T0 verified`)); f.advance(60_000); }
      const r = await queue(f);
      expect(r.active.map((x) => x.taskId).sort()).toEqual(["C-blocked", "C-fix", "C-live", "C-merge", "C-review"]);
      expect(r.terminal.map((x) => x.taskId)).toEqual(["C-verified"]);
      expect(r.active.some((x) => x.taskId === "T1")).toBe(false); // T1 stays auto
      for (const s of stages) {
        const e = entries.get(s)!, x = row(r, `C-${s}`), rec = e.data.manualReason as Record<string, unknown>;
        expect(x).toMatchObject({ stage: s, episodeId: e.seq, since: e.ts, reasonCode: "deps_not_live", structured: true, blocking: rec.blocking,
          owner: { role: "pm", who: "pm" }, due: { at: e.ts + MANUAL_CASE_SLA_HOURS.pm * HOUR, slaHours: 24 } });
        expect(x.owner.source).toContain("缺省");
        expect(x.due.source).toContain("缺省 SLA");
        expect(x.ageMin).toBeGreaterThanOrEqual(0);
      }
      expect(row(r, "C-review")).toMatchObject({ terminal: false, release: "T0 verified", request: null });
      // no edge blocks it, so MAN1's read-only check finds the release met: shown as a candidate only
      expect(row(r, "C-review")).toMatchObject({ candidate: true, gaps: [] });
      expect(row(r, "C-review").nextStep).toContain("本巡检不执行恢复");
      expect(row(r, "C-verified")).toMatchObject({ terminal: true, nextStep: "已到终态 verified，无待处置", candidate: false });
    } finally { f.close(); }
  });

  test("history-hours is checked; the command is read-only for the owner guard", async () => {
    const f = autoFixture();
    try {
      expect(await f.cli("pm", "manual-queue", "--history-hours", "0")).toMatchObject({ ok: false, code: "invalid" });
      expect(await f.cli("pm", "manual-queue", "--history-hours", "x")).toMatchObject({ ok: false, code: "invalid" });
      const { isWriteInvocation, READER_ONLY_SUBS } = await import("../src/manager/write-commands.js");
      expect(isWriteInvocation("ledger", ["manual-queue", "--project", "p"])).toBe(false);
      expect(READER_ONLY_SUBS.has("manual-queue")).toBe(true);
    } finally { f.close(); }
  });
});

describe("[验收线 3] unknown history stays unknown; merge_unknown splits into three exits", () => {
  test("no entry event / no recognisable reason: start unknown, PM check next, no due date invented", async () => {
    const f = autoFixture();
    try {
      // a card put into manual before MAN1 by a direct row (no workflow event at all), its updatedAt is not an entry time
      createTask(f.db, f.at("owner"), { project: "p", id: "OLD", title: "old", kind: "code", agent: "agent-task-one" });
      f.db.query(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, createdAt, updatedAt)
        VALUES ('OLD', 'p', 'code', 2, 'manual', 'claude', '人工', 1, 5, 5)`).run();
      // a legacy takeover with a reason nobody recognises (written before MAN1 refused such text)
      createTask(f.db, f.at("owner"), { project: "p", id: "LEG", title: "leg", kind: "code", agent: "agent-task-one" });
      setWorkflow(f.db, f.at("owner"), { taskId: "LEG", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "人工" });
      f.db.query("UPDATE task_workflows SET mode = 'manual', rev = rev + 1 WHERE taskId = 'LEG'").run();
      const leg = insertEvent(f.db, f.at("pm"), { project: "p", target: "LEG", kind: "scheduler", text: "流程设为 manual",
        data: { op: "workflow", mode: "manual", takeover: "随便写写", manual: true } }, false);
      const r = await queue(f);
      expect(row(r, "OLD")).toMatchObject({ episodeId: null, since: null, ageMin: null, reasonCode: null, structured: false, release: null,
        due: { at: null, overdue: null, source: "进入时间未知，不起算期限" }, owner: { role: "pm" } });
      expect(row(r, "OLD").nextStep).toContain("PM 核对");
      expect(row(r, "OLD").gaps[0]).toContain("没有进入 manual 的正式事件");
      expect(row(r, "LEG")).toMatchObject({ episodeId: leg.seq, since: leg.ts, reasonCode: null, label: "无理由", candidate: false });
      expect(row(r, "LEG").nextStep).toContain("PM 核对");
      expect(row(r, "LEG").gaps).toContain("理由未知：不按关键词猜，不扩大恢复授权");
    } finally { f.close(); }
  });

  test("cancelled retry / merge bounce / real unknown: same code, three sub-reasons, three different exits", async () => {
    const f = autoFixture();
    try {
      await manualCard(f, "U-retry", "merge", "merge_retry_requires_pm：合并意图 i1 已取消，先由 PM 核对外部结果", "fallback");
      await manualCard(f, "U-bounce", "merge", "merge_bounce_limit：反复冲突，可能和别的卡长期改同一处，需要 PM 排期", "fallback");
      await manualCard(f, "U-real", "merge", "merge_unknown: 合并回执丢了，结果不明");
      const r = await queue(f), rows = ["U-retry", "U-bounce", "U-real"].map((id) => row(r, id));
      expect(rows.map((x) => x.reasonCode)).toEqual(["merge_unknown", "merge_unknown", "merge_unknown"]);
      expect(rows.map((x) => [x.subreason, x.mergeVariant])).toEqual([["merge_retry_requires_pm", "cancel_retry"], ["merge_bounce_limit", "merge_bounce"],
        [null, "unknown"]]);
      expect(new Set(rows.map((x) => x.nextStep.split("；")[0])).size).toBe(3);
      expect(new Set(rows.map((x) => x.release)).size).toBe(3);
      expect(rows[2].nextStep).toContain("scheduler-merge-resolve");
      expect(rows[0].nextStep).not.toContain("scheduler-merge-resolve");
      expect(rows[1].nextStep).not.toContain("scheduler-merge-resolve");
      // no merge journal is unknown, so MAN1's journal check says "released"; only the real unknown may be a candidate
      expect(rows.map((x) => x.candidate)).toEqual([false, false, true]);
      expect(rows[0].gaps.join()).toContain("没有只读证据");
      // none of them states its own release: the variant's way out is the default and says so
      expect(rows.map((x) => x.releaseSource)).toEqual(["merge_variant", "merge_variant", "merge_variant"]);
      expect(rows.map((x) => x.release)).toEqual(rows.map((x) => x.variantRelease));
    } finally { f.close(); }
  });

  test("an explicit release on the entry event is kept for all three variants; the variant's way out is shown apart", async () => {
    const f = autoFixture();
    try {
      const own = "owner 核准且外部回执完整";
      const ev = [await manualCard(f, "R-retry", "merge", `merge_retry_requires_pm：合并意图 i1 已取消；解除：${own}`, "fallback"),
        await manualCard(f, "R-bounce", "merge", `merge_bounce_limit：反复冲突；解除：${own}`, "fallback"),
        await manualCard(f, "R-real", "spec", `merge_unknown: 外部结果待核;解除:${own}`)];
      const r = await queue(f), rows = ["R-retry", "R-bounce", "R-real"].map((id) => row(r, id));
      expect(ev.map((e) => (e.data.manualReason as { release: string }).release)).toEqual([own, own, own]);
      expect(rows.map((x) => [x.mergeVariant, x.release, x.releaseSource])).toEqual([["cancel_retry", own, "event"], ["merge_bounce", own, "event"],
        ["unknown", own, "event"]]);
      expect(new Set(rows.map((x) => x.variantRelease)).size).toBe(3);
      expect(rows.every((x) => x.variantRelease !== own)).toBe(true);
    } finally { f.close(); }
  });

  test("a resolve that settled cancelled while auto is a cancelled retry, not a real unknown", async () => {
    const f = autoFixture();
    try {
      insertEvent(f.db, f.at("pm"), { project: "p", target: "T1", kind: "scheduler", text: "合并结清", data: { op: "merge_resolve", outcome: "cancelled", intentId: "m1" } }, false);
      f.db.query("UPDATE task_workflows SET mode = 'manual' WHERE taskId = 'T1'").run();
      expect(row(await queue(f), "T1")).toMatchObject({ reasonCode: "merge_unknown", subreason: "merge_resolve:cancelled", mergeVariant: "cancel_retry" });
    } finally { f.close(); }
  });
});

describe("[验收线 4] reading changes nothing", () => {
  test("consecutive reads: tables, event count, workflow rev, resources, intents and files are identical", async () => {
    const f = autoFixture();
    try {
      await manualCard(f, "A", "review", "pm_takeover: PM 接手；解除：PM 交回");
      await manualCard(f, "B", "merge", "merge_bounce_limit：反复冲突", "fallback");
      const before = world(f.db, f.dir);
      const a = await queue(f, "--history-hours", "48"), b = await queue(f, "--history-hours", "48");
      expect(world(f.db, f.dir)).toEqual(before);
      const strip = (x: typeof a) => ({ ...x, history: { ...(x as unknown as { history: object }).history, from: 0, to: 0 } });
      expect(strip(b)).toEqual(strip(a));
      expect(a.active.length).toBe(2);
    } finally { f.close(); }
  });
});
