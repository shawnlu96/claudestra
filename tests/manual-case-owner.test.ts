/**
 * merge-arch-OWN1 on a real temp ledger through the formal entries (workflow-set, the ledger CLI, the manual-recovery tick): every active
 * manual episode gets a valid responsible and a response deadline by reason, the manualCaseOwnership switch backfills it once (on), only
 * notes it (observe) or does nothing (off), a PM's explicit setting wins and binds to its episode, wrong / stale / unauthorized writes
 * change nothing, and holds keep their authorizer.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { MANUAL_CASE_SLA_BY_CODE, manualCaseDefaults } from "../src/lib/manual-case-defaults.js";
import type { ManualCaseOwner } from "../src/lib/manual-case-owner.js";
import type { ManualCaseRow } from "../src/lib/manual-case-view.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { manualResumeManagerTick } from "../src/lib/scheduler-recovery-ports.js";
import { autoFixture } from "./scheduler-auto-helpers.js";

type F = ReturnType<typeof autoFixture>;
type Row = ManualCaseRow & { owner: ManualCaseOwner };
const HOUR = 3_600_000;
afterEach(() => rmSync(RECOVERY_POLICY_PATH, { force: true }));

const policy = (p: Record<string, unknown>) => writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p } }));
const own = (mode: "on" | "observe" | "off") => policy({ keys: { manualCaseOwnership: mode } });

/** A code card (created on first use, auto) put into manual by the PM's workflow-set; returns the entry event. */
async function enter(f: F, id: string, reason: string, extra: { pm?: string } = {}) {
  if (!getTask(f.db, id)) {
    createTask(f.db, f.at("owner"), { project: "p", id, title: id, kind: "code", agent: "agent-task-one", ...(extra.pm ? { pm: extra.pm } : {}) });
    setWorkflow(f.db, f.at("owner"), { taskId: id, taskRev: getTask(f.db, id)!.rev, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "人工" });
  }
  expect(await f.cli("pm", "workflow-set", id, "--rev", String(getTask(f.db, id)!.rev), "--workflow-rev", String(getWorkflow(f.db, id)!.rev), "--template", "code",
    "--version", "2", "--mode", "manual", "--author-family", "claude", "--fallback", "人工", "--reason", reason)).toMatchObject({ ok: true });
  return listEvents(f.db, { project: "p", target: id }).findLast((e) => e.kind === "scheduler")!;
}

const rows = async (f: F) => {
  const r = await f.cli("pm", "manual-queue", "--project", "p") as { ok: boolean; active: Row[]; terminal: Row[] };
  expect(r).toMatchObject({ ok: true });
  return [...r.active, ...r.terminal];
};
const row = async (f: F, id: string) => (await rows(f)).find((x) => x.taskId === id)!;
const tick = (f: F) => manualResumeManagerTick(f.db, { p: { maxActiveWorkers: 2 } }, { manager: f.tickDeps.manager, notifyPm: f.tickDeps.notifyPm, now: f.tickDeps.now });
const cases = (f: F, id: string) => listEvents(f.db, { project: "p", target: id }).filter((e) => e.data.op === "manual_case_set");
const notes = (f: F, id: string) => listEvents(f.db, { project: "p", target: id })
  .filter((e) => e.data.op === "recovery_observe" && e.data.mechanism === "manualCaseOwnership");
const seq = (f: F) => (f.db.query("SELECT MAX(seq) AS s FROM events").get() as { s: number }).s;
const iso = (ms: number) => new Date(ms).toISOString();
const set = (f: F, actor: string, id: string, entrySeq: number, o: { who?: string; role?: string; due?: number; next?: string; extra?: string[] } = {}) =>
  f.cli(actor, "manual-case-set", id, "--entry-seq", String(entrySeq), "--responsible", o.who ?? "pm", "--role", o.role ?? "pm",
    "--due-at", iso(o.due ?? 10 * HOUR), "--next", o.next ?? "PM 核对审查结论后排修复", "--reason", "PM 接手跟进", ...(o.extra ?? []));
const run = async (body: (f: F) => Promise<void>) => { const f = autoFixture(); try { await body(f); } finally { f.close(); } };

