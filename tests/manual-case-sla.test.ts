/**
 * merge-arch-SLA1 on a real temp ledger through the formal entries (workflow-set, manual-case-set, the leased `scheduler-manual-case-sla`
 * writer, the tick): overdue manual episodes of one PM become one message per batching window, an episode is reminded at most once
 * whatever changes inside it, observe only records, off does nothing, a card that moved before the claim is dropped, and sent /
 * unknown / unsent stay three different things. The send is a recorder; no bridge.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { appendEvent, createTask } from "../src/lib/ledger-write.js";
import { manualCaseSlaMode } from "../src/lib/manual-case-sla-compat.js";
import { manualCaseSlaTick, SLA_BATCH_WINDOW_MS, type SlaSendResult } from "../src/lib/manual-case-sla-tick.js";
import { manualCaseSlaReport } from "../src/lib/manual-case-sla-write.js";
import { manualStallTick } from "../src/lib/recovery-manual.js";
import { RECOVERY_KEYS, RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { manualResumeManagerTick, recoveryWrite } from "../src/lib/scheduler-recovery-ports.js";
import { autoFixture } from "./scheduler-auto-helpers.js";

type F = ReturnType<typeof autoFixture>;
type Write = (args: string[]) => Promise<Record<string, unknown>>;
const HOUR = 3_600_000, MIN = 60_000, CMD = "scheduler-manual-case-sla";
afterEach(() => rmSync(RECOVERY_POLICY_PATH, { force: true }));

const policy = (p: Record<string, unknown>) => writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p } }));
const sla = (mode: "on" | "observe" | "off") => policy({ keys: { manualCaseSla: mode } });
const run = async (body: (f: F) => Promise<void>) => { const f = autoFixture(); try { await body(f); } finally { f.close(); } };
const wfArgs = (f: F, id: string) => ["--rev", String(getTask(f.db, id)!.rev), "--workflow-rev", String(getWorkflow(f.db, id)!.rev)];

/** A code card (created on first use, auto) put into manual by the PM's workflow-set; returns the entry event. */
async function enter(f: F, id: string, reason: string) {
  if (!getTask(f.db, id)) {
    createTask(f.db, f.at("owner"), { project: "p", id, title: `卡 ${id}`, kind: "code", agent: "agent-task-one" });
    setWorkflow(f.db, f.at("owner"), { taskId: id, taskRev: getTask(f.db, id)!.rev, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "人工" });
  }
  expect(await f.cli("pm", "workflow-set", id, ...wfArgs(f, id), "--template", "code", "--version", "2", "--mode", "manual", "--author-family", "claude",
    "--fallback", "人工", "--reason", reason)).toMatchObject({ ok: true });
  return listEvents(f.db, { project: "p", target: id }).findLast((e) => e.kind === "scheduler")!;
}
/** Three cards of the same PM, all past their 4 h deadline and past the batching window. */
async function threeOverdue(f: F) {
  const entries = [];
  for (const id of ["C1", "C2", "C3"]) entries.push(await enter(f, id, "materials_gate: 外发材料没过闸"));
  f.advance(4 * HOUR + SLA_BATCH_WINDOW_MS + MIN);
  return entries;
}

function harness(f: F, result: () => SlaSendResult = () => ({ state: "sent", receipt: "msg-1" })) {
  const sends: { pm: string; text: string; batchId: string }[] = [];
  const writer: Write = (args) => recoveryWrite(f.tickDeps.manager, CMD, args, true);
  const tick = (write: Write = writer) => manualCaseSlaTick(f.db, ["p"], { now: f.tickDeps.now, write,
    send: async (_p, pm, text, batchId) => { sends.push({ pm, text, batchId }); return result(); } });
  return { sends, tick, writer };
}
const claims = (f: F, id: string) => listEvents(f.db, { project: "p", target: id }).filter((e) => e.data.op === "manual_case_sla");
const batches = (f: F) => listEvents(f.db, { project: "p", target: "" }).filter((e) => e.data.op === "manual_case_sla_batch");
const observed = (f: F) => listEvents(f.db, { project: "p" }).filter((e) => e.data.op === "recovery_observe" && e.data.mechanism === "manualCaseSla");
const seq = (f: F) => (f.db.query("SELECT MAX(seq) AS s FROM events").get() as { s: number }).s;
const report = (f: F) => manualCaseSlaReport(f.db, "p", 0, null);
const iso = (ms: number) => new Date(ms).toISOString();

