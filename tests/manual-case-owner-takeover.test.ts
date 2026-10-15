/**
 * merge-arch-OWN1f1: a pm_takeover is not a hold. Its default response deadline follows the reason it took over: the latest classifiable
 * reason earlier in the same manual run (never past where that run began), 4h when there is none. Hold codes and unknown reasons keep
 * 24h and every other code keeps its tier. Pure part: the five observed episodes' event shapes (ids and texts rewritten, event types and
 * structured fields kept). Ledger part: the same through workflow-set, the manual queue and the observe note.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import type { LedgerEvent, LedgerTask } from "../src/lib/ledger-stages.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask } from "../src/lib/ledger-write.js";
import { MANUAL_CASE_SLA_BY_CODE, manualCaseDefaults, REAL_CONFLICT_SUB } from "../src/lib/manual-case-defaults.js";
import { manualCaseOwnership, pendingDefault, type ManualCaseOwner } from "../src/lib/manual-case-owner.js";
import type { ManualCaseRow } from "../src/lib/manual-case-view.js";
import { manualEntry, MANUAL_REASON_CODES, type ManualReasonCode } from "../src/lib/manual-reason.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { manualResumeManagerTick } from "../src/lib/scheduler-recovery-ports.js";
import { autoFixture } from "./scheduler-auto-helpers.js";

const HOUR = 3_600_000;
const META = { pms: ["pm"], activePm: "pm", team: null };
const TASK = { id: "T", project: "p", kind: "code", stage: "review", agent: "agent-task-one", pm: "pm" } as LedgerTask;

/** A synthetic card history: each step is one ledger event, seq / ts in order. */
function history(steps: { kind?: LedgerEvent["kind"]; actor?: string; text?: string; data: Record<string, unknown> }[]): LedgerEvent[] {
  return steps.map((s, i) => ({ seq: 100 + i, ts: (i + 1) * HOUR, actor: s.actor ?? "pm", project: "p", target: "T", kind: s.kind ?? "scheduler",
    text: s.text ?? "", data: s.data, dedupKey: null }));
}
const reason = (code: ManualReasonCode, text: string) => ({ v: 1, code, label: code, text, blocking: null, release: "", node: "", approval: false, specRev: 1, head: null, uiDigest: null });
const auto = { data: { op: "workflow", mode: "auto" }, actor: "scheduler" };
const takeover = (text: string, hold = false) => ({ data: { op: "workflow", mode: "manual", takeover: text, manual: true, ...(hold ? { hold: text } : {}),
  manualReason: reason("pm_takeover", text) } });
const fallback = (code: ManualReasonCode, text: string) => ({ actor: "scheduler", data: { op: "fallback_manual", from: "auto", reason: text, manualReason: reason(code, text) } });
const resume = { data: { op: "workflow_resume", from: "manual", reason: "PM 交回" } };
const bounce = (cause: "conflict" | "ci_fail" | "update_fail", intentId = "i-merge") =>
  ({ actor: "scheduler", data: { op: "merge_conflict", intentId, from: "merging", cause, prHead: "a".repeat(40), count: 4, escalated: true } });
const BOUNCE = "merge_bounce_limit：反复退回，需要 PM 排期";

/** What the view and the backfill both say for the card's current episode. */
function hours(events: LedgerEvent[]): { view: number; backfill: number } {
  const entry = manualEntry(events)!;
  const view = manualCaseOwnership(manualCaseDefaults(entry.code, entry.event.ts, TASK, META), TASK, events, entry, META).due.slaHours;
  const p = pendingDefault(TASK, "manual", events, META);
  if (!p.ok) throw new Error(p.why);
  return { view, backfill: p.value.slaHours };
}

describe("[验收线 1] the five observed episodes", () => {
  test("four pm_takeover entries whose run begins at the takeover: 4h (was 24h)", () => {
    // placement: the local author's branch refused by the lending peer, PM takes over to route around placement
    expect(hours(history([auto, takeover("fix 挂池给 peer，出单因分支是本机作者的被拒，PM 接管")]))).toEqual({ view: 4, backfill: 4 });
    // review source: no bound author, reviewer not independent; the earlier materials_gate run ended with a resume and is not crossed
    expect(hours(history([auto, takeover("修复单被外发闸拒，改本机修"), resume,
      takeover("pm_takeover：卡上没有绑定作者，审查员与作者不独立；PM 转人工改派跨族审查")]))).toEqual({ view: 4, backfill: 4 });
    // environment: lending peer out of quota / offline, no review seat
    const first = [auto, takeover("私仓卡审查只派 peer，出借方停接 / 掉线，没有跨模型审查位，PM 接管")];
    expect(hours(history(first))).toEqual({ view: 4, backfill: 4 });
    // environment / dispatch source: a push timeout counted as tried, no free seat, the card waited 3h unreminded
    expect(hours(history([...first, resume, takeover("审查推送超时被撤又记为已试过、无空位，调度器干等；PM 手动定向派审")]))).toEqual({ view: 4, backfill: 4 });
  });

  test("fix_report (missing the previous full review report) stays 8h until it carries a structured signal (ask to PM, default A)", () => {
    expect(hours(history([auto, fallback("runtime_unavailable", "author_family：执行 session 与任务作者不一致"), resume,
      fallback("review_unresolved", "fix_report：修复阶段缺上一轮完整审查报告")]))).toEqual({ view: 8, backfill: 8 });
  });
});

