/**
 * merge-arch-SLA1 next to what was already there: the two older per-card stall notices (recovery-manual's action card, the audit's
 * manual_stalled) skip exactly the episodes an on batch took in and nothing else, and an episode one of them told first (or claimed, delivery unknown) is never batched; the live paths (serial merge slot, PM manual merge
 * request, the pass with its train / merge / deploy / auto ticks, PM hand-back) are not held, cancelled or changed; the command, the
 * key and the wiring are registered once; the report counts batches, repeats and the wake cost without guessing tokens.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import type { AuditFinding } from "../src/lib/ledger-audit.js";
import { stallAudit } from "../src/lib/ledger-audit-stall.js";
import { ackFindings, reconcileFindings } from "../src/lib/ledger-audit-store.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { manualCaseSlaCovers } from "../src/lib/manual-case-sla-compat.js";
import { manualCaseSlaTick, SLA_BATCH_WINDOW_MS } from "../src/lib/manual-case-sla-tick.js";
import { manualCaseSlaLines, manualCaseSlaReport } from "../src/lib/manual-case-sla-write.js";
import { manualStallTick } from "../src/lib/recovery-manual.js";
import { RECOVERY_KEYS, RECOVERY_POLICY_PATH, type RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { recoveryWrite } from "../src/lib/scheduler-recovery-ports.js";
import { SCHEDULER_V2_LEDGER_COMMANDS } from "../src/lib/scheduler-v2-ledger-cmds-args.js";
import { SKIP_EFFECT_FILES } from "../src/lib/scheduler-v2-skip-effects.js";
import { SKIP_LEDGER_COMMANDS, SKIP_LEDGER_DYNAMIC } from "../src/lib/scheduler-v2-skip-paths.js";
import { SCHEDULER_SERVICE_COMMANDS } from "../src/lib/shared-ledger-gate-cli-services.js";
import type { Registry } from "../src/manager/core.js";
import { runLedger } from "../src/manager/ledger.js";
import { ledgerAs, manualCard, requestArgs } from "./manual-merge-queue-world.test.js";
import { autoFixture } from "./scheduler-auto-helpers.js";
import { reclaimWorld, type ReclaimWorld } from "./scheduler-merge-reclaim-world.js";

type F = ReturnType<typeof autoFixture>;
const HOUR = 3_600_000, MIN = 60_000, CMD = "scheduler-manual-case-sla", PM = "agent-pm";
let w: ReclaimWorld | undefined;
afterEach(() => { w?.close(); w = undefined; rmSync(RECOVERY_POLICY_PATH, { force: true }); });
const policy = (keys: Record<string, string>, p: Record<string, unknown> = {}) => writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { ...p, keys } } }));

async function enter(f: F, id: string, reason: string) {
  createTask(f.db, f.at("owner"), { project: "p", id, title: id, kind: "code", agent: "agent-task-one" });
  setWorkflow(f.db, f.at("owner"), { taskId: id, taskRev: getTask(f.db, id)!.rev, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "人工" });
  expect(await f.cli("pm", "workflow-set", id, "--rev", String(getTask(f.db, id)!.rev), "--workflow-rev", String(getWorkflow(f.db, id)!.rev), "--template", "code",
    "--version", "2", "--mode", "manual", "--author-family", "claude", "--fallback", "人工", "--reason", reason)).toMatchObject({ ok: true });
}
function slaTick(f: F, sends: string[]) {
  return manualCaseSlaTick(f.db, ["p"], { now: f.tickDeps.now, write: (args) => recoveryWrite(f.tickDeps.manager, CMD, args, true),
    send: async (_p, _pm, text) => { sends.push(text); return { state: "sent", receipt: "m" }; } });
}
/** recovery-manual's action cards (its on path), as the older notice would send them now. */
async function stallCards(f: F): Promise<string[]> {
  const told: string[] = [];
  const out = await manualStallTick({ db: f.db, now: f.tickDeps.now(), svc: { autoDispatch: true, projects: ["p"], maxWorkers: () => 2 },
    policy: () => ({ mode: "observe", manualAfterMs: HOUR }), notify: async () => { throw new Error("observe 不发"); } });
  for (const o of out) if ("taskId" in o && o.action === "would_notify") told.push(o.taskId);
  return told;
}
/** The audit's stall rules over the cards' real events; every stall rule on. Returns the cards manual_stalled speaks about and what ran. */
function audit(f: F, ids: readonly string[]) {
  const emitted: string[] = [], evaluated: string[] = [];
  const on: RecoveryPolicyPort = () => ({ mode: "on", manualAfterMs: null, source: "config" });
  const tasks = ids.map((id) => ({ task: getTask(f.db, id)!, events: listEvents(f.db, { project: "p", target: id }), workflowMode: "manual", blockedBy: [] }));
  stallAudit({ project: "p", tasks, stall: { blockers: { facts: [] }, open: {} } } as never, f.tickDeps.now(), on,
    { emit: (x) => void emitted.push(`${x.rule}:${x.taskId}`), evaluated: evaluated as never, skip: () => {}, keep: () => {} });
  return { emitted, evaluated };
}