describe("[验收线 1] every active manual episode has a valid responsible and a due date by reason; on backfills exactly once", () => {
  test("the formal table: response hours by reason, owner chain card PM → on-duty PM → owner, never an executor by default", () => {
    const meta = { pms: ["pm", "pm2"], activePm: "pm2", team: null };
    const hours = (code: Parameters<typeof manualCaseDefaults>[0], sub: string | null = null) => manualCaseDefaults(code, 0, { agent: "x", pm: null }, meta, sub).due.slaHours;
    expect([hours("ui_evidence_stale"), hours("merge_unknown"), hours("safety_refusal")]).toEqual([2, 2, 2]);
    expect(["write_lease_ended", "runtime_unavailable", "review_source_missing", "materials_gate", "spec_drift"].map((c) => hours(c as never))).toEqual([4, 4, 4, 4, 4]);
    expect([hours("review_unresolved"), hours("merge_unknown", "merge_bounce_limit")]).toEqual([8, 8]);
    expect([hours("owner_hold"), hours("pm_hold"), hours("foreign_repo"), hours(null)]).toEqual([24, 24, 24, 24]);
    expect(Object.keys(MANUAL_CASE_SLA_BY_CODE)).toHaveLength(16);
    expect(manualCaseDefaults("ui_evidence_stale", 0, { agent: "x", pm: "pm" }, meta).owner).toMatchObject({ role: "pm", who: "pm" });
    expect(manualCaseDefaults("review_unresolved", 0, { agent: "x", pm: null }, meta).owner).toMatchObject({ role: "pm", who: "pm2" });
    expect(manualCaseDefaults("review_unresolved", 0, { agent: "x", pm: "gone" }, meta).owner).toMatchObject({ role: "pm", who: "pm2" });
    expect(manualCaseDefaults("review_unresolved", 0, { agent: "x", pm: null }, { ...meta, activePm: "gone" }).owner).toMatchObject({ who: "pm" });
    expect(manualCaseDefaults("owner_hold", 0, { agent: "x", pm: null }, { pms: [], team: null }).owner).toMatchObject({ role: "owner", who: "owner" });
    expect(manualCaseDefaults("review_unresolved", null, { agent: "x", pm: null }, meta).due).toMatchObject({ at: null });
  });

  test("derived read-only, then on records one default with its source; the view shows the record", () => run(async (f) => {
    const e = await enter(f, "C1", "review_unresolved: 审查 P1 未修");
    let x = await row(f, "C1");
    expect(x.owner).toMatchObject({ role: "pm", who: "pm", origin: "derived", setSeq: null });
    expect(x.due).toMatchObject({ at: e.ts + 8 * HOUR, slaHours: 8 });
    expect(x.owner.source).toContain("只读推导");
    own("on");
    for (let i = 0; i < 3; i++) await tick(f);
    const recs = cases(f, "C1");
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ kind: "decision", actor: "scheduler", data: { source: "default", entrySeq: e.seq, responsible: "pm", role: "pm", dueAt: e.ts + 8 * HOUR } });
    expect(String(recs[0].data.basis)).toContain("review_unresolved");
    x = await row(f, "C1");
    expect(x.owner).toMatchObject({ who: "pm", origin: "default_record", setSeq: recs[0].seq });
    expect(x.owner.source).toContain(`缺省补记 #${recs[0].seq}`);
    expect(x.due.at).toBe(e.ts + 8 * HOUR);
    expect(getWorkflow(f.db, "C1")).toMatchObject({ mode: "manual" });
  }));
});