describe("[验收线 1] three overdue cards of one PM: per card before, one batched message now, never again after sent", () => {
  test("red: the older stall notice wakes the PM once per card", () => run(async (f) => {
    await threeOverdue(f);
    const told: string[] = [];
    await manualStallTick({ db: f.db, now: f.tickDeps.now(), svc: { autoDispatch: true, projects: ["p"], maxWorkers: () => 2 },
      policy: () => ({ mode: "on", manualAfterMs: HOUR }), notify: async (_p, _a, text) => void told.push(text) });
    expect(told).toHaveLength(3);
  }));

  test("green: on sends one message with the three episodes and their next steps; a later round or a new process sends nothing", () => run(async (f) => {
    const entries = await threeOverdue(f);
    sla("on");
    const h = harness(f);
    const out = await h.tick();
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0].pm).toBe("pm");
    for (const id of ["C1", "C2", "C3"]) expect(h.sends[0].text).toContain(id);
    expect(h.sends[0].text.split("下一步：")).toHaveLength(4);
    for (const part of [h.sends[0].batchId, "materials_gate", "责任人 pm（pm）", "逾期", "ledger manual-queue --project p"]) expect(h.sends[0].text).toContain(part);
    expect(out).toEqual([expect.objectContaining({ action: "sent", pm: "pm", episodes: entries.map((e, i) => [`C${i + 1}`, e.seq]) })]);
    expect(batches(f)).toHaveLength(1);
    expect(batches(f)[0].data).toMatchObject({ batchId: h.sends[0].batchId, state: "sent", pm: "pm", count: 3, receipt: "msg-1" });
    expect((batches(f)[0].data.episodes as { taskId: string; dueAt: number; responsible: string }[]).map((e) => [e.taskId, e.dueAt, e.responsible]))
      .toEqual(entries.map((e, i) => [`C${i + 1}`, e.ts + 4 * HOUR, "pm"]));
    for (const id of ["C1", "C2", "C3"]) expect(claims(f, id)).toHaveLength(1);
    // durable: rounds much later, and a fresh harness standing in for a restarted service, find every episode sent
    for (let i = 0; i < 3; i++) { f.advance(2 * HOUR); await h.tick(); }
    const restarted = harness(f);
    await restarted.tick();
    expect([h.sends.length, restarted.sends.length, batches(f).length]).toEqual([1, 0, 1]);
    expect(report(f)).toMatchObject({ batches: { sent: 1, unknown: 0, unsent: 0 }, repeated: 0, unknown: [], dangling: [] });
  }));

  test("inside the window nothing is sent; cards coming due in it join the same message", () => run(async (f) => {
    const a = await enter(f, "C1", "ui_evidence_stale: 截图过期"); // 2 h
    await enter(f, "C2", "materials_gate: 外发材料没过闸"); // 4 h, not due when the window of C1 closes
    sla("on");
    const h = harness(f);
    f.advance(2 * HOUR + 10 * MIN);
    expect(await h.tick()).toEqual([expect.objectContaining({ action: "window_wait", episodes: [["C1", a.seq]] })]);
    expect([h.sends.length, claims(f, "C1").length]).toEqual([0, 0]);
    f.advance(25 * MIN);
    await h.tick();
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0].text).not.toContain("C2");
    // C2 comes due later: its own window is counted from its deadline and from the PM's last batch, then one more message with C2 only
    f.advance(HOUR + 30 * MIN);
    expect((await h.tick())[0]).toMatchObject({ action: "window_wait" });
    f.advance(SLA_BATCH_WINDOW_MS);
    await h.tick();
    expect(h.sends).toHaveLength(2);
    expect(h.sends[1].text).toContain("C2");
    expect(h.sends[1].text).not.toContain("C1（");
  }));
});