describe("[验收线 5] on: an episode in a batch is not also told per card; everything else, and observe / off, is as before", () => {
  test("the batched episode drops out of both older notices, the one outside the batch stays; observe and off give it back", async () => {
    const f = autoFixture();
    try {
      await enter(f, "C1", "materials_gate: 外发材料没过闸"); // 4 h
      await enter(f, "C2", "review_unresolved: 审查 P1 未修"); // 8 h: stalled for the older notices, not yet overdue
      f.db.run("UPDATE tasks SET stage = 'review' WHERE id IN ('C1', 'C2')"); // manual_stalled leaves spec cards alone
      f.advance(5 * HOUR);
      const sends: string[] = [], cards = (id: string) => listEvents(f.db, { project: "p", target: id });
      // observe (default): the would-notify notes change nothing for the older notices
      await slaTick(f, sends);
      expect(sends).toHaveLength(0);
      expect(await stallCards(f)).toEqual(["C1", "C2"]);
      expect([manualCaseSlaCovers("p", cards("C1")), manualCaseSlaCovers("p", cards("C2"))]).toEqual([false, false]);
      // on: C1 goes into the batch
      policy({ manualCaseSla: "on" });
      await slaTick(f, sends);
      expect(sends).toHaveLength(1);
      expect(sends[0]).toContain("C1");
      expect(sends[0]).not.toContain("C2");
      expect([manualCaseSlaCovers("p", cards("C1")), manualCaseSlaCovers("p", cards("C2"))]).toEqual([true, false]);
      expect(await stallCards(f)).toEqual(["C2"]);
      f.advance(8 * HOUR); // both past the audit's 12 h; C2 is overdue by now but this test runs no further SLA round
      expect(audit(f, ["C1", "C2"])).toEqual({ emitted: ["manual_stalled:C2"], evaluated: ["manual_stalled", "lock_blocker_stalled"] });
      // the other alarms of the same audit rule set and of other rules do not ask the SLA criterion at all
      expect(manualCaseSlaCovers("p", listEvents(f.db, { project: "p", target: "T1" }))).toBe(false);
      // rollback: observe / off / a project-wide on without the key restore the older notices for the batched episode too, and nothing is re-sent
      for (const p of [{ manualCaseSla: "observe" }, { manualCaseSla: "off" }, {}] as Record<string, string>[]) {
        policy(p, { mode: "on" });
        expect(manualCaseSlaCovers("p", cards("C1"))).toBe(false);
        expect(audit(f, ["C1", "C2"]).emitted).toEqual(["manual_stalled:C1", "manual_stalled:C2"]);
        expect((await stallCards(f)).includes("C1")).toBe(true);
        await slaTick(f, sends);
      }
      policy({ manualCaseSla: "on" });
      f.advance(SLA_BATCH_WINDOW_MS + MIN);
      await slaTick(f, sends); // back on: C2 is due and goes out once; C1's history stands
      expect(sends).toHaveLength(2);
      expect(sends[1]).not.toContain("C1（");
      // a new episode of C1 is not covered by the old episode's claim
      expect(await f.cli("pm", "workflow-set", "C1", "--rev", String(getTask(f.db, "C1")!.rev), "--workflow-rev", String(getWorkflow(f.db, "C1")!.rev), "--template", "code",
        "--version", "2", "--mode", "manual", "--author-family", "claude", "--fallback", "人工", "--reason", "pm_hold: 再停一下")).toMatchObject({ ok: true });
      expect(manualCaseSlaCovers("p", cards("C1"))).toBe(false);
    } finally { f.close(); }
  });
});