describe("[验收线 2] a takeover inside a manual run answers at the tier of the reason it took over", () => {
  test("a CI-failure bounce limit → 2h; a real conflict → 8h; the takeover's own texts are unchanged", () => {
    const ci = history([auto, bounce("ci_fail"), fallback("merge_unknown", BOUNCE), takeover("pm_takeover：PM 接手核对", true)]);
    expect(hours(ci)).toEqual({ view: 2, backfill: 2 });
    const conflict = history([auto, bounce("conflict"), fallback("merge_unknown", BOUNCE), takeover("pm_takeover：PM 接手核对", true)]);
    expect(hours(conflict)).toEqual({ view: 8, backfill: 8 });
    const p = pendingDefault(TASK, "manual", conflict, META);
    expect(p.ok && p.value.source).toBe("缺省：理由码 pm_takeover → pm（卡的 PM）；缺省 SLA：理由码 pm_takeover 响应 8 小时，从进入 manual 起算");
  });

  test("evidence inside the run wins over the run's first entry; a coded escalation counts, a code-less sentence is never guessed at", () => {
    const coded = { kind: "escalate" as const, text: "ui_stale：截图许可绑定的 head 已过期", data: { to: "pm", reason: "ui_stale：截图许可绑定的 head 已过期" } };
    expect(hours(history([auto, fallback("review_unresolved", "review_block：审查不通过"), coded, takeover("PM 接手", true)]))).toEqual({ view: 2, backfill: 2 });
    const loose = { kind: "escalate" as const, text: "截图过期了，审查也没过", data: { to: "pm", reason: "截图过期了，审查也没过" } };
    expect(hours(history([auto, fallback("review_unresolved", "review_block：审查不通过"), loose, takeover("PM 接手", true)]))).toEqual({ view: 8, backfill: 8 });
    expect(hours(history([auto, fallback("review_unresolved", "review_block：审查不通过"), bounce("conflict"), takeover("PM 接手", true)]))).toEqual({ view: 8, backfill: 8 });
  });

  test("nested takeovers / unknown entries are walked over inside the run; nothing classifiable → 4h; never past the run's start", () => {
    const unknown = { data: { op: "workflow", mode: "manual", takeover: "随便写写", manual: true } };
    expect(hours(history([auto, fallback("review_unresolved", "review_block：审查不通过"), takeover("PM 接手", true), takeover("PM 再接手", true)])))
      .toEqual({ view: 8, backfill: 8 });
    expect(hours(history([auto, unknown, takeover("PM 接手", true)]))).toEqual({ view: 4, backfill: 4 });
    // the earlier run (a real conflict, 8h) ended with a resume: the takeover that starts a new run does not reach back into it
    expect(hours(history([auto, bounce("conflict"), fallback("merge_unknown", BOUNCE), resume, bounce("conflict", "i-2"), takeover("PM 接手")])))
      .toEqual({ view: 4, backfill: 4 });
    // a hold taken over keeps the hold's tier
    expect(hours(history([auto, fallback("owner_hold", "owner_hold: owner 暂停"), takeover("PM 接手", true)]))).toEqual({ view: 24, backfill: 24 });
  });
});

describe("[验收线 3] every other code keeps its tier", () => {
  /** The table before this card, pm_takeover aside. */
  const BEFORE: Record<Exclude<ManualReasonCode, "pm_takeover">, number> = {
    safety_refusal: 2, ui_evidence_stale: 2, merge_unknown: 2,
    write_lease_ended: 4, runtime_unavailable: 4, review_source_missing: 4, materials_gate: 4, spec_drift: 4, questionnaire: 4, start_rollback: 4,
    review_unresolved: 8, owner_hold: 24, pm_hold: 24, foreign_repo: 24, deps_not_live: 24,
  };
  test("table-driven over every reason code, plus unknown and the merge_unknown sub-reasons", () => {
    const h = (code: ManualReasonCode | null, sub: string | null = null) => manualCaseDefaults(code, 0, { agent: "x", pm: null }, META, sub).due.slaHours;
    for (const code of MANUAL_REASON_CODES) expect([code, h(code)]).toEqual([code, code === "pm_takeover" ? 4 : BEFORE[code]]);
    expect(Object.keys(MANUAL_CASE_SLA_BY_CODE).sort()).toEqual([...MANUAL_REASON_CODES].sort());
    expect([h(null), h("merge_unknown", REAL_CONFLICT_SUB), h("merge_unknown", "merge_bounce_limit")]).toEqual([24, 8, 2]);
    // a basis only ever moves a takeover
    expect(manualCaseDefaults("pm_hold", 0, { agent: "x", pm: null }, META, null, { code: "ui_evidence_stale", sub: null }).due.slaHours).toBe(24);
  });
});

