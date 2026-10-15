import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAutostartSwitch } from "../src/lib/ledger-autostart.js";
import { closeLedger, getEventByDedup, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { appendEvent, createTask, setMeta } from "../src/lib/ledger-write.js";
import { autoRegisterObservation } from "../src/lib/observation-auto-register.js";
import { automaticKeys } from "../src/lib/observation-auto-register-spec.js";
import { ackObservation, observationDue } from "../src/lib/observation-plan-due.js";
import { markObservation, readPlans, registerObservation, parseTarget } from "../src/lib/observation-plan.js";
import { observationTickAt } from "../src/lib/observation-plan-tick.js";
import { recordRecoveryError } from "../src/lib/recovery-error.js";
import { recordObserved, recoveryPolicy, setRecovery } from "../src/lib/recovery-policy.js";
import { pmTodos } from "../src/lib/pm-todo.js";
import type { SpecWaitEnv } from "../src/lib/scheduler-spec-wait.js";

const H = 3600_000, T = 1_760_000_000_000, PM = "agent-pm";
let db: Database, dir: string, paths: { plans: string; recovery: string }, text: string;
const owner = (now = T) => ({ actor: "owner", now });
const scheduler = (now = T) => ({ actor: "scheduler", now });
const spec = () => ({ text, mtimeMs: 0 });
const opts = () => ({ ...paths, readSpec: spec });
const mode = (autoMode: string) => setAutostartSwitch(db, owner(), { project: "p", on: true, reason: "test", autoMode });
const register = () => autoRegisterObservation(db, scheduler(), "T1", opts());
const due = (now = T + H) => observationDue(db, scheduler(now), "obs-1", opts());
const events = (op: string) => listEvents(db, { project: "p" }).filter((e) => e.data.op === op);
function service() {
  const sent: string[] = [];
  let now = T;
  const env = { db, svc: { projects: ["p"] }, now: () => now, specWaitSend: async () => { sent.push("push"); },
    ledger: async (_: string, _sub: string, _task: string, id: string, flag?: string) => {
      if (flag) { await ackObservation(now, id, paths); return { ok: true }; }
      return { ok: true, ...await observationDue(db, scheduler(now), id, opts()) };
    } } as unknown as SpecWaitEnv;
  return { sent, tick: (at: number) => { now = at; return observationTickAt(paths.plans)(env); } };
}

const samples = (key = "askReminder", n = 2) => {
  for (let i = 0; i < n; i++) recordObserved(db, { project: "p", mechanism: key as "askReminder", target: "T1", actionKey: `sample-${i}`, action: "test" }, T + i + 1);
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "obs-auto-"));
  paths = { plans: join(dir, "plans.json"), recovery: join(dir, "recovery.json") };
  db = openLedger(join(dir, "ledger.sqlite"));
  setMeta(db, owner(), { project: "p", key: "pms", value: [PM] });
  createTask(db, owner(), { project: "p", id: "T1", title: "test", kind: "code", agent: "agent-w", pm: PM });
  db.run("UPDATE tasks SET stage = 'verified' WHERE id = 'T1'");
  db.run("INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (?, 'owner', 'p', 'T1', 'stage', '', ?)", [T, JSON.stringify({ to: "verified" })]);
  text = "# T1\n## 上线后 PM\n观察期:1 小时\n自动转正:askReminder\n";
  mode("on");
});
afterEach(() => { closeLedger(join(dir, "ledger.sqlite")); rmSync(dir, { recursive: true, force: true }); });

test("[验收线 1] only structured markers in the post-verify section authorize keys", () => {
  expect(automaticKeys("自动转正:askReminder、audit\nscheduler-recovery p on --key nearMarker", "p")).toEqual(["askReminder", "audit", "nearMarker"]);
  expect(automaticKeys('`ledger scheduler-recovery p on --key audit --reason "观察期通过"`', "p")).toEqual(["audit"]);
  expect(automaticKeys("请把 audit 转正\nscheduler-recovery other on --key audit", "p")).toEqual([]);
});