describe("[验收线 5] the other direction: an episode an older notice told first, or claimed with no delivery record, gets no batched reminder", () => {
  const svc = { autoDispatch: true, projects: ["p"], maxWorkers: () => 2 };
  const legacy = (f: F, notify: (text: string) => Promise<void>) => manualStallTick({ db: f.db, now: f.tickDeps.now(), svc,
    policy: () => ({ mode: "on", manualAfterMs: HOUR }), notify: (_p, _a, text) => notify(text) });
  const three = async (f: F) => {
    for (const id of ["C1", "C2", "C3"]) await enter(f, id, "materials_gate: 外发材料没过闸");
    f.advance(5 * HOUR);
    policy({ manualCaseSla: "on" });
  };
  const slaNotes = (f: F) => listEvents(f.db, { project: "p" }).filter((e) => String(e.data.op ?? "").startsWith("manual_case_sla"));
  const finding = (id: string, mark: string): AuditFinding => ({ key: `p|manual_stalled|${id}|${mark}`, project: "p", taskId: id, rule: "manual_stalled", since: 1,
    detail: `${id} 停了`, suggestion: "核对", notify: "pm" });

  test("the older action cards went out first: the batched reminder sends nothing for those episodes, now or later", async () => {
    const f = autoFixture();
    try {
      await three(f);
      const told: string[] = [], sends: string[] = [];
      await legacy(f, async (text) => void told.push(text));
      expect(told).toHaveLength(3);
      const out = await slaTick(f, sends);
      expect(out).toEqual([expect.objectContaining({ action: "legacy_covered", episodes: [["C1", expect.any(Number)], ["C2", expect.any(Number)], ["C3", expect.any(Number)]] })]);
      for (let i = 0; i < 3; i++) { f.advance(HOUR); await slaTick(f, sends); }
      expect([sends.length, slaNotes(f).length]).toEqual([0, 0]);
      // the leased writer says the same when asked directly: no claim on an episode the older notice delivered
      const seq = listEvents(f.db, { project: "p", target: "C1" }).findLast((e) => e.kind === "scheduler")!.seq;
      expect(await f.cli("scheduler", CMD, "C1", "--phase", "claim", "--entry-seq", String(seq), "--pm", "pm", "--batch", "sla-x"))
        .toMatchObject({ ok: true, recorded: false, state: "legacy_told" });
      // a new episode of the card is not covered by the old episode's notice
      expect(await f.cli("pm", "workflow-set", "C1", "--rev", String(getTask(f.db, "C1")!.rev), "--workflow-rev", String(getWorkflow(f.db, "C1")!.rev), "--template", "code",
        "--version", "2", "--mode", "manual", "--author-family", "claude", "--fallback", "人工", "--reason", "ui_evidence_stale: 截图过期")).toMatchObject({ ok: true });
      f.advance(3 * HOUR);
      await slaTick(f, sends);
      expect(sends).toHaveLength(1);
      expect(sends[0]).toContain("C1（");
      expect(sends[0]).not.toContain("C2（");
    } finally { f.close(); }
  });

  test("both at once: every episode is told by exactly one of them; a send of the older notice still out keeps its episode", async () => {
    const f = autoFixture();
    try {
      await three(f);
      const told: string[] = [], sends: string[] = [];
      // the batched round runs while the older notice's first send (C1) is out: C1 stays with it, C2 / C3 are claimed and the older notice loses them
      await legacy(f, async (text) => { told.push(text); if (told.length === 1) await slaTick(f, sends); });
      expect([told.length, sends.length]).toEqual([1, 1]);
      expect(told[0]).toContain("C1");
      expect(sends[0]).not.toContain("C1（");
      for (const id of ["C2（", "C3（"]) expect(sends[0]).toContain(id);
      for (let i = 0; i < 3; i++) { f.advance(HOUR); await slaTick(f, sends); await legacy(f, async (text) => void told.push(text)); }
      expect([told.length, sends.length]).toEqual([1, 1]);
    } finally { f.close(); }
  });

  test("legacy delivery timeout must not become definitely unsent: no delivery record on an older notice is unknown, never taken over", async () => {
    const f = autoFixture();
    try {
      await three(f);
      const told: string[] = [], sends: string[] = [];
      // the older notice reaches the PM and then its answer times out: claimed, no sent record
      await legacy(f, async (text) => { told.push(text); throw new Error("bridge 答复超时"); });
      expect(told).toHaveLength(3);
      f.advance(6 * MIN);
      const out = await slaTick(f, sends);
      expect(out).toEqual([expect.objectContaining({ action: "legacy_covered", episodes: [["C1", expect.any(Number)], ["C2", expect.any(Number)], ["C3", expect.any(Number)]] })]);
      expect(out[0].why).toContain("投递结果不明");
      const seq = listEvents(f.db, { project: "p", target: "C1" }).findLast((e) => e.kind === "scheduler")!.seq;
      expect(await f.cli("scheduler", CMD, "C1", "--phase", "claim", "--entry-seq", String(seq), "--pm", "pm", "--batch", "sla-x"))
        .toMatchObject({ ok: true, recorded: false, state: "legacy_unknown" });
      // however old the claim gets, and the older notice's own retry stays its own: the batched reminder never speaks for these episodes
      for (let i = 0; i < 3; i++) { f.advance(7 * HOUR); await slaTick(f, sends); }
      expect([sends.length, slaNotes(f).length]).toEqual([0, 0]);
      await legacy(f, async (text) => void told.push(text));
      expect(told).toHaveLength(6);
      f.advance(HOUR);
      await slaTick(f, sends);
      expect(sends).toHaveLength(0);
    } finally { f.close(); }
  });

  test("an older notice still out after six minutes keeps its episode; when it lands the PM has heard once", async () => {
    const f = autoFixture();
    try {
      await three(f);
      const told: string[] = [], sends: string[] = [];
      let land = () => {};
      const out = legacy(f, (text) => { told.push(text); return told.length === 1 ? new Promise<void>((r) => { land = r; }) : Promise.resolve(); });
      await Promise.resolve();
      expect(told).toHaveLength(1); // C1's send is out
      f.advance(6 * MIN);
      await slaTick(f, sends); // C2 / C3 have no older claim yet and are batched; C1 is not, whatever the age of its claim
      expect(sends).toHaveLength(1);
      expect(sends[0]).not.toContain("C1（");
      land();
      await out;
      for (let i = 0; i < 3; i++) { f.advance(HOUR); await slaTick(f, sends); await legacy(f, async (text) => void told.push(text)); }
      expect([told.length, sends.length]).toEqual([1, 1]);
    } finally { f.close(); }
  });

  test("the audit's finding opened for a push with no push record stays with the audit, also resolved or old", async () => {
    const f = autoFixture();
    try {
      await three(f);
      const sends: string[] = [], now = () => f.tickDeps.now();
      reconcileFindings(f.db, "p", [], ["manual_stalled"], now() - MIN);
      reconcileFindings(f.db, "p", [finding("C1", "e1"), finding("C2", "e1")], ["manual_stalled"], now()); // both handed to the push
      f.advance(6 * MIN);
      reconcileFindings(f.db, "p", [finding("C1", "e1")], ["manual_stalled"], now() - 6 * MIN + 1); // C2 resolved with its push unrecorded
      const out = await slaTick(f, sends);
      expect(out[0]).toMatchObject({ action: "legacy_covered", episodes: [["C1", expect.any(Number)], ["C2", expect.any(Number)]] });
      expect(sends).toHaveLength(1);
      for (const id of ["C1（", "C2（"]) expect(sends[0]).not.toContain(id);
    } finally { f.close(); }
  });

  test("the audit's manual_stalled finding: pushed or being pushed keeps the episode; one silenced at the rule's first run does not", async () => {
    const f = autoFixture();
    try {
      await three(f);
      const sends: string[] = [], now = () => f.tickDeps.now();
      reconcileFindings(f.db, "p", [finding("C3", "e1")], ["manual_stalled"], now()); // first run of the rule: recorded as told without a push
      f.advance(MIN);
      reconcileFindings(f.db, "p", [finding("C3", "e1"), finding("C1", "e1"), finding("C2", "e1")], ["manual_stalled"], now());
      expect(ackFindings(f.db, [finding("C1", "e1").key], now())).toBe(1); // C1 pushed; C2 opened and still to be pushed
      const out = await slaTick(f, sends);
      expect(out[0]).toMatchObject({ action: "legacy_covered", episodes: [["C1", expect.any(Number)], ["C2", expect.any(Number)]] });
      expect(sends).toHaveLength(1);
      expect(sends[0]).toContain("C3（");
      for (const id of ["C1（", "C2（"]) expect(sends[0]).not.toContain(id);
      expect(ackFindings(f.db, [finding("C2", "e1").key], now())).toBe(1);
      for (let i = 0; i < 3; i++) { f.advance(HOUR); await slaTick(f, sends); }
      expect(sends).toHaveLength(1);
      expect(manualCaseSlaReport(f.db, "p", 0, null)).toMatchObject({ batches: { sent: 1, unknown: 0, unsent: 0 }, repeated: 0, released: 0 });
    } finally { f.close(); }
  });

  test("an older notice lands between the claim and the send: the claim is released, nothing is sent twice", async () => {
    const f = autoFixture();
    try {
      await three(f);
      const sends: string[] = [];
      const write = async (args: string[]) => {
        if (args.includes("confirm")) {
          reconcileFindings(f.db, "p", [], ["manual_stalled"], f.tickDeps.now() - MIN);
          reconcileFindings(f.db, "p", [finding("C2", "e9")], ["manual_stalled"], f.tickDeps.now());
          ackFindings(f.db, [finding("C2", "e9").key], f.tickDeps.now());
        }
        return recoveryWrite(f.tickDeps.manager, CMD, args, true);
      };
      const out = await manualCaseSlaTick(f.db, ["p"], { now: f.tickDeps.now, write, send: async (_p, _pm, text) => { sends.push(text); return { state: "sent", receipt: "m" }; } });
      expect(out.map((o) => o.action)).toEqual(["released", "sent"]);
      expect(sends).toHaveLength(1);
      expect(sends[0]).not.toContain("C2（");
      for (let i = 0; i < 2; i++) { f.advance(HOUR); await slaTick(f, sends); }
      expect(sends).toHaveLength(1);
      expect(manualCaseSlaCovers("p", listEvents(f.db, { project: "p", target: "C2" }))).toBe(false); // a released claim covers nothing
    } finally { f.close(); }
  });
});

