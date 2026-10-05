/**
 * dispatch-recovery-AUDP composite ports: every exit runs the real leaf (MAT writeMaterials on a ledger card, MODEL
 * recordModelOutcome on the auto fixture, ASKR sweepReminders on a temp ledger, PLAN planGapTick) with one mutable policy table
 * behind the injected port. Asserted: the right (project, mechanism) is read on every call (no cache), projects and modes stay
 * apart, null thresholds are kept, illegal / throwing reads are off with a diagnostic, observe / off leave no side effect, a
 * provider safety refusal is a hold with no retry and no new dispatch. Temp ledgers only; notifyPm is a recorder, no bridge.
 */
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindHash, checkAsk } from "../src/lib/ask-bind.js";
import { noticeBlocker, noticeGateNow, reminderDedupKey } from "../src/lib/ask-recovery.js";
import { fixMaterials } from "../src/lib/fix-materials.js";
import { closeAsk, getAsk, listAsks, openAsk, type Ask, type NewAsk } from "../src/lib/ledger-asks.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask } from "../src/lib/ledger-write.js";
import type { PeerSeats, ProjectFacts, WorkItem } from "../src/lib/recovery-plan-gap.js";
import { createRecoveryRuntimePorts, type RecoveryMechanism, type RecoveryPolicyDiag } from "../src/lib/recovery-runtime-ports.js";
import type { OutcomeInput, RecoveryPolicy } from "../src/lib/scheduler-model-outcome.js";
import { openSafetyHold } from "../src/lib/scheduler-review-swap.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

/** project → mechanism → answer; "throw" makes the port throw. Mutated between calls to prove there is no cache. */
type Answer = RecoveryPolicy | "throw" | unknown;
function policyTable() {
  const table: Record<string, Partial<Record<RecoveryMechanism, Answer>>> = {};
  const asked: string[] = [];
  const diags: RecoveryPolicyDiag[] = [];
  const port = (project: string, mechanism: RecoveryMechanism): RecoveryPolicy => {
    asked.push(`${project}:${mechanism}`);
    const a = table[project]?.[mechanism];
    if (a === "throw") throw new Error(`cfg 坏了 ${project}`);
    return (a ?? { mode: "off", manualAfterMs: null }) as RecoveryPolicy;
  };
  const set = (project: string, mechanism: RecoveryMechanism, a: Answer) => { (table[project] ??= {})[mechanism] = a; };
  const rt = createRecoveryRuntimePorts({ policy: port, onDiag: (d) => void diags.push(d) });
  return { rt, set, asked, diags };
}
const pol = (mode: "on" | "observe" | "off", manualAfterMs: number | null = null): RecoveryPolicy => ({ mode, manualAfterMs });

const dirs: string[] = [];
const paths: string[] = [];
afterEach(() => {
  for (const p of paths.splice(0)) closeLedger(p);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDb(prefix: string): { db: Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix)), path = join(dir, "ledger.sqlite");
  dirs.push(dir);
  paths.push(path);
  return { db: openLedger(path), dir };
}

describe("factory shape", () => {
  test("only the four leaf exits; no approval port, tick or diagnose-and-run helper", () => {
    expect(Object.keys(createRecoveryRuntimePorts()).sort()).toEqual(["askReminderPorts", "planGapTick", "recordModelOutcome", "sweepAskReminders", "writeMaterials"]);
    // recordModelOutcome's exit takes exactly db, ctx, input: no port slot a caller could pass an approval through.
    expect(createRecoveryRuntimePorts().recordModelOutcome.length).toBe(3);
  });
});

// ── MAT ──

const FINDINGS = [{ findingId: "race-1", family: "concurrency", severity: "P1", probe: "两进程同时写", description: "并发写丢数据" },
  { findingId: "api-2", family: "api", severity: "P2", probe: "返回值没校验", description: "调用方拿到 undefined", file: "src/lib/x.ts", line: 12, basis: "acceptance:2" }];
const REPORT = "# 审查报告\n\n## P1\n- race-1 并发写丢数据\n";
const probe = { peerFp: async () => "abcd-ef01", remoteHead: async () => ({ ok: true as const, head: "b".repeat(40) }) };