describe("[验收线 2] observe records who would be told about which cards; off does nothing; only an explicit on is on", () => {
  test("the key is new, appears once, defaults to observe, and a project-wide on does not turn it on", () => {
    expect(RECOVERY_KEYS.filter((k) => k === "manualCaseSla")).toHaveLength(1);
    expect(manualCaseSlaMode("p").mode).toBe("observe");
    policy({ mode: "on" });
    expect(manualCaseSlaMode("p").mode).toBe("observe");
    sla("on");
    expect(manualCaseSlaMode("p").mode).toBe("on");
    policy({ mode: "on", keys: { manualCaseSla: "off" } });
    expect(manualCaseSlaMode("p").mode).toBe("off");
    writeFileSync(RECOVERY_POLICY_PATH, "{ broken");
    expect(manualCaseSlaMode("p").mode).toBe("error");
  });

  test("observe (unset, explicit, project-wide on): one would-notify note per episode, zero sends, zero claims, nothing on the cards", () => run(async (f) => {
    const entries = await threeOverdue(f);
    const h = harness(f), cardEvents = () => ["C1", "C2", "C3"].map((id) => listEvents(f.db, { project: "p", target: id }).length);
    const before = cardEvents();
    for (const p of [null, { keys: { manualCaseSla: "observe" } }, { mode: "on" }]) {
      if (p) policy(p);
      for (let i = 0; i < 2; i++) await h.tick();
    }
    expect(h.sends).toHaveLength(0);
    expect(cardEvents()).toEqual(before);
    expect(batches(f)).toHaveLength(0);
    const notes = observed(f);
    expect(notes.map((n) => n.data.wouldNotify)).toEqual(entries.map((e, i) => expect.objectContaining({ pm: "pm", taskId: `C${i + 1}`, entrySeq: e.seq, responsible: "pm" })));
    expect(new Set(notes.map((n) => (n.data.wouldNotify as { batchId: string }).batchId)).size).toBe(1);
    expect(notes.every((n) => n.target === "" && n.kind === "note")).toBe(true);
    // the wiring runs it too, and the leased writer refuses a phase the switch does not say
    await manualResumeManagerTick(f.db, { p: { maxActiveWorkers: 2 } }, { manager: f.tickDeps.manager, notifyPm: f.tickDeps.notifyPm, now: f.tickDeps.now });
    expect(observed(f)).toHaveLength(3);
    const s = seq(f);
    expect(await f.cli("scheduler", CMD, "C1", "--phase", "claim", "--entry-seq", String(entries[0].seq), "--pm", "pm", "--batch", "sla-x")).toMatchObject({ ok: false, code: "forbidden" });
    expect(seq(f)).toBe(s);
  }));

  test("off: no read, no write, no send; switching on later still reminds", () => run(async (f) => {
    await threeOverdue(f);
    sla("off");
    const h = harness(f), s = seq(f);
    expect(await h.tick()).toEqual([{ project: "p", mode: "off", action: "none", why: "manualCaseSla 是 off" }]);
    expect([seq(f), h.sends.length]).toEqual([s, 0]);
    sla("on");
    await h.tick();
    expect(h.sends).toHaveLength(1);
  }));
});