describe("[验收线 2] off / observe / on; a project-wide on is still observe; a default never overrides the PM", () => {
  test("off writes nothing; observe notes would_assign once; project mode on without the key stays observe", () => run(async (f) => {
    const e = await enter(f, "C1", "materials_gate: 外发材料没过闸");
    own("off");
    const s = seq(f);
    await tick(f);
    expect(seq(f)).toBe(s);
    for (const p of [{ keys: { manualCaseOwnership: "observe" } }, { mode: "on" }]) {
      policy(p);
      for (let i = 0; i < 2; i++) await tick(f);
      expect(cases(f, "C1")).toHaveLength(0);
    }
    const n = notes(f, "C1");
    expect(n).toHaveLength(1); // the same would-be assignment is one note across both observe readings
    expect(n[0].data.wouldAssign).toMatchObject({ responsible: "pm", role: "pm", slaHours: 4 });
    expect(n[0].text).toContain("pm");
    // the leased writer refuses a mode the policy does not say, with zero writes
    const t = seq(f);
    expect(await f.cli("scheduler", "scheduler-manual-case-default", "C1", "--entry-seq", String(e.seq), "--workflow-rev", String(getWorkflow(f.db, "C1")!.rev),
      "--mode", "on")).toMatchObject({ ok: false, code: "forbidden" });
    expect(seq(f)).toBe(t);
  }));

  test("a PM setting first: on records no default; a default first: the PM setting wins and the default cannot come back", () => run(async (f) => {
    const a = await enter(f, "A", "spec_drift: 规格改了");
    expect(await set(f, "pm", "A", a.seq, { due: a.ts + HOUR, next: "等 PM 复核规格" })).toMatchObject({ ok: true });
    own("on");
    await tick(f);
    expect(cases(f, "A").map((e) => e.data.source)).toEqual(["explicit"]);
    const s = seq(f);
    expect(await f.cli("scheduler", "scheduler-manual-case-default", "A", "--entry-seq", String(a.seq), "--workflow-rev", String(getWorkflow(f.db, "A")!.rev),
      "--mode", "on")).toMatchObject({ ok: false, code: "conflict" });
    expect(seq(f)).toBe(s);
    expect((await row(f, "A")).owner).toMatchObject({ origin: "explicit", next: "等 PM 复核规格" });

    const b = await enter(f, "B", "spec_drift: 规格改了");
    await tick(f);
    expect(await set(f, "pm", "B", b.seq, { due: b.ts + 30 * HOUR, next: "等 owner 定范围", extra: ["--waiting-on", "owner 拍板"] })).toMatchObject({ ok: true });
    for (let i = 0; i < 2; i++) await tick(f);
    expect(cases(f, "B").map((e) => e.data.source)).toEqual(["default", "explicit"]);
    const x = await row(f, "B");
    expect(x.owner).toMatchObject({ origin: "explicit", next: "等 owner 定范围", waitingOn: "owner 拍板" });
    expect(x.due).toMatchObject({ at: b.ts + 30 * HOUR, overdue: false });
  }));
});