function fixCards() {
  const { db, dir } = tempDb("recovery-ports-mat-");
  for (const project of ["pa", "pb"]) {
    const id = `T-${project}`, report = join(dir, `${id}.md`);
    writeFileSync(report, REPORT);
    createTask(db, { actor: "owner", now: 1000 }, { project, id, title: id, kind: "code", agent: "agent-dev" } as never);
    insertEvent(db, { actor: "agent-rev", now: 2000 }, { project, target: id, kind: "review", text: "changes", data: { round: 0, verdict: "changes", path: report, findings: FINDINGS } }, true);
    db.run("UPDATE tasks SET stage = 'fix', round = 1 WHERE id = ?", [id]);
  }
  const offer = (rt: ReturnType<typeof createRecoveryRuntimePorts>, project: string) =>
    rt.writeMaterials(db, getTask(db, `T-${project}`)!, { peer: "mate", repo: "o/r", base: "main" }, probe);
  return { db, dir, offer };
}

describe("MAT exit → writeMaterials", () => {
  test("on sends the leaf's structured items without the report; observe / off / other project keep the full text; read every call", async () => {
    const { db, dir, offer } = fixCards();
    const { rt, set, asked } = policyTable();
    set("pa", "materials", pol("on"));
    set("pb", "materials", pol("observe"));
    const a = (await offer(rt, "pa"))!;
    // The items are exactly what the leaf builds from the ledger review; nothing re-derived here.
    const leaf = fixMaterials("on", listEvents(db, { project: "pa", target: "T-pa" }), join(dir, "T-pa.md"), REPORT);
    expect(a.report).toBeNull();
    expect(a.materials).toEqual(leaf!);
    expect(a.materials!.items.map((i) => i.findingId)).toEqual(["race-1", "api-2"]);
    const b = (await offer(rt, "pb"))!;
    expect(b.report).toBe(REPORT);
    expect(b.materials?.mode).toBe("observe");
    expect(asked).toEqual(["pa:materials", "pb:materials"]);
    // Policy change between calls, no cache: pa now off → full text and no material at all.
    set("pa", "materials", pol("off"));
    const off = (await offer(rt, "pa"))!;
    expect(off.report).toBe(REPORT);
    expect(off.materials).toBeUndefined();
    expect(asked).toEqual(["pa:materials", "pb:materials", "pa:materials"]);
  });

  test("no port observes; throwing or illegal reads (an `on` with a bad threshold too) are off with a diagnostic", async () => {
    const { offer } = fixCards();
    const none = (await offer(createRecoveryRuntimePorts(), "pa"))!;
    expect([none.report, none.materials?.mode]).toEqual([REPORT, "observe"]);
    const { rt, set, diags } = policyTable();
    set("pa", "materials", "throw");
    set("pb", "materials", { mode: "on", manualAfterMs: -1 });
    for (const p of ["pa", "pb"]) {
      const w = (await offer(rt, p))!;
      expect([w.report, w.materials]).toEqual([REPORT, undefined]);
    }
    expect(diags.map((d) => [d.project, d.mechanism])).toEqual([["pa", "materials"], ["pb", "materials"]]);
    expect(diags[0].reason).toContain("cfg 坏了 pa");
    expect(diags[1].reason).toContain("manualAfterMs 不合法");
  });
});

// ── MODEL ──

const REFUSAL = "API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy";

async function building() {
  const f = autoFixture();
  await toBuild(f);
  expect(await f.tick()).toMatchObject({ step: "sent" });
  const intent = f.intents().findLast((i) => i.action === "dispatch")!;
  const input = (signal: OutcomeInput["signal"], more: Partial<OutcomeInput> = {}): OutcomeInput => ({ intentId: intent.id, signal,
    failed: { agent: "agent-task-one", family: "claude", machine: "local" }, authorized: [{ family: "claude", machine: "local" }, { family: "claude", machine: "Hede" }],
    ended: true, ...more });
  const outcomes = () => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => String(e.data.op).startsWith("model_"));
  return { f, input, outcomes };
}