describe("[验收线 6] next to the slot, manual merge requests, the pass and PM hand-back", () => {
  test("a reminder takes no slot, cancels no request or intent, changes no workflow or stage; the pass runs as before", async () => {
    w = reclaimWorld({ store: "memory", deploy: true });
    const world = w, live = () => ["scheduler_resources", "scheduler_intents", "scheduler_merges", "task_workflows", "tasks"].map((t) => world.db.query(`SELECT * FROM ${t}`).all());
    setMeta(world.db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: [PM] });
    policy({ manualMergeQueue: "on", manualCaseSla: "on" });
    const a = world.card("A"), m = await manualCard(world, "M");
    await world.begin("A");
    expect(await ledgerAs(world, PM, ...requestArgs(m))).toMatchObject({ ok: true });
    const queue = async () => (await ledgerAs(world, PM, "manual-queue", "--project", "p") as
      { active: { taskId: string; episodeId: number; request: { state: string } | null }[] }).active.find((x) => x.taskId === "M")!;
    const overdue = async () => expect(await ledgerAs(world, PM, "manual-case-set", "M", "--entry-seq", String((await queue()).episodeId), "--responsible", PM, "--role", "pm",
      "--due-at", new Date(Date.now() - HOUR).toISOString(), "--next", "排队合并", "--reason", "PM 跟进")).toMatchObject({ ok: true });
    await overdue();
    const sends: string[] = [];
    const tick = (later = 0) => manualCaseSlaTick(world.db, ["p"], { now: () => Date.now() + later, write: (args) => recoveryWrite(world.manager, CMD, args, true),
      send: async (_p, pm, text) => { sends.push(`${pm}: ${text}`); return { state: "sent", receipt: "m" }; } });
    const before = live(), max = (world.db.query("SELECT MAX(seq) AS s FROM events").get() as { s: number }).s;
    await tick();
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain(`${PM}: [人工卡逾期 sla-`);
    expect(live()).toEqual(before);
    expect(world.slot()).toBe("A");
    expect((await queue()).request).toMatchObject({ state: expect.stringMatching(/queued|waiting/) });
    expect(listEvents(world.db, { project: "p" }).filter((e) => e.seq > max).map((e) => [e.target, e.kind, e.data.op]))
      .toEqual([["M", "note", "manual_case_sla"], ["", "note", "manual_case_sla_batch"]]);
    // the pass (which also runs the wired tick) drives train / merge / deploy / auto: the request merges, A goes live, nothing more is sent
    for (let i = 0; i < 6; i++) await world.pass();
    expect((await queue()).request).toMatchObject({ state: "merged" });
    expect(getTask(world.db, a.taskId)!.stage).toBe("live");
    expect(sends).toHaveLength(1);
    // a card whose manual merge request merged is not reminded, even overdue; PM hand-back still works on a reminded card
    const n = await manualCard(world, "N");
    expect(await ledgerAs(world, PM, ...requestArgs(n))).toMatchObject({ ok: true });
    for (let i = 0; i < 6; i++) await world.pass();
    const row = (await ledgerAs(world, PM, "manual-queue", "--project", "p") as { active: { taskId: string; episodeId: number; request: { state: string } | null }[] })
      .active.find((x) => x.taskId === "N")!;
    expect(row.request).toMatchObject({ state: "merged" });
    expect(await ledgerAs(world, PM, "manual-case-set", "N", "--entry-seq", String(row.episodeId), "--responsible", PM, "--role", "pm",
      "--due-at", new Date(Date.now() - HOUR).toISOString(), "--next", "等部署", "--reason", "PM 跟进")).toMatchObject({ ok: true });
    await tick();
    expect(sends).toHaveLength(1);
    // PM holds B, it is reminded once it is overdue, and PM's hand-back works as before on the reminded card
    const pm = (...args: string[]) => runLedger(args, { db: world.db, actor: PM, projectIds: ["p"], autoProjects: () => ["p"], autoDispatch: () => true,
      loadRegistry: async () => ({} as Registry), saveRegistry: async () => {}, now: () => Date.now() }) as Promise<Record<string, unknown>>;
    const revs = () => ["--rev", String(getTask(world.db, "B")!.rev), "--workflow-rev", String(getWorkflow(world.db, "B")!.rev)];
    world.card("B");
    expect(await pm("workflow-set", "B", ...revs(), "--template", "code", "--version", "2", "--mode", "manual", "--author-family", "claude", "--fallback", "人工",
      "--reason", "pm_hold: 先停一下")).toMatchObject({ ok: true });
    const hold = listEvents(world.db, { project: "p", target: "B" }).findLast((e) => e.kind === "scheduler")!;
    expect(await pm("manual-case-set", "B", "--entry-seq", String(hold.seq), "--responsible", PM, "--role", "pm",
      "--due-at", new Date(Date.now() - HOUR).toISOString(), "--next", "核对后交回", "--reason", "PM 跟进")).toMatchObject({ ok: true });
    const stage = getTask(world.db, "B")!.stage;
    expect((await tick())[0]).toMatchObject({ action: "window_wait" }); // the PM's last batch is minutes old
    await tick(HOUR);
    expect(sends).toHaveLength(2);
    expect([getTask(world.db, "B")!.stage, getWorkflow(world.db, "B")!.mode]).toEqual([stage, "manual"]);
    expect(await pm("workflow-resume", "B", ...revs(), "--reason", "PM 交回")).toMatchObject({ ok: true });
    expect(getWorkflow(world.db, "B")!.mode).toBe("auto");
    await tick();
    expect(sends).toHaveLength(2);
  });
});