test("[验收线 1] spec registration binds PM, digest and verified; repeats and manual registrations deduplicate", async () => {
  await register(); await register();
  expect(readPlans(paths.plans).plans).toHaveLength(1);
  expect(readPlans(paths.plans).plans[0]).toMatchObject({ by: PM, source: "ledger-events", startAt: T, dueAt: T + H, authorization: { source: "spec", pm: PM } });
  expect(events("observation_plan")[0].actor).toBe("scheduler");
  expect(events("observation_plan")[0].data).toMatchObject({ source: "ledger-events", authorization: { source: "spec" } });
  expect(readPlans(paths.plans).plans[0].authorization?.digest).toHaveLength(64);
});

test("[验收线 1] legacy command and project PM fallback work; invalid targets leave deduplicated notes", async () => {
  db.run("UPDATE tasks SET pm = NULL WHERE id = 'T1'");
  text = "## 上线后 PM\n观察期:1 小时\nscheduler-recovery p on --key askReminder\n自动转正:unknownKey\n";
  await register(); await register();
  expect(readPlans(paths.plans).plans[0].by).toBe(PM);
  expect(events("observation_register_skip")).toHaveLength(1);
});

test("[验收线 1] manual plan wins and scheduler cannot use the manual registration entry", async () => {
  const input = { project: "p", taskId: "T1", target: parseTarget("recovery:askReminder"), hours: 1, source: "ledger-events", ruleVersion: "v1", reason: "test" };
  await expect(registerObservation(db, scheduler(), input, paths)).rejects.toThrow("PM");
  await registerObservation(db, { actor: PM, now: T }, input, paths);
  await register();
  expect(readPlans(paths.plans).plans.map((p) => p.source)).toEqual(["ledger-events"]);
});

test("[验收线 2] samples promote without a push and finish a section with only automatic work", async () => {
  await register(); samples();
  const { sent, tick } = service();
  expect(await tick(T + H)).toEqual([]);
  expect(sent).toEqual([]);
  expect(recoveryPolicy("p", "askReminder", paths.recovery).mode).toBe("on");
  expect(events("observation_promote")).toHaveLength(1);
  expect(events("observation_promote")[0].text).toContain("来源 ledger-events");
  expect(getEventByDedup(db, "post-verify-done:T1")).not.toBeNull();
  expect(pmTodos(db, "p", () => text, T + H)).toEqual([]);
});

test("[验收线 2] other post-verify checks remain with an automatic-promotion summary", async () => {
  text += "还要核对部署\n";
  await register(); samples(); await due();
  expect(getEventByDedup(db, "post-verify-done:T1")).toBeNull();
  expect(pmTodos(db, "p", () => text, T + H)[0].what).toContain("开关已自动转正");
});

test("[验收线 3] zero samples extend twice and only the third expiry is judged in pm-todo", async () => {
  await register();
  expect((await due()).outcome).toBe("extended");
  expect((await due(T + 2 * H)).outcome).toBe("extended");
  expect((await due(T + 3 * H)).outcome).toBe("judge");
  expect(events("observation_extend")).toHaveLength(2);
  expect(readPlans(paths.plans).plans[0]).toMatchObject({ status: "judged", judge: { code: "no_samples" } });
  const todos = pmTodos(db, "p", () => text, T + 3 * H);
  expect(todos.filter((t) => t.kind === "observation_judged")).toHaveLength(1);
  expect(todos.filter((t) => t.kind === "observation_extended")).toHaveLength(0);
});

test("[验收线 4] high-risk keys require three records and at least 24 hours", async () => {
  text = text.replace("askReminder", "pmRails");
  await register(); samples("pmRails", 2);
  expect((await due()).outcome).toBe("extended");
  expect(recoveryPolicy("p", "pmRails", paths.recovery).mode).toBe("observe");
});

test("[验收线 4] high-risk key with a 24-hour window and three records promotes", async () => {
  text = text.replace("askReminder", "pmRails").replace("1 小时", "24 小时");
  await register(); samples("pmRails", 3);
  expect((await due(T + 24 * H)).outcome).toBe("promoted");
});

test("[验收线 4] automatic scope approval needs the high-risk observation window and sample count", async () => {
  text = text.replace("askReminder", "askDefaultAll");
  await register(); samples("askDefaultAll", 2);
  expect((await due()).outcome).toBe("extended");
  expect(recoveryPolicy("p", "askDefaultAll", paths.recovery).mode).toBe("observe");
});