describe("MODEL exit → recordModelOutcome", () => {
  test("off records nothing; on capacity records the leaf's redispatch decision once (dedup), and dispatches nothing itself", async () => {
    const { f, input, outcomes } = await building();
    try {
      const { rt, set, asked } = policyTable();
      const cap = input({ failure: { kind: "quota", message: "usage limit reached" } });
      set("p", "modelOutcome", pol("off"));
      expect(rt.recordModelOutcome(f.db, f.at("scheduler"), cap)).toEqual({ kind: "off" });
      expect(outcomes()).toHaveLength(0);
      const intents = f.intents().length;
      set("p", "modelOutcome", pol("on"));
      const r = rt.recordModelOutcome(f.db, f.at("scheduler"), cap);
      expect(r).toMatchObject({ kind: "recorded", mode: "on", cls: "capacity", duplicate: false, plan: { kind: "redispatch", to: { family: "claude", machine: "Hede" } } });
      expect(rt.recordModelOutcome(f.db, f.at("scheduler"), cap)).toMatchObject({ duplicate: true });
      expect(outcomes()).toHaveLength(1);
      expect(f.intents()).toHaveLength(intents);
      expect(asked).toEqual(["p:modelOutcome", "p:modelOutcome", "p:modelOutcome"]);
      // Permission stays in the leaf: only the scheduler records.
      expect(() => rt.recordModelOutcome(f.db, f.at("pm"), cap)).toThrow(/调度服务/);
    } finally { f.close(); }
  });

  test("an unknown send (may have arrived) is manual, never a redispatch", async () => {
    const { f, input, outcomes } = await building();
    try {
      const { rt, set } = policyTable();
      set("p", "modelOutcome", pol("on"));
      expect(rt.recordModelOutcome(f.db, f.at("scheduler"), input({ send: { delivered: "unknown", reason: "timeout" } })))
        .toMatchObject({ kind: "recorded", plan: { kind: "manual", code: "model_recovery_manual" } });
      expect(outcomes().map((e) => (e.data.plan as { kind: string }).kind)).toEqual(["manual"]);
    } finally { f.close(); }
  });

  test("an order that already delivered is not a failure: nothing recorded, nothing re-dispatched", async () => {
    const { f, input, outcomes } = await building();
    try {
      const { rt, set } = policyTable();
      set("p", "modelOutcome", pol("on"));
      const intents = f.intents().length;
      expect(await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1)).toMatchObject({ ok: true });
      expect(rt.recordModelOutcome(f.db, f.at("scheduler"), input({ failure: { kind: "error", message: "ECONNRESET" } })))
        .toMatchObject({ kind: "none", reason: expect.stringContaining("已有交付") });
      expect(outcomes()).toHaveLength(0);
      expect(f.intents()).toHaveLength(intents);
    } finally { f.close(); }
  });

  test("not ended → manual, never a redispatch plan", async () => {
    const { f, input } = await building();
    try {
      const { rt, set } = policyTable();
      set("p", "modelOutcome", pol("on"));
      expect(rt.recordModelOutcome(f.db, f.at("scheduler"), input({ failure: { kind: "error", message: "ECONNRESET" } }, { ended: false })))
        .toMatchObject({ kind: "recorded", plan: { kind: "manual", reason: expect.stringContaining("未确认无结果且已终止") } });
    } finally { f.close(); }
  });

  test("provider safety refusal: evidence + hold, no retry, no family switch, no verdict; observe holds nothing", async () => {
    const { f, input, outcomes } = await building();
    try {
      const { rt, set } = policyTable();
      set("p", "modelOutcome", pol("observe"));
      const seen = rt.recordModelOutcome(f.db, f.at("scheduler"), input({ failure: { kind: "error", message: REFUSAL } }));
      expect(seen).toMatchObject({ kind: "recorded", mode: "observe", event: { kind: "note" } });
      expect(openSafetyHold(listEvents(f.db, { project: "p", target: "T1" }))).toBeNull();
      const intents = f.intents().length;
      set("p", "modelOutcome", pol("on"));
      const r = rt.recordModelOutcome(f.db, f.at("scheduler"), input({ failure: { kind: "error", message: REFUSAL } }));
      expect(r).toMatchObject({ kind: "recorded", mode: "on", cls: "safety", plan: { kind: "manual", code: "model_safety_hold" },
        event: { kind: "escalate", data: { evidence: REFUSAL, verdict: null, noReport: true } } });
      expect(openSafetyHold(listEvents(f.db, { project: "p", target: "T1" }))).not.toBeNull();
      expect(f.intents()).toHaveLength(intents);
      expect(outcomes().map((e) => e.data.op)).toEqual(["model_outcome", "model_safety_hold"]);
    } finally { f.close(); }
  });

  test("reviewer refusal: the exit injects no approval port, so even a fresh refusal is a hold, not the approved same-model retry", async () => {
    const f = autoFixture();
    try {
      await toBuild(f);
      expect(await f.tick()).toMatchObject({ step: "sent" });
      expect(await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1)).toMatchObject({ ok: true });
      expect(await f.tick()).toMatchObject({ step: "session" });
      expect(await f.tick()).toMatchObject({ step: "sent" });
      const review = f.intents().findLast((i) => i.action === "review")!;
      const intents = f.intents().length;
      const { rt, set } = policyTable();
      set("p", "modelOutcome", pol("on"));
      const r = rt.recordModelOutcome(f.db, f.at("scheduler"), { intentId: review.id, signal: { failure: { kind: "error", message: REFUSAL } },
        failed: { agent: "agent-rv-t1", family: "codex", machine: "local" }, authorized: [{ family: "codex", machine: "local" }, { family: "claude", machine: "backup" }],
        ended: true, review: { sessionId: "s-rv", materialDigest: "sha256:m" } });
      expect(r).toMatchObject({ kind: "recorded", cls: "safety", plan: { kind: "manual", code: "model_safety_hold", reason: expect.stringContaining("缺批准 port") },
        event: { data: { approvalId: null, verdict: null } } });
      expect(f.intents()).toHaveLength(intents);
    } finally { f.close(); }
  });

  test("illegal / throwing reads are off with a diagnostic and no record", async () => {
    const { f, input, outcomes } = await building();
    try {
      const { rt, set, diags } = policyTable();
      set("p", "modelOutcome", { mode: "on", manualAfterMs: Number.NaN });
      const cap = input({ failure: { kind: "quota", message: "usage limit reached" } });
      expect(rt.recordModelOutcome(f.db, f.at("scheduler"), cap)).toMatchObject({ kind: "off", diag: expect.stringContaining("manualAfterMs 不合法") });
      set("p", "modelOutcome", "throw");
      expect(rt.recordModelOutcome(f.db, f.at("scheduler"), cap)).toMatchObject({ kind: "off", diag: expect.stringContaining("cfg 坏了") });
      expect(outcomes()).toHaveLength(0);
      expect(diags.map((d) => d.mechanism)).toEqual(["modelOutcome", "modelOutcome"]);
    } finally { f.close(); }
  });
});