describe("[验收线 3] re-checked at the claim; changes inside a reminded episode never remind again", () => {
  test("recovered, verified, deadline moved, a new hold: each is refused at its claim, zero sends, zero claims", () => run(async (f) => {
    const entries = await threeOverdue(f);
    await enter(f, "C4", "materials_gate: 外发材料没过闸");
    f.advance(5 * HOUR);
    sla("on");
    const h = harness(f);
    let raced = false;
    // between this round's read and its first claim: PM hands C1 back, C2 reaches verified, PM moves C3's deadline, PM puts a new hold on C4
    const racing: Write = async (args) => {
      if (!raced) {
        raced = true;
        expect(await f.cli("pm", "workflow-resume", "C1", ...wfArgs(f, "C1"), "--reason", "PM 交回")).toMatchObject({ ok: true });
        f.db.run("UPDATE tasks SET stage = 'verified' WHERE id = 'C2'");
        expect(await f.cli("pm", "manual-case-set", "C3", "--entry-seq", String(entries[2].seq), "--responsible", "pm", "--role", "pm",
          "--due-at", iso(f.tickDeps.now() + 6 * HOUR), "--next", "等外发材料", "--reason", "PM 改期限")).toMatchObject({ ok: true });
        await enter(f, "C4", "pm_hold: 先停一下");
      }
      return h.writer(args);
    };
    expect(await h.tick(racing)).toEqual([expect.objectContaining({ action: "raced" })]);
    expect(h.sends).toHaveLength(0);
    for (const id of ["C1", "C2", "C3", "C4"]) expect(claims(f, id)).toHaveLength(0);
    // nothing is owed afterwards either: C3 is not due, C4's new episode has its own 24 h
    f.advance(HOUR);
    await h.tick();
    expect(h.sends).toHaveLength(0);
  }));

  test("a lost lease stops before the send; a card held by the central mapping is left out, the others still go", () => run(async (f) => {
    await threeOverdue(f);
    sla("on");
    const h = harness(f);
    const lost: Write = (args) => recoveryWrite(async () => ({ ok: false, code: "lease-lost", error: "租约没了" }), CMD, args, true);
    await expect(h.tick(lost)).rejects.toBeInstanceOf(SchedulerStopped);
    expect(await f.cliWith({ assertLease: () => { throw new Error("租约没了"); } }, "scheduler", CMD, "C1", "--phase", "claim", "--entry-seq", "1", "--pm", "pm", "--batch", "sla-x"))
      .toMatchObject({ ok: false });
    expect(await f.cli("pm", CMD, "C1", "--phase", "claim", "--entry-seq", "1", "--pm", "pm", "--batch", "sla-x")).toMatchObject({ ok: false, code: "forbidden" });
    expect([h.sends.length, batches(f).length, claims(f, "C1").length]).toEqual([0, 0, 0]);
    const held: Write = (args) => recoveryWrite(async (...a) => (a[2] === "C2" && a.includes("claim") ? { ok: false, code: "v2_unmapped", error: "中央映射" }
      : f.tickDeps.manager(...a)), CMD, args, true);
    await h.tick(held);
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0].text).toContain("C1");
    expect(h.sends[0].text).not.toContain("C2（");
    expect(claims(f, "C2")).toHaveLength(0);
  }));

  test("after sent: a new head, a note, another responsible and another deadline in the same episode send nothing more", () => run(async (f) => {
    const entries = await threeOverdue(f);
    sla("on");
    const h = harness(f);
    await h.tick();
    f.db.run("UPDATE tasks SET headSHA = ? WHERE id = 'C1'", ["9".repeat(40)]);
    appendEvent(f.db, f.at("pm"), { project: "p", target: "C2", kind: "note", text: "在等外发材料" });
    expect(await f.cli("pm", "manual-case-set", "C3", "--entry-seq", String(entries[2].seq), "--responsible", "owner", "--role", "owner",
      "--due-at", iso(f.tickDeps.now() - HOUR), "--next", "owner 拍板", "--reason", "转 owner")).toMatchObject({ ok: true });
    for (let i = 0; i < 3; i++) { f.advance(SLA_BATCH_WINDOW_MS + MIN); await h.tick(); }
    expect([h.sends.length, batches(f).length]).toEqual([1, 1]);
    // a new episode of the same card is a new key: reminded once when its own deadline passes
    await enter(f, "C1", "ui_evidence_stale: 截图又过期");
    f.advance(2 * HOUR + SLA_BATCH_WINDOW_MS + MIN);
    await h.tick();
    expect(h.sends).toHaveLength(2);
    expect(claims(f, "C1")).toHaveLength(2);
    expect(report(f).repeated).toBe(0);
  }));

  test("an owner / executor responsible is tracked by the card's PM; a recoverable candidate nobody executed is said so", () => run(async (f) => {
    const e = await enter(f, "C1", "materials_gate: 外发材料没过闸");
    expect(await f.cli("pm", "manual-case-set", "C1", "--entry-seq", String(e.seq), "--responsible", "owner", "--role", "owner",
      "--due-at", iso(f.tickDeps.now() + HOUR), "--next", "owner 拍板放行", "--reason", "要 owner 决定")).toMatchObject({ ok: true });
    f.advance(2 * HOUR);
    sla("on");
    const h = harness(f);
    await h.tick();
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0].pm).toBe("pm");
    for (const part of ["责任人 owner（owner）", "owner 拍板放行（PM 指派）", "由你汇总追踪"]) expect(h.sends[0].text).toContain(part);
    const { slaBatchText } = await import("../src/lib/manual-case-sla-tick.js");
    const snap = claims(f, "C1")[0].data as never as Parameters<typeof slaBatchText>[3][number];
    expect(slaBatchText("p", "pm", "sla-x", [{ ...snap, candidate: true }])).toContain("可恢复候选未执行");
    expect(h.sends[0].text).not.toContain("可恢复候选未执行");
  }));
});