describe("[验收线 3] a PM setting keeps the episode; a new episode starts empty; bad writes are refused with zero writes", () => {
  test("changing responsible / due / next keeps the entry, workflow and earlier records; a new hold does not inherit", () => run(async (f) => {
    const e = await enter(f, "C1", "review_unresolved: 审查 P1 未修");
    own("observe");
    await tick(f);
    const observed = notes(f, "C1").map((n) => n.seq), wf = getWorkflow(f.db, "C1");
    expect(await set(f, "pm", "C1", e.seq, { who: "agent-task-one", role: "executor", due: e.ts + 2 * HOUR, next: "执行者按 P1 修" })).toMatchObject({ ok: true });
    expect(await set(f, "pm", "C1", e.seq, { due: e.ts + 3 * HOUR, next: "PM 自己盯" })).toMatchObject({ ok: true });
    let x = await row(f, "C1");
    expect(x).toMatchObject({ episodeId: e.seq, since: e.ts });
    expect(x.owner).toMatchObject({ who: "pm", role: "pm", origin: "explicit", next: "PM 自己盯" });
    expect(x.due.at).toBe(e.ts + 3 * HOUR);
    expect(getWorkflow(f.db, "C1")).toEqual(wf);
    expect(notes(f, "C1").map((n) => n.seq)).toEqual(observed);
    // a new hold = a new episode: the old assignment is not carried over
    const h = await enter(f, "C1", "pm_hold: PM 先压住");
    x = await row(f, "C1");
    expect(x).toMatchObject({ episodeId: h.seq });
    expect(x.owner).toMatchObject({ origin: "derived", next: null });
    expect(x.due.at).toBe(h.ts + 24 * HOUR);
    expect((await set(f, "pm", "C1", e.seq)).code).toBe("conflict"); // the old episode's seq is stale now
  }));

  test("wrong entry seq, stale workflow rev, executor / unknown actors, bad subjects: refused, nothing written", () => run(async (f) => {
    const e = await enter(f, "C1", "review_unresolved: 审查 P1 未修");
    const s = seq(f), rev = getWorkflow(f.db, "C1")!.rev;
    expect(await set(f, "pm", "C1", e.seq + 1)).toMatchObject({ ok: false, code: "conflict" });
    expect(await set(f, "pm", "C1", e.seq, { extra: ["--workflow-rev", String(rev - 1)] })).toMatchObject({ ok: false, code: "conflict" });
    expect(await set(f, "agent-task-one", "C1", e.seq)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await set(f, "agent-rv-t1", "C1", e.seq)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await set(f, "scheduler", "C1", e.seq)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await set(f, "pm", "C1", e.seq, { who: "agent-rv-t1", role: "executor" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await set(f, "pm", "C1", e.seq, { who: "nobody", role: "pm" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await set(f, "pm", "C1", e.seq, { next: " " })).toMatchObject({ ok: false, code: "invalid" });
    expect(await f.cli("pm", "manual-case-set", "C1", "--entry-seq", String(e.seq), "--responsible", "pm", "--role", "pm", "--due-at", "明天",
      "--next", "x", "--reason", "y")).toMatchObject({ ok: false, code: "invalid" });
    expect(await set(f, "pm", "T1", e.seq)).toMatchObject({ ok: false, code: "conflict" }); // T1 is auto
    expect(seq(f)).toBe(s);
    expect(await set(f, "pm", "C1", e.seq, { extra: ["--workflow-rev", String(rev)] })).toMatchObject({ ok: true });
  }));
});

describe("[验收线 4] holds, refusals and unknown results keep their authorizer; an invalid subject falls back to a valid PM", () => {
  test("owner_hold / safety_refusal / merge_unknown / unknown reason: authorizer and check shown; assigning never hands back", () => run(async (f) => {
    const hold = await enter(f, "H", "owner_hold: 等 owner 拍板");
    await enter(f, "S", "safety_refusal: 模型拒答");
    await enter(f, "U", "merge_unknown: 合并回执丢了");
    expect(await set(f, "pm", "H", hold.seq, { next: "追 owner" })).toMatchObject({ ok: true });
    policy({ mode: "on", manualStallHours: 1, keys: { manualCaseOwnership: "on" } });
    f.advance(48 * HOUR);
    for (let i = 0; i < 2; i++) await tick(f);
    const all = await rows(f), by = (id: string) => all.find((x) => x.taskId === id)!;
    expect(by("H").owner).toMatchObject({ authorizer: "owner", who: "pm", origin: "explicit" });
    expect(by("H").owner.check).toContain("owner 明确放行");
    expect(by("S").owner).toMatchObject({ authorizer: "PM / owner" });
    expect(by("U").owner.authorizer).toContain("外部结果");
    for (const id of ["H", "S", "U"]) expect(getWorkflow(f.db, id)).toMatchObject({ mode: "manual" });
    expect(listEvents(f.db, { project: "p" }).filter((e) => e.data.op === "workflow_resume")).toHaveLength(0);
  }));

  test("a responsible who is no longer a PM is a gap; the view falls back to the valid PM and nothing is sent", () => run(async (f) => {
    setMeta(f.db, f.at("owner"), { project: "p", key: "pms", value: ["pm", "pm2"] });
    const e = await enter(f, "C1", "review_unresolved: 审查 P1 未修");
    expect(await set(f, "pm", "C1", e.seq, { who: "pm2" })).toMatchObject({ ok: true });
    expect((await row(f, "C1")).owner).toMatchObject({ who: "pm2", gap: null });
    setMeta(f.db, f.at("owner"), { project: "p", key: "pms", value: ["pm"] });
    const sent = f.sent.length, told = f.notices.length;
    own("on");
    await tick(f);
    const x = await row(f, "C1");
    expect(x.owner).toMatchObject({ who: "pm", role: "pm", origin: "explicit" });
    expect(x.owner.gap).toContain("pm2");
    expect(x.gaps.join()).toContain("已失效");
    expect(cases(f, "C1")).toHaveLength(1);
    expect([f.sent.length, f.notices.length]).toEqual([sent, told]);
  }));
});