type F = ReturnType<typeof autoFixture>;
type Row = ManualCaseRow & { owner: ManualCaseOwner };
afterEach(() => rmSync(RECOVERY_POLICY_PATH, { force: true }));
const run = async (body: (f: F) => Promise<void>) => { const f = autoFixture(); try { await body(f); } finally { f.close(); } };

async function manual(f: F, id: string, why: string) {
  if (!getTask(f.db, id)) {
    createTask(f.db, f.at("owner"), { project: "p", id, title: id, kind: "code", agent: "agent-task-one" });
    setWorkflow(f.db, f.at("owner"), { taskId: id, taskRev: getTask(f.db, id)!.rev, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "人工" });
  }
  expect(await f.cli("pm", "workflow-set", id, "--rev", String(getTask(f.db, id)!.rev), "--workflow-rev", String(getWorkflow(f.db, id)!.rev), "--template", "code",
    "--version", "2", "--mode", "manual", "--author-family", "claude", "--fallback", "人工", "--reason", why)).toMatchObject({ ok: true });
  return listEvents(f.db, { project: "p", target: id }).findLast((e) => e.kind === "scheduler")!;
}
function escalatedBounce(f: F, id: string, cause: "conflict" | "ci_fail") {
  insertEvent(f.db, { actor: "scheduler", now: f.tickDeps.now() }, { project: "p", target: id, kind: "scheduler", text: `合并队列：第 4 次退回（${cause}）`,
    data: { op: "merge_conflict", intentId: `i-${id}`, from: "merging", cause, prHead: "a".repeat(40), mainHead: null, checks: [], count: 4, escalated: true } }, true);
}

describe("[验收线 4] through the ledger: the manual queue and the observe note agree, the note's format unchanged", () => {
  test("a takeover from auto 4h; a takeover of a CI / real-conflict bounce limit 2h / 8h", () => run(async (f) => {
    const at: Record<string, number> = {}, seqOf: Record<string, number> = {};
    const entry = async (id: string) => { const e = await manual(f, id, "pm_takeover: PM 接手核对"); at[id] = e.ts; seqOf[id] = e.seq; };
    await entry("AUTO");
    for (const [id, cause] of [["CI", "ci_fail"], ["RC", "conflict"]] as const) {
      await manual(f, id, "spec_drift: 先占个位");
      await f.cli("pm", "workflow-resume", id, "--rev", String(getTask(f.db, id)!.rev), "--workflow-rev", String(getWorkflow(f.db, id)!.rev), "--reason", "交回");
      escalatedBounce(f, id, cause);
      await manual(f, id, BOUNCE);
      await entry(id);
    }
    const want: Record<string, number> = { AUTO: 4, CI: 2, RC: 8 };
    const r = await f.cli("pm", "manual-queue", "--project", "p") as { ok: boolean; active: Row[] };
    for (const id of Object.keys(want)) {
      const row = r.active.find((x) => x.taskId === id)!;
      expect([id, row.reasonCode, row.due.slaHours, row.due.at]).toEqual([id, "pm_takeover", want[id], at[id]! + want[id]! * HOUR]);
    }
    writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { manualCaseOwnership: "observe", manualStall: "off", manualRecovery: "off",
      manualMergeQueue: "off" } } } }));
    await manualResumeManagerTick(f.db, { p: { maxActiveWorkers: 2 } }, { manager: f.tickDeps.manager, notifyPm: f.tickDeps.notifyPm, now: f.tickDeps.now });
    for (const id of Object.keys(want)) {
      const note = listEvents(f.db, { project: "p", target: id }).find((e) => e.data.op === "recovery_observe" && e.data.mechanism === "manualCaseOwnership")!;
      expect(note.data.wouldAssign).toMatchObject({ responsible: "pm", slaHours: want[id], dueAt: at[id]! + want[id]! * HOUR });
      const due = new Date(at[id]! + want[id]! * HOUR).toISOString();
      expect(note.text).toBe(`恢复观察（manualCaseOwnership）：本会把 ${id} 的 manual 段 #${seqOf[id]} 缺省分给 pm（pm），${due} 前响应`);
    }
  }));
});