// ── ASKR ──

const H = 3_600_000;
const BIND = { action: "release", params: { tag: "v1" }, approve: ["go"] };
const ASK: NewAsk = { project: "pa", fromAgent: "agent-x", fromChannelId: "111", source: "reply", kind: "decide", title: "发吗", blocking: true,
  options: [{ type: "buttons", buttons: [{ id: "go", label: "发" }] }], askKey: "release", extra: {} };
const LIVE = { ownerActive: () => ({ active: true, evidence: "heartbeat" }), askerLive: () => true };

function asks() {
  const { db } = tempDb("recovery-ports-askr-");
  const expired = (input: Partial<NewAsk> = {}, key = "release"): Ask => {
    const a = openAsk(db, { ...ASK, askKey: key, expiresAt: 1_000 + 4 * H, ...input }, 1_000);
    return closeAsk(db, a.id, "expired", "", a.expiresAt)!;
  };
  const reminders = () => listAsks(db).filter((a) => typeof a.extra.recoveryOf === "string");
  return { db, expired, reminders };
}

describe("ASKR exit → sweepReminders / notice gate", () => {
  test("projects apart: on opens one reminder, observe / off open nothing; a repeat sweep opens no second", async () => {
    const { db, expired, reminders } = asks();
    const a = expired(), b = expired({ project: "pb" }, "b"), c = expired({ project: "pc" }, "c");
    const { rt, set, asked } = policyTable();
    set("pa", "askReminder", pol("on"));
    set("pb", "askReminder", pol("observe"));
    set("pc", "askReminder", pol("off"));
    const now = a.expiresAt + 1;
    const out = await rt.sweepAskReminders(db, LIVE, now);
    expect(Object.fromEntries(out.map((r) => [r.id, r.result]))).toEqual({ [a.id]: "opened", [b.id]: "observe", [c.id]: "skip" });
    expect(reminders().map((r) => r.extra.recoveryOf)).toEqual([a.id]);
    expect(asked.filter((x) => x.startsWith("pb") || x.startsWith("pc"))).toEqual(["pb:askReminder", "pc:askReminder"]);
    expect((await rt.sweepAskReminders(db, LIVE, now + 60_000)).find((r) => r.id === a.id)).toMatchObject({ result: "skip", reason: "reminder already opened" });
    expect(reminders()).toHaveLength(1);
    expect(getAsk(db, a.id)!.state).toBe("expired");
  });

  test("null threshold waits forever; a set threshold is the owner's, passed through unchanged", async () => {
    const { db, expired, reminders } = asks();
    const a = expired();
    const { rt, set } = policyTable();
    set("pa", "askReminder", pol("on", 1_000));
    expect((await rt.sweepAskReminders(db, LIVE, a.expiresAt + 100 * 24 * H))[0]).toMatchObject({ result: "skip", reason: "reminder window passed" });
    set("pa", "askReminder", pol("on", null));
    expect((await rt.sweepAskReminders(db, LIVE, a.expiresAt + 100 * 24 * H))[0]).toMatchObject({ result: "opened" });
    expect(reminders()).toHaveLength(1);
  });

  test("authorize: the reminder is re-bound (new hash); the old hash never approves it", async () => {
    const { db, expired } = asks();
    const a = expired({ kind: "authorize", bind: { ...BIND, paramsHash: bindHash(BIND, "agent-x") } });
    const { rt, set } = policyTable();
    set("pa", "askReminder", pol("on"));
    const r = (await rt.sweepAskReminders(db, LIVE, a.expiresAt + 1))[0] as { reminder: Ask };
    expect(r.reminder.dedupKey).toBe(reminderDedupKey(a.id));
    expect(r.reminder.bind!.paramsHash).not.toBe(a.bind!.paramsHash);
    expect(checkAsk(r.reminder, a.bind!.paramsHash, "agent-x", a.expiresAt + 2)).toMatchObject({ ok: false });
  });

  test("illegal answers are off (not the leaf's later mode / window checks) with a diagnostic; a caller-passed policy is dropped", async () => {
    const { db, expired, reminders } = asks();
    const a = expired(), b = expired({ project: "pb" }, "b");
    const { rt, set, diags } = policyTable();
    set("pa", "askReminder", { mode: "ON", manualAfterMs: null });
    set("pb", "askReminder", { mode: "on", manualAfterMs: -5 });
    const smuggled = { ...LIVE, policy: () => pol("on") } as never;
    const out = await rt.sweepAskReminders(db, smuggled, a.expiresAt + 1);
    expect(out.map((r) => [r.id, r.result, "reason" in r && r.reason])).toEqual([[a.id, "skip", "mode=off"], [b.id, "skip", "mode=off"]]);
    expect(reminders()).toHaveLength(0);
    expect(diags.map((d) => [d.project, d.mechanism])).toEqual([["pa", "askReminder"], ["pb", "askReminder"]]);
    expect(rt.askReminderPorts(smuggled).policy).not.toBe((smuggled as { policy: unknown }).policy);
  });

  test("notice gate reads the same port live: a pending notice is held while observe / off, released when on", async () => {
    const { db, expired, reminders } = asks();
    const a = expired();
    const { rt, set } = policyTable();
    set("pa", "askReminder", pol("on"));
    await rt.sweepAskReminders(db, LIVE, a.expiresAt + 1);
    const n = reminders()[0];
    const ports = rt.askReminderPorts(LIVE);
    set("pa", "askReminder", pol("observe"));
    expect(noticeGateNow(n, ports)).toBe("mode=observe");
    set("pa", "askReminder", "throw");
    expect(await noticeBlocker(n, ports)).toBe("mode=off");
    set("pa", "askReminder", pol("on"));
    expect(await noticeBlocker(n, ports)).toBeNull();
  });

  test("no port observes: nothing opened", async () => {
    const { db, expired, reminders } = asks();
    const a = expired();
    expect((await createRecoveryRuntimePorts().sweepAskReminders(db, LIVE, a.expiresAt + 1))[0]).toMatchObject({ result: "observe" });
    expect(reminders()).toHaveLength(0);
  });
});

