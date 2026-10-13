/**
 * merge-arch-OWN1 review round 1 regressions on a real temp ledger: (observe-id) a card id the ledger accepts but recovery-policy's
 * ASCII observe key does not (中文) neither breaks the round nor misses its own observation; (ci-sla) a bounce-limit episode is 8h only
 * when the escalating merge_conflict's structured cause is a real conflict, CI / update failures keep 2h, in the view and the backfill alike.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask } from "../src/lib/ledger-write.js";
import type { ManualCaseOwner } from "../src/lib/manual-case-owner.js";
import type { ManualCaseRow } from "../src/lib/manual-case-view.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { manualResumeManagerTick } from "../src/lib/scheduler-recovery-ports.js";
import { autoFixture } from "./scheduler-auto-helpers.js";

type F = ReturnType<typeof autoFixture>;
type Row = ManualCaseRow & { owner: ManualCaseOwner };
const HOUR = 3_600_000;
afterEach(() => rmSync(RECOVERY_POLICY_PATH, { force: true }));

const own = (mode: "on" | "observe") => writeFileSync(RECOVERY_POLICY_PATH,
  JSON.stringify({ projects: { p: { keys: { manualCaseOwnership: mode, manualStall: "off", manualRecovery: "off", manualMergeQueue: "off" } } } }));

function card(f: F, id: string) {
  if (getTask(f.db, id)) return;
  createTask(f.db, f.at("owner"), { project: "p", id, title: id, kind: "code", agent: "agent-task-one" });
  setWorkflow(f.db, f.at("owner"), { taskId: id, taskRev: getTask(f.db, id)!.rev, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "人工" });
}
async function mode(f: F, id: string, m: "manual" | "auto", reason: string) {
  card(f, id);
  expect(await f.cli("pm", "workflow-set", id, "--rev", String(getTask(f.db, id)!.rev), "--workflow-rev", String(getWorkflow(f.db, id)!.rev), "--template", "code",
    "--version", "2", "--mode", m, "--author-family", "claude", "--fallback", "人工", "--reason", reason)).toMatchObject({ ok: true });
  return listEvents(f.db, { project: "p", target: id }).findLast((e) => e.kind === "scheduler")!;
}
/** The merge queue's own record of a bounce (scheduler-merge-conflict.ts shape); escalated = the fourth one. */
function bounce(f: F, id: string, cause: "conflict" | "ci_fail" | "update_fail", count: number) {
  card(f, id);
  insertEvent(f.db, { actor: "scheduler", now: f.tickDeps.now() }, { project: "p", target: id, kind: "scheduler", text: `合并队列：退回（${cause}，第 ${count} 次）`,
    data: { op: "merge_conflict", intentId: `i-${id}-${count}`, from: "merging", cause, prHead: "a".repeat(40), mainHead: cause === "conflict" ? "b".repeat(40) : null,
      checks: cause === "ci_fail" ? [{ name: "test", link: "https://ci/1" }] : [], count, escalated: count > 3 } }, true);
}
const BOUNCE = "merge_bounce_limit：反复冲突，可能和别的卡长期改同一处，需要 PM 排期";

const row = async (f: F, id: string) => {
  const r = await f.cli("pm", "manual-queue", "--project", "p") as { ok: boolean; active: Row[] };
  return r.active.find((x) => x.taskId === id)!;
};
const tick = (f: F) => manualResumeManagerTick(f.db, { p: { maxActiveWorkers: 2 } }, { manager: f.tickDeps.manager, notifyPm: f.tickDeps.notifyPm, now: f.tickDeps.now });
const of = (f: F, id: string, op: string) => listEvents(f.db, { project: "p", target: id }).filter((e) => e.data.op === op
  && (op !== "recovery_observe" || e.data.mechanism === "manualCaseOwnership"));
const run = async (body: (f: F) => Promise<void>) => { const f = autoFixture(); try { await body(f); } finally { f.close(); } };

describe("[验收线 2] a card id outside recovery-policy's ASCII observe key is observed once and never starves the round", () => {
  test("A中文 then B-good under observe: two rounds, each card exactly one would-assign; on then backfills both once", () => run(async (f) => {
    await mode(f, "A中文", "manual", "owner_hold: owner 暂停");
    await mode(f, "B-good", "manual", "owner_hold: owner 暂停");
    own("observe");
    await tick(f); await tick(f);
    expect(["A中文", "B-good"].map((id) => of(f, id, "recovery_observe").length)).toEqual([1, 1]);
    expect(of(f, "A中文", "recovery_observe")[0]!.data).toMatchObject({ mechanism: "manualCaseOwnership", wouldAssign: { responsible: "pm", slaHours: 24 } });
    own("on");
    await tick(f); await tick(f);
    expect(["A中文", "B-good"].map((id) => of(f, id, "manual_case_set").length)).toEqual([1, 1]);
    expect(["A中文", "B-good"].map((id) => getWorkflow(f.db, id)!.mode)).toEqual(["manual", "manual"]);
  }));
});

describe("[验收线 1] bounce-limit SLA follows the structured merge_conflict cause: CI 2h, real conflict 8h, view and backfill alike", () => {
  test("pure CI / update-branch bounces → 2h; a conflict escalation → 8h; on records the same deadline the view derived", () => run(async (f) => {
    for (const c of ["ci_fail", "ci_fail", "ci_fail"] as const) bounce(f, "CI", c, ["ci_fail", "ci_fail", "ci_fail"].indexOf(c) + 1);
    bounce(f, "CI", "ci_fail", 4);
    bounce(f, "UP", "update_fail", 4);
    bounce(f, "CF", "ci_fail", 3); bounce(f, "CF", "conflict", 4);
    const at = Object.fromEntries(await Promise.all(["CI", "UP", "CF"].map(async (id) => [id, (await mode(f, id, "manual", BOUNCE)).ts])));
    const want = { CI: 2, UP: 2, CF: 8 } as Record<string, number>;
    for (const id of ["CI", "UP", "CF"]) {
      const r = await row(f, id);
      expect([id, r.subreason, r.due.slaHours, r.due.at]).toEqual([id, "merge_bounce_limit", want[id], at[id] + want[id]! * HOUR]);
    }
    own("on");
    await tick(f);
    for (const id of ["CI", "UP", "CF"]) {
      const rec = of(f, id, "manual_case_set");
      expect([id, rec.length, rec[0]!.data.slaHours, rec[0]!.data.dueAt]).toEqual([id, 1, want[id], at[id] + want[id]! * HOUR]);
      expect((await row(f, id)).due.at).toBe(at[id] + want[id]! * HOUR);
    }
  }));

  test("a real conflict escalation from an earlier, handed-back episode does not make a later CI bounce-limit 8h", () => run(async (f) => {
    bounce(f, "OLD", "conflict", 4);
    await mode(f, "OLD", "manual", BOUNCE);
    await mode(f, "OLD", "auto", "PM 排期后交回");
    bounce(f, "OLD", "ci_fail", 5);
    const e = await mode(f, "OLD", "manual", BOUNCE);
    expect((await row(f, "OLD")).due).toMatchObject({ slaHours: 2, at: e.ts + 2 * HOUR });
  }));
});