describe("[验收线 4] at most one wake attempt per episode; unknown is kept apart from a definite failure", () => {
  test("two rounds at once: every episode goes out in exactly one message", () => run(async (f) => {
    await threeOverdue(f);
    sla("on");
    const h = harness(f);
    await Promise.all([h.tick(), h.tick()]);
    for (const id of ["C1", "C2", "C3"]) {
      expect(claims(f, id)).toHaveLength(1);
      expect(h.sends.filter((s) => s.text.includes(`${id}（`))).toHaveLength(1);
    }
    expect(report(f).repeated).toBe(0);
  }));

  test("crash after the send (no outcome recorded): never sent again, shown as unknown for the PM to check", () => run(async (f) => {
    await threeOverdue(f);
    sla("on");
    const h = harness(f);
    const crashing: Write = (args) => (args.includes("sent") ? Promise.reject(new Error("进程没了")) : h.writer(args));
    expect(await h.tick(crashing)).toEqual([expect.objectContaining({ action: "error" })]);
    expect([h.sends.length, batches(f).length]).toEqual([1, 0]);
    expect(report(f).dangling.map((d) => d.taskId)).toEqual(["C1", "C2", "C3"]);
    await h.tick(); // right away: the claim stands, nothing is sent
    f.advance(SLA_BATCH_WINDOW_MS + MIN);
    expect(await h.tick()).toEqual([expect.objectContaining({ action: "settled_unknown" })]);
    for (let i = 0; i < 2; i++) { f.advance(HOUR); await h.tick(); }
    expect(h.sends).toHaveLength(1);
    expect(batches(f).map((b) => b.data.state)).toEqual(["unknown"]);
    expect(report(f)).toMatchObject({ batches: { sent: 0, unknown: 1, unsent: 0 }, dangling: [], repeated: 0 });
    expect(report(f).unknown.map((u) => u.taskId)).toEqual(["C1", "C2", "C3"]);
  }));

  test("bridge timeout with the frame out: unknown, never re-sent; a frame that never left: unsent, offered again once and then sent", () => run(async (f) => {
    const entries = await threeOverdue(f);
    sla("on");
    let result: SlaSendResult = { state: "unknown", why: "Bridge 请求超时" };
    const h = harness(f, () => result);
    expect((await h.tick())[0]).toMatchObject({ action: "unknown" });
    for (let i = 0; i < 3; i++) { f.advance(HOUR); await h.tick(); }
    expect(h.sends).toHaveLength(1);
    expect(batches(f).map((b) => b.data.state)).toEqual(["unknown"]);
    const q = await f.cli("pm", "manual-queue", "--project", "p") as { sla: ReturnType<typeof report>; lines: string[] };
    expect(q.sla.unknown).toHaveLength(3);
    expect(q.lines.some((l) => l.includes("待 PM 核对") && l.includes("C1 段#"))).toBe(true);
    // a new card: its frame never leaves (bridge down), so the episode stays owed and goes out after the next window
    const d = await enter(f, "D1", "ui_evidence_stale: 截图过期");
    f.advance(2 * HOUR + SLA_BATCH_WINDOW_MS + MIN);
    result = { state: "unsent", why: "Bridge 连接出错" };
    expect((await h.tick())[0]).toMatchObject({ action: "unsent", episodes: [["D1", d.seq]] });
    expect((await h.tick())[0]).toMatchObject({ action: "window_wait" });
    result = { state: "sent", receipt: "msg-2" };
    f.advance(SLA_BATCH_WINDOW_MS + MIN);
    expect((await h.tick())[0]).toMatchObject({ action: "sent", episodes: [["D1", d.seq]] });
    f.advance(HOUR);
    await h.tick();
    expect(h.sends).toHaveLength(3); // unknown batch, the frame that never left, the one that arrived
    expect(claims(f, "D1").map((c) => c.data.attempt)).toEqual([1, 2]);
    expect(batches(f).map((b) => b.data.state)).toEqual(["unknown", "unsent", "sent"]);
    expect(report(f)).toMatchObject({ batches: { sent: 1, unknown: 1, unsent: 1 }, repeated: 0 });
    // a late contradicting outcome cannot rewrite the first one
    const first = batches(f)[0].data as { batchId: string };
    expect(await f.cli("scheduler", CMD, "C1", "--phase", "unsent", "--pm", "pm", "--batch", first.batchId, "--episodes", JSON.stringify([["C1", entries[0].seq]])))
      .toMatchObject({ ok: true, recorded: false, state: "unknown" });
    expect(batches(f)[0].data.state).toBe("unknown");
  }));
});