describe("[验收线 7] registered once; the log counts batches, repeats and outcomes; tokens are unknown unless a usage row is linked", () => {
  test("the command and the key are registered once everywhere they must be", () => {
    expect(SCHEDULER_V2_LEDGER_COMMANDS[CMD]).toEqual({ target: "task", handling: "unmapped" });
    expect(SKIP_LEDGER_COMMANDS[CMD]).toBe("task");
    expect(SKIP_LEDGER_DYNAMIC["scheduler-recovery-ports.ts"]).toContain(CMD);
    expect(SCHEDULER_SERVICE_COMMANDS.has(CMD)).toBe(true);
    expect(RECOVERY_KEYS.filter((k) => k === "manualCaseSla")).toHaveLength(1);
    const registered = Object.values(SKIP_EFFECT_FILES).flatMap((g) => Object.keys(g));
    expect(registered.filter((x) => x === "manual-case-sla-tick.ts")).toHaveLength(1);
  });

  test("the report: batches, episodes repeated, unknown; cost only from usage rows that carry the batch id", async () => {
    const f = autoFixture();
    try {
      for (const id of ["C1", "C2"]) await enter(f, id, "materials_gate: 外发材料没过闸");
      f.advance(5 * HOUR);
      policy({ manualCaseSla: "on" });
      const sends: string[] = [];
      await slaTick(f, sends);
      const batchId = /sla-[0-9a-f]{12}/.exec(sends[0])![0];
      // no usage db: the deliveries are counted, the wake turns and tokens are unknown, never estimated from the text
      const blind = manualCaseSlaReport(f.db, "p", 0, null);
      expect(blind).toMatchObject({ batches: { sent: 1, unknown: 0, unsent: 0 }, repeated: 0,
        cost: { deliveries: 1, wakeTurns: null, input: null, output: null, unlinked: 1 } });
      expect(manualCaseSlaLines(blind).join("\n")).toContain("PM 被叫醒回合 未知，输入 token 未知");
      // a usage db whose turn was triggered by this batch's message: that turn's calls, and only those
      const usage = new Database(":memory:");
      usage.run("CREATE TABLE turns (turn_id TEXT PRIMARY KEY, agent TEXT, trigger TEXT)");
      usage.run("CREATE TABLE calls (key TEXT PRIMARY KEY, turn_id TEXT, input INTEGER, cache_creation INTEGER, cache_read INTEGER, output INTEGER)");
      expect(manualCaseSlaReport(f.db, "p", 0, usage).cost).toMatchObject({ deliveries: 1, wakeTurns: null, input: null, unlinked: 1 });
      usage.run("INSERT INTO turns VALUES ('t1', 'pm', ?), ('t2', 'pm', '[人工卡逾期 sla-other] 别的批次')", [`[人工卡逾期 ${batchId}] 项目 p · 给 pm：2 段…`]);
      usage.run("INSERT INTO calls VALUES ('c1', 't1', 100, 20, 3000, 40), ('c2', 't1', 50, 0, 3100, 60), ('c3', 't2', 999, 999, 999, 999)");
      const linked = manualCaseSlaReport(f.db, "p", 0, usage);
      expect(linked.cost).toEqual({ deliveries: 1, wakeTurns: 1, input: 150, cacheRead: 6100, cacheCreation: 20, output: 100, unlinked: 0, why: null });
      expect(manualCaseSlaLines(linked).join("\n")).toContain("PM 被叫醒回合 1，输入 token 150");
      usage.close();
      // the events carry what the log needs: batch id, episode set, count, responsible, due date, outcome, receipt
      const batch = listEvents(f.db, { project: "p", target: "" }).find((e) => e.data.op === "manual_case_sla_batch")!;
      expect(batch.data).toMatchObject({ batchId, state: "sent", pm: "pm", count: 2, receipt: "m",
        episodes: [expect.objectContaining({ taskId: "C1", responsible: "pm" }), expect.objectContaining({ taskId: "C2", dueAt: expect.any(Number) })] });
      expect(String(batch.data.summary).length).toBeLessThanOrEqual(300);
    } finally { f.close(); }
  });
});