for (const change of ["error", "misjudged", "digest", "authority", "mode"] as const) {
  test(`[验收线 5] ${change} prevents promotion and produces a pull todo`, async () => {
    await register(); samples();
    if (change === "error") {
      const input = { project: "p", mechanism: "askReminder" as const, actionKey: "failure", error: "failed" };
      recordRecoveryError(db, input, T + 100); recordRecoveryError(db, input, T + 101);
      expect(events("recovery_error")).toHaveLength(1);
    }
    if (change === "misjudged") await markObservation(db, { actor: PM, now: T + 100 }, { id: "obs-1", record: events("recovery_observe")[0].seq, reason: "wrong" }, paths);
    if (change === "digest") text += "edited\n";
    if (change === "authority") setMeta(db, owner(), { project: "p", key: "pms", value: ["agent-new"] });
    if (change === "mode") await setRecovery(db, owner(T + 100), { project: "p", set: { key: "askReminder", mode: "off" }, reason: "manual" }, { path: paths.recovery });
    expect((await due()).outcome).toBe("judge");
    expect(pmTodos(db, "p", () => text, T + H).some((t) => t.kind === "observation_judged")).toBe(true);
    expect(events("observation_promote")).toHaveLength(0);
  });
}

test("[验收线 6] observe registers and only records would-extend; off neither registers nor judges", async () => {
  mode("off"); await register(); expect(readPlans(paths.plans).plans).toEqual([]);
  mode("observe"); await register();
  expect((await due()).outcome).toBe("dry-run");
  expect(events("observation_dry_run")[0].text).toContain("本会顺延");
  expect(readPlans(paths.plans).plans[0].dueAt).toBe(T + H);
  mode("off"); expect((await due()).outcome).toBe("idle");
  expect(events("observation_extend")).toHaveLength(0);
});

test("[验收线 1] a read-only scheduler tick registers once through the leased writer and precedes due checking", async () => {
  const { Database: Sqlite } = await import("bun:sqlite");
  const { observationAutoRegisterTick, observationAutoRegisterTickAt } = await import("../src/lib/observation-auto-register-tick.js");
  const { observationCmds } = await import("../src/manager/ledger-observation-cmds.js");
  const { LedgerCli } = await import("../src/manager/ledger-context.js");
  const { parseLedgerArgs } = await import("../src/manager/ledger-identity.js");
  const { pmWakeTicks } = await import("../src/lib/scheduler-merge-pm-tick.js");
  expect(pmWakeTicks.indexOf(observationAutoRegisterTick)).toBe(pmWakeTicks.length - 2);
  const tick = observationAutoRegisterTickAt(paths.plans);
  const reader = new Sqlite(join(dir, "ledger.sqlite"), { readonly: true });
  reader.run("PRAGMA query_only = ON");
  let calls = 0;
  const env = { db: reader, svc: { projects: ["p"] }, readSpec: spec, now: () => T,
    ledger: async (_: string, sub: string, id: string) => {
      calls++;
      const cmd = observationCmds(opts())[sub];
      const args = parseLedgerArgs([sub, id], cmd.valued, cmd.bools);
      if ("error" in args) throw new Error(args.error);
      return cmd.run(new LedgerCli({ db, actor: "scheduler", projectIds: ["p"], now: () => T, assertLease: () => {},
        autoDispatch: () => true, autoProjects: () => ["p"], loadRegistry: async () => ({ socket: "s", agents: {} }), saveRegistry: async () => {} }, args));
    } } as unknown as SpecWaitEnv;
  try {
    expect(await tick(env)).toEqual([]);
    expect(await tick(env)).toEqual([]);
    expect(readPlans(paths.plans).plans).toHaveLength(1);
    expect(calls).toBe(1);
    mode("off"); await tick(env); expect(calls).toBe(1);
  } finally { reader.close(); }
});