// ── PLAN ──

const item = (key: string, over: Partial<WorkItem> = {}): WorkItem =>
  ({ featureId: "f1", key, taskId: `t-${key}`, version: 1, state: "ready", external: true, why: "就绪", ...over });
const peer = (free: number): PeerSeats => ({ peer: "mate", seats: free, why: null, free: { codex: free }, allowed: ["codex"] });
const pf = (project: string): ProjectFacts =>
  ({ project, work: [item("a"), item("b", { state: "blocked", gate: "lanes", why: "依赖没满足：a" })], drafts: [], localRoom: 1, localWhy: null, peers: [peer(3)] });

describe("PLAN exit → planGapTick", () => {
  test("projects apart, null threshold sends nothing, one notice per picture, policy change read live; off reads no facts", async () => {
    const { db } = tempDb("recovery-ports-plan-");
    const sent: string[] = [], read: string[] = [];
    const { rt, set, asked } = policyTable();
    const seen = new Map<string, { fp: string; since: number }>();
    const tick = (now: number) => rt.planGapTick({ db, now, projects: ["pa", "pb", "pc"], seen,
      facts: (p: string) => (read.push(p), pf(p)), notifyPm: async (p: string) => void sent.push(p), policy: () => pol("on", 0) } as never);
    set("pa", "planGap", pol("on", 0));
    set("pb", "planGap", pol("observe", 0));
    set("pc", "planGap", pol("on", null));
    const first = await tick(1_000_000);
    expect(first.map((o) => [o.project, o.mode, "action" in o && o.action])).toEqual([["pa", "on", "notified"], ["pb", "observe", "would_notify"], ["pc", "on", "none"]]);
    expect(first[2]).toMatchObject({ why: expect.stringContaining("未设 manualAfterMs") });
    expect(sent).toEqual(["pa"]);
    expect((await tick(1_000_001))[0]).toMatchObject({ action: "deduped" });
    expect(sent).toEqual(["pa"]);
    // pa switched off between ticks: no facts read for it, nothing sent; the smuggled `policy: on` in deps is ignored throughout.
    set("pa", "planGap", pol("off"));
    read.length = 0;
    expect((await tick(1_000_002))[0]).toEqual({ project: "pa", mode: "off", diag: null });
    expect(read).not.toContain("pa");
    expect(asked.filter((x) => x.startsWith("pa"))).toEqual(["pa:planGap", "pa:planGap", "pa:planGap"]);
  });

  test("throwing / illegal reads are off with a diagnostic; no port observes and sends nothing", async () => {
    const { db } = tempDb("recovery-ports-plan-");
    const sent: string[] = [];
    const { rt, set, diags } = policyTable();
    set("pa", "planGap", "throw");
    set("pb", "planGap", { mode: "on", manualAfterMs: "5" });
    const deps = { db, now: 1, projects: ["pa", "pb"], seen: new Map(), facts: pf, notifyPm: async (p: string) => void sent.push(p) };
    const out = await rt.planGapTick(deps);
    expect(out.map((o) => [o.project, o.mode])).toEqual([["pa", "off"], ["pb", "off"]]);
    expect(out[1]).toMatchObject({ diag: expect.stringContaining("manualAfterMs 不合法") });
    expect(diags.map((d) => [d.project, d.mechanism])).toEqual([["pa", "planGap"], ["pb", "planGap"]]);
    const none = await createRecoveryRuntimePorts().planGapTick({ ...deps, seen: new Map() });
    expect(none.map((o) => [o.mode, "action" in o && o.action])).toEqual([["observe", "none"], ["observe", "none"]]);
    expect(sent).toEqual([]);
  });
});

describe("diagnostic sink", () => {
  test("a throwing sink changes nothing: the read is still off", async () => {
    const { offer } = fixCards();
    const rt = createRecoveryRuntimePorts({ policy: () => ({ mode: "maybe" }) as never, onDiag: () => { throw new Error("sink down"); } });
    expect((await offer(rt, "pa"))!.materials).toBeUndefined();
  });
});