test("[验收线 1] unrecognized duration and on / off / diagnostic targets do not register", async () => {
  text = text.replace("观察期:1 小时", "观察期:稍后");
  await register(); await register();
  expect(readPlans(paths.plans).plans).toEqual([]);
  expect(events("observation_register_skip")).toHaveLength(1);
  text = text.replace("观察期:稍后", "观察期:1 小时");
  for (const mode of ["on", "off"] as const) {
    await setRecovery(db, owner(), { project: "p", set: { key: "askReminder", mode }, reason: "manual" }, { path: paths.recovery });
    await register(); expect(readPlans(paths.plans).plans).toEqual([]);
  }
  writeFileSync(paths.recovery, "{");
  await register(); expect(readPlans(paths.plans).plans).toEqual([]);
});

test("[验收线 2] a multi-key spec closes only when every target is promoted", async () => {
  text = text.replace("自动转正:askReminder", "自动转正:askReminder、auditIdleFacts");
  await register(); samples();
  expect((await due()).outcome).toBe("promoted");
  expect(getEventByDedup(db, "post-verify-done:T1")).toBeNull();
  samples("auditIdleFacts");
  expect((await observationDue(db, scheduler(T + H), "obs-2", opts())).outcome).toBe("promoted");
  expect(getEventByDedup(db, "post-verify-done:T1")).not.toBeNull();
});

test("[验收线 3] extended items are waiting rows and disappear after PM cancellation", async () => {
  const { cancelObservation } = await import("../src/lib/observation-plan.js");
  await register(); await due();
  const todos = pmTodos(db, "p", () => text, T + H);
  expect(todos.filter((t) => t.kind === "observation_extended")).toMatchObject([{ kind: "observation_extended", due: false }]);
  expect(todos.filter((t) => !t.kind)).toHaveLength(1);
  await cancelObservation(db, { actor: PM, now: T + H }, "obs-1", "manual", paths);
  expect(pmTodos(db, "p", () => text, T + H).some((t) => t.kind === "observation_extended")).toBe(false);
  await register(); expect(readPlans(paths.plans).plans).toHaveLength(1);
});

test("[验收线 5] spec authorization is revalidated inside the target writer", async () => {
  await register(); samples();
  const r = await observationDue(db, scheduler(T + H), "obs-1", { ...opts(), writers: { recovery: async (_db, _plan, _ctx, guard) => {
    text += "changed while waiting\n"; guard(); throw new Error("must not switch");
  } } });
  expect(r).toMatchObject({ outcome: "judge", plan: { judge: { code: "spec_changed" } } });
  expect(recoveryPolicy("p", "askReminder", paths.recovery).mode).toBe("observe");
});

test("[验收线 5] the generic adapter binds keys and isolates project / mechanism / kind / error windows", async () => {
  const { evidenceAdapter, readEvidence } = await import("../src/lib/observation-plan-evidence.js");
  await register(); samples();
  const plan = readPlans(paths.plans).plans[0];
  appendEvent(db, scheduler(T + 1), { project: "p", target: "T1", kind: "decision", data: { op: "recovery_observe", mechanism: "askReminder" } });
  recordObserved(db, { project: "p", mechanism: "audit", target: "T1", actionKey: "other", action: "other key" }, T + 2);
  recordRecoveryError(db, { project: "p", mechanism: "askReminder", actionKey: "late", error: "after window" }, T + 2 * H);
  recordRecoveryError(db, { project: "other", mechanism: "askReminder", actionKey: "foreign", error: "other project" }, T + 1);
  const evidence = readEvidence(db, plan, T + H);
  expect([evidence.records.length, evidence.errors.length]).toEqual([2, 0]);
  expect(evidenceAdapter({ kind: "recovery", key: "bad' OR 1=1 --" as "audit" })).toBeUndefined();
});


test("[验收线 3] extension and judgement ticks acknowledge without pushing", async () => {
  await register();
  const { sent, tick } = service();
  for (let n = 1; n <= 3; n++) expect(await tick(T + n * H)).toEqual([]);
  expect(sent).toEqual([]);
  expect(readPlans(paths.plans).plans[0]).toMatchObject({ status: "judged", judge: { sentAt: T + 3 * H } });
  expect(await tick(T + 4 * H)).toEqual([]);
  expect(events("observation_extend")).toHaveLength(2);
});


test("[验收线 2] formatting around a legacy command does not leave a completed automatic-only card open", async () => {
  text = '## 上线后 PM\n观察期:1 小时\n```sh\nledger scheduler-recovery p on --key askReminder --reason "通过"\n```\n';
  await register(); samples(); await due();
  expect(getEventByDedup(db, "post-verify-done:T1")).not.toBeNull();
});

for (const key of ["unknownKey", "auditIdleFacts"] as const) {
  test(`[验收线 2] a skipped ${key} keeps the card visible before and after partial promotion`, async () => {
    text = text.replace("自动转正:askReminder", `自动转正:askReminder、${key}`);
    if (key === "auditIdleFacts") {
      await setRecovery(db, owner(), { project: "p", set: { key, mode: "on" }, reason: "manual" }, { path: paths.recovery });
    }
    await register();
    expect(events("observation_register_skip")).toHaveLength(1);
    expect(pmTodos(db, "p", () => text, T + H)).toMatchObject([{ task: "T1", what: expect.stringContaining("开关已交系统观察") }]);
    samples(); await due();
    expect(getEventByDedup(db, "post-verify-done:T1")).toBeNull();
    expect(pmTodos(db, "p", () => text, T + H)).toMatchObject([{ task: "T1", what: expect.stringContaining("开关已自动转正") }]);
  });
}

test("[验收线 3] closing a judgement does not close the card's unfinished post-verify work", async () => {
  await register();
  for (let n = 1; n <= 3; n++) await due(T + n * H);
  const judged = pmTodos(db, "p", () => text, T + 3 * H).find((t) => t.kind === "observation_judged")!;
  appendEvent(db, { actor: PM, now: T + 3 * H, dedupKey: `pm-todo-done:${judged.dedupKey}` },
    { project: "p", target: "T1", kind: "note", text: "判断已处理，卡仍有未完成步骤" });
  expect(getEventByDedup(db, "post-verify-done:T1")).toBeNull();
  expect(pmTodos(db, "p", () => text, T + 3 * H)).toMatchObject([{ task: "T1" }]);
  appendEvent(db, { actor: PM, now: T + 3 * H, dedupKey: "post-verify-done:T1" },
    { project: "p", target: "T1", kind: "note", text: "上线后工作完成" });
  expect(pmTodos(db, "p", () => text, T + 3 * H)).toEqual([]);
});

for (const status of ["active", "judged", "cancelled", "skipped", "manual"] as const) {
  test(`[验收线 1] tick avoids the writer for ${status} targets but discovers new keys and verified generations`, async () => {
    const { observationAutoRegisterTickAt } = await import("../src/lib/observation-auto-register-tick.js");
    const { cancelObservation } = await import("../src/lib/observation-plan.js");
    if (status === "skipped") text = text.replace("askReminder", "unknownKey");
    if (status === "manual") {
      await registerObservation(db, { actor: PM, now: T }, { project: "p", taskId: "T1", target: parseTarget("recovery:askReminder"),
        hours: 1, source: "ledger-events", ruleVersion: "v1", reason: "manual" }, paths);
    } else await register();
    if (status === "judged") for (let n = 1; n <= 3; n++) await due(T + n * H);
    if (status === "cancelled") await cancelObservation(db, { actor: PM, now: T + H }, "obs-1", "manual", paths);
    const calls: string[] = [];
    const env = { db, svc: { projects: ["p"] }, readSpec: spec, ledger: async (...args: string[]) => { calls.push(args.join(" ")); return { ok: true }; } } as unknown as SpecWaitEnv;
    const tick = observationAutoRegisterTickAt(paths.plans);
    for (let i = 0; i < 3; i++) expect(await tick(env)).toEqual([]);
    expect(calls).toEqual([]);
    if (status === "judged" || status === "cancelled" || status === "skipped") {
      db.run("INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (?, 'owner', 'p', 'T1', 'stage', '', ?)", [T + 4 * H, JSON.stringify({ to: "verified" })]);
      expect(await tick(env)).toEqual([]);
      expect(calls).toHaveLength(1);
      calls.length = 0;
    }
    text += "自动转正:auditIdleFacts\n";
    expect(await tick(env)).toEqual([]);
    expect(calls).toEqual(["ledger scheduler-observation-register T1"]);
  });
}
